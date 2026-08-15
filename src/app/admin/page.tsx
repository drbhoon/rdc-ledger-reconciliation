import { getUsageByDay, getUsageRuns, getUsageTotals, usageDbConfigured, usageDbStatus } from '@/core/usageDb';

export const dynamic = 'force-dynamic';

const inr = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const usd = (n: number) => `$${n.toFixed(4)}`;
const RUPEES_PER_USD = 87;

function isoDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function fmtDateTime(value: unknown) {
  if (!value) return '';
  const d = new Date(String(value));
  return isNaN(d.getTime()) ? String(value) : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (key: string) => { const v = params[key]; return Array.isArray(v) ? v[0] : v; };
  const from = one('from') || isoDaysAgo(30);
  const to = one('to') || new Date().toISOString().slice(0, 10);
  const party = one('party') || '';
  const filters = { from, to, party: party || undefined };

  if (!usageDbConfigured()) {
    return (
      <div className="shell">
        <aside className="side"><h1>Admin Console</h1><p>Usage and cost tracking for the reconciliation app.</p></aside>
        <main className="main">
          <section className="band">
            <h2>Database not connected</h2>
            <p className="muted">
              Add a Postgres database to this Railway project and expose its connection string to this
              service as <code>DATABASE_URL</code>. The usage table is created automatically on the first
              reconciliation after that — nothing else to run.
            </p>
          </section>
        </main>
      </div>
    );
  }

  const [totals, byDay, runs] = await Promise.all([
    getUsageTotals(filters),
    getUsageByDay(filters),
    getUsageRuns(filters, 200),
  ]);
  const status = usageDbStatus();

  if (!totals) {
    return (
      <div className="shell">
        <aside className="side"><h1>Admin Console</h1></aside>
        <main className="main">
          <section className="band">
            <h2>Could not reach the database</h2>
            <p className="error">{status.lastError || 'Unknown error'}</p>
            <p className="muted">Reconciliations are unaffected — usage logging fails quietly by design.</p>
          </section>
        </main>
      </div>
    );
  }

  const cards: Array<[string, string]> = [
    ['Reconciliations run', inr(totals.runs)],
    ['Certified', `${inr(totals.certified)}${totals.runs ? ` (${Math.round((totals.certified / totals.runs) * 100)}%)` : ''}`],
    ['Review required', inr(totals.reviewRequired)],
    ['Failed', inr(totals.failed)],
    ['API calls', inr(totals.aiCalls)],
    ['Runs that used AI', `${inr(totals.aiRuns)}${totals.runs ? ` of ${inr(totals.runs)}` : ''}`],
    ['Tokens in / out', `${inr(totals.inputTokens)} / ${inr(totals.outputTokens)}`],
    ['API cost', `${usd(totals.costUsd)}  (≈ ₹${inr(totals.costUsd * RUPEES_PER_USD)})`],
    ['Parties reconciled', inr(totals.parties)],
  ];

  return (
    <div className="shell">
      <aside className="side">
        <h1>Admin Console</h1>
        <p>API usage, cost and reconciliation history.</p>
        <p className="muted" style={{ marginTop: 16 }}>
          Showing {fmtDateTime(totals.firstRun) || '—'} to {fmtDateTime(totals.lastRun) || '—'}.
        </p>
      </aside>
      <main className="main">
        <section className="band">
          <h2>Period</h2>
          <form method="get" className="grid">
            <div className="field"><label>From</label><input type="date" name="from" defaultValue={from} /></div>
            <div className="field"><label>To</label><input type="date" name="to" defaultValue={to} /></div>
            <div className="field"><label>Party contains</label><input type="text" name="party" defaultValue={party} placeholder="all parties" /></div>
            <div className="field"><label>&nbsp;</label><button className="button" type="submit">Apply</button></div>
          </form>
          <p className="muted">
            Counts every reconciliation this app ran in the period. <b>API calls</b> are successful OpenAI
            requests made by the app — most runs make none, because the file was read by a parser.
          </p>
        </section>

        <section className="band">
          <h2>Totals for the period</h2>
          <div className="cards">
            {cards.map(([label, value]) => (
              <div className="card" key={label}><b>{value}</b><span>{label}</span></div>
            ))}
          </div>
        </section>

        {!!byDay?.length && (
          <section className="band">
            <h2>By day</h2>
            <table>
              <thead><tr><th>Date</th><th>Runs</th><th>API calls</th><th>Tokens</th><th>Cost</th></tr></thead>
              <tbody>
                {byDay.map((d, i) => (
                  <tr key={i}>
                    <td>{String(d.day).slice(0, 10)}</td>
                    <td>{inr(Number(d.runs))}</td>
                    <td>{inr(Number(d.ai_calls))}</td>
                    <td>{inr(Number(d.tokens))}</td>
                    <td>{usd(Number(d.cost_usd))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="band">
          <h2>Runs {runs?.length ? `(latest ${runs.length})` : ''}</h2>
          {runs?.length ? (
            <table>
              <thead>
                <tr>
                  <th>When</th><th>Party</th><th>Verdict</th><th>Matched</th><th>Coverage</th>
                  <th>Unexplained</th><th>API calls</th><th>Cost</th><th>Took</th><th>Files</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => (
                  <tr key={i} className={r.status === 'FAILED' ? 'summary-row' : ''}>
                    <td>{fmtDateTime(r.ran_at)}</td>
                    <td>{String(r.party_name ?? '')}</td>
                    <td>{r.status === 'FAILED' ? 'FAILED' : String(r.verdict ?? '')}</td>
                    <td>{inr(Number(r.matched_count ?? 0))}</td>
                    <td>{Number(r.matched_coverage_pct ?? 0).toFixed(2)}%</td>
                    <td>{inr(Number(r.unexplained_difference ?? 0))}</td>
                    <td>{inr(Number(r.ai_calls ?? 0))}</td>
                    <td>{Number(r.ai_cost_usd ?? 0) ? usd(Number(r.ai_cost_usd)) : '—'}</td>
                    <td>{(Number(r.duration_ms ?? 0) / 1000).toFixed(1)}s</td>
                    <td className="muted">{String(r.rdc_file ?? '')} / {String(r.customer_file ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">No reconciliations recorded in this period.</p>}
        </section>

        <section className="band">
          <h2>Export</h2>
          <div className="actions">
            <a className="button link-button" href={`/api/admin/usage?from=${from}&to=${to}${party ? `&party=${encodeURIComponent(party)}` : ''}&format=csv`}>Download CSV</a>
            <a className="button link-button secondary" href={`/api/admin/usage?from=${from}&to=${to}${party ? `&party=${encodeURIComponent(party)}` : ''}`}>View JSON</a>
          </div>
          <p className="muted">The same period and filter as above. CSV opens directly in Excel.</p>
        </section>
      </main>
    </div>
  );
}
