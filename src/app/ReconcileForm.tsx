'use client';
import { useState } from 'react';

type ApiResult = { runId: string; reportPath: string; cards: Record<string, number>; summaryLines: Array<{ sign: string; particular: string; amount: number; remarks?: string }>; aiUsage?: { enabled: boolean; model: string; rowsReviewed: number; referencesExtracted: number; journalRowsClassified: number; possibleMatchesSuggested: number; autoAccepted: number; requiresHumanReview: number } };
function inr(value: number) { return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0); }
export default function ReconcileForm() {
  const [result, setResult] = useState<ApiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(''); setResult(null);
    try {
      const form = new FormData(event.currentTarget);
      const res = await fetch('/api/reconcile', { method: 'POST', body: form });
      const text = await res.text();
      if (!res.ok) {
        setError(text || `Reconciliation failed with HTTP ${res.status}`);
        return;
      }
      setResult(JSON.parse(text));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reconciliation failed unexpectedly');
    } finally {
      setBusy(false);
    }
  }
  return <>
    <section className="band"><h2>Run Reconciliation</h2><form onSubmit={submit} action="/api/reconcile" method="post" encType="multipart/form-data"><div className="grid"><div className="field"><label>Customer / Vendor Name</label><input name="partyName" autoComplete="organization" required /></div><div className="field"><label>Period Start</label><input name="periodStart" type="date" required /></div><div className="field"><label>Period End</label><input name="periodEnd" type="date" required /></div><div className="field"><label>Invoice Tolerance</label><input name="invoiceTolerance" type="number" defaultValue="1" /></div><div className="field"><label>Payment Tolerance</label><input name="paymentTolerance" type="number" defaultValue="1" /></div><div className="field"><label>RDC Ledger</label><input name="rdc" type="file" accept=".xlsx,.xls,.csv,.pdf" required /></div><div className="field"><label>Customer Ledger</label><input name="customer" type="file" accept=".xlsx,.xls,.csv,.pdf" required /></div><div className="field"><label>&nbsp;</label><button className="button" type="submit" disabled={busy}>{busy ? 'Running...' : 'Run & Export'}</button></div></div></form>{busy && <p className="muted">Running parser and reconciliation. Large PDF ledgers can take a little while.</p>}{error && <p className="error">{error}</p>}</section>
    {result && <section className="band"><h2>Result</h2>{result.aiUsage && <div className="ai-strip"><b>AI {result.aiUsage.enabled ? 'enabled' : 'disabled'}</b><span>Model: {result.aiUsage.model}</span><span>Rows reviewed: {result.aiUsage.rowsReviewed}</span><span>References extracted: {result.aiUsage.referencesExtracted}</span><span>Journals classified: {result.aiUsage.journalRowsClassified}</span><span>Possible matches: {result.aiUsage.possibleMatchesSuggested}</span><span>Needs review: {result.aiUsage.requiresHumanReview}</span></div>}<div className="cards">{Object.entries(result.cards).map(([k,v]) => <div className="card" key={k}><b>{typeof v === 'number' && Math.abs(v) > 999 ? inr(v) : v}</b><span>{k.replace(/([A-Z])/g, ' $1')}</span></div>)}</div><div className="actions"><a className="button link-button" href={`/api/runs/${result.runId}/report`}>Excel Report</a><a className="button link-button secondary" href={`/api/runs/${result.runId}/summary-pdf`}>Summary PDF</a></div><p className="muted">Excel report: {result.reportPath}</p><table><thead><tr><th>Sign</th><th>Particular</th><th>Amount</th><th>Remarks</th></tr></thead><tbody>{result.summaryLines.map((l, i) => <tr key={i} className={/Difference/.test(l.particular) ? 'summary-row' : ''}><td>{l.sign}</td><td>{l.particular}</td><td>{inr(l.amount)}</td><td>{l.remarks}</td></tr>)}</tbody></table></section>}
  </>;
}
