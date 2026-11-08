'use client';
import { useState } from 'react';

type Result = { runId: string; cutoff: string; bankOpening: number | null; bankBalance: number | null; lines: { label: string; amount: number }[]; matched: number; outstanding: { source: string; date: string; reference: string; description: string; amount: number; status: string; laterDate: string }[]; warnings: string[] };
const money = (n: number) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
export default function BankForm() {
  const [result, setResult] = useState<Result | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [page, setPage] = useState(0);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError(''); setResult(null); setPage(0);
    try { const r = await fetch('/api/bank-reconcile', { method: 'POST', body: new FormData(e.currentTarget) }); const text = await r.text(); if (!r.ok) throw new Error(text); setResult(JSON.parse(text)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Reconciliation failed'); } finally { setBusy(false); }
  }
  return <><section className="band"><h2>Bank Reconciliation</h2><p>Upload the HDFC workbook or separate Excel/CSV files containing the bank statement, payment register and receipt register. Include earlier outstanding transactions.</p><form onSubmit={submit}><div className="grid">
    <div className="field"><label>Bank account (optional)</label><input name="account" /></div>
    <div className="field"><label>Reconciliation date (optional; defaults to latest bank date)</label><input name="cutoff" type="date" /></div>
    <div className="field"><label>Source workbook(s)</label><input name="files" type="file" multiple accept=".xls,.xlsx,.csv" required /></div>
    <div className="field"><label>&nbsp;</label><button className="button" disabled={busy}>{busy ? 'Reconciling…' : 'Run bank reconciliation'}</button></div>
  </div></form>{error && <p className="error">{error}</p>}</section>
  {result && <section className="band"><h2>Bank Reconciliation as at {result.cutoff}</h2><p>{result.matched} reference matches; {result.outstanding.length} items outstanding at cutoff. Signed amounts use positive for an asset balance and negative for an overdraft.</p><table><thead><tr><th>Particulars</th><th>Amount</th></tr></thead><tbody><tr><td>Bank statement opening balance</td><td>{result.bankOpening == null ? 'Not available' : money(result.bankOpening)}</td></tr><tr className="summary-row"><td>Bank balance at reconciliation date</td><td>{result.bankBalance == null ? 'Not verifiable' : money(result.bankBalance)}</td></tr>{result.lines.map(l => <tr key={l.label}><td>{l.label}</td><td>{money(l.amount)}</td></tr>)}</tbody></table><div className="actions"><a className="button link-button" href={`/api/runs/${result.runId}/report`}>Download BRS and outstanding items</a></div>{result.warnings.map((w, i) => <p className="error" key={i}>{w}</p>)}<h3>Unreconciled items at cutoff</h3><div style={{ overflowX: 'auto' }}><table><thead><tr><th>Source</th><th>Date</th><th>Reference</th><th>Description</th><th>Amount</th><th>Status</th><th>Later match</th></tr></thead><tbody>{result.outstanding.slice(page * 100, page * 100 + 100).map((e, i) => <tr key={i}><td>{e.source}</td><td>{e.date}</td><td>{e.reference}</td><td>{e.description}</td><td>{money(e.amount)}</td><td>{e.status}</td><td>{e.laterDate}</td></tr>)}</tbody></table></div><div className="actions"><button className="button secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {Math.max(1, Math.ceil(result.outstanding.length / 100))}</span><button className="button secondary" disabled={(page + 1) * 100 >= result.outstanding.length} onClick={() => setPage(page + 1)}>Next</button></div></section>}</>;
}
