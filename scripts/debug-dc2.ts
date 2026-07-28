import path from 'path';
import { extractRawText } from '../src/core/parser';
(async () => {
  const raw = await extractRawText(path.join(process.cwd(), 'test-data-240726', 'vendor kedger  dalmia chennai.PDF'));
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  lines.slice(45, 95).forEach((l, i) => console.log('[' + (45 + i) + '] ' + JSON.stringify(l.slice(0, 170))));
})();
