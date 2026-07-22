export function parseAmount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return 0;
  const raw = String(value).replace(/₹|Rs\.?|INR/gi, '').trim();
  if (!raw || raw === '-') return 0;
  // SAP-style trailing minus ("300000.00-") and leading minus both negate.
  const neg = /\(|\bCr\b/.test(raw) || /-\s*$/.test(raw) || /^-/.test(raw);
  const body = raw.replace(/[(),]/g, '').replace(/\bDr\b|\bCr\b/gi, '').replace(/^-|-+\s*$/g, '').replace(/\s+/g, '');
  // Only a purely numeric body is an amount — internal dashes/letters mean a
  // date or code ("01-Jan-26", "30 Days"), never money.
  if (!/^\d+(?:\.\d+)?$/.test(body)) return 0;
  const num = Number(body);
  return neg ? -num : num;
}
export function absAmount(value: unknown): number { return Math.abs(parseAmount(value)); }
export function within(a: number, b: number, tolerance = 1) { return Math.abs(a - b) <= tolerance; }
export function signedFromDebitCredit(sourceSide: 'RDC' | 'CUSTOMER', debit: number, credit: number) {
  return sourceSide === 'RDC' ? debit - credit : credit - debit;
}
export function inr(value: number) {
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
}
