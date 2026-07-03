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

/**
 * Geometry-aware text extraction: rebuilds each line from pdf.js text items
 * sorted by (y, x), inserting a space whenever there is a horizontal gap
 * between items. This prevents adjacent table columns (e.g. Qty and Amount)
 * from fusing into one token — the root cause of amounts like 4,501.70 being
 * read as 14,501.70.
 */
async function extractSpacedText(buffer: Buffer): Promise<string> {
  const render = (pageData: any) =>
    pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((tc: any) => {
      type Item = { str: string; x: number; y: number; w: number };
      const items: Item[] = tc.items
        .filter((it: any) => it.str && it.str.trim() !== '')
        .map((it: any) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }));
      // group items into lines by y (2pt tolerance)
      const lines: Item[][] = [];
      for (const it of items.sort((a, b) => b.y - a.y || a.x - b.x)) {
        const line = lines.find(l => Math.abs(l[0].y - it.y) <= 2);
        if (line) line.push(it); else lines.push([it]);
      }
      return lines
        .map(line => {
          line.sort((a, b) => a.x - b.x);
          let out = '';
          let cursor = -1;
          for (const it of line) {
            if (cursor >= 0 && it.x - cursor > 0.5) out += ' ';
            out += it.str;
            cursor = it.x + it.w;
          }
          return out.trim();
        })
        .filter(Boolean)
        .join('\n');
    });
  const data = await pdf(buffer, { pagerender: render } as any);
  return String(data.text || '');
}

