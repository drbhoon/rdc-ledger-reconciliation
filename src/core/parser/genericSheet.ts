import * as XLSX from 'xlsx';
import { v4 as uuid } from 'uuid';
import { parseAmount, signedFromDebitCredit } from '../amount';
import { parseDate } from '../date';
import { extractChequeNo, extractReferences, normalizeReference } from '../reference';
import type { NormalizedTxn, ParseResult, ParserLogRow, PrintedTotals, VoucherType } from '../types';

/**
 * Generic spreadsheet adapter — the deterministic safety net that fires when
 * every known layout reads ZERO rows from a file. It makes no assumption
 * about where the header sits or what the columns are called:
 *
 *  1. hunts the header row anywhere in the first 25 rows of each sheet
 *     (needs a date-ish column plus debit+credit-ish columns);
 *  2. maps columns by fuzzy name (GL Date / Doc Type / Inv No. / Dr. Amt. /
 *     Running Bal ... ), preferring posting dates over due/invoice dates;
 *  3. skips non-ledger sheets (pivots/summaries have no qualifying header);
 *  4. de-duplicates identical rows ACROSS sheets — exports often contain the
 *     same ledger twice with overlapping periods (e.g. Dalmia's two
 *     "BIHAR_LEDGER FROM ..." sheets), which would double-count;
 *  5. classifies via an extended doc-type map covering AP/AR exports
 *     (INV/STANDARD, COLL/REC/Quick Payment, CREDIT/CM, DEBIT/DN, TDS, OTH);
 *  6. reads opening/closing from explicit rows, else derives closing from a
 *     running-balance column (SAP trailing-minus handled by parseAmount).
 *
 * Everything it emits is flagged and still judged by the integrity gate and
 * the certificate — generic extraction can rescue, never silently degrade.
 */

type Role = 'date' | 'docType' | 'docNo' | 'reference' | 'narration' | 'contra' | 'debit' | 'credit' | 'balance' | 'signedAmount';

