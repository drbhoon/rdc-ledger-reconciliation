import * as XLSX from 'xlsx';
import { parseAmount } from './amount';
import { parseDate, daysBetween } from './date';

export type BankEntry = { id: string; source: 'BANK' | 'PAYMENT' | 'RECEIPT'; sheet: string; row: number; date: string; amount: number; reference: string; description: string; status: string; balance?: number };
export type BankMatch = { bank: BankEntry; book: BankEntry; evidence: string };
const clean = (s: unknown) => String(s ?? '').trim();
const key = (s: string) => {
  const normalized = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+(?=\d)/, '') : normalized;
};
const hasReference = (b: BankEntry, ref: string) => key(b.reference) === ref || b.description.split(/[^A-Za-z0-9]+/).some(token => key(token) === ref);
const date = (v: unknown) => parseDate(typeof v === 'string' ? v.trim().replace(/\s+\d{1,2}:\d{2}:\d{2}$/, '') : v);
const col = (row: unknown[], name: RegExp) => row.findIndex(v => name.test(clean(v)));

export function readBankFiles(files: Buffer[]): { entries: BankEntry[]; warnings: string[]; seen: string[] } {
  const entries: BankEntry[] = [], warnings: string[] = [], seen = new Set<string>();
  for (let f = 0; f < files.length; f++) {
    const wb = XLSX.read(files[f], { type: 'buffer', cellDates: true });
    for (const sheet of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, defval: '', raw: true });
      let header = -1, type: BankEntry['source'] | undefined;
      for (let i = 0; i < Math.min(rows.length, 20); i++) {
        const s = rows[i].map(clean).join('|');
        if (/transaction date/i.test(s) && /transaction description/i.test(s) && /running balance/i.test(s)) { header = i; type = 'BANK'; break; }
        if (/receipt number/i.test(s) && /receipt amount/i.test(s)) { header = i; type = 'RECEIPT'; break; }
        if (/check number/i.test(s) && /check date/i.test(s) && /cleared amount/i.test(s)) { header = i; type = 'PAYMENT'; break; }
      }
      if (!type) continue;
      // Do not silently combine two copies of a statement or register.
      if (seen.has(type)) { warnings.push(`Skipped additional ${type} sheet ${sheet}; select one source per type.`); continue; }
      seen.add(type);
      const h = rows[header];
      const dt = col(h, type === 'BANK' ? /^transaction date$/i : type === 'PAYMENT' ? /^check date$/i : /^receipt date$/i);
      const amount = col(h, type === 'PAYMENT' ? /^cleared amount$/i : /^receipt amount$/i);
      const debit = col(h, /^payment$/i), credit = col(h, /^receipt$/i);
      const ref = col(h, type === 'BANK' ? /^reference no/i : type === 'PAYMENT' ? /^check number$/i : /^receipt number$/i);
      const desc = col(h, type === 'BANK' ? /^transaction description$/i : type === 'PAYMENT' ? /^vendor name$/i : /^customer name$/i);
      const status = col(h, type === 'PAYMENT' ? /^check status$/i : /^status$/i);
      const balance = col(h, /^running balance$/i), comment = col(h, /^comment$/i);
      let skipped = 0;
      for (let i = header + 1; i < rows.length; i++) {
        const row = rows[i]; const d = date(row[dt]);
        const a = type === 'BANK' ? parseAmount(row[credit]) - parseAmount(row[debit]) : Math.abs(parseAmount(row[amount])) * (type === 'PAYMENT' ? -1 : 1);
        if (!d || !a) { if (row.some(v => clean(v))) skipped++; continue; }
        entries.push({ id: `${f}:${sheet}:${i + 1}`, source: type, sheet, row: i + 1, date: d, amount: Math.round(a * 100) / 100, reference: clean(row[ref]), description: [clean(row[desc]), comment >= 0 ? clean(row[comment]) : ''].filter(Boolean).join(' | '), status: status >= 0 ? clean(row[status]) : '', balance: balance >= 0 && clean(row[balance]) ? parseAmount(row[balance]) : undefined });
      }
      if (skipped) warnings.push(`${sheet}: ${skipped} non-empty rows could not be read as dated transactions; review source.`);
    }
  }
  return { entries, warnings, seen: [...seen] };
}

