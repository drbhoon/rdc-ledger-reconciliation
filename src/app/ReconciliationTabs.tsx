'use client';
import { useState } from 'react';
import ReconcileForm from './ReconcileForm';
import BankForm from './BankForm';
export default function ReconciliationTabs() {
  const [tab, setTab] = useState<'ledger' | 'bank'>('ledger');
  return <><nav className="actions" aria-label="Reconciliation type"><button className={`button ${tab !== 'ledger' ? 'secondary' : ''}`} onClick={() => setTab('ledger')} aria-pressed={tab === 'ledger'}>Customer / Vendor</button><button className={`button ${tab !== 'bank' ? 'secondary' : ''}`} onClick={() => setTab('bank')} aria-pressed={tab === 'bank'}>Bank Reconciliation</button></nav>{tab === 'ledger' ? <ReconcileForm /> : <BankForm />}</>;
}
