import assert from 'node:assert/strict';
import { reconcileBank, type BankEntry } from '../src/core/bankRecon';
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
console.log('Bank reconciliation tests passed');
