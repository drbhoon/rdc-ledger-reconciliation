import ExcelJS from 'exceljs';
import type { MatchRow, NormalizedTxn, ReconcileResult, SummaryLine } from './types';
const columns = [ ['sourceFile','Source File'], ['sourceSheet','Source Sheet/Page'], ['sourceRow','Source Row/Line'], ['referenceNo','Original Reference'], ['normalizedReferenceNo','Normalized Reference'], ['date','Date'], ['rdcAmount','RDC Amount'], ['customerAmount','Customer Amount'], ['difference','Difference'], ['matchStatus','Match Status'], ['reasonCode','Reason Code'], ['confidence','Confidence Score'], ['parserNotes','Parser Notes'], ['aiExtractedValue','AI Extracted Value'], ['aiConfidence','AI Confidence'], ['aiReason','AI Reason'], ['userApproved','User Approved'] ] as const;
function rowFromMatch(m: MatchRow) {
  const t = m.rdcTxn || m.customerTxn;
  return { sourceFile: t?.sourceFile, sourceSheet: t?.sourceSheet || t?.sourcePage, sourceRow: t?.sourceRow, referenceNo: t?.referenceNo, normalizedReferenceNo: t?.normalizedReferenceNo, date: t?.date, rdcAmount: m.rdcAmount ?? m.rdcTxn?.signedAmountRdcView ?? '', customerAmount: m.customerAmount ?? m.customerTxn?.signedAmountRdcView ?? '', difference: m.difference, matchStatus: m.matchStatus, reasonCode: m.reasonCode, confidence: m.confidence, parserNotes: [t?.parserNotes?.join('; '), m.remarks].filter(Boolean).join('; '), aiExtractedValue: t?.aiExtractedReferences?.join(', '), aiConfidence: t?.aiConfidence, aiReason: t?.aiReason, userApproved: t?.userApproved ? 'Yes' : 'No' };
}
function rowFromTxn(t: NormalizedTxn, status = 'INFO', reason = '') {
  return { sourceFile: t.sourceFile, sourceSheet: t.sourceSheet || t.sourcePage, sourceRow: t.sourceRow, referenceNo: t.referenceNo, normalizedReferenceNo: t.normalizedReferenceNo, date: t.date, rdcAmount: t.sourceSide === 'RDC' ? t.signedAmountRdcView : '', customerAmount: t.sourceSide === 'CUSTOMER' ? t.signedAmountRdcView : '', difference: '', matchStatus: status, reasonCode: reason, confidence: t.parseConfidence, parserNotes: t.parserNotes?.join('; '), aiExtractedValue: t.aiExtractedReferences?.join(', '), aiConfidence: t.aiConfidence, aiReason: t.aiReason, userApproved: t.userApproved ? 'Yes' : 'No' };
}
function addSheet(wb: ExcelJS.Workbook, name: string, rows: Record<string, unknown>[]) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns.map(([key, header]) => ({ key, header, width: Math.max(14, String(header).length + 2) }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF00' } };
  rows.forEach(r => ws.addRow(r));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'Q1' };
}
export async function writeReport(result: ReconcileResult, filePath: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RDC Reconciliation App';
  addSummary(wb, result.summaryLines, result.options.partyName);
  addRecoStatement(wb, result.summaryLines, result.options.partyName);
  addCards(wb, result.cards);
  addSheet(wb, 'Matched_Invoices', result.matches.map(rowFromMatch));
  addSheet(wb, 'Unmatched_RDC', result.unmatchedRdc.map(rowFromMatch));
  addSheet(wb, 'Unmatched_Customer', result.unmatchedCustomer.map(rowFromMatch));
  addSheet(wb, 'Outside_RDC_Period_Customer_Items', result.outsidePeriodCustomer.map(rowFromMatch));
  addSheet(wb, 'Payment_Compare', [...result.matches, ...result.unmatchedRdc, ...result.unmatchedCustomer].filter(m => ['PAYMENT','RECEIPT'].includes(m.rdcTxn?.voucherType || '') || ['PAYMENT','RECEIPT'].includes(m.customerTxn?.voucherType || '')).map(rowFromMatch));
  addSheet(wb, 'Net_Zero_Reversals', result.netZeroReversals.map(t => rowFromTxn(t, 'INFO', 'CUSTOMER_PAYMENT_REVERSAL_NET_ZERO')));
  addSheet(wb, 'Reversal_Netted', result.netZeroReversals.map(t => rowFromTxn(t, 'INFO', 'REVERSAL_PAIR_NET_ZERO')));
  addSheet(wb, 'TDS_Compare', result.tdsCompare.map(rowFromMatch));
  addSheet(wb, 'Journal_Entries_Considered', result.journalEntries.map(t => rowFromTxn(t, 'INFO', t.voucherType === 'JOURNAL_ADJUSTMENT' ? 'JOURNAL_ADJUSTMENT_REVIEW' : '')));
  addSheet(wb, 'Possible_Matches', result.possibleMatches.map(rowFromMatch));
  addSheet(wb, 'Opening_Closing', result.openingClosing.map(rowFromMatch));
  addSheet(wb, 'AI_Review_Log', [
    ...(result.customer.transactions || []).filter(t => t.aiConfidence || t.aiReason || t.aiExtractedReferences?.length).map(t => rowFromTxn(t, 'INFO', 'AI_REVIEW')),
    ...result.possibleMatches.filter(m => m.remarks?.includes('AI review')).map(rowFromMatch),
  ]);
  const log = wb.addWorksheet('Parser_Log');
  log.columns = [{key:'sourceFile',header:'Source File',width:28},{key:'sourceSheet',header:'Source Sheet/Page',width:18},{key:'sourceRow',header:'Source Row/Line',width:16},{key:'level',header:'Level',width:10},{key:'message',header:'Message',width:80},{key:'confidence',header:'Confidence',width:12}];
  result.parserLog.forEach(r=>log.addRow(r));
  log.getRow(1).font={bold:true};
  await wb.xlsx.writeFile(filePath);
}
function addRecoStatement(wb: ExcelJS.Workbook, lines: SummaryLine[], partyName: string) {
  const ws = wb.addWorksheet('Reco_Statement');
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = 'Reconciliation RDC vs ' + partyName;
  ws.getCell('A1').font = { bold: true, size: 15 };
  ws.addRow([]);
  ws.addRow(['Action','Particular','Amount','Remarks']);
  ws.getRow(3).font = { bold: true };
  ws.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF00' } };
  for (const line of lines) {
    const row = ws.addRow([line.sign, line.particular, line.amount, line.remarks || '']);
    row.getCell(3).numFmt = '#,##,##0.00';
    if (/Difference/.test(line.particular)) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF00' } };
  }
  ws.columns = [{width:12},{width:56},{width:18},{width:56}];
}
function addSummary(wb: ExcelJS.Workbook, lines: SummaryLine[], partyName: string) {
  const ws = wb.addWorksheet('Summary_Reco_Statement');
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = 'Reconciliation RDC vs ' + partyName;
  ws.getCell('A1').font = { bold: true, size: 15 };
  ws.addRow([]);
  ws.addRow(['Sign','Particular','Amount','Remarks']);
  ws.getRow(3).font = { bold: true };
  ws.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF00' } };
  for (const line of lines) {
    const row = ws.addRow([line.sign,line.particular,line.amount,line.remarks || '']);
    row.getCell(3).numFmt = '#,##,##0.00';
    if (/Difference/.test(line.particular)) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF00' } };
  }
  ws.columns = [{width:12},{width:56},{width:18},{width:56}];
}
function addCards(wb: ExcelJS.Workbook, cards: Record<string, number>) {
  const ws = wb.addWorksheet('Summary_Cards');
  ws.columns = [{header:'Metric',key:'metric',width:36},{header:'Value',key:'value',width:18}];
  Object.entries(cards).forEach(([metric,value])=>ws.addRow({metric,value}));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFF00'} };
}
