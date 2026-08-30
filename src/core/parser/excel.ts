import * as XLSX from 'xlsx';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { absAmount, parseAmount, signedFromDebitCredit } from '../amount';
import { parseDate } from '../date';
import { extractChequeNo, extractReferences, hasTruncatedReference, normalizeReference } from '../reference';
import { parseGenericWorkbook } from './genericSheet';
import { parseSplitVoucherWorkbook } from './splitVoucherSheet';
import { parseInvoiceRegisterWorkbook } from './invoiceRegisterSheet';
import { parseTallyColumnarWorkbook } from './tallyColumnarSheet';
import { parseSapLineItemWorkbook } from './sapLineItemSheet';
import type { NormalizedTxn, ParseResult, ParserLogRow, PrintedTotals, VoucherType } from '../types';

type Row = Record<string, unknown> & { __rowNum__: number };
function headerRowIndex(ws: XLSX.WorkSheet) {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: true });
  const idx = matrix.findIndex((row) => {
    const text = row.map((c) => String(c).toLowerCase()).join('|');
    return text.includes('date') && (text.includes('doc type') || text.includes('vch type') || text.includes('particulars') || text.includes('gst inv'));
  });
  // sheet_to_json({header:1}) yields rows from the sheet's USED range, so index
  // 0 is the first used row - but the `range` option that consumes this number
  // counts absolute worksheet rows. On a sheet whose data starts below row 1
  // the two disagree and the header lands short, keying every column as
  // __EMPTY_n: Atlas (!ref = A3:J300) then had no Date column at all, so the
  // Tally reader saw a dateless file and half the ledger was lost.
  const origin = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;
  return (idx >= 0 ? idx : 0) + origin;
}
function normHeader(v: string) { return v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function pick(row: Row, names: string[]) {
  const keys = Object.keys(row);
  const exactName = names.find(n => keys.some(k => normHeader(k) === normHeader(n)));
  const exact = exactName ? keys.find(k => normHeader(k) === normHeader(exactName)) : undefined;
  if (exact) return row[exact];
  const includeName = names.find(n => n.length >= 4 && keys.some(k => normHeader(k).includes(normHeader(n))));
  const found = includeName ? keys.find(k => normHeader(k).includes(normHeader(includeName))) : undefined;
  return found ? row[found] : undefined;
}
/** First NON-EMPTY value among the named columns. `pick` returns '' for blank
 * cells, and '' defeats `??` chains — which silently left 361 Suroj RDC rows
 * with no reference at all when GST Inv Number was blank. */
function pickText(row: Row, names: string[]): string {
  for (const n of names) {
    const v = pick(row, [n]);
    const s = v instanceof Date ? '' : String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}
/**
 * Does this sheet actually look like an RDC ledger export? A reconciliation
 * WORKBOOK carries the ledger alongside working sheets (the customer's ledger,
 * a Reco sheet, annexures). Forcing the RDC reader onto every sheet merged them
 * all into one ledger — Mosh's 1,348-row ledger came out as 2,612 rows, which
 * is what produced 879 "unbooked" invoices worth ₹2.23 crore.
 */
function looksLikeRdcSheet(rows: Row[]) {
  const header = Object.keys(rows[0] || {}).map(normHeader).join(' | ');
  const hasAmounts = /tran dr amt|tran cr amt|\bdebit\b|\bcredit\b|\bdr\b|\bcr\b/.test(header);
  const hasRdcColumns = /inv receipt|invoice number|doc type|gst inv|vendor name|vendor site|plant name/.test(header);
  return hasAmounts && hasRdcColumns;
}
function detect(rows: Row[]) {
  const headers = Object.keys(rows[0] || {}).join('|').toLowerCase();
  if (headers.includes('tran dr') || headers.includes('gst inv')) return 'RDC';
  if (headers.includes('vch type') || headers.includes('particulars')) return 'TALLY';
  return 'GENERIC';
}
function classifyRdc(doc: string, narration: string, debit: number, credit: number): VoucherType {
  // Doc Type column is authoritative when present (Oracle debtors export).
  // REV (receipt reversal) reconciles together with REC per accounts team.
  const d = doc.trim().toUpperCase();
  const DOC_MAP: Record<string, VoucherType> = {
    INV: 'INVOICE', REC: 'RECEIPT', REV: 'RECEIPT', CM: 'CREDIT_NOTE',
    CN: 'CREDIT_NOTE', DM: 'DEBIT_NOTE', DN: 'DEBIT_NOTE', TDS: 'TDS',
  };
  if (DOC_MAP[d]) return DOC_MAP[d];
  const t = (doc + ' ' + narration).toLowerCase();
  if (/opening/.test(t)) return 'OPENING';
  if (/closing/.test(t)) return 'CLOSING';
  if (/tds|194q|194c|tax deducted/.test(t)) return 'TDS';
  if (/credit note|credit memo|armn| cn\b/.test(t)) return 'CREDIT_NOTE';
  if (/debit note|debit memo|arcm| d no/.test(t)) return 'DEBIT_NOTE';
  if (/inv|sale|invoice/.test(t) || debit > 0) return 'INVOICE';
  if (/rec|receipt|payment|bank/.test(t) || credit > 0) return 'RECEIPT';
  return 'OTHER';
}
/**
 * RDC's own CREDITOR (accounts-payable) ledger — used when RDC is the buyer
 * (cement suppliers such as Dalmia). The AP convention is the mirror of the
 * debtors ledger: a supplier's bill is a CREDIT and RDC's payment is a DEBIT,
 * and Oracle prints the document type as STANDARD / CREDIT / DEBIT rather than
 * INV / CM / DM. Without this, every purchase invoice was classified as a
 * receipt, which then flipped the counterparty's signs and killed all matching.
 */
function classifyRdcCreditor(doc: string, narration: string, debit: number, credit: number): VoucherType {
  const t = (doc + ' ' + narration).toLowerCase();
  if (/opening/.test(t)) return 'OPENING';
  if (/closing/.test(t)) return 'CLOSING';
  // TDS/TCS first: those rows are typed CREDIT but are tax, not credit notes.
  if (/tds|tcs|194q|194c|tax deducted/.test(t)) return 'TDS';
  const DOC_MAP: Record<string, VoucherType> = {
    STANDARD: 'INVOICE', INV: 'INVOICE', INVOICE: 'INVOICE',
    CREDIT: 'CREDIT_NOTE', CM: 'CREDIT_NOTE', CN: 'CREDIT_NOTE',
    DEBIT: 'DEBIT_NOTE', DM: 'DEBIT_NOTE', DN: 'DEBIT_NOTE',
    PAYMENT: 'RECEIPT', PREPAYMENT: 'RECEIPT',
  };
  const mapped = DOC_MAP[doc.trim().toUpperCase()];
  if (mapped) return mapped;
  if (/quick payment|payment|neft|rtgs|cheque|fund tr/.test(t)) return 'RECEIPT';
  if (credit > 0) return 'INVOICE';   // supplier bill
  if (debit > 0) return 'RECEIPT';    // payment made to the supplier
  return 'OTHER';
}
function classifyVendorMirror(doc: string, narration: string, debit: number, credit: number): VoucherType {
  // Customer's VENDOR ledger of RDC (payable view) exported in the same ERP
  // column layout as RDC's own debtors export — but mirrored: RDC bills are
  // CREDITS, payments to RDC are DEBITS (e.g. Balajee Infratech Jan-2026).
  const d = doc.trim().toUpperCase();
  const DOC_MAP: Record<string, VoucherType> = {
    INV: 'INVOICE', REC: 'PAYMENT', REV: 'PAYMENT', CM: 'CREDIT_NOTE',
    CN: 'CREDIT_NOTE', DM: 'DEBIT_NOTE', DN: 'DEBIT_NOTE', TDS: 'TDS',
  };
  if (DOC_MAP[d]) return DOC_MAP[d];
  const t = (doc + ' ' + narration).toLowerCase();
  if (/opening/.test(t)) return 'OPENING';
  if (/closing/.test(t)) return 'CLOSING';
  if (/tds|194q|194c|tax deducted/.test(t)) return 'TDS';
  if (/credit note|credit memo|arcm|armn/.test(t)) return 'CREDIT_NOTE';
  if (/debit note|debit memo/.test(t)) return 'DEBIT_NOTE';
  if (/payment|paid|neft|rtgs|\bcms\b|cheque|\bchq\b/.test(t) || (debit > 0 && !credit)) return 'PAYMENT';
  if (/bill booked|invoice|purchase|\binv\b/.test(t) || credit > 0) return 'INVOICE';
  return 'OTHER';
}
function classifyCustomer(vch: string, particulars: string, debit: number, credit: number, refs: string[]): VoucherType {
  const t = (vch + ' ' + particulars + ' ' + refs.join(' ')).toLowerCase();
  if (/opening/.test(t)) return 'OPENING';
  if (/closing/.test(t)) return 'CLOSING';
  if (/tds|194q|194c|tax deducted|tds on supply/.test(t)) return /journal|jv/.test(t) ? 'JOURNAL_TDS' : 'TDS';
  if (/journal|\bjv\b/.test(t)) {
    if (/debit note|d no|arcm/.test(t)) return debit > 0 ? 'CREDIT_NOTE' : 'DEBIT_NOTE';
    if (/credit note|invoice cancelled|\bcn\b|armn/.test(t)) return 'CREDIT_NOTE';
    if (refs.length && credit > 0) return 'JOURNAL_INVOICE';
    return 'JOURNAL_ADJUSTMENT';
  }
  // What the row CALLS itself decides what it is. The Dr/Cr sign is only a
  // last resort, and it used to be consulted first: a row whose voucher type
  // read "Debit Note" but whose amount sat in the Debit column was filed as a
  // receipt (DSR: 11 debit notes against RDC credit notes), and a row reading
  // "GST INVOICE" became a payment for the same reason (GK: 235 of 241 rows).
  if (/debit note|arcm/.test(t)) return 'DEBIT_NOTE';
  if (/credit note|invoice cancelled|armn|\bcn\b/.test(t)) return 'CREDIT_NOTE';
  if (/purchase|local purchases|invoice|\bsales?\b/.test(t)) return 'INVOICE';
  if (/bank payment|payment|collection|receipt|\brcpt\b|neft|rtgs|imps/.test(t)) return 'PAYMENT';
  if (refs.length && credit > 0) return 'INVOICE';
  if (credit > 0) return 'INVOICE';
  if (debit > 0) return 'PAYMENT';
  return 'OTHER';
}

/**
 * A document number standing on its own in some column: letters AND digits,
 * with the separators bill numbers use. Deliberately refuses a bare serial
 * ("205" is a Tally voucher counter, not a bill), a date and an amount.
 */
function documentRef(text: string): string {
  for (const token of String(text || '').split(/[|\s,;]+/)) {
    const t = token.trim().replace(/[.,;:]+$/, '');
    if (t.length < 5 || t.length > 30) continue;
    if (!/[A-Za-z]/.test(t) || !/\d/.test(t)) continue;
    if (!/^[A-Za-z0-9/\-.]+$/.test(t)) continue;
    if (/^\d{1,2}[-/.][A-Za-z]{3}[-/.]\d{2,4}$/.test(t)) continue;
    return t.toUpperCase();
  }
  return '';
}
function buildTxn(partial: Omit<NormalizedTxn, 'id'>): NormalizedTxn { return { id: uuid(), ...partial }; }
export function parseExcelFile(filePath: string, sourceSideHint?: 'RDC' | 'CUSTOMER'): ParseResult {
  // CSV: keep every cell as its original string (raw:true). SheetJS would
  // otherwise date-detect strings like "05/01/2026" with US month-first order
  // and render 2-digit years as year 0026 — parseDate handles the real text
  // (dd/MM/yyyy, dd-MMM-yy) correctly.
  const isCsv = /\.csv$/i.test(filePath);
  const wb = XLSX.read(fs.readFileSync(filePath), isCsv ? { type: 'buffer', raw: true } : { cellDates: true, type: 'buffer' });
  const transactions: NormalizedTxn[] = [];
  const parserLog: ParserLogRow[] = [];
  const balances: ParseResult['balances'] = { openingRows: [], closingRows: [] };
  const printedTotals: PrintedTotals = {};
  const sourceFile = filePath.split(/[\\/]/).pop() || filePath;
  // ERP exports that split one voucher across several account rows must be
  // regrouped before anything else reads them row by row.
  const hintedSide = sourceSideHint === 'RDC' ? 'RDC' : 'CUSTOMER';
  if (parseSplitVoucherWorkbook(wb, sourceFile, hintedSide, transactions, balances, parserLog, printedTotals) && transactions.length) {
    return { transactions, balances, parserLog, printedTotals: (printedTotals.debit || printedTotals.credit) ? printedTotals : undefined };
  }
  // Customer-maintained invoice registers: one row can hold an invoice AND a
  // payment, so they must be split before any row-per-entry reader sees them.
  if (parseInvoiceRegisterWorkbook(wb, sourceFile, hintedSide, transactions, balances, parserLog) && transactions.length) {
    return { transactions, balances, parserLog };
  }
  // When at least one sheet is a genuine RDC ledger, the others are working
  // papers and must not be folded into it.
  const rdcSheets = new Set<string>();
  if (sourceSideHint === 'RDC') {
    for (const sheetName of wb.SheetNames) {
      const probe = XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheetName], { defval: '', raw: true, range: headerRowIndex(wb.Sheets[sheetName]) });
      if (probe.length && looksLikeRdcSheet(probe)) rdcSheets.add(sheetName);
    }
  }
  const seenAcrossSheets = new Map<string, string>();
  const genericSheets = new Set<string>();
  for (const sheetName of wb.SheetNames) {
    if (rdcSheets.size && !rdcSheets.has(sheetName)) {
      parserLog.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: 'Skipped: this sheet is not an RDC ledger export (working paper, annexure or the other party\'s ledger)', confidence: 85 });
      continue;
    }
    const ws = wb.Sheets[sheetName];
    // raw:true is REQUIRED for accuracy: raw:false returns Excel's *displayed*
    // text, so a cell formatted without decimals ("29,250" for 29250.20) loses
    // its paise. That silently broke amount matching and produced phantom
    // integrity gaps (Suroj: ₹134.33).
    const rows = XLSX.utils.sheet_to_json<Row>(ws, { defval: '', raw: true, range: headerRowIndex(ws) });
    if (!rows.length) continue;
    const kind = sourceSideHint === 'RDC' ? 'RDC' : sourceSideHint === 'CUSTOMER' ? detect(rows) : detect(rows);
    const side = sourceSideHint === 'CUSTOMER' ? 'CUSTOMER' : 'RDC';
    // RDC's accounts-PAYABLE export (RDC is the buyer): supplier bills are
    // credits and payments are debits — the mirror of the debtors ledger.
    const headerText = Object.keys(rows[0] || {}).join('|').toLowerCase();
    const creditorLedger = /creditor|vendor name|vendor site/.test(sheetName.toLowerCase() + '|' + headerText);
    parserLog.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: 'Detected ' + kind + ' ledger layout' + (kind === 'RDC' && side === 'CUSTOMER' ? ' (customer vendor-ledger mirror: bills=Cr, payments=Dr)' : '') + (creditorLedger && side === 'RDC' ? ' (RDC creditor/payable ledger: bills=Cr, payments=Dr)' : ''), confidence: 90 });
    if (kind === 'RDC') parseRdcRows(rows, sourceFile, sheetName, transactions, balances, parserLog, side, creditorLedger && side === 'RDC', printedTotals, seenAcrossSheets);
    // "GENERIC" means the sheet is neither an RDC export nor a Tally print -
    // a flat register with its own Debit/Credit and type columns. Handing it to
    // the Tally parent/child reader made a mess of it (Mosh: 760 rows in a
    // nameless "Other entries" bucket, a duplicate invoice swallowed, coverage
    // halved); the generic adapter is the reader built for that shape.
    else if (kind === 'GENERIC') genericSheets.add(sheetName);
    else parseCustomerRows(rows, sourceFile, sheetName, transactions, balances, parserLog);
  }
  if (genericSheets.size) {
    parseGenericWorkbook(wb, sourceFile, sourceSideHint === 'RDC' ? 'RDC' : 'CUSTOMER', transactions, balances, parserLog, printedTotals, genericSheets);
  }
  // Deterministic safety net: none of the known layouts read a single row —
  // hunt for a ledger table generically before anyone reaches for the AI.
  // The columnar Tally print goes first: it has no Dr/Cr pair at all, so the
  // generic reader cannot see it as a ledger, and it proves itself against the
  // balance the file prints before it accepts anything.
  if (!transactions.length) {
    parseTallyColumnarWorkbook(wb, sourceFile, sourceSideHint === 'RDC' ? 'RDC' : 'CUSTOMER', transactions, balances, parserLog);
  }
  // SAP line-item statements have one SIGNED amount column instead of a Dr/Cr
  // pair and name the row's nature with a two-letter document type, so the
  // generic reader cannot see a ledger in them at all.
  if (!transactions.length) {
    parseSapLineItemWorkbook(wb, sourceFile, sourceSideHint === 'RDC' ? 'RDC' : 'CUSTOMER', transactions, balances, parserLog);
  }
  if (!transactions.length) {
    parseGenericWorkbook(wb, sourceFile, sourceSideHint === 'RDC' ? 'RDC' : 'CUSTOMER', transactions, balances, parserLog, printedTotals);
  }
  return { transactions, balances, parserLog, printedTotals: (printedTotals.debit || printedTotals.credit) ? printedTotals : undefined };
}
function parseRdcRows(rows: Row[], sourceFile: string, sourceSheet: string, out: NormalizedTxn[], balances: ParseResult['balances'], log: ParserLogRow[], side: 'RDC' | 'CUSTOMER' = 'RDC', creditorLedger = false, totals?: PrintedTotals, seenAcrossSheets?: Map<string, string>) {
  const firstRowIndex = out.length;
  let bareBalanceSeen = false;
  for (const row of rows) {
    const docType = String(pick(row, ['Doc Type','Voucher Type']) ?? '');
    const voucherNo = String(pick(row, ['Inv / Receipt Number','Voucher No']) ?? '');
    // RDC's debtors export labels its closing row with the bare word "Balance"
    // (no "Closing"), so the row was read as an ordinary transaction, the
    // ledger stated no closing balance at all, and the balance was derived from
    // the rows as 0.00 - which is what the statement then printed as "Balance
    // As per RDC" (Mosh: the real figure, 19,24,476.46, was sitting in the file).
    const balanceLabel = Object.values(row).find(v => /^\s*(opening|closing)?\s*balance\s*$/i.test(String(v)) || /Opening Balance|Closing Balance/i.test(String(v)));
    const particulars = [pick(row, ['Narration','Particular','Customer Name','Plant Name','Transaction Type']), balanceLabel].filter(Boolean).join(' | ');
    // A bare "Balance" with no date closes the ledger; "Opening"/"Closing" are
    // handled by the classifier below on the particulars text.
    const bareBalance = !!balanceLabel && /^\s*balance\s*$/i.test(String(balanceLabel));
    // Invoice date before posting/GL date: it is the date the COUNTERPARTY
    // also books, so date-tolerance matching works (creditor exports post a
    // whole month on one GL date).
    const date = parseDate(pick(row, ['Inv/ Receipt Date','Invoice Date','Voucher Date','GL Date','Date']));
    const debit = absAmount(pick(row, ['Tran Dr Amt','Debit','Dr']));
    const credit = absAmount(pick(row, ['Tran Cr Amt','Credit','Cr']));
    if (!date && !debit && !credit && !particulars && !docType) continue;
    const refs = extractReferences([particulars, pickText(row, ['GST Inv Number','Invoice Number','Inv / Receipt Number','Bill No','Reference'])]);
    // Shared invoice identity first, then anything extracted from the text,
    // then RDC's own document number so a row is never left reference-less.
    const referenceNo = pickText(row, ['GST Inv Number','Bill No','Reference']) || refs[0] || pickText(row, ['Invoice Number','Inv / Receipt Number']);
    // A customer's vendor ledger in this same layout is the MIRROR of RDC's
    // export: bills sit in the credit column, payments in the debit column,
    // and the row label ("Bill Booked" / "Payment Made ...") lives in the
    // Inv / Receipt Number column.
    const voucherType = side !== 'RDC'
      ? classifyVendorMirror(docType, [voucherNo, particulars, referenceNo].join(' '), debit, credit)
      : creditorLedger
        ? classifyRdcCreditor(docType, particulars + ' ' + referenceNo, debit, credit)
        : classifyRdc(docType, particulars + ' ' + referenceNo, debit, credit);
    // Summary rows: the label often sits in an unmapped column (e.g. "Grand
    // Total" under Document Seq Number), so scan EVERY cell — a missed total
    // row double-counts the entire ledger.
    const allCells = Object.values(row).map(v => String(v ?? '')).join(' ');
    if (/grand total|total of debits|period total|\btotal\b/i.test(allCells) && (debit || credit) && !date) {
      // Capture, don't just discard: the printed Dr/Cr totals prove the parse
      // read every amount, which a net closing balance alone cannot.
      if (totals && !totals.debit && !totals.credit) { totals.debit = debit; totals.credit = credit; totals.sheet = sourceSheet; }
      log.push({ sourceFile, sourceSheet, sourceRow: row.__rowNum__, level: 'info', message: `Skipped total row (printed totals captured for the parse audit: Dr ${debit.toFixed(2)} / Cr ${credit.toFixed(2)})` });
      continue;
    }
    // UNLABELLED totals row: amounts but no date, no document number and no
    // description (creditor exports print a bare Debit/Credit total above the
    // closing balance). Counting it doubles the whole ledger — Dalmia Chennai
    // was off by exactly its ₹69.9 lakh total.
    if ((debit || credit) && !date && !referenceNo && !docType && !particulars.trim()) {
      if (totals && !totals.debit && !totals.credit) { totals.debit = debit; totals.credit = credit; totals.sheet = sourceSheet; }
      log.push({ sourceFile, sourceSheet, sourceRow: row.__rowNum__, level: 'info', message: `Skipped unlabelled total row (printed totals captured: Dr ${debit.toFixed(2)} / Cr ${credit.toFixed(2)})` });
      continue;
    }
    const txn = buildTxn({ sourceSide: side, sourceFile, sourceSheet, sourceRow: row.__rowNum__, date, voucherType, voucherNo, referenceNo, normalizedReferenceNo: normalizeReference(referenceNo || refs[0]), extractedReferences: refs, chequeNo: extractChequeNo([particulars, voucherNo, referenceNo]), particulars: [voucherNo, particulars].filter(Boolean).join(' | '), narration: [voucherNo, particulars].filter(Boolean).join(' | '), debit, credit, signedAmountRdcView: signedFromDebitCredit(side, debit, credit), amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '', parseConfidence: hasTruncatedReference([particulars, referenceNo]) ? 60 : 90, parserNotes: [], runningBalance: (() => { const cb = pick(row, ['CB','Running Bal','Closing Bal','Balance']); const s = cb instanceof Date ? '' : String(cb ?? '').trim(); return s ? parseAmount(s) : undefined; })() });
    if (bareBalance && !date) {
      balances.closing = txn.signedAmountRdcView;
      bareBalanceSeen = true;
      balances.closingRows?.push(txn);
      log.push({ sourceFile, sourceSheet, sourceRow: row.__rowNum__, level: 'info', message: `Closing balance ${Math.abs(txn.signedAmountRdcView).toFixed(2)} read from the ledger's "Balance" row`, confidence: 90 });
      continue;
    }
    if (voucherType === 'OPENING') { balances.opening = txn.signedAmountRdcView; balances.openingRows?.push(txn); continue; }
    if (voucherType === 'CLOSING') { balances.closing = txn.signedAmountRdcView; balances.closingRows?.push(txn); continue; }
    // An annexure repeats rows that already appear in the ledger sheet. Drop a
    // row only when the identical entry was read from a DIFFERENT sheet —
    // genuine repeats inside one sheet are kept.
    if (seenAcrossSheets) {
      const key = [date, txn.voucherNo, referenceNo, debit, credit].join('|');
      const firstSheet = seenAcrossSheets.get(key);
      if (firstSheet && firstSheet !== sourceSheet) continue;
      if (!firstSheet) seenAcrossSheets.set(key, sourceSheet);
    }
    out.push(txn);
  }
  // The "Balance" row is printed on whichever side squares the ledger, so its
  // Dr/Cr does not say which way the balance runs. Decide by arithmetic, and
  // only when the contra reading ties EXACTLY - otherwise an incomplete parse
  // would be hidden by flipping a sign instead of reported as a gap.
  if (bareBalanceSeen && balances.closing != null) {
    const running = out.slice(firstRowIndex).reduce((sum, t) => sum + t.signedAmountRdcView, balances.opening || 0);
    const asPrinted = Math.abs(running - balances.closing);
    const asContra = Math.abs(running + balances.closing);
    if (asContra <= 2 && asPrinted > 2) {
      log.push({ sourceFile, sourceSheet, level: 'info', message: `The "Balance" row was printed on the contra side; read as ${(-balances.closing).toFixed(2)} - the only sign that satisfies opening + rows = closing`, confidence: 90 });
      balances.closing = -balances.closing;
    }
  }
}
function parseCustomerRows(rows: Row[], sourceFile: string, sourceSheet: string, out: NormalizedTxn[], balances: ParseResult['balances'], log: ParserLogRow[]) {
  // One printed sheet can hold several ledger blocks back to back - the same
  // party at two sites, each starting with its own "Opening Balance" and
  // sharing one closing total at the end (Atlas: A/ANAND then KRUPA). The
  // second opening used to overwrite the first, losing 5,20,981.80 and leaving
  // the whole ledger unable to tie.
  let openingBlocks = 0;
  const addOpening = (value: number, sourceRow?: number) => {
    openingBlocks += 1;
    balances.opening = (openingBlocks > 1 ? (balances.opening || 0) : 0) + value;
    log.push({ sourceFile, sourceSheet, sourceRow, level: 'info', message: openingBlocks > 1
      ? `Captured a further opening balance (${value.toFixed(2)}) - this sheet holds ${openingBlocks} ledger blocks; openings summed to ${(balances.opening || 0).toFixed(2)}`
      : 'Captured customer opening balance separately', confidence: 90 });
  };
  let parent: Row | undefined;
  let parentBase: { voucherNo?: string; parentKey?: string; date?: string; vchType?: string; particulars?: string; rowText?: string; debit: number; credit: number } | undefined;
  let parentHadChildren = false;
  let parentDetailLines: string[] = [];
  const firstRowIndex = out.length;
  // Set when the closing balance came from a label row whose Dr/Cr side does
  // not say which way the balance runs. Resolved by proof after the loop.
  let ambiguousClosing = false;
  // Every cell of a row, for CLASSIFICATION and REFERENCE EXTRACTION only -
  // never for display. Exports put the bill number and the row's own
  // description in columns this reader has no name for: "DD" in DSR,
  // "INVOICE NO" in AGA, a second and third "Particulars" in Pressmatic.
  // Reading only the columns we recognise made all of them invisible, so 3,218
  // DSR rows and 504 AGA rows carried no reference at all.
  const rowText = (row: Row) => Object.entries(row)
    .filter(([k]) => !/^(debit|credit|dr\.?|cr\.?|amount)$/i.test(k.trim()))
    .map(([, v]) => (v instanceof Date ? '' : String(v ?? '').trim()))
    .filter(Boolean).join(' | ');
  const detailText = (row: Row) => [pick(row, ['Particulars','Narration','Bill wise Details']), (row as any).__EMPTY, (row as any).__EMPTY_1, (row as any).__EMPTY_2].filter(Boolean).map(String).join(' | ');
  const balanceAmount = (row: Row) => Math.max(...Object.values(row).map(absAmount));
  const balanceSign = (row: Row) => /by/i.test(String(pick(row, ['Particulars']) || Object.values(row)[1] || '')) ? -1 : 1;
  const baseWithDetails = () => parentBase ? { ...parentBase, particulars: [parentBase.particulars, ...parentDetailLines].filter(Boolean).join(' | ') } : undefined;
  const flushParent = () => {
    const base = baseWithDetails();
    if (parent && base && !parentHadChildren) addCustomerTxn(parent, base, '', base.debit, base.credit, '');
    // The pending voucher MUST be released here. Tally prints two or three
    // trailing rows (period totals, "Closing Balance", the grand total) and
    // each of them flushes; without clearing, the ledger's last dated row was
    // emitted once per trailing row. That double-count is invisible in the row
    // list and surfaces only as an integrity gap exactly equal to the last
    // transaction (Afita 21,31,400 / Ecoform 1,25,906 / ZCC 50,000).
    parent = undefined;
    parentBase = undefined;
    parentHadChildren = false;
    parentDetailLines = [];
  };
  const addCustomerTxn = (row: Row, base: NonNullable<typeof parentBase>, refText: string, debit: number, credit: number, allocationType: 'New Ref' | 'Agst Ref' | 'Inferred' | '') => {
    const particulars = [base.particulars, String(pick(row, ['Particulars','Narration','Bill wise Details']) ?? ''), refText].filter(Boolean).join(' | ');
    // Classification and reference hunting look at the WHOLE row (see rowText).
    const searchText = [particulars, refText, base.rowText].filter(Boolean).join(' | ');
    const refs = extractReferences([searchText, base.voucherNo]);
    // Fallback reference: strip any allocation amount / Dr-Cr tokens that were
    // joined onto the ref text (else "21MU25AR1253 53775 cr" fuses into one blob).
    const fallbackRef = refText
      .replace(/New Ref|Agst Ref/gi, '')
      .replace(/\s+\d[\d,]*(?:\.\d{1,2})?\s*(?:dr|cr)?\s*$/i, '')
      .replace(/\s+\d[\d,]*(?:\.\d{1,2})?\s*(?:dr|cr)?\s*$/i, '')
      .replace(/\s+(?:dr|cr)\s*$/i, '')
      .trim();
    // The counterparty's own bill number is a perfectly good match key even
    // when it is not shaped like an RDC reference - both ledgers print it
    // (GK: "GKE/23-24/328" on both sides, and not one row matched on it).
    const referenceNo = refs[0] || fallbackRef || documentRef(base.voucherNo || '') || documentRef(base.rowText || '');
    // On an allocation CHILD the reference names the document being settled,
    // not the kind of row this is: a payment applied against credit note
    // 22MU25ARMN35 is still part of that payment. When the parent voucher is
    // explicitly cash, the child inherits it and its reference is ignored for
    // typing - otherwise six of Talib's PYT/40616 allocations became credit
    // notes, the voucher totalled 16,41,933 instead of 19,68,719, and neither
    // side could match a cheque both ledgers had recorded.
    const isAllocationChild = allocationType === 'New Ref' || allocationType === 'Agst Ref';
    const parentIsCash = /payment|receipt|contra/i.test(base.vchType || '');
    const voucherType = isAllocationChild && parentIsCash
      ? classifyCustomer(base.vchType || '', [base.particulars, base.vchType].filter(Boolean).join(' | '), debit, credit, [])
      : classifyCustomer(base.vchType || '', searchText, debit, credit, refs);
    const notes: string[] = /journal|\bjv\b/i.test(base.vchType || '') ? ['SOURCE_VOUCHER_TYPE_JOURNAL'] : [];
    let confidence = refs.length ? 88 : 78;
    if (!refs.length && referenceNo) confidence = 84;
    if (hasTruncatedReference([particulars, refText])) { confidence = 55; notes.push('LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED'); }
    const txn = buildTxn({ sourceSide: 'CUSTOMER', sourceFile, sourceSheet, sourceRow: row.__rowNum__, date: base.date, voucherType, voucherNo: base.voucherNo, referenceNo, normalizedReferenceNo: normalizeReference(referenceNo), extractedReferences: refs, parentVoucherNo: allocationType ? (base.parentKey || base.voucherNo) : undefined, chequeNo: extractChequeNo([particulars, base.voucherNo]), allocationType, particulars, narration: particulars, debit, credit, signedAmountRdcView: signedFromDebitCredit('CUSTOMER', debit, credit), amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '', parseConfidence: confidence, parserNotes: notes });
    if (voucherType === 'OPENING') { addOpening(txn.signedAmountRdcView, row.__rowNum__); balances.openingRows?.push(txn); return; }
    if (voucherType === 'CLOSING') { balances.closing = txn.signedAmountRdcView; balances.closingRows?.push(txn); return; }
    // Zero-amount rows (informational sub-allocations) contribute nothing and
    // can wrongly consume a reference match — drop them.
    if (!txn.debit && !txn.credit) return;
    out.push(txn);
  };
  // Tally groups consecutive vouchers under one printed date: the second and
  // later vouchers of the same day leave the Date cell blank. See the
  // carry-forward branch near the bottom of this loop.
  let lastDate: string | undefined;
  for (const row of rows) {
    const date = parseDate(pick(row, ['Date']));
    const particulars = [pick(row, ['Particulars','Narration']), (row as any).__EMPTY, (row as any).__EMPTY_1].filter(Boolean).join(' | ');
    const vchType = String(pick(row, ['Vch Type','Voucher Type']) ?? '');
    const vchNo = String(pick(row, ['Vch No','Voucher No']) ?? '');
    const debit = absAmount(pick(row, ['Debit','Dr']));
    const credit = absAmount(pick(row, ['Credit','Cr']));
    const line = Object.values(row).join(' | ');
    // Balance rows are recognised BEFORE the dated-voucher branch, because
    // Tally prints them WITH a date and the label often sits in a column this
    // reader has no name for. Caught by the dated branch instead, Pressmatic's
    // opening balance became an ordinary "Other entry" of 12,61,263.97, the
    // ledger lost its opening entirely, and the statement led with a phantom
    // 14,84,245.13 opening difference.
    if (/open(ing)?\s*bal/i.test(line)) {
      flushParent();
      addOpening(balanceAmount(row) * balanceSign(row), row.__rowNum__);
      continue;
    }
    if (/clos(ing)?\s*bal/i.test(line)) {
      flushParent();
      balances.closing = balanceAmount(row) * balanceSign(row);
      ambiguousClosing = true;
      log.push({ sourceFile, sourceSheet, sourceRow: row.__rowNum__, level: 'info', message: 'Captured customer closing balance separately', confidence: 90 });
      continue;
    }
    if (date) {
      flushParent();
      lastDate = date;
      parent = row;
      parentHadChildren = false;
      // Not every Tally print numbers its vouchers. Without a key the payment's
      // allocation children cannot be grouped back into the cheque that RDC
      // received, so each fragment faced the receipt alone and none matched
      // (Honeybird: 245 allocations against 53 receipts, the same 92.9 lakh
      // reported as missing on both sides). The source row is a stable key.
      parentBase = { voucherNo: vchNo, parentKey: vchNo || `#row${row.__rowNum__}`, date, vchType, particulars, rowText: rowText(row), debit, credit };
      continue;
    }
    if (/total/i.test(line) && Object.values(row).some(v => absAmount(v) > 0)) {
      flushParent();
      log.push({ sourceFile, sourceSheet, sourceRow: row.__rowNum__, level: 'info', message: 'Skipped customer total row', confidence: 90 });
      continue;
    }
    if (parentBase && /New Ref|Agst Ref/i.test(line)) {
      const parentHadChildrenBefore = parentHadChildren;
      parentHadChildren = true;
      // Generic Tally allocation-row scan: cell positions vary by export, so
      // identify the reference, the Dr/Cr token and the amount by *shape*
      // rather than hard-coded column keys (fixes amounts missing on
      // Agst Ref rows, e.g. Talib).
      const cells = Object.values(row).map(v => String(v ?? '').trim()).filter(Boolean);
      // Accept both comma-grouped and PLAIN digit amounts (Tally often exports
      // "53690" without separators — previously this failed and the code fell
      // back to reading "30 Days" as 30).
      const MONEY_CELL = /^-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?$|^-?\d+(?:\.\d{1,2})?$/;
      const allocRef = cells.find(c => /^[0-9]{1,2}[A-Z]{2,4}\d{2}[A-Z0-9/-]{3,}$/i.test(c))
        || String((row as any).__EMPTY_1 || '');
      const signCell = cells.find(c => /^(dr|cr)$/i.test(c));
      const moneyCells = cells.filter(c => MONEY_CELL.test(c) && c !== allocRef);
      // No money cell on the child (e.g. TDS journal allocations)? Inherit the
      // parent voucher's amount for its first child — never fall back to text
      // like "30 Days" (absAmount would read it as 30).
      const parentAmount = !parentHadChildrenBefore ? (parentBase.debit || parentBase.credit || 0) : 0;
      const allocAmount = moneyCells.length ? absAmount(moneyCells[moneyCells.length - 1]) : parentAmount;
      const allocSign = (signCell || String((row as any)['Vch No.'] || (row as any)['Vch No'] || '')).toLowerCase();
      // Fall back to the parent's side when the child row omits Dr/Cr.
      const parentSide = parentBase.debit > 0 ? 'dr' : parentBase.credit > 0 ? 'cr' : '';
      const side = allocSign === 'dr' || allocSign === 'cr' ? allocSign : parentSide;
      const childDebit = debit || (side === 'dr' ? allocAmount : 0);
      const childCredit = credit || (side === 'cr' ? allocAmount : 0);
      const refLine = [String((row as any).__EMPTY || ''), allocRef, allocAmount ? String(allocAmount) : '', side].filter(Boolean).join(' ');
      addCustomerTxn(row, baseWithDetails() || parentBase, refLine, childDebit, childCredit, /New Ref/i.test(line) ? 'New Ref' : 'Agst Ref');
      continue;
    }
    // A dateless row carrying its OWN voucher number and amount is not a
    // sub-line of the row above - it is the next voucher of the same day,
    // printed with the date cell left blank. Treated as a detail line its
    // amount was silently dropped: Atlas lost 154 of 275 rows (43.5 lakh) and
    // the reconciliation blamed the hole on the customer. The voucher NUMBER is
    // the test, not the voucher type: Tally spills the type into the next
    // column on some rows, which left six more payments (9.66 lakh) behind.
    // Bill allocations are excluded by their markers and handled above;
    // opening/closing/total rows are consumed by the branches above this one.
    const isSameDayVoucher = !date && lastDate && (debit || credit) && vchNo.trim()
      && !/New Ref|Agst Ref|On Account|Advance/i.test(line)
      && vchNo.trim() !== (parentBase?.voucherNo || '').trim();
    if (isSameDayVoucher) {
      flushParent();
      parent = row;
      parentHadChildren = false;
      parentBase = { voucherNo: vchNo, parentKey: vchNo || `#row${row.__rowNum__}`, date: lastDate, vchType, particulars, rowText: rowText(row), debit, credit };
      continue;
    }
    if (parentBase) {
      const text = detailText(row);
      if (text) parentDetailLines.push(text);
    }
  }
  flushParent();
  // A "Closing Balance" row's Dr/Cr side is ambiguous: Tally squares the ledger
  // by printing the balance on the CONTRA side, so a debit balance appears in
  // the Credit column. Taken at face value GK's closing came out +1,67,49,392.76
  // instead of -1,67,49,392.76, and the ledger reported an integrity gap of
  // exactly twice that - 3.35 crore of "rows not captured" that were all there.
  // Decided by arithmetic, and only when the contra reading ties EXACTLY, so an
  // incomplete parse still surfaces as a gap instead of being papered over.
  if (ambiguousClosing && balances.closing != null) {
    const running = out.slice(firstRowIndex).reduce((sum, t) => sum + t.signedAmountRdcView, balances.opening || 0);
    const asPrinted = Math.abs(running - balances.closing);
    const asContra = Math.abs(running + balances.closing);
    if (asContra <= 2 && asPrinted > 2) {
      log.push({ sourceFile, sourceSheet, level: 'info', message: `Closing balance ${balances.closing.toFixed(2)} was printed on the contra side (Tally convention); read as ${(-balances.closing).toFixed(2)} - the only sign that satisfies opening + rows = closing`, confidence: 90 });
      balances.closing = -balances.closing;
    }
  }
  log.push({ sourceFile, sourceSheet, level: 'info', message: 'Parsed Tally/customer rows with parent-child allocation protection', confidence: 85 });
}
