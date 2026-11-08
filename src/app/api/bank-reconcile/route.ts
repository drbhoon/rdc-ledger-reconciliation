import { NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { readBankFiles, reconcileBank, statementBalance, auditBankSequence } from '@/core/bankRecon';

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const files = form.getAll('files').filter((v): v is File => v instanceof File && v.size > 0);
    const requestedCutoff = String(form.get('cutoff') || '');
    if (!files.length || (requestedCutoff && !/^\d{4}-\d{2}-\d{2}$/.test(requestedCutoff))) return new NextResponse('Provide the workbook(s) and a valid reconciliation date.', { status: 400 });
    const parsed = readBankFiles(await Promise.all(files.map(async f => Buffer.from(await f.arrayBuffer()))));
    if (!['BANK', 'PAYMENT', 'RECEIPT'].every(t => parsed.seen.includes(t))) return new NextResponse(`Required bank statement, payment register and receipt register were not all found. Found: ${parsed.seen.join(', ') || 'none'}.`, { status: 400 });
    const bankRows = parsed.entries.filter(e => e.source === 'BANK');
    const bankDates = bankRows.map(e => e.date).sort();
    if (!bankRows.length) return new NextResponse('The bank statement contains no readable transactions.', { status: 400 });
    const cutoff = requestedCutoff || bankDates[bankDates.length - 1];
    const balance = statementBalance(parsed.entries, cutoff, parsed.bankOpening, parsed.bankClosing);
    const result = reconcileBank(parsed.entries, cutoff);
    const warnings = [...parsed.warnings];
    const notes = [...parsed.notes, 'The independent bank-ledger and historical book balances are not in these files. The difference between books and bank cannot be verified.', 'The payment register does not identify held versus released cheques. Unmatched payments are shown together until that distinction is available.', 'Only unique equal-amount reference matches are accepted; grouped and ambiguous transactions remain outstanding.', `Bank statement coverage: ${bankDates[0]} to ${bankDates.at(-1)}. Include prior outstanding items if available; transactions outside the supplied statement cannot be verified.`];
    if (!balance.verified) warnings.push('Bank balance at the selected date could not be verified from the statement opening, transactions and closing; it is not shown.');
    let balanceBreaks = 0;
    for (let i = 1; i < bankRows.length; i++) if (bankRows[i - 1].balance != null && bankRows[i].balance != null && Math.abs(bankRows[i - 1].balance! + bankRows[i].amount - bankRows[i].balance!) > 0.02) balanceBreaks++;
    if (balanceBreaks) {
      if (auditBankSequence(parsed.entries, parsed.bankOpening, parsed.bankClosing)) notes.push('Bank statement rows were out of order. All running balances were verified after reconstructing their chronological sequence.');
      else warnings.push(`Bank statement has ${balanceBreaks} running-balance breaks in source row order; automatic chronological verification could not prove the full sequence.`);
    }
    if (cutoff < bankDates[0] || cutoff > bankDates[bankDates.length - 1]) warnings.push('The bank statement does not cover the selected cutoff date.');
    const lines: { label: string; amount: number | null; remark: string }[] = [
      { label: 'Balance as per Bank Ledger (Cr. Balance)', amount: null, remark: 'Independent ledger balance not supplied' },
      { label: 'Add: Cheque Prepared but not Issued (Hold Cheque)', amount: null, remark: 'Hold status not identified in the supplied register' },
      { label: 'Add: Cash Credit Balance as per Book as on 31.03.2024', amount: null, remark: 'Historical book balance not supplied' },
      { label: 'Add: Cheque Issued but not Presented in Bank (Released Cheque)', amount: null, remark: 'Released status not identified in the supplied register' },
      { label: 'Unmatched book payments — held / released status not determined', amount: result.lines[0].amount, remark: 'Includes non-cheque payments; see details' },
      { label: 'Less: Cheque Debited by Bank but not accounted by us', amount: result.lines[2].amount, remark: 'Bank debits not matched to supplied payment register; includes other payment methods' },
      { label: 'Less: Cheque deposited in bank but not credited in Bank', amount: result.lines[1].amount, remark: 'Receipts not matched to supplied bank statement; includes other receipt methods' },
      { label: 'Add: Cheque Credited by Bank but not accounted by us', amount: result.lines[3].amount, remark: 'Bank credits not matched to supplied receipt register; includes other receipt methods' },
      { label: 'Balance as per Bank Statement (Cr. Balance)', amount: balance.balance ?? null, remark: balance.verified ? 'Calculated from statement opening and transactions at cutoff' : 'Not verifiable from supplied statement' },
    ];
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Bank Reconciliation');
    ws.addRow(['Bank Reconciliation Statement', '', '', '', '', '', '', '']);
    ws.addRow(['As at', cutoff]); ws.addRow(['Account', String(form.get('account') || '')]); ws.addRow([]);
    ws.addRow(['Particulars', 'Signed amount']);
    ws.addRow(['Bank statement opening balance', parsed.bankOpening ?? 'Not available']);
    for (const line of lines) ws.addRow([line.label, line.amount ?? 'Not available', line.remark]);
    ws.addRow(['Difference between book and bank balances', 'Not available: book balance not supplied']);
    ws.addRow([]); ws.addRow(['Unreconciled items at cutoff']);
    ws.addRow(['Source', 'Date', 'Reference', 'Description', 'Signed amount', 'Status', 'Source sheet', 'Source row', 'Later matching date', 'Later matching reference']);
    for (const e of result.outstanding) { const m = result.later.get(e.id); const counterpart = m && (e.source === 'BANK' ? m.book : m.bank); ws.addRow([e.source, e.date, e.reference, e.description, e.amount, e.status, e.sheet, e.row, counterpart?.date || '', counterpart?.reference || '']); }
    ws.getColumn(1).width = 28; ws.getColumn(2).width = 18; ws.getColumn(3).width = 24; ws.getColumn(4).width = 54; for (let c = 5; c <= 10; c++) ws.getColumn(c).width = 20;
    ws.getRow(1).font = { bold: true, size: 14 }; ws.getRow(5).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 5 }];
    const matched = wb.addWorksheet('Matched'); matched.addRow(['Book source', 'Book date', 'Book reference', 'Book amount', 'Book sheet', 'Book row', 'Bank date', 'Bank reference', 'Bank amount', 'Bank sheet', 'Bank row', 'Evidence']);
    for (const m of result.matches) matched.addRow([m.book.source, m.book.date, m.book.reference, m.book.amount, m.book.sheet, m.book.row, m.bank.date, m.bank.reference, m.bank.amount, m.bank.sheet, m.bank.row, m.evidence]);
    matched.columns.forEach(c => { c.width = 22; }); matched.getRow(1).font = { bold: true };
    const checks = wb.addWorksheet('Checks'); checks.addRow(['Review notes']); [...warnings, ...notes].forEach(w => checks.addRow([w])); checks.getColumn(1).width = 110;
    const id = uuid(), dir = path.join(process.cwd(), 'reports'); fs.mkdirSync(dir, { recursive: true });
    await wb.xlsx.writeFile(path.join(dir, `${id}_reconciliation.xlsx`));
    return NextResponse.json({ runId: id, cutoff, bankOpening: parsed.bankOpening ?? null, bankBalance: balance.balance ?? null, bankClosing: parsed.bankClosing ?? null, lines, matched: result.matches.length, outstanding: result.outstanding.map(e => ({ source: e.source, date: e.date, reference: e.reference, description: e.description, amount: e.amount, status: e.status, laterDate: result.later.get(e.id) ? (e.source === 'BANK' ? result.later.get(e.id)!.book.date : result.later.get(e.id)!.bank.date) : '' })), warnings, notes });
  } catch (e) { console.error('Bank reconciliation failed', e); return new NextResponse(e instanceof Error ? e.message : 'Bank reconciliation failed', { status: 500 }); }
}
