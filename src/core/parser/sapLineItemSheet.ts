import * as XLSX from 'xlsx';
import { v4 as uuid } from 'uuid';
import { parseAmount, signedFromDebitCredit } from '../amount';
import { parseDate } from '../date';
import { extractChequeNo, extractReferences, normalizeReference } from '../reference';
import type { NormalizedTxn, ParseResult, ParserLogRow, VoucherType } from '../types';

/**
 * SAP vendor/customer line-item report (FBL1N / FBL5N and their exports).
 *
 *   DocumentNo | Type | Doc. Date | S | DD | Amount in local cur. | LCurr |
 *   Clrng doc. | Text | Reference | Amount in local cur.
 *
 * Three things defeat every other reader here. There is no debit/credit pair —
 * one signed amount column carries both, negative meaning a credit. The amount
 * column name is repeated at the end of the row. And the row's nature is a
 * two-letter SAP document type (RE invoice, ZP/KZ payment, KJ/KF/KU clearing
 * and tax adjustments), not a word any classifier would recognise.
 *
 * The RDC invoice number sits in the Reference column, which is what makes
 * these statements worth reading properly: matching is exact once parsed.
 *
 * Sundew's file read as ZERO rows and the accounts team was told their
 * spreadsheet was a scan.
 */

const SAP_TYPES: Record<string, VoucherType> = {
  RE: 'INVOICE', RN: 'INVOICE', KR: 'INVOICE', RV: 'INVOICE',
  ZP: 'PAYMENT', KZ: 'PAYMENT', DZ: 'PAYMENT', ZR: 'PAYMENT',
  KG: 'CREDIT_NOTE', RA: 'CREDIT_NOTE',
  DG: 'DEBIT_NOTE', DR: 'DEBIT_NOTE',
  KJ: 'TDS', KF: 'TDS', KU: 'JOURNAL_ADJUSTMENT', SA: 'JOURNAL_ADJUSTMENT', AB: 'JOURNAL_ADJUSTMENT',
};

const AMOUNT_HEADER = /amount in (local|doc(ument)?) cur|amount in lc|\blc amount\b|amount \(local/i;
const DOC_HEADER = /^document\s*no\.?$|^doc(ument)?\.?\s*no\.?$/i;
const TYPE_HEADER = /^type$|document type|doc\.?\s*type/i;
const DATE_HEADER = /doc(ument)?\.?\s*date|posting date|pstng date|net due|^date$/i;
const REF_HEADER = /^reference$|ref\.?\s*(no|number)?$|assignment/i;
const TEXT_HEADER = /^text$|narration|description/i;

function findHeader(matrix: unknown[][]) {
  for (let i = 0; i < Math.min(matrix.length, 25); i++) {
    const cells = (matrix[i] as unknown[]).map(c => String(c ?? '').trim());
    const amountCols = cells.map((c, col) => ({ c, col })).filter(({ c }) => AMOUNT_HEADER.test(c)).map(({ col }) => col);
    const typeCol = cells.findIndex(c => TYPE_HEADER.test(c));
    const docCol = cells.findIndex(c => DOC_HEADER.test(c));
    // A Dr/Cr pair means an ordinary ledger; leave it to the other readers.
    const hasDrCr = cells.some(c => /^(dr|debit)/i.test(c)) && cells.some(c => /^(cr|credit)/i.test(c));
    if (!amountCols.length || typeCol < 0 || docCol < 0 || hasDrCr) continue;
    return {
      headerIdx: i,
      amountCol: amountCols[0],
      typeCol, docCol,
      dateCol: cells.findIndex(c => DATE_HEADER.test(c)),
      refCol: cells.findIndex(c => REF_HEADER.test(c)),
      textCol: cells.findIndex(c => TEXT_HEADER.test(c)),
    };
  }
  return undefined;
}

export function parseSapLineItemWorkbook(
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
    const h = findHeader(matrix as unknown[][]);
    if (!h) continue;

    const rows: NormalizedTxn[] = [];
    let stated: number | undefined;
    const cellAt = (row: unknown[], c: number) => (c < 0 ? '' : (row[c] instanceof Date ? (row[c] as Date).toISOString().slice(0, 10) : String(row[c] ?? '').trim()));

    for (let i = h.headerIdx + 1; i < matrix.length; i++) {
      const row = matrix[i] as unknown[];
      const amount = parseAmount(cellAt(row, h.amountCol));
      if (!amount) continue;
      const docNo = cellAt(row, h.docCol);
      const type = cellAt(row, h.typeCol).toUpperCase();
      // A trailing row with an amount but no document number is the report's
      // own total - the balance the statement claims for itself.
      if (!docNo && !type) { stated = amount; continue; }

      const reference = cellAt(row, h.refCol);
      const text = cellAt(row, h.textCol);
      const date = parseDate(cellAt(row, h.dateCol));
      // Positive is a debit in the printer's own books; negative a credit.
      // signedFromDebitCredit then puts it into RDC's view for this side.
      const debit = Math.max(amount, 0);
      const credit = Math.max(-amount, 0);
      const voucherType: VoucherType = SAP_TYPES[type]
        || (/tds|194/i.test(text) ? 'TDS' : credit > 0 ? (side === 'RDC' ? 'INVOICE' : 'INVOICE') : (side === 'RDC' ? 'RECEIPT' : 'PAYMENT'));
      const refs = extractReferences([reference, text]);
      const referenceNo = reference || refs[0] || '';
      rows.push({
        id: uuid(), sourceSide: side, sourceFile, sourceSheet: sheetName, sourceRow: i + 1,
        date, voucherType, voucherNo: docNo, referenceNo,
        normalizedReferenceNo: normalizeReference(referenceNo),
        extractedReferences: Array.from(new Set([...refs, ...(referenceNo ? [normalizeReference(referenceNo)] : [])])).filter(Boolean),
        chequeNo: extractChequeNo([text, docNo]),
        allocationType: 'Inferred',
        particulars: [type, text].filter(Boolean).join(' | ').slice(0, 200),
        narration: [type, text, reference, docNo].filter(Boolean).join(' | ').slice(0, 400),
        debit, credit,
        signedAmountRdcView: signedFromDebitCredit(side, debit, credit),
        amountOriginalSign: debit ? 'Dr' : 'Cr',
        parseConfidence: referenceNo ? 86 : 74,
        parserNotes: ['SAP line-item statement adapter'],
      });
    }
    if (!rows.length) continue;

    out.push(...rows);
    parsedAny = true;
    const sum = rows.reduce((s, t) => s + t.signedAmountRdcView, 0);
    if (stated != null) {
      // The report totals its own amount column; that total IS the balance.
      balances.closing = signedFromDebitCredit(side, Math.max(stated, 0), Math.max(-stated, 0));
      balances.opening = balances.opening ?? 0;
      const gap = Math.abs(sum - balances.closing);
      log.push({ sourceFile, sourceSheet: sheetName, level: gap <= 2 ? 'info' : 'warn', message: `SAP line-item statement: ${rows.length} rows read; the report's own total ${stated.toFixed(2)} ${gap <= 2 ? 'is reproduced exactly by those rows' : `differs from them by ${gap.toFixed(2)} — review the certificate`}`, confidence: gap <= 2 ? 90 : 65 });
    } else {
      log.push({ sourceFile, sourceSheet: sheetName, level: 'warn', message: `SAP line-item statement: ${rows.length} rows read, but the report prints no total to verify them against`, confidence: 70 });
    }
  }
  return parsedAny;
}
