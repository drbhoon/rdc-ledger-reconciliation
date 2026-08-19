import * as XLSX from 'xlsx';
import { v4 as uuid } from 'uuid';
import { parseAmount, signedFromDebitCredit } from '../amount';
import { parseDate } from '../date';
import { extractChequeNo, extractReferences, normalizeReference } from '../reference';
import type { NormalizedTxn, ParseResult, ParserLogRow, VoucherType } from '../types';

/**
 * Tally "Columnar Ledger Account" export.
 *
 * This layout has NO Debit/Credit pair. Instead every ledger account that
 * appeared opposite the party gets its own money column, named after that
 * account, and each row puts its amount under whichever account it hit:
 *
 *   Date | Particulars | Voucher Type | Voucher Ref. No. | Voucher Ref. Date |
 *   PNB-RERA-30%-4166002900000064 | Total Invoice Amount | TDS-...-194Q
 *
 * so a purchase lands in "Total Invoice Amount", a payment in the bank column,
 * and the TDS withheld on that same purchase in the 194Q column — meaning ONE
 * source row can carry two entries. Every generic reader needs a Dr/Cr pair or
 * a single signed column, so this file previously read zero rows and was
 * reported to the accounts team as an unreadable scan (SPJ Properties).
 *
 * Direction comes from the Voucher Type, not from the column: a purchase
 * increases what the party owes RDC, everything else (payment, debit note,
 * TDS, journal) reduces it. That rule is not assumed — the adapter REFUSES its
 * own parse unless the signed rows reproduce the balance the file prints for
 * itself, so a layout whose columns mean something else is handed on to the
 * other adapters rather than silently mis-read.
 */

const IDENTITY = /date|particular|voucher type|vch type|voucher ref|narration|remark/i;
const TDS_COLUMN = /tds|194[a-z]|tax deducted/i;
const INVOICE_TYPE = /^(purchase|sales|sale|invoice|purc)/i;

function classify(vchType: string, column: string, side: 'RDC' | 'CUSTOMER'): VoucherType {
  const cash: VoucherType = side === 'RDC' ? 'RECEIPT' : 'PAYMENT';
  if (TDS_COLUMN.test(column)) return 'TDS';
  const t = vchType.trim().toLowerCase();
  if (INVOICE_TYPE.test(t)) return 'INVOICE';
  if (/credit note/.test(t)) return 'CREDIT_NOTE';
  if (/debit note/.test(t)) return 'DEBIT_NOTE';
  if (/payment|receipt|contra/.test(t)) return cash;
  if (/journal|\bjv\b/.test(t)) return 'JOURNAL_ADJUSTMENT';
  return 'OTHER';
}

/** Header row of a columnar ledger, or -1. */
function findHeader(matrix: unknown[][]) {
  for (let i = 0; i < Math.min(matrix.length, 25); i++) {
    const cells = (matrix[i] as unknown[]).map(c => String(c ?? '').trim());
    const hasDate = cells.some(c => /^date$/i.test(c));
    const hasType = cells.some(c => /voucher type|vch type/i.test(c));
    // A Dr/Cr pair means this is an ordinary ledger — not our layout.
    const hasDrCr = cells.some(c => /^(dr|debit)/i.test(c)) && cells.some(c => /^(cr|credit)/i.test(c));
    if (!hasDate || !hasType || hasDrCr) continue;
    const amountCols = cells
      .map((c, col) => ({ c, col }))
      .filter(({ c }) => c && !IDENTITY.test(c))
      .map(({ col }) => col);
    if (amountCols.length >= 2) return { headerIdx: i, cells, amountCols };
  }
  return undefined;
}

