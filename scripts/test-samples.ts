import assert from 'node:assert/strict';
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';

const root = process.cwd();

async function run() {
  process.env.AI_ENABLED = 'false';
  await testSuruchi();
  await testBearys();
  console.log('Sample accounting tests passed');
}

async function testSuruchi() {
  const rdc = await parseLedger(path.join(root, 'Suruchi Developers- RDC Ledger.xlsx'), 'RDC');
  const customer = await parseLedger(path.join(root, 'Suruchi Developers -customer Ledger.xlsx'), 'CUSTOMER');
  const result = reconcile(rdc, customer, sampleOptions('Suruchi Developers'));

  assert.equal(result.netZeroReversals.length, 2, 'Suruchi same-date same-amount debit/credit reversal must net to zero');
  assert.equal(result.cards.netZeroReversalCount, 2, 'Suruchi reversal count must be exposed in cards');
  assert.ok(result.journalEntries.length >= 10, 'Suruchi Journal/JV rows must be considered, not ignored');
  assert.ok(result.outsidePeriodCustomer.length > 0, 'Suruchi outside-period customer entries must be separated');
  assert.ok(result.summaryLines.some((line) => line.reasonCode === 'CUSTOMER_PAYMENT_REVERSAL_NET_ZERO'), 'Summary must mention customer reversal netted to zero');
  assert.ok(result.summaryLines.some((line) => line.reasonCode === 'OUTSIDE_RDC_PERIOD_PRESENT_IN_CUSTOMER'), 'Summary must mention outside-period customer entries');
}

async function testBearys() {
  const rdc = await parseLedger(path.join(root, 'bearys - RDC -ledger.xlsx'), 'RDC');
  const customer = await parseLedger(path.join(root, 'beays  - customer-ledger.xlsx'), 'CUSTOMER');
  const result = reconcile(rdc, customer, sampleOptions('Bearys'));

  assert.ok(customer.transactions.some((txn) => txn.allocationType === 'New Ref'), 'Bearys Tally New Ref rows must parse as child allocations');
  assert.ok(customer.transactions.some((txn) => txn.allocationType === 'Agst Ref'), 'Bearys Tally Agst Ref rows must parse as child allocations');
  assert.ok(result.journalEntries.length > 0, 'Bearys Journal rows must be considered');
  assert.ok(result.tdsCompare.length > 0 || customer.transactions.some((txn) => txn.voucherType === 'JOURNAL_TDS' || txn.voucherType === 'TDS'), 'Bearys TDS Journal entries must be parsed for TDS compare/summary');
}

function sampleOptions(partyName: string) {
  return {
    partyName,
    periodStart: '2024-04-01',
    periodEnd: '2026-03-31',
    invoiceTolerance: 1,
    paymentTolerance: 1,
    invoiceDateToleranceDays: 7,
    paymentDateToleranceDays: 15,
  };
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
