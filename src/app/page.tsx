import ReconcileForm from './ReconcileForm';
export default async function Page() {
  return <div className="shell"><aside className="side"><h1>RDC Customer and Vendor Reconciliation</h1><p>Parser-first ledger reconciliation with journal, TDS, outside-period, and customer reversal controls.</p><p className="muted" style={{ marginTop: 24 }}><a href="/admin">Admin console</a></p></aside><main className="main"><ReconcileForm /></main></div>;
}
