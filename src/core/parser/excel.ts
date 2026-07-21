import * as XLSX from 'xlsx';
import fs from 'fs';
import { v4 as uuid } from 'uuid';
import { absAmount, signedFromDebitCredit } from '../amount';
import { parseDate } from '../date';
import { extractChequeNo, extractReferences, hasTruncatedReference, normalizeReference } from '../reference';
import type { NormalizedTxn, ParseResult, ParserLogRow, VoucherType } from '../types';

type Row = Record<string, unknown> & { __rowNum__: number };
function headerRowIndex(ws: XLSX.WorkSheet) {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false });
  const idx = matrix.findIndex((row) => {
    const text = row.map((c) => String(c).toLowerCase()).join('|');
    return text.includes('date') && (text.includes('doc type') || text.includes('vch type') || text.includes('particulars') || text.includes('gst inv'));
  });
  return idx >= 0 ? idx : 0;
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
  if (/purchase|local purchases/.test(t) || (refs.length && credit > 0)) return 'INVOICE';
  if (/bank payment|payment|receipt/.test(t) || debit > 0) return 'PAYMENT';
  if (/debit note|arcm/.test(t)) return 'DEBIT_NOTE';
  if (/credit note|armn|\bcn\b/.test(t)) return 'CREDIT_NOTE';
  return 'OTHER';
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
  const sourceFile = filePath.split(/[\\/]/).pop() || filePath;
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Row>(ws, { defval: '', raw: false, range: headerRowIndex(ws) });
    if (!rows.length) continue;
    const kind = sourceSideHint === 'RDC' ? 'RDC' : sourceSideHint === 'CUSTOMER' ? detect(rows) : detect(rows);
    const side = sourceSideHint === 'CUSTOMER' ? 'CUSTOMER' : 'RDC';
    parserLog.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: 'Detected ' + kind + ' ledger layout' + (kind === 'RDC' && side === 'CUSTOMER' ? ' (customer vendor-ledger mirror: bills=Cr, payments=Dr)' : ''), confidence: 90 });
    if (kind === 'RDC') parseRdcRows(rows, sourceFile, sheetName, transactions, balances, parserLog, side);
    else parseCustomerRows(rows, sourceFile, sheetName, transactions, balances, parserLog);
  }
  return { transactions, balances, parserLog };
}
function parseRdcRows(rows: Row[], sourceFile: string, sourceSheet: string, out: NormalizedTxn[], balances: ParseResult['balances'], log: ParserLogRow[], side: 'RDC' | 'CUSTOMER' = 'RDC') {
  for (const row of rows) {
    const docType = String(pick(row, ['Doc Type','Voucher Type']) ?? '');
    const voucherNo = String(pick(row, ['Inv / Receipt Number','Voucher No']) ?? '');
    const particulars = [pick(row, ['Narration','Particular','Customer Name','Plant Name','Transaction Type']), Object.values(row).find(v => /Opening Balance|Closing Balance/i.test(String(v)))].filter(Boolean).join(' | ');
    const date = parseDate(pick(row, ['Inv/ Receipt Date','Date','Voucher Date']));
    const debit = absAmount(pick(row, ['Tran Dr Amt','Debit','Dr']));
    const credit = absAmount(pick(row, ['Tran Cr Amt','Credit','Cr']));
    if (!date && !debit && !credit && !particulars && !docType) continue;
    const refs = extractReferences([particulars, String(pick(row, ['GST Inv Number','Inv / Receipt Number','Bill No','Reference']) ?? '')]);
    const referenceNo = String(pick(row, ['GST Inv Number','Bill No','Reference','Inv / Receipt Number']) ?? refs[0] ?? '').trim();
    // A customer's vendor ledger in this same layout is the MIRROR of RDC's
    // export: bills sit in the credit column, payments in the debit column,
    // and the row label ("Bill Booked" / "Payment Made ...") lives in the
    // Inv / Receipt Number column.
    const voucherType = side === 'RDC'
      ? classifyRdc(docType, particulars + ' ' + referenceNo, debit, credit)
      : classifyVendorMirror(docType, [voucherNo, particulars, referenceNo].join(' '), debit, credit);
    // Summary rows: the label often sits in an unmapped column (e.g. "Grand
    // Total" under Document Seq Number), so scan EVERY cell — a missed total
    // row double-counts the entire ledger.
    const allCells = Object.values(row).map(v => String(v ?? '')).join(' ');
    if (/grand total|total of debits|period total|\btotal\b/i.test(allCells) && (debit || credit) && !date) {
      log.push({ sourceFile, sourceSheet, sourceRow: row.__rowNum__, level: 'info', message: 'Skipped total row' });
      continue;
    }
    const txn = buildTxn({ sourceSide: side, sourceFile, sourceSheet, sourceRow: row.__rowNum__, date, voucherType, voucherNo, referenceNo, normalizedReferenceNo: normalizeReference(referenceNo || refs[0]), extractedReferences: refs, chequeNo: extractChequeNo([particulars, voucherNo, referenceNo]), particulars: [voucherNo, particulars].filter(Boolean).join(' | '), narration: [voucherNo, particulars].filter(Boolean).join(' | '), debit, credit, signedAmountRdcView: signedFromDebitCredit(side, debit, credit), amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '', parseConfidence: hasTruncatedReference([particulars, referenceNo]) ? 60 : 90, parserNotes: [] });
    if (voucherType === 'OPENING') { balances.opening = txn.signedAmountRdcView; balances.openingRows?.push(txn); continue; }
    if (voucherType === 'CLOSING') { balances.closing = txn.signedAmountRdcView; balances.closingRows?.push(txn); continue; }
    out.push(txn);
  }
}
function parseCustomerRows(rows: Row[], sourceFile: string, sourceSheet: string, out: NormalizedTxn[], balances: ParseResult['balances'], log: ParserLogRow[]) {
  let parent: Row | undefined;
  let parentBase: { voucherNo?: string; date?: string; vchType?: string; particulars?: string; debit: number; credit: number } | undefined;
  let parentHadChildren = false;
  let parentDetailLines: string[] = [];
  const detailText = (row: Row) => [pick(row, ['Particulars','Narration','Bill wise Details']), (row as any).__EMPTY, (row as any).__EMPTY_1, (row as any).__EMPTY_2].filter(Boolean).map(String).join(' | ');
  const balanceAmount = (row: Row) => Math.max(...Object.values(row).map(absAmount));
  const balanceSign = (row: Row) => /by/i.test(String(pick(row, ['Particulars']) || Object.values(row)[1] || '')) ? -1 : 1;
  const baseWithDetails = () => parentBase ? { ...parentBase, particulars: [parentBase.particulars, ...parentDetailLines].filter(Boolean).join(' | ') } : undefined;
  const flushParent = () => {
    const base = baseWithDetails();
    if (parent && base && !parentHadChildren) addCustomerTxn(parent, base, '', base.debit, base.credit, '');
    parentDetailLines = [];
  };
  const addCustomerTxn = (row: Row, base: NonNullable<typeof parentBase>, refText: string, debit: number, credit: number, allocationType: 'New Ref' | 'Agst Ref' | 'Inferred' | '') => {
    const particulars = [base.particulars, String(pick(row, ['Particulars','Narration','Bill wise Details']) ?? ''), refText].filter(Boolean).join(' | ');
    const refs = extractReferences([particulars, refText, base.voucherNo]);
    // Fallback reference: strip any allocation amount / Dr-Cr tokens that were
    // joined onto the ref text (else "21MU25AR1253 53775 cr" fuses into one blob).
    const fallbackRef = refText
      .replace(/New Ref|Agst Ref/gi, '')
      .replace(/\s+\d[\d,]*(?:\.\d{1,2})?\s*(?:dr|cr)?\s*$/i, '')
      .replace(/\s+\d[\d,]*(?:\.\d{1,2})?\s*(?:dr|cr)?\s*$/i, '')
      .replace(/\s+(?:dr|cr)\s*$/i, '')
      .trim();
    const referenceNo = refs[0] || fallbackRef;
    const voucherType = classifyCustomer(base.vchType || '', particulars, debit, credit, refs);
    const notes: string[] = /journal|\bjv\b/i.test(base.vchType || '') ? ['SOURCE_VOUCHER_TYPE_JOURNAL'] : [];
    let confidence = refs.length ? 88 : 78;
    if (hasTruncatedReference([particulars, refText])) { confidence = 55; notes.push('LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED'); }
    const txn = buildTxn({ sourceSide: 'CUSTOMER', sourceFile, sourceSheet, sourceRow: row.__rowNum__, date: base.date, voucherType, voucherNo: base.voucherNo, referenceNo, normalizedReferenceNo: normalizeReference(referenceNo), extractedReferences: refs, parentVoucherNo: allocationType ? base.voucherNo : undefined, chequeNo: extractChequeNo([particulars, base.voucherNo]), allocationType, particulars, narration: particulars, debit, credit, signedAmountRdcView: signedFromDebitCredit('CUSTOMER', debit, credit), amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '', parseConfidence: confidence, parserNotes: notes });
    if (voucherType === 'OPENING') { balances.opening = txn.signedAmountRdcView; balances.openingRows?.push(txn); return; }
    if (voucherType === 'CLOSING') { balances.closing = txn.signedAmountRdcView; balances.closingRows?.push(txn); return; }
    // Zero-amount rows (informational sub-allocations) contribute nothing and
    // can wrongly consume a reference match — drop them.
    if (!txn.debit && !txn.credit) return;
    out.push(txn);
  };
  for (const row of rows) {
    const date = parseDate(pick(row, ['Date']));
    const particulars = [pick(row, ['Particulars','Narration']), (row as any).__EMPTY, (row as any).__EMPTY_1].filter(Boolean).join(' | ');
    const vchType = String(pick(row, ['Vch Type','Voucher Type']) ?? '');
    const vchNo = String(pick(row, ['Vch No','Voucher No']) ?? '');
    const debit = absAmount(pick(row, ['Debit','Dr']));
    const credit = absAmount(pick(row, ['Credit','Cr']));
    if (date) {
      flushParent();
      parent = row;
      parentHadChildren = false;
      parentBase = { voucherNo: vchNo, date, vchType, particulars, debit, credit };
      continue;
    }
    const line = Object.values(row).join(' | ');
    if (/opening balance/i.test(line)) {
      flushParent();
      balances.opening = balanceAmount(row) * balanceSign(row);
      log.push({ sourceFile, sourceSheet, sourceRow: row.__rowNum__, level: 'info', message: 'Captured customer opening balance separately', confidence: 90 });
      continue;
    }
    if (/closing balance/i.test(line)) {
      flushParent();
      balances.closing = balanceAmount(row) * balanceSign(row);
      log.push({ sourceFile, sourceSheet, sourceRow: row.__rowNum__, level: 'info', message: 'Captured customer closing balance separately', confidence: 90 });
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
    if (parentBase) {
      const text = detailText(row);
      if (text) parentDetailLines.push(text);
    }
  }
  flushParent();
  log.push({ sourceFile, sourceSheet, level: 'info', message: 'Parsed Tally/customer rows with parent-child allocation protection', confidence: 85 });
}
