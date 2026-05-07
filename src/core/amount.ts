export function parseAmount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return 0;
  const raw = String(value).replace(/₹|Rs\.?|INR/gi, '').trim();
  if (!raw || raw === '-') return 0;
  const neg = /\(|\bCr\b|-$/.test(raw);
  const cleaned = raw.replace(/[(),]/g, '').replace(/Dr|Cr/gi, '').replace(/[^0-9.-]/g, '');
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return 0;
  return neg ? -Math.abs(num) : num;
}
export function absAmount(value: unknown): number { return Math.abs(parseAmount(value)); }
export function within(a: number, b: number, tolerance = 1) { return Math.abs(a - b) <= tolerance; }
export function signedFromDebitCredit(sourceSide: 'RDC' | 'CUSTOMER', debit: number, credit: number) {
  return sourceSide === 'RDC' ? debit - credit : credit - debit;
}
export function inr(value: number) {
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
}
