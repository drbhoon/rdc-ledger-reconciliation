import { differenceInCalendarDays, format, isValid, parse } from 'date-fns';
export function parseDate(value: unknown): string | undefined {
  if (value instanceof Date && isValid(value)) {
    // SheetJS converts Excel serials a few seconds off midnight (serial 41894 =
    // 12-Sep-2014 arrives as 11-Sep 23:59:50), which silently shifted EVERY
    // date-typed cell back one day. Snap to the nearest day when the time sits
    // on a midnight boundary; leave genuine timestamps alone.
    const localAsUtc = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
    const nearestDay = new Date(Math.round(localAsUtc.getTime() / 86400000) * 86400000);
    const onBoundary = Math.abs(localAsUtc.getTime() - nearestDay.getTime()) <= 5 * 60 * 1000;
    return (onBoundary ? nearestDay : localAsUtc).toISOString().slice(0, 10);
  }
  // Excel date serials only: ~20000 (1954) to ~80000 (2119). Without an upper
  // bound an AMOUNT that lands in a date column becomes a date — Bearys had
  // 55,720,408 read as the year 153270, dragging ₹16.7cr of phantom rows in.
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    const d = new Date(Math.round((value - 25569) * 86400 * 1000));
    return isValid(d) ? format(d, 'yyyy-MM-dd') : undefined;
  }
  const s = String(value ?? '').trim();
  if (!s) return undefined;
  const formats = ['dd-MMM-yy','dd-MMM-yyyy','dd/MM/yyyy','d/M/yyyy','dd/MM/yy','d/M/yy','dd-MM-yyyy','d-M-yyyy','dd-MM-yy','yyyy-MM-dd','dd.MM.yyyy'];
  for (const f of formats) {
    const d = parse(s, f, new Date());
    // A yyyy pattern happily consumes a 2-digit year ("26" -> year 0026);
    // reject implausible years so the matching 2-digit format gets its turn.
    if (isValid(d) && d.getFullYear() >= 1990) return format(d, 'yyyy-MM-dd');
  }
  const d = new Date(s);
  return isValid(d) && d.getFullYear() >= 1990 ? format(d, 'yyyy-MM-dd') : undefined;
}
export function daysBetween(a?: string, b?: string) {
  if (!a || !b) return 999999;
  return Math.abs(differenceInCalendarDays(new Date(a), new Date(b)));
}
export function isOutsidePeriod(date: string | undefined, start: string, end: string) {
  return !!date && (date < start || date > end);
}
