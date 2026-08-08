import path from 'path';
import { parseLedger } from '../src/core/parser';
const DIR = path.join(process.cwd(), 'test-data-250726');
(async () => {
  const rdc = await parseLedger(path.join(DIR, 'RDC Senghani Ledger 6-6-26.xlsx'), 'RDC');
  const cust = await parseLedger(path.join(DIR, 'Senghani -Leela Site ledger.xlsx'), 'CUSTOMER');
  const rec = rdc.transactions.filter(t => t.voucherType === 'RECEIPT');
  const pay = cust.transactions.filter(t => t.voucherType === 'PAYMENT');
  console.log('RDC receipts=' + rec.length + ' total=' + rec.reduce((s,t)=>s+t.signedAmountRdcView,0).toFixed(2));
  console.log('CUST payments=' + pay.length + ' total=' + pay.reduce((s,t)=>s+t.signedAmountRdcView,0).toFixed(2));
  console.log('--- RDC receipts (first 14) ---');
  rec.slice(0,14).forEach(t => console.log('  ' + t.date + '  ' + t.signedAmountRdcView.toFixed(2).padStart(14) + '  ref=' + t.referenceNo));
  console.log('--- CUST payments (first 14) ---');
  pay.slice(0,14).forEach(t => console.log('  ' + t.date + '  ' + t.signedAmountRdcView.toFixed(2).padStart(14) + '  chq=' + t.chequeNo + ' vno=' + t.voucherNo));
  const cn = rdc.transactions.filter(t => t.voucherType === 'CREDIT_NOTE');
  console.log('RDC credit notes=' + cn.length + ' total=' + cn.reduce((s,t)=>s+t.signedAmountRdcView,0).toFixed(2));
  // do CNs cancel invoices exactly?
  const inv = rdc.transactions.filter(t => t.voucherType === 'INVOICE');
  let paired = 0;
  for (const c of cn) { if (inv.some(i => Math.abs(i.signedAmountRdcView + c.signedAmountRdcView) < 1)) paired++; }
  console.log('credit notes whose amount exactly cancels some invoice: ' + paired + '/' + cn.length);
})();