export async function parsePdfFile(filePath: string, sourceSide: PdfSide = 'CUSTOMER'): Promise<ParseResult> {
  const sourceFile = filePath.split(/[\\/]/).pop() || filePath;
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  const parserLog: ParseResult['parserLog'] = [{ sourceFile, level: 'info', message: 'PDF text extraction completed', confidence: data.text.trim() ? 80 : 20 }];
  const lines = String(data.text || '').split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
  // Column-safe text used by the structured (compact / FIN002) parsers.
  let spacedLines: string[] = [];
  try {
    spacedLines = (await extractSpacedText(buffer)).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  } catch {
    spacedLines = lines;
    parserLog.push({ sourceFile, level: 'warn', message: 'Geometry-aware extraction failed; falling back to plain text', confidence: 50 });
  }
  const compact = parseCompactPdfLedger(spacedLines.length ? spacedLines : lines, sourceFile, sourceSide);
  if (compact.transactions.length || compact.balances.opening || compact.balances.closing) {
    compact.parserLog.unshift(...parserLog);
    return compact;
  }
  const fin002 = parseFin002PdfLedger(spacedLines.length ? spacedLines : lines, sourceFile, sourceSide);
  if (fin002.transactions.length) {
    fin002.parserLog.unshift(...parserLog);
    return fin002;
  }
  const tally = parseTallyPdfLedger(lines, sourceFile, sourceSide);
  if (tally.transactions.length || tally.balances.opening || tally.balances.closing) {
    tally.parserLog.unshift(...parserLog);
    return tally;
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

function parseTallyPdfLedger(lines: string[], sourceFile: string, sourceSide: PdfSide): ParseResult {
  const balances: ParseResult['balances'] = { openingRows: [], closingRows: [] };
  const parserLog: ParseResult['parserLog'] = [];
  if (!lines.some(line => /ParticularsCreditDebit|Vch No\.Vch Type/i.test(line))) return { transactions: [], balances, parserLog };
  const transactions = parseTallyPdfRows(lines, sourceFile, sourceSide, balances);
  parserLog.push({ sourceFile, level: 'info', message: `Parsed ${transactions.length} Tally PDF ledger rows`, confidence: transactions.length ? 82 : 45 });
  return { transactions, balances, parserLog };
}

function isTallyDate(line: string) {
  return /^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(line);
}

function isMoneyLine(line: string) {
  return /^\d{1,3}(?:,\d{2,3})*(?:\.\d{2})$/.test(line);
}

function isTotalLine(line: string) {
  return /^\d{1,3}(?:,\d{2,3})*(?:\.\d{2})\d{1,3}(?:,\d{2,3})*(?:\.\d{2})$/.test(line);
}

function tallyVoucherType(vchType: string, particulars: string, amountSign: 'DR' | 'CR', refs: string[]): VoucherType {
  const text = `${vchType} ${particulars}`.toLowerCase();
  if (/payment|receipt|bank|control|ho - payment/.test(text)) return 'PAYMENT';
  if (/tds|194q|194c|tax deducted/.test(text)) return /journal|jv/i.test(vchType) ? 'JOURNAL_TDS' : 'TDS';
  if (/journal|\bjv\b/i.test(vchType)) {
    if (/debit note|d no|arcm/.test(text)) return amountSign === 'DR' ? 'CREDIT_NOTE' : 'DEBIT_NOTE';
    if (/credit note|invoice cancelled|\bcn\b|armn/.test(text)) return 'CREDIT_NOTE';
    if (refs.length) return 'JOURNAL_INVOICE';
    return 'JOURNAL_ADJUSTMENT';
  }
  if (/purchase|bill booked|invoice/.test(text) || refs.length) return 'INVOICE';
  if (/debit note|arcm/.test(text)) return 'DEBIT_NOTE';
  if (/credit note|armn|\bcn\b/.test(text)) return 'CREDIT_NOTE';
  return 'OTHER';
}

function balanceTxn(sourceFile: string, sourceRow: number, sourceSide: PdfSide, date: string | undefined, voucherType: 'OPENING' | 'CLOSING', amountSign: 'DR' | 'CR', amount: number, line: string): NormalizedTxn {
  const debit = amountSign === 'DR' ? amount : 0;
  const credit = amountSign === 'CR' ? amount : 0;
  return makePdfTxn({ sourceSide, sourceFile, sourceRow, date, voucherType, particulars: line, narration: line, debit, credit, signedAmountRdcView: signedFromDebitCredit(sourceSide, debit, credit), amountOriginalSign: amountSign === 'DR' ? 'Dr' : 'Cr', parseConfidence: 82, parserNotes: ['Tally PDF balance row'] });
}

function parseTallyPdfRows(lines: string[], sourceFile: string, sourceSide: PdfSide, balances: ParseResult['balances']) {
  const transactions: NormalizedTxn[] = [];
  let currentDate: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const dateWithSign = lines[i].match(/^(\d{1,2}-[A-Za-z]{3}-\d{2,4})(Dr|Cr)$/i);
    let signIndex = i;
    if (dateWithSign) {
      currentDate = parseDate(dateWithSign[1]);
      const gluedBalance = (lines[i + 1] || '').match(/^(Opening Balance|Closing Balance)(\d{1,3}(?:,\d{2,3})*(?:\.\d{2}))$/i);
      if (gluedBalance) {
        const voucherType = /opening/i.test(gluedBalance[1]) ? 'OPENING' : 'CLOSING';
        const amount = moneyValue(gluedBalance[2]);
        const amountSign = dateWithSign[2].toUpperCase() as 'DR' | 'CR';
        const txn = balanceTxn(sourceFile, i + 1, sourceSide, currentDate, voucherType, amountSign, amount, `${gluedBalance[1]} | ${gluedBalance[2]}`);
        if (voucherType === 'OPENING') {
          if (balances.opening == null) balances.opening = txn.signedAmountRdcView;
          balances.openingRows?.push(txn);
        } else {
          balances.closing = txn.signedAmountRdcView;
          balances.closingRows?.push(txn);
        }
        i += 1;
        continue;
      }
    } else if (isTallyDate(lines[i])) {
      currentDate = parseDate(lines[i]);
      continue;
    }
    if (!dateWithSign && !/^(Dr|Cr)$/i.test(lines[i])) continue;
    const amountSign = (dateWithSign ? dateWithSign[2] : lines[signIndex]).toUpperCase() as 'DR' | 'CR';
    const particulars = lines[signIndex + 1] || '';
    const amountLine = lines[signIndex + 2] || '';
    if (!isMoneyLine(amountLine)) continue;
    const amount = moneyValue(amountLine);
    const voucherNo = lines[signIndex + 3] && !/^(Dr|Cr)$/i.test(lines[signIndex + 3]) && !isTallyDate(lines[signIndex + 3]) ? lines[signIndex + 3] : '';
    const vchType = lines[signIndex + 4] && !/^(Dr|Cr)$/i.test(lines[signIndex + 4]) && !isTallyDate(lines[signIndex + 4]) && !isTotalLine(lines[signIndex + 4]) ? lines[signIndex + 4] : '';
    const text = [particulars, voucherNo, vchType].join(' | ');

    if (/opening balance/i.test(particulars)) {
      const txn = balanceTxn(sourceFile, i + 1, sourceSide, currentDate, 'OPENING', amountSign, amount, text);
      if (balances.opening == null) balances.opening = txn.signedAmountRdcView; balances.openingRows?.push(txn);
      i += 2;
      continue;
    }
    if (/closing balance/i.test(particulars)) {
      const txn = balanceTxn(sourceFile, i + 1, sourceSide, currentDate, 'CLOSING', amountSign, amount, text);
      balances.closing = txn.signedAmountRdcView; balances.closingRows?.push(txn);
      i += 2;
      continue;
    }

    const refs = extractReferences([text]);
    const referenceNo = refs[0] || (/^[A-Z0-9/-]{5,}$/i.test(voucherNo) ? voucherNo : '');
    const debit = amountSign === 'DR' ? amount : 0;
    const credit = amountSign === 'CR' ? amount : 0;
    const voucherType = tallyVoucherType(vchType, particulars, amountSign, refs);
    transactions.push(makePdfTxn({
      sourceSide,
      sourceFile,
      sourceRow: i + 1,
      date: currentDate,
      voucherType,
      voucherNo,
      referenceNo,
      normalizedReferenceNo: normalizeReference(referenceNo),
      extractedReferences: refs,
      chequeNo: extractChequeNo([text]),
      allocationType: 'Inferred',
      particulars,
      narration: text,
      debit,
      credit,
      signedAmountRdcView: signedFromDebitCredit(sourceSide, debit, credit),
      amountOriginalSign: amountSign === 'DR' ? 'Dr' : 'Cr',
      parseConfidence: refs.length || /payment/i.test(text) ? 84 : 76,
      parserNotes: ['Tally PDF ledger row'],
    }));
    i += vchType ? 4 : 2;
  }
  return transactions;
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

const MONEY_TOKEN = /^-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?$|^-?\d+(?:\.\d{1,2})?$/;

/**
 * Read Debit/Credit for a compact-RDC row from whitespace tokens at the line
 * end. Layout per row tail: `<qty> <debit> <credit>` — e.g. INV: `1 4,501.70 0`,
 * REC: `0 20,51,451.00`, CM: `-6 0 33,276.00`. Never regex-fuses columns.
 */
function rdcAmountFromTokens(line: string, docType: string): { debit: number; credit: number } | undefined {
  const tokens = line.trim().split(/\s+/);
  // Collect trailing money-like tokens (stop at first non-money looking back)
  const tail: string[] = [];
  for (let i = tokens.length - 1; i >= 0 && tail.length < 3; i--) {
    if (MONEY_TOKEN.test(tokens[i])) tail.unshift(tokens[i]);
    else break;
  }
  if (tail.length < 2) return undefined;
  const vals = tail.map(t => parseAmount(t));
  // Last two tokens are always [debit, credit]; a token before them is qty.
  const credit = Math.abs(vals[vals.length - 1]);
  const debit = Math.abs(vals[vals.length - 2]);
  if (!debit && !credit) return undefined;
  // Sanity: a REC/CM/CN row carries a credit; INV/DN/TDS carries a debit.
  const creditDoc = ['REC', 'CM', 'CN'].includes(docType);
  if (creditDoc && !credit) return undefined;
  if (!creditDoc && !debit) return undefined;
  return { debit: creditDoc ? 0 : debit, credit: creditDoc ? credit : 0 };
}

function parseCompactRdcPdf(lines: string[], sourceFile: string, balances: ParseResult['balances']) {
  const transactions: NormalizedTxn[] = [];
  const parserNotes: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opening = line.match(/Customer Opening Balance\s*(-?[\d,]+(?:\.\d+)?)/i);
    if (opening) {
      const amount = moneyValue(opening[1]);
      const txn = makePdfTxn({ sourceSide: 'RDC', sourceFile, sourceRow: i + 1, voucherType: 'OPENING', particulars: line, narration: line, debit: amount, credit: 0, signedAmountRdcView: amount, parseConfidence: 80, parserNotes: ['RDC compact PDF opening balance'] });
      balances.opening = txn.signedAmountRdcView; balances.openingRows?.push(txn);
      continue;
    }
    const closing = line.match(/Customer Closing Balance\s*(-?[\d,]+(?:\.\d+)?)/i);
    if (closing) {
      const amount = moneyValue(closing[1]);
      const txn = makePdfTxn({ sourceSide: 'RDC', sourceFile, sourceRow: i + 1, voucherType: 'CLOSING', particulars: line, narration: line, debit: amount, credit: 0, signedAmountRdcView: amount, parseConfidence: 80, parserNotes: ['RDC compact PDF closing balance'] });
      balances.closing = txn.signedAmountRdcView; balances.closingRows?.push(txn);
      continue;
    }
    // Doc types include CM (credit memo) and DM (debit memo) — previously
    // missing, which silently dropped credit memos like 2SR25ARCM42.
    const row = line.match(/^(\d{2}-[A-Za-z]{3}-\d{2})\s*(INV|REC|TDS|DN|CN|CM|DM)\b(.+)$/i);
    if (!row) continue;
    const [, dateText, docTypeRaw, rest] = row;
    const docType = docTypeRaw.toUpperCase();
    const refs = compactRdcRefs(line.replace(/\s+/g, '')).concat(compactRdcRefs(line)).concat(extractReferences([line])).filter((ref, index, arr) => arr.indexOf(ref) === index);
    const referenceNo = refs[0] || '';
    const voucherNo = docType === 'REC' ? rest.trim().match(/^([A-Z0-9/-]+)/i)?.[1] || '' : rest.match(/^.*?(\d{6,})/)?.[1] || '';
    const amounts = rdcAmountFromTokens(line, docType) || rdcAmountAtEnd(line.replace(/\s+/g, ''), docType);
    const { debit, credit } = amounts || { debit: 0, credit: 0 };
    if (!debit && !credit) {
      parserNotes.push(`Row ${i + 1}: could not read amount (${docType} ${referenceNo || voucherNo || '?'})`);
      continue;
    }
    const voucherType: VoucherType = docType === 'REC' ? 'RECEIPT'
      : docType === 'DN' || docType === 'DM' ? 'DEBIT_NOTE'
      : docType === 'CN' || docType === 'CM' ? 'CREDIT_NOTE'
      : docType === 'TDS' ? 'TDS' : 'INVOICE';
    transactions.push(makePdfTxn({ sourceSide: 'RDC', sourceFile, sourceRow: i + 1, date: parseDate(dateText), voucherType, voucherNo, referenceNo, normalizedReferenceNo: normalizeReference(referenceNo), extractedReferences: refs, chequeNo: extractChequeNo([line]), particulars: docType, narration: line, debit, credit, signedAmountRdcView: signedFromDebitCredit('RDC', debit, credit), amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '', parseConfidence: refs.length || docType === 'REC' ? 82 : 70, parserNotes: ['RDC compact PDF row'] }));
  }
  return transactions;
}

/**
 * FIN002-style project ledger (e.g. Malnad): header
 * `Vchr Date Vchr No Project Code Particulars Inv. No Inv. Date Chq. No Debit Credit Balance ...`
 * Rows start with dd/mm/yyyy. The running Balance column lets us derive each
 * row's signed amount deterministically (balance delta), immune to
 * debit/credit column ambiguity.
 */
function parseFin002PdfLedger(lines: string[], sourceFile: string, sourceSide: PdfSide): ParseResult {
  const balances: ParseResult['balances'] = { openingRows: [], closingRows: [] };
  const parserLog: ParseResult['parserLog'] = [];
  const isFin002 = lines.some(l => /Vchr\s*Date\s*Vchr\s*No/i.test(l) && /Debit\s*Credit\s*Balance/i.test(l));
  if (!isFin002) return { transactions: [], balances, parserLog };

  // Each transaction row carries an explicit money trio: `debit credit balance [Dr|Cr]`,
  // followed by the Opposite Ledger text. Parse the trio directly (deterministic),
  // and fold following wrapped narration lines into the row for reference extraction.
  const TRIO = /(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})\s*(Dr|Cr)?/;
  const isDateRow = (l: string) => /^\d{2}\/\d{2}\/\d{4}\s/.test(l);
  const isHeaderish = (l: string) => /^(?:Vchr Date|Report Code|Account Name|Page \d|Malnad|FIN\d|Ledger Total|Grand Total|Total Closing|Ledger Closing)/i.test(l);

  const transactions: NormalizedTxn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const closingLine = line.match(/Ledger Closing Balance\s*:?\s*(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})/i);
    if (closingLine) {
      // customer books payable view: closing = credit − debit ≡ RDC receivable
      balances.closing = moneyValue(closingLine[2]) - moneyValue(closingLine[1]);
      continue;
    }
    const openMatch = line.match(/Opening Balance\s*:?\s*(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})/i);
    if (openMatch) { balances.opening = moneyValue(openMatch[2]) - moneyValue(openMatch[1]); continue; }
    if (!isDateRow(line)) continue;
    const trio = line.match(TRIO);
    if (!trio) continue;
    const debitCustBooks = moneyValue(trio[1]);
    const creditCustBooks = moneyValue(trio[2]);
    if (!debitCustBooks && !creditCustBooks) continue;
    const head = line.slice(0, trio.index || 0);
    const row = head.match(/^(\d{2}\/\d{2}\/\d{4})\s+(\S+)\s+(\S+)\s+(.*)$/);
    const dateText = row?.[1] || line.slice(0, 10);
    const vchrNo = row?.[2] || '';
    const rest = row?.[4] || head;
    // Fold wrapped continuation lines (until the next date row / header) into
    // the narration so full invoice references split across lines are captured.
    const continuation: string[] = [];
    for (let j = i + 1; j < lines.length && continuation.length < 4; j++) {
      if (isDateRow(lines[j]) || isHeaderish(lines[j])) break;
      continuation.push(lines[j]);
    }
    const narration = [line, ...continuation].join(' | ');
    const refs = extractReferences([rest, narration]);
    const referenceNo = refs[0] || rest.match(/\b(\d{1,2}[A-Z]{2,4}\d{2}[A-Z]{0,4}\d{1,8})\b/i)?.[1]?.toUpperCase() || '';
    const isPayment = /paid to vendor|payment|receipt|chq|cheque|neft|rtgs/i.test(rest) && !/purchase|bill booked|invoice/i.test(rest);
    const isTds = /\btds\b|194q|194c/i.test(rest);
    const voucherType: VoucherType = isTds ? 'TDS' : isPayment ? 'PAYMENT' : (refs.length || /vendor|purchase|bill|invoice/i.test(rest)) ? 'INVOICE' : 'OTHER';
    // signedFromDebitCredit('CUSTOMER', d, c) = credit − debit — already the
    // RDC-receivable view for this payable-format ledger.
    transactions.push(makePdfTxn({
      sourceSide, sourceFile, sourceRow: i + 1, date: parseDate(dateText), voucherType,
      voucherNo: vchrNo, referenceNo, normalizedReferenceNo: normalizeReference(referenceNo),
      extractedReferences: refs, chequeNo: extractChequeNo([rest]), allocationType: 'Inferred',
      particulars: rest.slice(0, 160), narration: narration.slice(0, 400),
      debit: debitCustBooks, credit: creditCustBooks,
      signedAmountRdcView: signedFromDebitCredit(sourceSide, debitCustBooks, creditCustBooks),
      amountOriginalSign: debitCustBooks ? 'Dr' : 'Cr',
      parseConfidence: refs.length ? 84 : 74,
      parserNotes: ['FIN002 project ledger row'],
    }));
  }
  parserLog.push({ sourceFile, level: 'info', message: `Parsed ${transactions.length} FIN002 project-ledger rows`, confidence: transactions.length ? 82 : 45 });
  return { transactions, balances, parserLog };
}

