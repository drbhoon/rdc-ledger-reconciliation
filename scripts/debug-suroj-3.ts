/** Find (1) the ₹37 customer integrity gap and (2) what sits in the
 * "reference truncated / low confidence" bucket. */
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';
import { parseAmount } from '../src/core/amount';

const DIR = path.join(process.cwd(), 'test-data-230726');
(async () => {
  const cust = await parseLedger(path.join(DIR, 'SUROJ LEDGER 2.xlsx'), 'CUSTOMER');
  const wb = XLSX.read(fs.readFileSync(path.join(DIR, 'SUROJ LEDGER 2.xlsx')), { cellDates: true, type: 'buffer' });
  const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['SUROJ'], { header: 1, defval: '', raw: true });
  const parsedRows = new Set(cust.transactions.map(t => Number(t.sourceRow)));
  console.log('rows in sheet (data 2..end):', m.length - 2, 'parsed:', cust.transactions.length);
  let missingSum = 0;
  for (let i = 2; i < m.length; i++) {
    const row = m[i] as unknown[];
    const gross = parseAmount(String(row[6] ?? ''));
    if (!gross) continue;
    if (!parsedRows.has(i + 1)) {
      missingSum += gross;
      console.log(`  NOT PARSED [sheet row ${i + 1}] date="${row[0]}" vtype="${row[2]}" vno="${row[3]}" ref="${row[4]}" gross=${gross}`);
    }
  }
  console.log('sum of unparsed gross =', missingSum.toFixed(2));
  console.log('opening captured =', cust.balances.opening, ' closing =', cust.balances.closing);

  const rdc = await parseLedger(path.join(DIR, 'RDC SUROJ  LEDGER.xlsx'), 'RDC');
  const r = reconcile(rdc, cust, { partyName: 'SUROJ', periodStart: '2010-04-01', periodEnd: '2026-03-31', invoiceTolerance: 2, paymentTolerance: 2, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  const low = r.unmatchedRdc.filter(x => x.reasonCode === 'LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED');
  const lowC = r.unmatchedCustomer.filter(x => x.reasonCode === 'LOW_PARSE_CONFIDENCE_REFERENCE_NOT_EXTRACTED');
  console.log(`\nlow-confidence bucket: rdc=${low.length} cust=${lowC.length}`);
  for (const x of low.slice(0, 10)) console.log(`  RDC ${x.rdcTxn?.date} ${x.rdcTxn?.voucherType} ref="${x.rdcTxn?.referenceNo}" conf=${x.rdcTxn?.parseConfidence} notes=${JSON.stringify(x.rdcTxn?.parserNotes)} amt=${x.rdcAmount}`);
  for (const x of lowC.slice(0, 6)) console.log(`  CUST ${x.customerTxn?.date} ${x.customerTxn?.voucherType} ref="${x.customerTxn?.referenceNo}" conf=${x.customerTxn?.parseConfidence} amt=${x.customerAmount}`);

  // post-customer-ledger-start receipts still unmatched?
  const matchedRdcIds = new Set(r.matches.map(x => x.rdcTxn?.id));
  const recs = rdc.transactions.filter(t => t.voucherType === 'RECEIPT' && (t.date || '') >= '2020-04-24');
  const un = recs.filter(t => !matchedRdcIds.has(t.id));
  console.log(`\nRDC receipts on/after customer ledger start: ${recs.length}, unmatched ${un.length}, unmatched value ${un.reduce((s, t) => s + t.signedAmountRdcView, 0).toFixed(2)}`);
  for (const t of un.slice(0, 12)) console.log(`  ${t.date} ref="${t.referenceNo}" amt=${t.signedAmountRdcView}`);
})();
