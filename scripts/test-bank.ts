import assert from 'node:assert/strict';
import { auditBankSequence, reconcileBank, statementBalance, readBankFiles, type BankEntry } from '../src/core/bankRecon';
import * as XLSX from 'xlsx';
const entry = (id: string, source: BankEntry['source'], date: string, amount: number, reference: string): BankEntry => ({ id, source, date, amount, reference, sheet: source, row: 1, description: '', status: '' });
const entries = [
  entry('p1', 'PAYMENT', '2026-10-20', -100, 'CHEQUE123456'),
  entry('b1', 'BANK', '2026-10-23', -100, 'CHEQUE123456'),
  entry('r1', 'RECEIPT', '2026-10-20', 50, 'RECEIPT123456'),
  entry('b2', 'BANK', '2026-10-20', 30, 'BANK123456'),
  entry('p2', 'PAYMENT', '2026-10-20', -20, 'MATCH123456'),
  entry('b3', 'BANK', '2026-10-20', -20, 'MATCH123456'),
];
const r = reconcileBank(entries, '2026-10-22', 1000, 1080);
assert.equal(r.calculated, 1080);
assert.equal(r.difference, 0);
assert.deepEqual(r.outstanding.map(e => e.id), ['p1', 'r1', 'b2']);
assert.equal(r.later.get('p1')?.bank.date, '2026-10-23');
assert.equal(r.matches.length, 2);
const ambiguous = reconcileBank([entry('p', 'PAYMENT', '2026-10-20', -50, 'CHECK12345'), entry('b1', 'BANK', '2026-10-20', -50, 'CHECK12345'), entry('b2', 'BANK', '2026-10-20', -50, 'CHECK12345')], '2026-10-22', 0, 0);
assert.equal(ambiguous.matches.length, 0);
assert.equal(ambiguous.outstanding.length, 3);
const statement = [entry('s1', 'BANK', '2026-10-01', -100, 'ONE123456'), entry('s2', 'BANK', '2026-10-23', 50, 'TWO123456')];
assert.deepEqual(statementBalance(statement, '2026-10-22', 1000, 950), { balance: 900, verified: true });
assert.deepEqual(statementBalance(statement, '2026-10-23', 1000, 950), { balance: 950, verified: true });
assert.equal(statementBalance(statement, '2026-10-22', 1000, 949).balance, undefined);
assert.equal(statementBalance(statement, '2026-09-30', 1000, 950).balance, undefined);
assert.equal(reconcileBank(entries, '2026-10-22').difference, undefined);
const reorder = [
  { ...entry('a', 'BANK', '2026-10-01', -10, 'A123456'), time: '10:00:00', balance: 100 },
  { ...entry('b', 'BANK', '2026-10-01', 10, 'B123456'), time: '10:00:00', balance: 110 },
];
assert.equal(auditBankSequence(reorder, 100, 100), true, 'same-time rows can be reconstructed without dropping them');
assert.equal(auditBankSequence(reorder, 99, 100), false, 'incorrect opening balance must fail');
const wb = XLSX.utils.book_new();
const headers = ['Transaction Date', 'Transaction Description', 'PAYMENT', 'RECEIPT', 'Debit / Credit', 'Reference No.', 'Value Date', 'Running Balance'];
const record = ['01/10/2026 10:00:00', 'Test', 10, 0, 'D', 'REF123456', '01/10/2026', 90];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Opening Balance', 100], ['Closing Balance', 90], headers, record, headers]), 'Bank');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, record]), 'Copy');
const parsed = readBankFiles([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]);
assert.equal(parsed.entries.length, 1, 'repeated headers and duplicate-sheet rows must not become transactions');
assert.equal(parsed.warnings.length, 0);
assert.ok(parsed.notes.some(n => n.includes('already appear')));
console.log('Bank reconciliation tests passed');
