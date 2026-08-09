import * as XLSX from 'xlsx';
import { v4 as uuid } from 'uuid';
import { parseAmount, signedFromDebitCredit } from '../amount';
import { parseDate } from '../date';
import { extractChequeNo, extractReferences, normalizeReference } from '../reference';
import type { NormalizedTxn, ParseResult, ParserLogRow, VoucherType } from '../types';

/**
 * Customer-maintained INVOICE REGISTER (a spreadsheet the customer keeps by
 * hand rather than an ERP export). One row carries an invoice AND, when the
 * customer paid that day, the payment too — with a running balance:
 *
 *   PARTY | GST NO | GOODS | INVOICE NO. | DATE | BASIC | GST | … | TOTAL AMOUNT ‖ TRNFER/CQ | DATE | AMT PAID | BALANCE
 *   RDC … | 22AA…  | M25   | 1DU25ARS4   | 31-Mar-25 | 28,177.94 | … | 33,249.97 ‖ BANK | 01-Apr-25 | 2,61,250 | 1,89,999.79
 *
 * Two things break a generic reader here: the header is split over two rows
 * (the payment block is named on the row above), and a single row can hold two
 * different transactions on two different dates. Read as one row = one entry,
 * AFA's closing balance came out as −3,46,750.88 instead of 8,58,403.06.
 *
 * The running balance is carried through so the parse can be proved row by row.
 */

type Role = 'invoiceNo' | 'invoiceDate' | 'total' | 'mode' | 'payDate' | 'amtPaid' | 'balance' | 'goods' | 'tax';

/** Column names, gathered per column across the (possibly stacked) header rows. */
function headerNames(matrix: unknown[][], rows: number[]) {
  const names = new Map<number, string[]>();
  for (const r of rows) {
    const row = (matrix[r] || []) as unknown[];
    row.forEach((cell, c) => {
      const text = String(cell ?? '').trim();
      if (!text || text.length > 40) return;
      names.set(c, [...(names.get(c) || []), text]);
    });
  }
  return names;
}

function findRole(names: Map<number, string[]>, re: RegExp, skip: Set<number> = new Set()) {
  for (const [col, list] of names) {
    if (skip.has(col)) continue;
    if (list.some(n => re.test(n))) return col;
  }
  return undefined;
}

