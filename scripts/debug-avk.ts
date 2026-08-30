import path from 'path';
import { extractRawText } from '../src/core/parser';
const F = path.join(process.cwd(), 'test-data-300826-nitesh/AVK Client Ledger.pdf');
(async () => {
  const raw = await extractRawText(F);
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log(`${lines.length} lines`);
  console.log('--- first 18 ---');
  lines.slice(0, 18).forEach((l, i) => console.log(`[${i}] ${JSON.stringify(l.slice(0, 150))}`));
  console.log('--- lines that look like totals / balances ---');
  lines.forEach((l, i) => { if (/total|balance|c\/f|b\/f|carried|brought/i.test(l)) console.log(`[${i}] ${JSON.stringify(l.slice(0, 150))}`); });
})();
