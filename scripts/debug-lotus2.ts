import path from 'path';
import { extractRawText } from '../src/core/parser';
(async () => {
  const raw = await extractRawText(path.join(process.cwd(), 'test-data-250726', 'Lotus Client Ledger 6-6-26.pdf'));
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log('--- lines 30-60 ---');
  lines.slice(30, 60).forEach((l, i) => console.log('[' + (30 + i) + '] ' + JSON.stringify(l.slice(0, 150))));
  console.log('--- last 18 lines ---');
  lines.slice(-18).forEach((l, i) => console.log('[' + (lines.length - 18 + i) + '] ' + JSON.stringify(l.slice(0, 150))));
})();
