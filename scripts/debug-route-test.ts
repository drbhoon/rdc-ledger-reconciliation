import fs from 'fs';
import path from 'path';
const DIR = path.join(process.cwd(), 'test-data-280726');
const file = (name: string, type: string) => new File([fs.readFileSync(path.join(DIR, name))], name, { type });
(async () => {
  const form = new FormData();
  form.set('partyName', 'Henna route test');
  form.set('periodStart', '2025-04-01');
  form.set('periodEnd', '2026-08-31');
  form.set('invoiceTolerance', '1');
  form.set('paymentTolerance', '1');
  form.set('rdc', file('RDC_henna 5th.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  form.set('customer', file('Customer Hena 5th.pdf', 'application/pdf'));
  const res = await fetch('http://localhost:3010/api/reconcile', { method: 'POST', body: form });
  const text = await res.text();
  console.log('HTTP ' + res.status);
  if (!res.ok) { console.log(text.slice(0, 300)); return; }
  const json = JSON.parse(text);
  console.log('verdict=' + json.cards.verdict + ' matched=' + json.cards.matchedCount + ' coverage=' + json.cards.matchedCoveragePct + '%');
  console.log('aiUsage: calls=' + json.aiUsage.apiCalls + ' tokens=' + json.aiUsage.inputTokens + '/' + json.aiUsage.outputTokens + ' cost=' + json.aiUsage.estimatedCostUsd);
})();