export function parseTallyColumnarWorkbook(
  wb: XLSX.WorkBook,
  sourceFile: string,
  side: 'RDC' | 'CUSTOMER',
  out: NormalizedTxn[],
  balances: ParseResult['balances'],
  log: ParserLogRow[],
): boolean {
  let parsedAny = false;
  for (const sheetName of wb.SheetNames) {
    // raw:true - see parseExcelFile: displayed text silently drops hidden paise.
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
    const header = findHeader(matrix as unknown[][]);
    if (!header) continue;
    const { headerIdx, cells, amountCols } = header;
    const col = (name: RegExp) => cells.findIndex(c => name.test(c));
    const dateCol = col(/^date$/i);
    const typeCol = col(/voucher type|vch type/i);
    const refCol = col(/voucher ref\.?\s*no|ref\.?\s*no/i);
    const partyCol = col(/particular|narration/i);

    const rows: NormalizedTxn[] = [];
    let stated: number | undefined;
    for (let i = headerIdx + 1; i < matrix.length; i++) {
      const row = matrix[i] as unknown[];
      const text = row.map(c => String(c ?? '')).join(' ');
      const cellAt = (c: number) => (c < 0 ? '' : (row[c] instanceof Date ? (row[c] as Date).toISOString().slice(0, 10) : String(row[c] ?? '').trim()));
      const amounts = amountCols.map(c => ({ column: cells[c], value: parseAmount(cellAt(c)) })).filter(a => a.value);
      // Tally closes the columnar print with a bare totals row and then the
      // balance (spelled "Blance" in some builds) - both carry no date.
      const date = parseDate(cellAt(dateCol));
      if (!date) {
        if (/bl?a?n?ce|balance/i.test(text) && amounts.length === 1) stated = amounts[0].value;
        continue;
      }
      if (!amounts.length) continue;
      const vchType = cellAt(typeCol);
      const reference = cellAt(refCol);
      const particulars = cellAt(partyCol);
      // One source row, one entry per money column: a purchase row carries the
      // invoice AND the TDS withheld on it, and RDC books those separately too.
      for (const { column, value } of amounts) {
        const voucherType = classify(vchType, column, side);
        // A purchase is the only thing that increases what the party owes RDC.
        const increasesReceivable = voucherType === 'INVOICE';
        const asCredit = side === 'CUSTOMER' ? increasesReceivable : !increasesReceivable;
        const debit = asCredit ? 0 : Math.abs(value);
        const credit = asCredit ? Math.abs(value) : 0;
        const refs = extractReferences([reference, particulars, column]);
        const referenceNo = reference || refs[0] || '';
        rows.push({
          id: uuid(), sourceSide: side, sourceFile, sourceSheet: sheetName, sourceRow: i + 1,
          date, voucherType, voucherNo: reference, referenceNo,
          normalizedReferenceNo: normalizeReference(referenceNo),
          extractedReferences: refs.length ? refs : (referenceNo ? [referenceNo] : []),
          chequeNo: extractChequeNo([particulars, column]),
          allocationType: 'Inferred',
          particulars: [vchType, particulars, column].filter(Boolean).join(' | ').slice(0, 200),
          narration: [vchType, particulars, column, reference].filter(Boolean).join(' | ').slice(0, 400),
          debit, credit,
          signedAmountRdcView: signedFromDebitCredit(side, debit, credit),
          amountOriginalSign: debit ? 'Dr' : 'Cr',
          parseConfidence: referenceNo ? 85 : 75,
          parserNotes: ['Tally columnar ledger adapter'],
        });
      }
    }
    if (!rows.length) continue;
    // Refuse rather than guess: the direction rule above must reproduce the
    // balance this file prints for itself.
    const sum = rows.reduce((s, t) => s + t.signedAmountRdcView, 0);
    const expected = side === 'CUSTOMER' ? stated : stated != null ? -stated : undefined;
    if (expected == null || Math.abs(sum - expected) > 2) {
      log.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: `Tally columnar adapter rejected: its ${rows.length} rows total ${sum.toFixed(2)}, which does not reproduce the printed balance (${stated == null ? 'none printed' : stated.toFixed(2)}); trying the other layouts`, confidence: 60 });
      continue;
    }
    out.push(...rows);
    balances.closing = expected;
    balances.opening = balances.opening ?? 0;
    parsedAny = true;
    log.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: `Tally columnar ledger adapter: ${rows.length} rows across ${amountCols.length} account columns (${amountCols.map(c => cells[c]).join(', ')}); rows reproduce the printed balance ${expected.toFixed(2)}`, confidence: 90 });
  }
  return parsedAny;
}
