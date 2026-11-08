import ReconciliationTabs from './ReconciliationTabs';
export default async function Page() {
  return <div className="shell"><aside className="side"><h1>RDC Reconciliation</h1><p>Customer, vendor and bank reconciliation.</p><p className="muted" style={{ marginTop: 24 }}><a href="/admin">Admin console</a></p></aside><main className="main"><ReconciliationTabs /></main></div>;
}