/** Last two money tokens on a compact-customer row are [Debit, Credit]. */
function customerAmountFromTokens(line: string): { debit: number; credit: number } | undefined {
  const tokens = line.trim().split(/\s+/);
  const tail: string[] = [];
  for (let i = tokens.length - 1; i >= 0 && tail.length < 2; i--) {
    if (MONEY_TOKEN.test(tokens[i])) tail.unshift(tokens[i]);
    else break;
  }
  if (tail.length < 2) return undefined;
  const debit = Math.abs(parseAmount(tail[0]));
  const credit = Math.abs(parseAmount(tail[1]));
  if (!debit && !credit) return undefined;
  return { debit, credit };
}

function parseCompactCustomerPdf(lines: string[], sourceFile: string, balances: ParseResult['balances']) {
  const transactions: NormalizedTxn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const balance = line.match(/^(\d{2}\/\d{2}\/\d{4})?\s*Closing Balance\s*0\s+([\d,]+(?:\.\d+)?)/i)
      || line.match(/^\d+\s+\S+\s+(\d{2}\/\d{2}\/\d{4})\s*Opening\s*0\s+([\d,]+(?:\.\d+)?)/i)
      || line.match(/^(\d{2}\/\d{2}\/\d{4})?Closing Balance0\s+([\d,]+(?:\.\d+)?)/i)
      || line.match(/^\d+\s+\S+\s+(\d{2}\/\d{2}\/\d{4})Opening0\s+([\d,]+(?:\.\d+)?)/i);
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
    const refs = compactCustomerRefs(line.replace(/\s+/g, '')).concat(compactCustomerRefs(line)).concat(extractReferences([line])).filter((ref, index, arr) => arr.indexOf(ref) === index);
    const referenceNo = refs[0] || '';
    const { debit, credit } = customerAmountFromTokens(line) || compactAmountAtEnd(line.replace(/\s+/g, ''));
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
