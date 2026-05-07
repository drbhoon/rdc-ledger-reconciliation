import { differenceInCalendarDays, format, isValid, parse } from 'date-fns';
export function parseDate(value: unknown): string | undefined {
  if (value instanceof Date && isValid(value)) return format(value, 'yyyy-MM-dd');
  if (typeof value === 'number' && value > 20000) {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return isValid(d) ? format(d, 'yyyy-MM-dd') : undefined;
  }
  const s = String(value ?? '').trim();
  if (!s) return undefined;
  const formats = ['dd-MMM-yy','dd-MMM-yyyy','dd/MM/yyyy','d/M/yyyy','dd-MM-yyyy','d-M-yyyy','yyyy-MM-dd','dd.MM.yyyy'];
  for (const f of formats) {
    const d = parse(s, f, new Date());
    if (isValid(d)) return format(d, 'yyyy-MM-dd');
  }
  const d = new Date(s);
  return isValid(d) ? format(d, 'yyyy-MM-dd') : undefined;
}
export function daysBetween(a?: string, b?: string) {
  if (!a || !b) return 999999;
  return Math.abs(differenceInCalendarDays(new Date(a), new Date(b)));
}
export function isOutsidePeriod(date: string | undefined, start: string, end: string) {
  return !!date && (date < start || date > end);
}