const ROLE_PATTERNS: Array<{ role: Role; re: RegExp; priority: number }> = [
  { role: 'date', re: /^date$/i, priority: 0 },
  { role: 'date', re: /gl date|posting date|voucher date|tran date/i, priority: 1 },
  { role: 'date', re: /(^|[^a-z])date/i, priority: 2 },
  { role: 'docType', re: /doc\.?\s*type|vch type|voucher type|^type$/i, priority: 0 },
  { role: 'docNo', re: /doc(?:ument)?\.?\s*(?:no|num(?:ber)?)\b|voucher no\.?$|vch no/i, priority: 0 },
  { role: 'reference', re: /gst inv/i, priority: 0 },
  { role: 'reference', re: /(voucher\s*)?ref\.?\s*(no|number)|inv(oice)?\s*no|inv(oice)?\s*number|bill no|reference/i, priority: 1 },
  { role: 'narration', re: /particular|narration|description|remarks/i, priority: 0 },
  // The contra-account column names the OTHER side of the voucher ("Sales",
  // "NEFT-RDC CONCRETE") and is what says whether a row is a bill or a
  // payment. It is a column of its own, so it cannot share the narration slot.
  { role: 'contra', re: /^account$|account name|contra|against account|^head$/i, priority: 0 },
  { role: 'debit', re: /^dr|debit|dr\.?\s*amt/i, priority: 0 },
  { role: 'credit', re: /^cr|credit|cr\.?\s*amt/i, priority: 0 },
  { role: 'balance', re: /running bal|balance|(^|\s)bal(\s|\.|$)/i, priority: 0 },
  // Columnar Tally registers carry ONE signed amount column instead of a
  // Dr/Cr pair (Suroj: "Gross Total", positive = purchase, negative = payment).
  { role: 'signedAmount', re: /gross total|net amount|^amount$|^amount\s*\(|voucher amount|^value$/i, priority: 0 },
  // Last-resort date header: SAP/ERP statements abbreviate it ("Document Dt",
  // "Posting Dt"). Checked after every other role so it can never steal a
  // column with a more specific meaning; the /due/ guard still excludes
  // "Due Dt".
  { role: 'date', re: /\bd(?:ate|t)\.?$/i, priority: 3 },
  // A bare "Ref" column (Premix) is a reference column.
  { role: 'reference', re: /^ref\.?$/i, priority: 1 },
];

function mapHeader(cells: string[]): { cols: Partial<Record<Role, number>>; candidates: Partial<Record<Role, number[]>> } | undefined {
  const best: Partial<Record<Role, { col: number; priority: number }>> = {};
  // Exports repeat a header name across columns ("Document  No" appears twice
  // in UltraTech's statement: once for the account code, once for the invoice
  // number). Keep every candidate so the caller can pick the informative one.
  const candidates: Partial<Record<Role, number[]>> = {};
  cells.forEach((cell, col) => {
    const text = cell.trim();
    if (!text || text.length > 40) return;
    for (const { role, re, priority } of ROLE_PATTERNS) {
      if (!re.test(text)) continue;
      // due dates are never the posting date
      if (role === 'date' && /due/i.test(text)) continue;
      const cur = best[role];
      if (!cur || priority < cur.priority) best[role] = { col, priority };
      (candidates[role] ||= []).push(col);
      break;
    }
  });
  if (best.date == null) return undefined;
  const hasDrCr = best.debit != null && best.credit != null && best.debit.col !== best.credit.col;
  // Either a Dr/Cr pair OR a single signed-amount column qualifies as a ledger.
  if (!hasDrCr && best.signedAmount == null) return undefined;
  const out: Partial<Record<Role, number>> = {};
  for (const [role, v] of Object.entries(best)) out[role as Role] = (v as { col: number }).col;
  if (hasDrCr) delete out.signedAmount; else { delete out.debit; delete out.credit; }
  return { cols: out, candidates };
}

/**
 * Pick the informative column when a header name is repeated. A document-number
 * column holding the same value on every row is an account or branch code, not
 * a document number - the sibling column that actually varies is the one that
 * identifies the transaction (UltraTech: col 1 is "610926R101" on all 70 rows,
 * col 2 carries the invoice number RDC's own ledger prints).
 */
function preferVaryingColumn(matrix: unknown[][], headerIdx: number, candidates: number[] | undefined, current: number | undefined) {
  if (!candidates || candidates.length < 2) return current;
  let bestCol = current, bestDistinct = -1;
  for (const col of candidates) {
    const values = new Set<string>();
    for (let i = headerIdx + 1; i < Math.min(matrix.length, headerIdx + 200); i++) {
      const v = String((matrix[i] as unknown[])?.[col] ?? '').trim();
      if (v) values.add(v);
    }
    if (values.size > bestDistinct) { bestDistinct = values.size; bestCol = col; }
  }
  return bestCol;
}

function classifyGeneric(side: 'RDC' | 'CUSTOMER', docType: string, text: string, debit: number, credit: number): VoucherType {
  // In the engine's vocabulary the RDC-side cash row is RECEIPT and the
  // counterparty-side cash row is PAYMENT — regardless of who pays whom
  // (works for both receivable and payable reconciliations; signs align via
  // signedFromDebitCredit).
  const cash: VoucherType = side === 'RDC' ? 'RECEIPT' : 'PAYMENT';
  const d = docType.trim().toUpperCase();
  const MAP: Record<string, VoucherType> = {
    INV: 'INVOICE', INVOICE: 'INVOICE', STANDARD: 'INVOICE',
    REC: cash, COLL: cash, PAYMENT: cash, REV: cash,
    CM: 'CREDIT_NOTE', CN: 'CREDIT_NOTE', CREDIT: 'CREDIT_NOTE',
    DM: 'DEBIT_NOTE', DN: 'DEBIT_NOTE', DEBIT: 'DEBIT_NOTE',
    TDS: 'TDS', OTH: 'OTHER',
  };
  if (MAP[d]) return MAP[d];
  const t = (docType + ' ' + text).toLowerCase();
  if (/opening/.test(t)) return 'OPENING';
  if (/closing/.test(t)) return 'CLOSING';
  if (/tds|194q|194c|tax deducted/.test(t)) return 'TDS';
  if (/quick payment|payment|collection|receipt|\brcpt\b|\brcvd\b|neft|rtgs|imps|\bchq\b|cheque|fund trf|fund transfer/.test(t)) return cash;
  if (/credit note|credit memo/.test(t)) return 'CREDIT_NOTE';
  if (/debit note|debit memo|tcs/.test(t)) return 'DEBIT_NOTE';
  if (/round\s*off/.test(t)) return 'OTHER';
  if (/journal|\bjv\b/.test(t)) return 'JOURNAL_ADJUSTMENT';
  if (/purchase|material|\bpur\b|inv|sale|bill/.test(t)) return 'INVOICE';
  // Last resort, counterparty side only: in the customer's books of RDC a
  // credit is a bill and a debit is money paid. A ledger row with an amount is
  // a real transaction, and dumping it into "Other entries" tells the accounts
  // team nothing (Mosh: 834 rows worth ₹69 lakh landed there). RDC's own
  // exports are left alone — a debit there can be either, depending on whether
  // the file is a debtors or a creditors ledger.
  if (side === 'CUSTOMER') {
    if (credit > 0) return 'INVOICE';
    if (debit > 0) return cash;
  }
  return 'OTHER';
}

export function parseGenericWorkbook(wb: XLSX.WorkBook, sourceFile: string, side: 'RDC' | 'CUSTOMER', out: NormalizedTxn[], balances: ParseResult['balances'], log: ParserLogRow[], totals?: PrintedTotals, onlySheets?: Set<string>) {
  // Key -> the sheet it was first seen on. De-duplication is for workbooks that
  // repeat the same ledger across sheets; a row repeated WITHIN one sheet is a
  // real double posting and must survive — that is exactly the reconciling item
  // the accounts team is looking for (Mosh: invoice 1RA23ARS998 booked twice,
  // ₹22,148, which was being silently removed).
  const seen = new Map<string, string>();
  // receivable-view sign of a displayed balance: a customer/vendor statement
  // shows its OWN view, which is the mirror of RDC's receivable view.
  const balSign = side === 'CUSTOMER' ? -1 : 1;
  let latestBalance: { date: string; value: number } | undefined;
  let parsedSheets = 0, duplicates = 0;
  // Set when the closing balance came from a Dr/Cr closing row, whose side does
  // not say which way the balance runs (see the closing branch below).
  let ambiguousClosing = false;
  // Number of opening-balance rows seen, so per-site sections accumulate.
  let openingBlocks = 0;

  for (const sheetName of wb.SheetNames) {
    if (onlySheets && !onlySheets.has(sheetName)) continue;
    // raw:true — see parseExcelFile: formatted text silently drops hidden paise.
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
    let cols: Partial<Record<Role, number>> | undefined;
    let headerIdx = -1;
    for (let i = 0; i < Math.min(matrix.length, 25); i++) {
      const mapped = mapHeader((matrix[i] as unknown[]).map(c => String(c ?? '')));
      if (!mapped) continue;
      cols = mapped.cols;
      headerIdx = i;
      for (const role of ['docNo', 'reference'] as const) {
        const picked = preferVaryingColumn(matrix as unknown[][], i, mapped.candidates[role], cols[role]);
        if (picked != null) cols[role] = picked;
      }
      break;
    }
    if (!cols || headerIdx < 0) {
      log.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: 'Generic adapter: no ledger header found on this sheet; skipped (likely a summary/pivot sheet)', confidence: 80 });
      continue;
    }
    parsedSheets += 1;
    const columnar = cols.signedAmount != null;
    log.push({ sourceFile, sourceSheet: sheetName, level: 'warn', message: `Generic ${columnar ? 'columnar (single signed amount column) ' : ''}layout adapter engaged (header row ${headerIdx + 1}); columns: ${Object.entries(cols).map(([r, c]) => `${r}=${c}`).join(' ')} — review the certificate`, confidence: 75 });
    const cell = (row: unknown[], role: Role) => {
      if (cols![role] == null) return '';
      const v = row[cols![role]!];
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v ?? '').trim();
    };
    // Columnar registers print the column TOTAL — which IS the closing balance —
    // in a bare row ABOVE the header (Tally) or at the very bottom. Capture it
    // as the stated closing so the integrity gate has something to verify.
    if (columnar && balances.closing == null) {
      const totalRow = (idx: number) => {
        const row = matrix[idx] as unknown[] | undefined;
        if (!row) return undefined;
        const amt = parseAmount(cell(row, 'signedAmount'));
        if (!amt) return undefined;
        // A totals row carries numbers only — no date and none of the
        // descriptive fields (it may hold a total per column, so the count of
        // filled cells says nothing).
        const descriptive = (['date', 'docType', 'docNo', 'reference', 'narration'] as Role[]).some(r => cell(row, r));
        return descriptive ? undefined : amt;
      };
      const total = totalRow(headerIdx - 1) ?? totalRow(matrix.length - 1);
      if (total != null) {
        balances.closing = total;
        log.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: `Columnar register: closing balance ${total.toFixed(2)} taken from the amount-column total row`, confidence: 85 });
      }
    }

    for (let i = headerIdx + 1; i < matrix.length; i++) {
      const row = matrix[i] as unknown[];
      const allText = row.map(c => String(c ?? '')).join(' ');
      const date = parseDate(cell(row, 'date'));
      // Columnar: ONE signed column. Positive = the counterparty owes more to
      // the other side (purchase/invoice), negative = payment. Mapping it onto
      // debit/credit per side keeps signedFromDebitCredit() consistent, so the
      // signed amount equals the printed value on both sides.
      const gross = columnar ? parseAmount(cell(row, 'signedAmount')) : 0;
      const debit = columnar
        ? (side === 'RDC' ? Math.max(gross, 0) : Math.max(-gross, 0))
        : Math.abs(parseAmount(cell(row, 'debit')));
      const credit = columnar
        ? (side === 'RDC' ? Math.max(-gross, 0) : Math.max(gross, 0))
        : Math.abs(parseAmount(cell(row, 'credit')));
      // opening / closing / total rows (label can sit in any column)
      if (/open(ing)?\s*bal/i.test(allText)) {
        const balCell = cell(row, 'balance');
        // With no running-balance column the opening still sits in the Dr/Cr
        // pair - reading it as zero threw the figure away. RDC's creditor
        // export prints one "Site Opening Balance" per vendor site, so the
        // openings ADD UP: Shree Ram's two sites (51,74,407.46 + 26,425.99)
        // were both discarded, and the 52,00,833.45 hole was then reported as
        // an integrity gap against the vendor.
        const value = columnar ? gross : (balCell ? balSign * parseAmount(balCell) : signedFromDebitCredit(side, debit, credit));
        openingBlocks += 1;
        balances.opening = (openingBlocks > 1 ? (balances.opening || 0) : 0) + value;
        if (openingBlocks > 1) {
          log.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: `Opening balance ${value.toFixed(2)} added: this sheet holds ${openingBlocks} ledger blocks (per-site sections); openings summed to ${(balances.opening || 0).toFixed(2)}`, confidence: 85 });
        }
        continue;
      }
      if (/clos(ing)?\s*bal/i.test(allText)) {
        const balCell = cell(row, 'balance');
        // With no running-balance column the figure comes from the Dr/Cr pair,
        // and its side is genuinely ambiguous: an ERP export prints the balance
        // on its own side, while Tally squares the ledger by printing it on the
        // CONTRA side (a credit balance appears in the Debit column). Take it at
        // face value here and let the arithmetic decide below - guessing either
        // way inverts somebody's closing balance.
        balances.closing = columnar ? gross : (balCell ? balSign * parseAmount(balCell) : signedFromDebitCredit(side, debit, credit));
        if (!columnar && !balCell) ambiguousClosing = true;
        continue;
      }
      if (/grand total|total of|period total|\btotal\b/i.test(allText) && !date) {
        // Printed Dr/Cr totals are evidence for the parse audit.
        if (totals && !totals.debit && !totals.credit && !columnar && (debit || credit)) { totals.debit = debit; totals.credit = credit; totals.sheet = sheetName; }
        continue;
      }
      if (!debit && !credit) continue;
      // A columnar register's column total includes every money row, even one
      // with no date (Suroj had a stray −₹37). Dropping it would leave an
      // unexplainable integrity gap, so keep it and flag the missing date.
      if (!date && !columnar) continue;

      const docType = cell(row, 'docType');
      const docNo = cell(row, 'docNo');
      const contra = cell(row, 'contra');
      const narration = [cell(row, 'narration'), contra, docNo].filter(Boolean).join(' | ');
      const reference = cell(row, 'reference');
      const voucherNo = docNo || reference;
      const key = [date, voucherNo, reference, debit, credit].join('|');
      const firstSheet = seen.get(key);
      if (firstSheet && firstSheet !== sheetName) { duplicates += 1; continue; }
      if (!firstSheet) seen.set(key, sheetName);
      const voucherType = classifyGeneric(side, docType, narration + ' ' + reference, debit, credit);
      const refs = extractReferences([reference, narration]);
      // extractReferences only knows RDC's OWN invoice shapes. In an AP/AR
      // statement with no reference column the "Document No." IS the matching
      // key, and it is printed identically on both sides (PAMR:
      // "PAMR/N/2526/0176" on both ledgers, yet zero rows matched because
      // referenceNo stayed empty). A Tally voucher serial ("555") is not a
      // document number, so require something identifier-shaped.
      const docNoIsIdentifier = /[A-Za-z]/.test(docNo) || /^\d{6,}$/.test(docNo.replace(/[\s,]/g, ''));
      const referenceNo = reference || refs[0] || (docNoIsIdentifier ? docNo : '');
      out.push({
        id: uuid(), sourceSide: side, sourceFile, sourceSheet: sheetName, sourceRow: i + 1,
        date, voucherType, voucherNo, referenceNo,
        normalizedReferenceNo: normalizeReference(referenceNo),
        extractedReferences: refs.length ? refs : (referenceNo ? [referenceNo] : []),
        chequeNo: extractChequeNo([narration, voucherNo]),
        allocationType: 'Inferred',
        particulars: [docType, narration].filter(Boolean).join(' | ').slice(0, 200),
        narration: [docType, narration, reference].filter(Boolean).join(' | ').slice(0, 400),
        debit, credit,
        signedAmountRdcView: signedFromDebitCredit(side, debit, credit),
        amountOriginalSign: debit ? 'Dr' : 'Cr',
        parseConfidence: referenceNo ? 85 : 78,
        parserNotes: ['Generic layout adapter', ...(date ? [] : ['Source row has no date'])],
        runningBalance: cell(row, 'balance') ? balSign * parseAmount(cell(row, 'balance')) : undefined,
      });
      const balCell = cell(row, 'balance');
      if (balCell && date && (!latestBalance || date >= latestBalance.date)) {
        latestBalance = { date, value: balSign * parseAmount(balCell) };
      }
    }
  }
  // Resolve an ambiguous closing-balance side by proof rather than by
  // convention: whichever sign satisfies opening + rows = closing is the one
  // the ledger actually means. Only flip when the contra reading TIES exactly -
  // a ledger we failed to parse fully must surface as an integrity gap, never
  // be papered over by inverting its closing balance.
  if (ambiguousClosing && balances.closing != null) {
    const running = out.reduce((sum, t) => sum + t.signedAmountRdcView, balances.opening || 0);
    const asPrinted = Math.abs(running - balances.closing);
    const asContra = Math.abs(running + balances.closing);
    if (asContra <= 2 && asPrinted > 2) {
      log.push({ sourceFile, level: 'info', message: `Closing balance ${balances.closing.toFixed(2)} was printed on the contra side (Tally convention); read as ${(-balances.closing).toFixed(2)} - the only sign that satisfies opening + rows = closing`, confidence: 90 });
      balances.closing = -balances.closing;
    }
  }
  // No explicit closing row? A running-balance column gives the closing as of
  // the last dated row.
  if (balances.closing == null && latestBalance) {
    balances.closing = latestBalance.value;
    log.push({ sourceFile, level: 'info', message: `Generic adapter: closing balance ${latestBalance.value.toFixed(2)} taken from running-balance column as of ${latestBalance.date}`, confidence: 75 });
  }
  if (parsedSheets && duplicates) {
    log.push({ sourceFile, level: 'warn', message: `Generic adapter: ${duplicates} duplicate rows across sheets removed (overlapping period exports)`, confidence: 80 });
  }
}
