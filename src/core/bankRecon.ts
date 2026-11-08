import * as XLSX from 'xlsx';
import { parseAmount } from './amount';
import { parseDate, daysBetween } from './date';

export type BankEntry = { id: string; source: 'BANK' | 'PAYMENT' | 'RECEIPT'; sheet: string; row: number; date: string; time?: string; amount: number; reference: string; description: string; status: string; balance?: number };
export type BankMatch = { bank: BankEntry; book: BankEntry; evidence: string };
const clean = (s: unknown) => String(s ?? '').trim();
const key = (s: string) => {
  const normalized = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+(?=\d)/, '') : normalized;
};
const hasReference = (b: BankEntry, ref: string) => key(b.reference) === ref || b.description.split(/[^A-Za-z0-9]+/).some(token => key(token) === ref);
const date = (v: unknown) => parseDate(typeof v === 'string' ? v.trim().replace(/\s+\d{1,2}:\d{2}:\d{2}$/, '') : v);
const col = (row: unknown[], name: RegExp) => row.findIndex(v => name.test(clean(v)));

export function readBankFiles(files: Buffer[]): { entries: BankEntry[]; warnings: string[]; notes: string[]; seen: string[]; bankOpening?: number; bankClosing?: number } {
  const entries: BankEntry[] = [], warnings: string[] = [], notes: string[] = [], seen = new Set<string>();
  let firstBankRows = new Map<string, number>();
  const bankFingerprint = (row: unknown[], header: unknown[]) => {
    const at = (pattern: RegExp) => clean(row[col(header, pattern)]);
    return JSON.stringify([at(/^transaction date$/i), at(/^transaction description$/i), parseAmount(row[col(header, /^payment$/i)]), parseAmount(row[col(header, /^receipt$/i)]), at(/^reference no/i), at(/^value date$/i), at(/^running balance$/i)]);
  };
  let bankOpening: number | undefined, bankClosing: number | undefined;
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
      if (seen.has(type)) {
        if (type === 'BANK') {
          const remaining = new Map(firstBankRows); let distinct = 0, checked = 0;
          for (const row of rows.slice(header + 1)) {
            if (!date(row[col(rows[header], /^transaction date$/i)])) continue;
            const fingerprint = bankFingerprint(row, rows[header]); const count = remaining.get(fingerprint) || 0;
            if (count) { remaining.set(fingerprint, count - 1); checked++; } else distinct++;
          }
          if (checked && !distinct) notes.push(`Additional bank sheet ${sheet} was checked: its ${checked} transactions already appear in the selected statement, so they were not counted twice.`);
          else warnings.push(`Additional bank sheet ${sheet} contains ${distinct} row(s) not identified in the selected statement. It was not included; review for missing transactions.`);
        } else warnings.push(`Skipped additional ${type} sheet ${sheet}; select one source per type.`);
        continue;
      }
      seen.add(type);
      if (type === 'BANK') {
        for (const row of rows.slice(0, header)) {
          const label = clean(row[0]);
          if (/^opening balance$/i.test(label) && clean(row[1])) bankOpening = parseAmount(row[1]);
          if (/^closing balance$/i.test(label) && clean(row[1])) bankClosing = parseAmount(row[1]);
        }
      }
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
        if (type === 'BANK' && /^transaction date$/i.test(clean(row[dt])) && /transaction description/i.test(clean(row[desc]))) continue;
        if (!d || !a) { if (row.some(v => clean(v))) skipped++; continue; }
        if (type === 'BANK') { const fingerprint = bankFingerprint(row, h); firstBankRows.set(fingerprint, (firstBankRows.get(fingerprint) || 0) + 1); }
        const time = typeof row[dt] === 'string' ? row[dt].match(/\b(\d{2}:\d{2}:\d{2})\s*$/)?.[1] : undefined;
        entries.push({ id: `${f}:${sheet}:${i + 1}`, source: type, sheet, row: i + 1, date: d, time, amount: Math.round(a * 100) / 100, reference: clean(row[ref]), description: [clean(row[desc]), comment >= 0 ? clean(row[comment]) : ''].filter(Boolean).join(' | '), status: status >= 0 ? clean(row[status]) : '', balance: balance >= 0 && clean(row[balance]) ? parseAmount(row[balance]) : undefined });
      }
      if (skipped) warnings.push(`${sheet}: ${skipped} non-empty rows could not be read as dated transactions; review source.`);
    }
  }
  return { entries, warnings, notes, seen: [...seen], bankOpening, bankClosing };
}

