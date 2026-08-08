import * as XLSX from 'xlsx';
import { v4 as uuid } from 'uuid';
import { parseAmount, signedFromDebitCredit } from '../amount';
import { parseDate } from '../date';
import { extractChequeNo, extractReferences, normalizeReference } from '../reference';
import type { NormalizedTxn, ParseResult, ParserLogRow, PrintedTotals, VoucherType } from '../types';

/**
 * ERP "Ledger Detail Summary" exports where ONE voucher is split across
 * several accounting-head rows (Senghani / Leela Business Park):
 *
 *   Business Unit | Date | Type | Document No | Particulars | Header Narration | ... | Debit | Credit
 *   Leela …  24-Apr-25  PBILL  LBPPBGRN/0002525-26  Purchase A/c        Party Inv. No.-7MU25BP1-1115   0    38,444
 *   Leela …  24-Apr-25  PBILL  LBPPBGRN/0002525-26  194 Q TDS on Goods  Party Inv. No.-7MU25BP1-1115  33         0
 *
 * Read row by row this produces two "transactions" per bill — which is why a
 * reconciliation came out with roughly twice the line items the accounts team
 * expected, and with no references at all (the supplier's invoice number lives
 * in Header Narration, not in any column).
 *
 * So: rows are grouped back into vouchers by document number, the party
 * invoice number is lifted out of the narration, and withholding-tax lines are
 * kept as their own TDS entries — matching how the team writes the recon
 * ("Tds Deducted By Senghani" is a line of its own).
 */

type Role = 'date' | 'type' | 'docNo' | 'particulars' | 'narration' | 'chequeNo' | 'chequeDate' | 'debit' | 'credit';
const ROLE_RE: Array<[Role, RegExp]> = [
  ['date', /^date$/i],
  ['type', /^type$|voucher type|doc\.?\s*type/i],
  ['docNo', /document\s*no|doc\.?\s*no|voucher\s*no/i],
  ['particulars', /particular|account head|ledger/i],
  ['narration', /narration|remarks|description/i],
  ['chequeNo', /cheque\s*no|instrument\s*no|utr/i],
  ['chequeDate', /cheque\s*date|instrument\s*date/i],
  ['debit', /^debit$|^dr\.?$|debit amount/i],
  ['credit', /^credit$|^cr\.?$|credit amount/i],
];

const PARTY_INVOICE = /Party\s*Inv\.?\s*(?:No)?\.?\s*[-:]?\s*([A-Z0-9][A-Z0-9/\-]{3,})/i;
const TDS_LINE = /\btds\b|194\s*q|194\s*c|withhold|tcs/i;

function mapHeader(cells: string[]) {
  const cols: Partial<Record<Role, number>> = {};
  cells.forEach((cell, i) => {
    const text = String(cell || '').trim();
    if (!text || text.length > 40) return;
    for (const [role, re] of ROLE_RE) {
      if (cols[role] == null && re.test(text)) { cols[role] = i; break; }
    }
  });
  return cols;
}

function voucherTypeFor(type: string, particulars: string, narration: string, side: 'RDC' | 'CUSTOMER'): VoucherType {
  const cash: VoucherType = side === 'RDC' ? 'RECEIPT' : 'PAYMENT';
  const t = `${type} ${particulars} ${narration}`.toLowerCase();
  const code = type.trim().toUpperCase();
  if (/^op$/.test(code) || /opening/.test(t)) return 'OPENING';
  if (TDS_LINE.test(particulars)) return 'TDS';
  if (/^(pbill|bill|inv|pi)$/.test(code) || /purchase|bill/.test(t)) return 'INVOICE';
  if (/^(rp|pymt|pay|rcpt|bp)$/.test(code) || /bank|cheque|neft|rtgs|payment/.test(t)) return cash;
  if (/^(pdn|dn)$/.test(code) || /debit note/.test(t)) return 'DEBIT_NOTE';
  if (/^(pcn|cn)$/.test(code) || /credit note/.test(t)) return 'CREDIT_NOTE';
  if (/^(jo|jv)$/.test(code) || /journal|write off/.test(t)) return 'JOURNAL_ADJUSTMENT';
  return 'OTHER';
}

