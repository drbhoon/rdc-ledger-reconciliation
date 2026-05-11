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

type PdfSide = 'RDC' | 'CUSTOMER';

export async function parsePdfFile(filePath: string, sourceSide: PdfSide = 'CUSTOMER'): Promise<ParseResult> {
  const sourceFile = filePath.split(/[\\/]/).pop() || filePath;
  const data = await pdf(fs.readFileSync(filePath));
  const parserLog: ParseResult['parserLog'] = [{ sourceFile, level: 'info', message: 'PDF text extraction completed', confidence: data.text.trim() ? 80 : 20 }];
  const lines = String(data.text || '').split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
  const compact = parseCompactPdfLedger(lines, sourceFile, sourceSide);
  if (compact.transactions.length || compact.balances.opening || compact.balances.closing) {
    compact.parserLog.unshift(...parserLog);
    return compact;
  }
  const chunks = chunkVerticalLedger(lines);
  const transactions: NormalizedTxn[] = [];
  const balances: ParseResult['balances'] = { openingRows: [], closingRows: [] };

  for (const chunk of chunks) {
    const txn = parseChunk(chunk, sourceFile, sourceSide);
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

function parseChunk(chunk: { startLine: number; lines: string[] }, sourceFile: string, sourceSide: PdfSide): NormalizedTxn | undefined {
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
    sourceSide,
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
    signedAmountRdcView: signedFromDebitCredit(sourceSide, debit, credit),
    amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '',
    parseConfidence: notes.includes('LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED') ? 55 : refs.length ? 88 : 75,
    parserNotes: notes,
  };
}

function parseCompactPdfLedger(lines: string[], sourceFile: string, sourceSide: PdfSide): ParseResult {
  const balances: ParseResult['balances'] = { openingRows: [], closingRows: [] };
  const parserLog: ParseResult['parserLog'] = [];
  if (sourceSide === 'RDC' && lines.some(line => /RDC Debtors Ledger Excel Report/i.test(line))) {
    const transactions = parseCompactRdcPdf(lines, sourceFile, balances);
    parserLog.push({ sourceFile, level: 'info', message: `Parsed ${transactions.length} RDC compact PDF rows`, confidence: transactions.length ? 82 : 45 });
    return { transactions, balances, parserLog };
  }
  if (sourceSide === 'CUSTOMER' && lines.some(line => /Vendor Ledger|Sr\. No\.\s+Site\s+Transaction date/i.test(line))) {
    const transactions = parseCompactCustomerPdf(lines, sourceFile, balances);
    parserLog.push({ sourceFile, level: 'info', message: `Parsed ${transactions.length} customer compact PDF rows`, confidence: transactions.length ? 82 : 45 });
    return { transactions, balances, parserLog };
  }
  return { transactions: [], balances, parserLog };
}

function moneyValue(value?: string) {
  return absAmount(value || '');
}

function compactAmountAtEnd(line: string) {
  const spacedCredit = line.match(/0\s+(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,3})?$/);
  if (spacedCredit) return { debit: 0, credit: moneyValue(spacedCredit[1]) };
  const debitAfterDocDate = line.match(/\d{2}\/\d{2}\/\d{4}(\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3},\d{3})(?:\.\d{1,3})?0$/);
  if (debitAfterDocDate) return { debit: moneyValue(debitAfterDocDate[1]), credit: 0 };
  const debitZero = line.match(/(\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3},\d{3})(?:\.\d{1,3})?0$/);
  if (debitZero) return { debit: moneyValue(debitZero[1]), credit: 0 };
  const last = line.match(/(\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3},\d{3}|\d+)(?:\.\d{1,3})?$/);
  return { debit: last ? moneyValue(last[0]) : 0, credit: 0 };
}

function rdcAmountAtEnd(line: string, docType: string) {
  if (docType === 'REC') return { debit: 0, credit: moneyValue(line.match(/0(\d{1,2}(?:,\d{2})*,\d{3}\.\d{2})$/)?.[1] || line.match(/(\d{1,2}(?:,\d{2})*,\d{3}\.\d{2})$/)?.[1]) };
  const compact = line.match(/(\d{1,2},\d{3}\.\d{3})0?$/);
  if (compact) return { debit: moneyValue(compact[1]), credit: 0 };
  const fallback = line.match(/(\d{1,3}(?:,\d{2,3})+\.\d{2,3})0?$/);
  return { debit: fallback ? moneyValue(fallback[1]) : 0, credit: 0 };
}

function makePdfTxn(input: Omit<NormalizedTxn, 'id'>): NormalizedTxn {
  return { id: uuid(), ...input };
}

function compactRdcRefs(line: string) {
  const refs = new Set<string>();
  const afterDueDate = /(?:\d{2}-[A-Za-z]{3}-\d{2})(\d{1,2}[A-Z]{2,4}\d{2}(?:ARS|BP|ARCM|ARMN)\d{4,6})(?=\d+(?:\.\d+)?\d{3,}E|M\d{2})/gi;
  for (const match of line.matchAll(afterDueDate)) refs.add(match[1].toUpperCase());
  return Array.from(refs);
}

function compactCustomerRefs(line: string) {
  const refs = new Set<string>();
  const beforeDocDate = /(\d{1,2}[A-Z]{2,4}\d{2}(?:ARS|BP|ARCM|ARMN)\d{4,6})(?=\d{2}\/\d{2}\/\d{4})/gi;
  for (const match of line.matchAll(beforeDocDate)) refs.add(match[1].toUpperCase());
  return Array.from(refs);
}