/** Verify the running balance in chronological order. Transactions with the
 * same timestamp can be ordered by their balance transitions; never merge or
 * discard rows. All transitions must form a continuous path from opening. */
export function auditBankSequence(entries: BankEntry[], opening?: number, closing?: number): boolean {
  const bank = entries.filter(e => e.source === 'BANK');
  if (opening == null || closing == null || !bank.length || bank.some(e => e.balance == null)) return false;
  const groups = new Map<string, BankEntry[]>();
  for (const e of bank) { const k = e.date + ' ' + (e.time || ''); const list = groups.get(k) || []; list.push(e); groups.set(k, list); }
  let current = Math.round(opening * 100);
  for (const groupKey of [...groups.keys()].sort()) {
    const group = groups.get(groupKey)!;
    const edges = new Map<number, number[]>();
    for (const e of group) { const end = Math.round(e.balance! * 100); const start = end - Math.round(e.amount * 100); const out = edges.get(start) || []; out.push(end); edges.set(start, out); }
    const stack = [current]; const path: number[] = [];
    while (stack.length) { const v = stack[stack.length - 1], out = edges.get(v); if (out?.length) stack.push(out.pop()!); else path.push(stack.pop()!); }
    if (path.length !== group.length + 1) return false;
    path.reverse();
    // Hierholzer only yields a valid contiguous path when every original edge
    // is represented, including when balance values repeat.
    const counts = new Map<string, number>();
    for (const e of group) { const end = Math.round(e.balance! * 100); const start = end - Math.round(e.amount * 100); const k = `${start}:${end}`; counts.set(k, (counts.get(k) || 0) + 1); }
    for (let i = 1; i < path.length; i++) { const k = `${path[i - 1]}:${path[i]}`; const n = counts.get(k) || 0; if (!n) return false; counts.set(k, n - 1); }
    current = path[path.length - 1];
  }
  return current === Math.round(closing * 100);
}

/** Compute a cutoff balance only when the statement's opening, all parsed
 * movements and printed closing agree; never use a zero as a missing balance. */
export function statementBalance(entries: BankEntry[], cutoff: string, opening?: number, closing?: number) {
  const bank = entries.filter(e => e.source === 'BANK');
  if (opening == null || closing == null || !bank.length) return { balance: undefined, verified: false };
  const dates = bank.map(e => e.date).sort();
  const sum = bank.reduce((s, e) => s + Math.round(e.amount * 100), 0);
  const gap = Math.round(opening * 100) + sum - Math.round(closing * 100);
  if (Math.abs(gap) > 1 || cutoff < dates[0] || cutoff > dates[dates.length - 1]) return { balance: undefined, verified: false };
  const upto = bank.filter(e => e.date <= cutoff).reduce((s, e) => s + Math.round(e.amount * 100), 0);
  return { balance: (Math.round(opening * 100) + upto) / 100, verified: true };
}

export function reconcileBank(entries: BankEntry[], cutoff: string, bookBalance?: number, bankBalance?: number) {
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
    { label: 'Add: payments recorded in books, not debited by bank', amount: -total(e => e.source === 'PAYMENT') },
    { label: 'Less: receipts recorded in books, not credited by bank', amount: -total(e => e.source === 'RECEIPT') },
    { label: 'Less: bank debits not recorded in books', amount: total(e => e.source === 'BANK' && e.amount < 0) },
    { label: 'Add: bank credits not recorded in books', amount: total(e => e.source === 'BANK' && e.amount > 0) },
  ];
  const adjustment = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const calculated = bookBalance == null ? undefined : Math.round((bookBalance + adjustment) * 100) / 100;
  const difference = calculated == null || bankBalance == null ? undefined : Math.round((calculated - bankBalance) * 100) / 100;
  return { matches, outstanding, later, lines: bookBalance == null ? lines : [{ label: 'Balance as per bank ledger (asset positive; overdraft negative)', amount: bookBalance }, ...lines], calculated, bankBalance, difference };
}
