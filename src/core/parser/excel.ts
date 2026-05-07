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
  const t = (doc + ' ' + narration).toLowerCase();
  if (/opening/.test(t)) return 'OPENING';
  if (/closing/.test(t)) return 'CLOSING';
  if (/tds|194q|194c|tax deducted/.test(t)) return 'TDS';
  if (/credit note|armn| cn\b/.test(t)) return 'CREDIT_NOTE';
  if (/debit note|arcm| d no/.test(t)) return 'DEBIT_NOTE';
  if (/inv|sale|invoice/.test(t) || debit > 0) return 'INVOICE';
  if (/rec|receipt|payment|bank/.test(t) || credit > 0) return 'RECEIPT';
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
  const wb = XLSX.read(fs.readFileSync(filePath), { cellDates: true, type: 'buffer' });
  const transactions: NormalizedTxn[] = [];
  const parserLog: ParserLogRow[] = [];
  const balances: ParseResult['balances'] = { openingRows: [], closingRows: [] };
  const sourceFile = filePath.split(/[\\/]/).pop() || filePath;
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Row>(ws, { defval: '', raw: false, range: headerRowIndex(ws) });
    if (!rows.length) continue;
    const kind = sourceSideHint === 'RDC' ? 'RDC' : sourceSideHint === 'CUSTOMER' ? detect(rows) : detect(rows);
    parserLog.push({ sourceFile, sourceSheet: sheetName, level: 'info', message: 'Detected ' + kind + ' ledger layout', confidence: 90 });
    if (kind === 'RDC') parseRdcRows(rows, sourceFile, sheetName, transactions, balances, parserLog);
    else parseCustomerRows(rows, sourceFile, sheetName, transactions, balances, parserLog);
  }
  return { transactions, balances, parserLog };
}
function parseRdcRows(rows: Row[], sourceFile: string, sourceSheet: string, out: NormalizedTxn[], balances: ParseResult['balances'], log: ParserLogRow[]) {
  for (const row of rows) {
    const docType = String(pick(row, ['Doc Type','Voucher Type']) ?? '');
    const particulars = [pick(row, ['Narration','Particular','Customer Name','Plant Name','Transaction Type']), Object.values(row).find(v => /Opening Balance|Closing Balance/i.test(String(v)))].filter(Boolean).join(' | ');
    const date = parseDate(pick(row, ['Inv/ Receipt Date','Date','Voucher Date']));
    const debit = absAmount(pick(row, ['Tran Dr Amt','Debit','Dr']));
    const credit = absAmount(pick(row, ['Tran Cr Amt','Credit','Cr']));
    if (!date && !debit && !credit && !particulars && !docType) continue;
    const refs = extractReferences([particulars, String(pick(row, ['GST Inv Number','Inv / Receipt Number','Bill No','Reference']) ?? '')]);
    const referenceNo = String(pick(row, ['GST Inv Number','Bill No','Reference','Inv / Receipt Number']) ?? refs[0] ?? '').trim();
    const voucherType = classifyRdc(docType, particulars + ' ' + referenceNo, debit, credit);
    if (/total of debits|total/i.test(particulars + ' ' + docType) && debit && credit) {
      log.push({ sourceFile, sourceSheet, sourceRow: row.__rowNum__, level: 'info', message: 'Skipped total row' });
      continue;
    }
    const txn = buildTxn({ sourceSide: 'RDC', sourceFile, sourceSheet, sourceRow: row.__rowNum__, date, voucherType, voucherNo: String(pick(row, ['Inv / Receipt Number','Voucher No']) ?? ''), referenceNo, normalizedReferenceNo: normalizeReference(referenceNo || refs[0]), extractedReferences: refs, chequeNo: extractChequeNo([particulars, referenceNo]), particulars, narration: particulars, debit, credit, signedAmountRdcView: signedFromDebitCredit('RDC', debit, credit), amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '', parseConfidence: hasTruncatedReference([particulars, referenceNo]) ? 60 : 90, parserNotes: [] });
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
    const referenceNo = refs[0] || refText.replace(/New Ref|Agst Ref/gi, '').trim();
    const voucherType = classifyCustomer(base.vchType || '', particulars, debit, credit, refs);
    const notes: string[] = /journal|\bjv\b/i.test(base.vchType || '') ? ['SOURCE_VOUCHER_TYPE_JOURNAL'] : [];
    let confidence = refs.length ? 88 : 78;
    if (hasTruncatedReference([particulars, refText])) { confidence = 55; notes.push('LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED'); }
    const txn = buildTxn({ sourceSide: 'CUSTOMER', sourceFile, sourceSheet, sourceRow: row.__rowNum__, date: base.date, voucherType, voucherNo: base.voucherNo, referenceNo, normalizedReferenceNo: normalizeReference(referenceNo), extractedReferences: refs, parentVoucherNo: allocationType ? base.voucherNo : undefined, chequeNo: extractChequeNo([particulars, base.voucherNo]), allocationType, particulars, narration: particulars, debit, credit, signedAmountRdcView: signedFromDebitCredit('CUSTOMER', debit, credit), amountOriginalSign: debit ? 'Dr' : credit ? 'Cr' : '', parseConfidence: confidence, parserNotes: notes });
    if (voucherType === 'OPENING') { balances.opening = txn.signedAmountRdcView; balances.openingRows?.push(txn); return; }
    if (voucherType === 'CLOSING') { balances.closing = txn.signedAmountRdcView; balances.closingRows?.push(txn); return; }
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
      parentHadChildren = true;
      const allocRef = String((row as any).__EMPTY_1 || '');
      const allocAmount = absAmount((row as any)['Vch Type'] || (row as any).__EMPTY_2 || (row as any).__EMPTY_3);
      const allocSign = String((row as any)['Vch No.'] || (row as any)['Vch No'] || '').toLowerCase();
      const childDebit = debit || (allocSign === 'dr' ? allocAmount : 0);
      const childCredit = credit || (allocSign === 'cr' ? allocAmount : 0);
      const refLine = [String((row as any).__EMPTY || ''), allocRef, allocAmount ? String(allocAmount) : '', allocSign].filter(Boolean).join(' ');
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