function parseCompactRdcPdf(lines: string[], sourceFile: string, balances: ParseResult['balances']) {
  const transactions: NormalizedTxn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opening = line.match(/Customer Opening Balance\s*([\d,]+(?:\.\d+)?)/i);
    if (opening) {
      const amount = moneyValue(opening[1]);
      const txn = makePdfTxn({ sourceSide: 'RDC', sourceFile, sourceRow: i + 1, voucherType: 'OPENING', particulars: line, narration: line, debit: amount, credit: 0, signedAmountRdcView: amount, parseConfidence: 80, parserNotes: ['RDC compact PDF opening balance'] });
      balances.opening = txn.signedAmountRdcView; balances.openingRows?.push(txn);
      continue;
    }
    const closing = line.match(/Customer Closing Balance\s*([\d,]+(?:\.\d+)?)/i);
    if (closing) {
      const amount = moneyValue(closing[1]);
      const txn = makePdfTxn({ sourceSide: 'RDC', sourceFile, sourceRow: i + 1, voucherType: 'CLOSING', particulars: line, narration: line, debit: amount, credit: 0, signedAmountRdcView: amount, parseConfidence: 80, parserNotes: ['RDC compact PDF closing balance'] });
      balances.closing = txn.signedAmountRdcView; balances.closingRows?.push(txn);
      continue;
    }
    const row = line.match(/^(\d{2}-[A-Za-z]{3}-\d{2})(INV|REC|TDS|DN|CN)(.+)$/i);
    if (!row) continue;
    const [, dateText, docTypeRaw, rest] = row;
    const docType = docTypeRaw.toUpperCase();
    const refs = compactRdcRefs(line).concat(extractReferences([line])).filter((ref, index, arr) => arr.indexOf(ref) === index);
    const referenceNo = refs[0] || '';
    const voucherNo = docType === 'REC' ? rest.match(/^([A-Z0-9/-]+)/i)?.[1] || '' : rest.match(/^.*?(\d{6,})/)?.[1] || '';
    const { debit, credit } = rdcAmountAtEnd(line, docType);
    if (!debit && !credit) continue;
    const voucherType: VoucherType = docType === 'REC' ? 'RECEIPT' : docType === 'DN' ? 'DEBIT_NOTE' : docType === 'CN' ? 'CREDIT_NOTE' : docType === 'TDS' ? 'TDS' : 'INVOICE';
    transactions.push(makePdfTxn({ sourceSide: 'RDC', sourceFile, sourceRow: i + 1, date: parseDate(dateText), voucherType, voucherNo, referenceNo, normalizedReferenceNo: normalizeReference(referenceNo), extractedReferences: refs, chequeNo: extractChequeNo([line]), particulars: docType, narration: line, debit, credit, signedAmountRdcView: signedFromDebitCredit('RDC', debit, credit), amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '', parseConfidence: refs.length || docType === 'REC' ? 82 : 70, parserNotes: ['RDC compact PDF row'] }));
  }
  return transactions;
}

function parseCompactCustomerPdf(lines: string[], sourceFile: string, balances: ParseResult['balances']) {
  const transactions: NormalizedTxn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const balance = line.match(/^(\d{2}\/\d{2}\/\d{4})?Closing Balance0\s+([\d,]+(?:\.\d+)?)/i) || line.match(/^\d+\s+\S+\s+(\d{2}\/\d{2}\/\d{4})Opening0\s+([\d,]+(?:\.\d+)?)/i);
    if (balance) {
      const amount = moneyValue(balance[2]);
      const isClosing = /Closing Balance/i.test(line);
      const txn = makePdfTxn({ sourceSide: 'CUSTOMER', sourceFile, sourceRow: i + 1, date: parseDate(balance[1]), voucherType: isClosing ? 'CLOSING' : 'OPENING', particulars: line, narration: line, debit: 0, credit: amount, signedAmountRdcView: amount, parseConfidence: 80, parserNotes: ['Customer compact PDF balance'] });
      if (isClosing) { balances.closing = amount; balances.closingRows?.push(txn); } else { balances.opening = amount; balances.openingRows?.push(txn); }
      continue;
    }
    if (/Period Transaction Total/i.test(line)) continue;
    const row = line.match(/^(\d+)\s+(\S+)\s+(\d{2}\/\d{2}\/\d{4})(.+)$/);
    if (!row) continue;
    const [, srNo, site, dateText, rest] = row;
    if (/Opening/i.test(rest)) continue;
    const refs = compactCustomerRefs(line).concat(extractReferences([line])).filter((ref, index, arr) => arr.indexOf(ref) === index);
    const referenceNo = refs[0] || '';
    const { debit, credit } = compactAmountAtEnd(line);
    if (!debit && !credit) continue;
    const isPayment = /payment/i.test(rest);
    const isTds = /tds|194q|194c|tax deducted/i.test(rest);
    const voucherType: VoucherType = isTds ? 'TDS' : isPayment ? 'PAYMENT' : refs.length && credit > 0 ? 'INVOICE' : 'OTHER';
    const voucherNo = rest.match(/([A-Z]{3,}[A-Z0-9/-]{6,})/)?.[1] || referenceNo || srNo;
    transactions.push(makePdfTxn({ sourceSide: 'CUSTOMER', sourceFile, sourceRow: i + 1, date: parseDate(dateText), voucherType, voucherNo, referenceNo, normalizedReferenceNo: normalizeReference(referenceNo), extractedReferences: refs, chequeNo: extractChequeNo([line]), allocationType: 'Inferred', particulars: site, narration: line, debit, credit, signedAmountRdcView: signedFromDebitCredit('CUSTOMER', debit, credit), amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '', parseConfidence: refs.length || isPayment ? 82 : 70, parserNotes: ['Customer compact PDF row'] }));
  }
  return transactions;
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
