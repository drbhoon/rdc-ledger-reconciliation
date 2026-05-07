import fs from 'fs';
import path from 'path';
import { parseLedger } from '../src/core/parser';
import { reconcile } from '../src/core/reconcile';
import { writeReport } from '../src/core/report';
import { emptyAiUsage, getAiConfig } from '../src/core/aiConfig';
import { aiEnhanceParseResult, aiEnhanceReconciliation } from '../src/services/aiLedgerService';
const root = process.cwd();
const samples = [
  ['Bearys','bearys - RDC -ledger.xlsx','beays  - customer-ledger.xlsx'],
  ['Elite','Elite - RDC Ledger.xlsx','elite - customer - ledger.pdf'],
  ['Pratha Constructions','Pratha Constructions -rdc ledger.xlsx','Pratha Constructions -customer ledger.xlsx'],
  ['Suruchi Developers','Suruchi Developers- RDC Ledger.xlsx','Suruchi Developers -customer Ledger.xlsx'],
] as const;
async function main() {
fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
for (const [party, rdcFile, customerFile] of samples) {
  const rdcPath = path.join(root, rdcFile);
  const customerPath = path.join(root, customerFile);
  const rdc = await parseLedger(rdcPath, 'RDC');
  const customer = await parseLedger(customerPath, 'CUSTOMER');
  const aiConfig = getAiConfig();
  const aiUsage = emptyAiUsage(aiConfig);
  Object.assign(aiUsage, await aiEnhanceParseResult(customer, 'CUSTOMER', aiConfig));
  const result = reconcile(rdc, customer, { partyName: party, periodStart: '2024-04-01', periodEnd: '2026-03-31', invoiceTolerance: 1, paymentTolerance: 1, invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
  result.aiUsage = aiUsage;
  await aiEnhanceReconciliation(result, aiConfig);
  const reportPath = path.join(root, 'reports', party.replace(/[^A-Za-z0-9]+/g, '_') + '_reconciliation.xlsx');
  await writeReport(result, reportPath);
  console.log(JSON.stringify({ party, reportPath, cards: result.cards, summaryLines: result.summaryLines.slice(0, 8) }, null, 2));
}

}
main().catch((error) => { console.error(error); process.exit(1); });