/** Returns true when it recognised and consumed the workbook. */
export function parseSplitVoucherWorkbook(
  wb: XLSX.WorkBook, sourceFile: string, side: 'RDC' | 'CUSTOMER',
  out: NormalizedTxn[], balances: ParseResult['balances'], log: ParserLogRow[], totals?: PrintedTotals,
): boolean {
  let handled = false;
  for (const sheetName of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
    let cols: Partial<Record<Role, number>> | undefined;
    let headerIdx = -1;
    for (let i = 0; i < Math.min(matrix.length, 30); i++) {
      const candidate = mapHeader((matrix[i] as unknown[]).map(c => String(c ?? '')));
      // The signature of this layout: a document number, a narration column and
      // a Dr/Cr pair. Without the narration there is nothing to group on.
      if (candidate.docNo != null && candidate.debit != null && candidate.credit != null && candidate.narration != null && candidate.date != null) {
        cols = candidate; headerIdx = i; break;
      }
    }
    if (!cols || headerIdx < 0) continue;

    const cell = (row: unknown[], role: Role) => {
      if (cols![role] == null) return '';
      const v = row[cols![role]!];
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v ?? '').trim();
    };
    type Line = { row: unknown[]; index: number; debit: number; credit: number };
    const groups = new Map<string, Line[]>();
    const order: string[] = [];

    for (let i = headerIdx + 1; i < matrix.length; i++) {
      const row = matrix[i] as unknown[];
      const all = row.map(c => String(c ?? '')).join(' ').trim();
      if (!all) continue;
      const debit = Math.abs(parseAmount(cell(row, 'debit')));
      const credit = Math.abs(parseAmount(cell(row, 'credit')));
      const first = String(row[0] ?? '').trim();
      const particulars = cell(row, 'particulars');

      // "Total" line and the NET (closing balance) line the report prints.
      if (/^total$/i.test(first) || /^total$/i.test(particulars)) {
        if (totals && !totals.debit && !totals.credit) { totals.debit = debit; totals.credit = credit; totals.sheet = sheetName; }
        continue;
      }
      if (/^net$/i.test(particulars) || /^net$/i.test(first)) {
        balances.closing = signedFromDebitCredit(side, debit, credit);
        continue;
      }
      if (/opening/i.test(particulars)) {
        balances.opening = signedFromDebitCredit(side, debit, credit);
        continue;
      }
      if (!debit && !credit) continue;
      const key = cell(row, 'docNo') || `row-${i}`;
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key)!.push({ row, index: i, debit, credit });
    }
    if (!groups.size) continue;

    let vouchers = 0, taxLines = 0;
    for (const key of order) {
      const lines = groups.get(key)!;
      const head = lines[0].row;
      const date = parseDate(cell(head, 'date'));
      const type = cell(head, 'type');
      const narration = lines.map(l => cell(l.row, 'narration')).find(Boolean) || '';
      const partyRef = narration.match(PARTY_INVOICE)?.[1]?.trim() || '';
      const refs = extractReferences([narration, partyRef]);
      const referenceNo = partyRef || refs[0] || '';
      const docNo = cell(head, 'docNo');

      // Withholding-tax lines are their own entries — the counterparty deducted
      // them, RDC never invoiced them, and the recon reports them separately.
      const taxRows = lines.filter(l => TDS_LINE.test(cell(l.row, 'particulars')));
      const mainRows = lines.filter(l => !TDS_LINE.test(cell(l.row, 'particulars')));

      const push = (rows: Line[], forceType?: VoucherType, noteSuffix?: string) => {
        if (!rows.length) return;
        const debit = rows.reduce((s, l) => s + l.debit, 0);
        const credit = rows.reduce((s, l) => s + l.credit, 0);
        if (!debit && !credit) return;
        const particulars = rows.map(l => cell(l.row, 'particulars')).filter(Boolean).join(' + ');
        const voucherType = forceType || voucherTypeFor(type, particulars, narration, side);
        out.push({
          id: uuid(), sourceSide: side, sourceFile, sourceSheet: sheetName,
          sourceRow: rows.map(l => l.index + 1).join(','),
          date, voucherType, voucherNo: docNo, referenceNo,
          normalizedReferenceNo: normalizeReference(referenceNo),
          extractedReferences: refs.length ? refs : (referenceNo ? [referenceNo] : []),
          chequeNo: cell(head, 'chequeNo') || extractChequeNo([narration]),
          allocationType: 'Inferred',
          particulars: [type, particulars].filter(Boolean).join(' | ').slice(0, 200),
          narration: [type, docNo, narration].filter(Boolean).join(' | ').slice(0, 400),
          debit, credit,
          signedAmountRdcView: signedFromDebitCredit(side, debit, credit),
          amountOriginalSign: debit ? 'Dr' : 'Cr',
          parseConfidence: referenceNo ? 88 : 76,
          parserNotes: ['Split-voucher ledger adapter', ...(rows.length > 1 ? [`${rows.length} account lines combined`] : []), ...(noteSuffix ? [noteSuffix] : [])],
        });
      };
      push(mainRows);
      push(taxRows, 'TDS', 'Withholding tax deducted by the counterparty');
      vouchers += mainRows.length ? 1 : 0;
      taxLines += taxRows.length ? 1 : 0;
    }
    handled = true;
    log.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: `Split-voucher adapter: ${vouchers} vouchers rebuilt from ${matrix.length - headerIdx - 1} account lines (${taxLines} carried withholding tax, reported separately); invoice numbers read from the narration`, confidence: 88 });
    if (totals?.debit) log.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: `Printed totals captured for the parse audit: Dr ${totals.debit.toFixed(2)} / Cr ${(totals.credit ?? 0).toFixed(2)}`, confidence: 90 });
  }
  return handled;
}