export function reconcileBank(entries: BankEntry[], cutoff: string, bookBalance: number, bankBalance: number) {
  const bank = entries.filter(e => e.source === 'BANK'), book = entries.filter(e => e.source !== 'BANK');
  const used = new Set<string>(); const matches: BankMatch[] = [];
  const buckets = new Map<string, BankEntry[]>();
  for (const b of bank) { const k = String(Math.round(b.amount * 100)); buckets.set(k, [...(buckets.get(k) || []), b]); }
  const bookBuckets = new Map<string, BankEntry[]>();
  for (const b of book) { const k = String(Math.round(b.amount * 100)); bookBuckets.set(k, [...(bookBuckets.get(k) || []), b]); }
  // Exact amount + a meaningful reference appearing in either bank field.
  // Match only uniquely identified candidates; equal amounts alone are unsafe.
  for (const t of book) {
    if (/cancel|void/i.test(t.status)) continue;
    const refs = [t.reference, ...t.description.split(/[^A-Za-z0-9]+/)].map(key).filter(s => s.length >= 6 && /\d/.test(s) && !/^0+$/.test(s));
    const candidates = (buckets.get(String(Math.round(t.amount * 100))) || []).filter(b => !used.has(b.id) && daysBetween(t.date, b.date) <= 180 && refs.some(ref => hasReference(b, ref)));
    if (candidates.length !== 1) continue;
    const b = candidates[0];
    // Reject a reference shared by multiple book candidates of the same amount.
    const competing = (bookBuckets.get(String(Math.round(t.amount * 100))) || []).filter(x => x.id !== t.id && !used.has(x.id) && daysBetween(x.date, b.date) <= 180 && [x.reference, ...x.description.split(/[^A-Za-z0-9]+/)].map(key).some(ref => ref.length >= 6 && /\d/.test(ref) && hasReference(b, ref)));
    if (competing.length) continue;
    used.add(t.id); used.add(b.id); matches.push({ bank: b, book: t, evidence: 'Amount and reference' });
  }
  const pairedAtCutoff = new Set(matches.filter(m => m.bank.date <= cutoff && m.book.date <= cutoff).flatMap(m => [m.bank.id, m.book.id]));
  const later = new Map<string, BankMatch>();
  for (const m of matches) { if (m.book.date <= cutoff && m.bank.date > cutoff) later.set(m.book.id, m); if (m.bank.date <= cutoff && m.book.date > cutoff) later.set(m.bank.id, m); }
  const outstanding = entries.filter(e => e.date <= cutoff && !pairedAtCutoff.has(e.id) && !/cancel|void/i.test(e.status));
  const total = (fn: (e: BankEntry) => boolean) => Math.round(outstanding.filter(fn).reduce((s, e) => s + e.amount, 0) * 100) / 100;
  const lines = [
    { label: 'Balance as per bank ledger (asset positive; overdraft negative)', amount: bookBalance },
    { label: 'Add: payments recorded in books, not debited by bank', amount: -total(e => e.source === 'PAYMENT') },
    { label: 'Less: receipts recorded in books, not credited by bank', amount: -total(e => e.source === 'RECEIPT') },
    { label: 'Less: bank debits not recorded in books', amount: total(e => e.source === 'BANK' && e.amount < 0) },
    { label: 'Add: bank credits not recorded in books', amount: total(e => e.source === 'BANK' && e.amount > 0) },
  ];
  const calculated = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { matches, outstanding, later, lines, calculated, bankBalance, difference: Math.round((calculated - bankBalance) * 100) / 100 };
}
