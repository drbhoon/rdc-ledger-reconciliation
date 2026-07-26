import path from 'path';
import { parseLedger } from '../src/core/parser';
import { ledgerIntegrityGap } from '../src/core/reconcile';
(async () => {
  const p = await parseLedger(path.join(process.cwd(), 'test-data-230726', 'RDC The indogrid Infra 30Jun26.xls'), 'RDC');
  console.log('rows=' + p.transactions.length, 'opening=' + p.balances.opening, 'closing=' + p.balances.closing, 'gap=' + ledgerIntegrityGap(p)?.toFixed(2));
})();
