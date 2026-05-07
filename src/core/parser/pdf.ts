import fs from 'fs';
import pdf from 'pdf-parse';
import { v4 as uuid } from 'uuid';
import { absAmount, parseAmount, signedFromDebitCredit } from '../amount';
import { parseDate } from '../date';
import { extractChequeNo, extractReferences, hasTruncatedReference, normalizeReference } from '../reference';
import type { NormalizedTxn, ParseResult, VoucherType } from '../types';

const START_DATE = /^\d{1,2} [A-Za-z]{3} \d{4}$/;
const VOUCHER_TYPES = /^(BP|PV|JV|DN|CN|BR|0)$/i;
const MONEY = /^-?\d+(?:,\d{2,3})*(?:\.\d{2})(?:\s*(?:Dr|Cr))?$/i;

function classify(voucherTypeText: string, chunkText: string, debit: number, credit: number, refs: string[]): VoucherType {
  const v = voucherTypeText.toUpperCase();
  const t = chunkText.toLowerCase();
  if (/opening/.test(t)) return 'OPENING';
  if (/closing/.test(t)) return 'CLOSING';
  if (/tds|194q|194c|tax deducted|tds dedication/.test(t)) return v === 'JV' ? 'JOURNAL_TDS' : 'TDS';
  if (v === 'BP' || /bank payment|payment paid|cheque|neft|rtgs/.test(t)) return 'PAYMENT';
  if (v === 'PV' || (refs.length && credit > 0)) return 'INVOICE';
  if (v === 'JV' && refs.length && credit > 0) return 'JOURNAL_INVOICE';
  if (v === 'JV') return 'JOURNAL_ADJUSTMENT';
  if (v === 'DN' || /debit note|arcm|d no/.test(t)) return 'DEBIT_NOTE';
  if (v === 'CN' || /credit note|armn|\bcn\b/.test(t)) return 'CREDIT_NOTE';
  return 'OTHER';
}

export async function parsePdfFile(filePath: string): Promise<ParseResult> {
  const sourceFile = filePath.split(/[\\/]/).pop() || filePath;
  const data = await pdf(fs.readFileSync(filePath));
  const parserLog: ParseResult['parserLog'] = [{ sourceFile, level: 'info', message: 'PDF text extraction completed', confidence: data.text.trim() ? 80 : 20 }];
  const lines = String(data.text || '').split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
  const chunks = chunkVerticalLedger(lines);
  const transactions: NormalizedTxn[] = [];
  const balances: ParseResult['balances'] = { openingRows: [], closingRows: [] };

  for (const chunk of chunks) {
    const txn = parseChunk(chunk, sourceFile);
    if (!txn) continue;
    if (txn.voucherType === 'OPENING') { balances.opening = txn.signedAmountRdcView; balances.openingRows?.push(txn); continue; }
    if (txn.voucherType === 'CLOSING') { balances.closing = txn.signedAmountRdcView; balances.closingRows?.push(txn); continue; }
    transactions.push(txn);
  }

  parserLog.push({ sourceFile, level: 'info', message: `Parsed ${transactions.length} PDF ledger rows using vertical table layout`, confidence: chunks.length ? 85 : 45 });
  return { transactions: groupPdfPayments(transactions), balances, parserLog };
}

function chunkVerticalLedger(lines: string[]) {
  const starts: number[] = [];
  for (let i = 0; i < lines.length - 2; i++) {
    if (START_DATE.test(lines[i]) && VOUCHER_TYPES.test(lines[i + 1])) starts.push(i);
  }
  const chunks: Array<{ startLine: number; lines: string[] }> = [];
  for (let i = 0; i < starts.length; i++) {
    chunks.push({ startLine: starts[i] + 1, lines: lines.slice(starts[i], starts[i + 1] ?? lines.length) });
  }
  return chunks;
}

function parseChunk(chunk: { startLine: number; lines: string[] }, sourceFile: string): NormalizedTxn | undefined {
  const [dateText, vType = '', voucherNo = '', particulars = '', billOrCheque = ''] = chunk.lines;
  const date = parseDate(dateText);
  const moneyIdx = chunk.lines.findIndex((line, index) => index >= 4 && MONEY.test(line));
  if (!date || moneyIdx < 0) return undefined;

  const debit = absAmount(chunk.lines[moneyIdx]);
  const credit = absAmount(chunk.lines[moneyIdx + 1]);
  const narration = chunk.lines.slice(3, Math.min(chunk.lines.length, moneyIdx + 6)).join(' | ');
  const allText = chunk.lines.join(' | ');
  const refs = extractReferences([billOrCheque, voucherNo, particulars, narration, allText]);
  const referenceNo = refs[0] || (/[A-Z0-9]+\d/i.test(billOrCheque) ? billOrCheque : undefined);
  const voucherType = classify(vType, allText, debit, credit, refs);
  const notes: string[] = [];
  if (vType.toUpperCase() === 'BP') notes.push('PDF payment row grouped by cheque where applicable');
  if (hasTruncatedReference([allText])) notes.push('LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED');

  return {
    id: uuid(),
    sourceSide: 'CUSTOMER',
    sourceFile,
    sourceRow: chunk.startLine,
    date,
    voucherType,
    voucherNo,
    referenceNo,
    normalizedReferenceNo: normalizeReference(referenceNo),
    extractedReferences: refs,
    chequeNo: extractChequeNo([billOrCheque, narration]) || (vType.toUpperCase() === 'BP' ? billOrCheque : undefined),
    allocationType: 'Inferred',
    particulars,
    narration,
    debit,
    credit,
    signedAmountRdcView: signedFromDebitCredit('CUSTOMER', debit, credit),
    amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '',
    parseConfidence: notes.includes('LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED') ? 55 : refs.length ? 88 : 75,
    parserNotes: notes,
  };
}

function groupPdfPayments(txns: NormalizedTxn[]) {
  const byCheque = new Map<string, NormalizedTxn[]>();
  const rest: NormalizedTxn[] = [];
  for (const txn of txns) {
    if (txn.voucherType === 'PAYMENT' && txn.chequeNo) {
      const key = [txn.date, txn.chequeNo].join('|');
      byCheque.set(key, [...(byCheque.get(key) || []), txn]);
    } else rest.push(txn);
  }
  for (const group of byCheque.values()) {
    if (group.length === 1) rest.push(group[0]);
    else {
      const first = group[0];
      const debit = group.reduce((s, t) => s + t.debit, 0);
      const credit = group.reduce((s, t) => s + t.credit, 0);
      rest.push({
        ...first,
        id: uuid(),
        sourceRow: group.map(g => g.sourceRow).join(','),
        debit,
        credit,
        signedAmountRdcView: signedFromDebitCredit('CUSTOMER', debit, credit),
        parserNotes: [...(first.parserNotes || []), `Grouped ${group.length} PDF payment rows by cheque number`],
      });
    }
  }
  return rest;
}
