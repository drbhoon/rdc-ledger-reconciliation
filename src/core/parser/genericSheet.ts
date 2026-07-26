import * as XLSX from 'xlsx';
import { v4 as uuid } from 'uuid';
import { parseAmount, signedFromDebitCredit } from '../amount';
import { parseDate } from '../date';
import { extractChequeNo, extractReferences, normalizeReference } from '../reference';
import type { NormalizedTxn, ParseResult, ParserLogRow, VoucherType } from '../types';

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

type Role = 'date' | 'docType' | 'docNo' | 'reference' | 'narration' | 'debit' | 'credit' | 'balance' | 'signedAmount';

const ROLE_PATTERNS: Array<{ role: Role; re: RegExp; priority: number }> = [
  { role: 'date', re: /^date$/i, priority: 0 },
  { role: 'date', re: /gl date|posting date|voucher date|tran date/i, priority: 1 },
  { role: 'date', re: /(^|[^a-z])date/i, priority: 2 },
  { role: 'docType', re: /doc\.?\s*type|vch type|voucher type|^type$/i, priority: 0 },
  { role: 'docNo', re: /doc\.?\s*no|voucher no\.?$|vch no|document no/i, priority: 0 },
  { role: 'reference', re: /gst inv/i, priority: 0 },
  { role: 'reference', re: /(voucher\s*)?ref\.?\s*(no|number)|inv(oice)?\s*no|inv(oice)?\s*number|bill no|reference/i, priority: 1 },
  { role: 'narration', re: /particular|narration|description|remarks/i, priority: 0 },
  { role: 'debit', re: /^dr|debit|dr\.?\s*amt/i, priority: 0 },
  { role: 'credit', re: /^cr|credit|cr\.?\s*amt/i, priority: 0 },
  { role: 'balance', re: /running bal|balance|(^|\s)bal(\s|\.|$)/i, priority: 0 },
  // Columnar Tally registers carry ONE signed amount column instead of a
  // Dr/Cr pair (Suroj: "Gross Total", positive = purchase, negative = payment).
  { role: 'signedAmount', re: /gross total|net amount|^amount$|^amount\s*\(|voucher amount|^value$/i, priority: 0 },
];

function mapHeader(cells: string[]): Partial<Record<Role, number>> | undefined {
  const best: Partial<Record<Role, { col: number; priority: number }>> = {};
  cells.forEach((cell, col) => {
    const text = cell.trim();
    if (!text || text.length > 40) return;
    for (const { role, re, priority } of ROLE_PATTERNS) {
      if (!re.test(text)) continue;
      // due dates are never the posting date
      if (role === 'date' && /due/i.test(text)) continue;
      const cur = best[role];
      if (!cur || priority < cur.priority) best[role] = { col, priority };
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
  return out;
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
  if (/quick payment|payment|collection|receipt|neft|rtgs|fund trf|fund transfer/.test(t)) return cash;
  if (/credit note|credit memo/.test(t)) return 'CREDIT_NOTE';
  if (/debit note|debit memo|tcs/.test(t)) return 'DEBIT_NOTE';
  if (/round\s*off/.test(t)) return 'OTHER';
  if (/journal|\bjv\b/.test(t)) return 'JOURNAL_ADJUSTMENT';
  if (/purchase|material|inv|sale|bill/.test(t)) return 'INVOICE';
  return 'OTHER';
}

export function parseGenericWorkbook(wb: XLSX.WorkBook, sourceFile: string, side: 'RDC' | 'CUSTOMER', out: NormalizedTxn[], balances: ParseResult['balances'], log: ParserLogRow[]) {
  const seen = new Set<string>();
  // receivable-view sign of a displayed balance: a customer/vendor statement
  // shows its OWN view, which is the mirror of RDC's receivable view.
  const balSign = side === 'CUSTOMER' ? -1 : 1;
  let latestBalance: { date: string; value: number } | undefined;
  let parsedSheets = 0, duplicates = 0;

  for (const sheetName of wb.SheetNames) {
    // raw:true — see parseExcelFile: formatted text silently drops hidden paise.
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
    let cols: Partial<Record<Role, number>> | undefined;
    let headerIdx = -1;
    for (let i = 0; i < Math.min(matrix.length, 25); i++) {
      cols = mapHeader((matrix[i] as unknown[]).map(c => String(c ?? '')));
      if (cols) { headerIdx = i; break; }
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
        balances.opening = columnar ? gross : (balCell ? balSign * parseAmount(balCell) : 0);
        continue;
      }
      if (/clos(ing)?\s*bal/i.test(allText)) {
        const balCell = cell(row, 'balance');
        balances.closing = columnar ? gross : (balCell ? balSign * parseAmount(balCell) : signedFromDebitCredit(side, debit, credit));
        continue;
      }
      if (/grand total|total of|period total|\btotal\b/i.test(allText) && !date) continue;
      if (!debit && !credit) continue;
      // A columnar register's column total includes every money row, even one
      // with no date (Suroj had a stray −₹37). Dropping it would leave an
      // unexplainable integrity gap, so keep it and flag the missing date.
      if (!date && !columnar) continue;

      const docType = cell(row, 'docType');
      const narration = [cell(row, 'narration'), cell(row, 'docNo')].filter(Boolean).join(' | ');
      const reference = cell(row, 'reference');
      const voucherNo = cell(row, 'docNo') || reference;
      const key = [date, voucherNo, reference, debit, credit].join('|');
      if (seen.has(key)) { duplicates += 1; continue; }
      seen.add(key);
      const voucherType = classifyGeneric(side, docType, narration + ' ' + reference, debit, credit);
      const refs = extractReferences([reference, narration]);
      const referenceNo = reference || refs[0] || '';
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
      });
      const balCell = cell(row, 'balance');
      if (balCell && date && (!latestBalance || date >= latestBalance.date)) {
        latestBalance = { date, value: balSign * parseAmount(balCell) };
      }
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