export function parseInvoiceRegisterWorkbook(
  wb: XLSX.WorkBook, sourceFile: string, side: 'RDC' | 'CUSTOMER',
  out: NormalizedTxn[], balances: ParseResult['balances'], log: ParserLogRow[],
): boolean {
  let handled = false;
  for (const sheetName of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: '', raw: true }) as unknown[][];
    if (matrix.length < 5) continue;

    let cols: Partial<Record<Role, number>> | undefined;
    let headerEnd = -1;
    for (let i = 0; i < Math.min(matrix.length, 8); i++) {
      const names = headerNames(matrix, [i, i + 1].filter(r => r < matrix.length));
      const invoiceNo = findRole(names, /^(invoice|inv|bill)\s*(no|number)\.?$/i);
      const total = findRole(names, /^total\s*(amount|amt)\.?$/i);
      // "BALANCE" only — never "OPENING BALANCE", which names a header cell.
      const balance = findRole(names, /^(closing\s*)?balance$/i);
      const amtPaid = findRole(names, /^(amt|amount)\s*paid$/i);
      if (invoiceNo == null || total == null || balance == null || amtPaid == null) continue;
      // The two DATE columns: the one after the invoice number is the invoice
      // date, the one beside AMT PAID is the payment date.
      const dateCols = [...names.entries()].filter(([, list]) => list.some(n => /^date$/i.test(n))).map(([c]) => c).sort((a, b) => a - b);
      const invoiceDate = dateCols.find(c => c > invoiceNo && c < total);
      const payDate = [...dateCols].reverse().find(c => c < amtPaid && c > total) ?? dateCols.find(c => c > total);
      cols = {
        invoiceNo, invoiceDate, total, amtPaid, balance, payDate,
        mode: findRole(names, /trnfer|transfer|cheque|^cq|mode|utr/i),
        goods: findRole(names, /nature of goods|goods|service|description/i),
        tax: findRole(names, /tds|tcs|freight/i),
      };
      headerEnd = i + 1;
      break;
    }
    if (!cols) continue;

    const value = (row: unknown[], role: Role) => {
      if (cols![role] == null) return '';
      const v = row[cols![role]!];
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v ?? '').trim();
    };

    // Opening balance: the header row that says "OPENING BALANCE" carries the
    // figure itself in the balance column.
    for (let i = 0; i <= headerEnd; i++) {
      const row = (matrix[i] || []) as unknown[];
      if (!row.some(c => /opening\s*balance/i.test(String(c ?? '')))) continue;
      const opening = parseAmount(value(row, 'balance'));
      if (Number.isFinite(opening) && opening !== 0) balances.opening = opening;
    }

    let invoices = 0, payments = 0, creditNotes = 0, lastBalance: number | undefined;
    for (let i = headerEnd + 1; i < matrix.length; i++) {
      const row = matrix[i] as unknown[];
      const all = row.map(c => String(c ?? '')).join(' ').trim();
      if (!all) continue;
      if (/^total\b/i.test(String(row[0] ?? '').trim())) continue;

      const emitted: NormalizedTxn[] = [];
      const push = (voucherType: VoucherType, amount: number, date: string | undefined, reference: string, narration: string, chequeNo?: string) => {
        // Only an invoice increases what the customer owes; payments and credit
        // notes reduce it.
        const debit = voucherType === 'INVOICE' ? 0 : amount;
        const credit = voucherType === 'INVOICE' ? amount : 0;
        const refs = extractReferences([reference, narration]);
        const txn: NormalizedTxn = {
          id: uuid(), sourceSide: side, sourceFile, sourceSheet: sheetName, sourceRow: i + 1,
          date, voucherType, voucherNo: reference, referenceNo: reference,
          normalizedReferenceNo: normalizeReference(reference),
          extractedReferences: refs.length ? refs : (reference ? [reference] : []),
          chequeNo: chequeNo || extractChequeNo([narration]),
          allocationType: 'Inferred',
          particulars: narration.slice(0, 200), narration: narration.slice(0, 400),
          debit, credit,
          signedAmountRdcView: signedFromDebitCredit(side, debit, credit),
          amountOriginalSign: debit ? 'Dr' : 'Cr',
          // A payment carries no invoice number by nature — that is not low
          // parse confidence, and must not be reported as an unreadable
          // reference.
          parseConfidence: reference ? 88 : 80,
          parserNotes: ['Customer invoice-register adapter'],
        };
        out.push(txn); emitted.push(txn);
      };

      // A NEGATIVE total is a credit note, not an invoice — it reduces what is
      // owed. Reading it as a positive invoice moves the balance the wrong way
      // by twice the amount (AFA: six notes, ₹1,53,374.87, showing up as a
      // ₹3,06,749.76 gap that the running-balance audit caught row by row).
      const total = parseAmount(value(row, 'total'));
      if (Math.abs(total) > 0.005) {
        const reference = value(row, 'invoiceNo');
        const narration = [value(row, 'goods'), reference].filter(Boolean).join(' | ');
        if (total > 0) { push('INVOICE', total, parseDate(value(row, 'invoiceDate')), reference, narration); invoices++; }
        else { push('CREDIT_NOTE', Math.abs(total), parseDate(value(row, 'invoiceDate')), reference, narration); creditNotes++; }
      }
      const paid = Math.abs(parseAmount(value(row, 'amtPaid')));
      if (paid > 0.005) {
        const mode = value(row, 'mode');
        push(side === 'RDC' ? 'RECEIPT' : 'PAYMENT', paid, parseDate(value(row, 'payDate')) ?? parseDate(value(row, 'invoiceDate')), '', ['Payment', mode].filter(Boolean).join(' | '), mode.replace(/[^0-9]/g, '') || undefined);
        payments++;
      }

      // The printed balance belongs to the row as a whole, so it is carried on
      // the last entry the row produced — the audit then compares it against
      // everything that row booked.
      const balanceText = value(row, 'balance');
      if (balanceText && emitted.length) {
        const balance = parseAmount(balanceText);
        if (Number.isFinite(balance)) {
          emitted[emitted.length - 1].runningBalance = balance;
          lastBalance = balance;
        }
      }
    }
    if (!invoices && !payments) continue;
    if (lastBalance != null) balances.closing = lastBalance;
    handled = true;
    log.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: `Customer invoice-register adapter: ${invoices} invoices, ${creditNotes} credit notes and ${payments} payments read (a row can carry both); closing balance ${lastBalance?.toFixed(2)} taken from the running-balance column`, confidence: 88 });
  }
  return handled;
}
