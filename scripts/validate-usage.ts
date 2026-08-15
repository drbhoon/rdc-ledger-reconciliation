/**
 * Offline checks for the usage log — no database required.
 * Covers the parts that fail silently in production if wrong: the date guard
 * on the DATE columns, and the placeholder numbering in the filter SQL.
 * Run: npx tsx scripts/validate-usage.ts
 */
import { asDateOrNull, rangeWhere, usageDbConfigured } from '../src/core/usageDb';

let pass = 0, fail = 0;
const ck = (label: string, cond: boolean, detail = '') => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + label + (detail ? `  [${detail}]` : '')); cond ? pass++ : fail++; };

// ── the DATE guard ───────────────────────────────────────────────────────────
ck('date: a real ISO date passes through', asDateOrNull('2026-04-01') === '2026-04-01');
ck('date: empty string -> null (would reject the whole row)', asDateOrNull('') === null);
ck('date: undefined -> null', asDateOrNull(undefined) === null);
ck('date: the string "undefined" -> null', asDateOrNull('undefined') === null);
ck('date: a display format -> null rather than a bad cast', asDateOrNull('01-04-2026') === null);
ck('date: nonsense day -> null', asDateOrNull('2026-13-45') === null, String(asDateOrNull('2026-13-45')));

// ── filter SQL ───────────────────────────────────────────────────────────────
const none = rangeWhere({});
ck('filters: no filters -> no WHERE clause', none.clause === '' && none.values.length === 0, JSON.stringify(none));

const both = rangeWhere({ from: '2026-08-01', to: '2026-08-31' });
ck('filters: from/to numbered $1 and $2', /\$1::date/.test(both.clause) && /\$2::date/.test(both.clause), both.clause);
ck('filters: "to" is inclusive of the whole day', /INTERVAL '1 day'/.test(both.clause));
ck('filters: two values bound', both.values.length === 2);

const all = rangeWhere({ from: '2026-08-01', to: '2026-08-31', party: 'Dalmia' });
ck('filters: party numbered $3 and wrapped for ILIKE', /\$3/.test(all.clause) && all.values[2] === '%Dalmia%', `${all.clause} :: ${JSON.stringify(all.values)}`);

const partyOnly = rangeWhere({ party: 'Suroj' });
ck('filters: party alone is $1, not $3', /party_name ILIKE \$1/.test(partyOnly.clause), partyOnly.clause);

// every placeholder present exactly once, and none beyond the bound values
for (const built of [none, both, all, partyOnly]) {
  const used = (built.clause.match(/\$\d+/g) || []).map(p => Number(p.slice(1)));
  const unique = new Set(used);
  const inRange = used.every(n => n >= 1 && n <= built.values.length);
  ck(`filters: placeholders sane for "${built.clause || '(empty)'}"`, unique.size === used.length && inRange);
}

// ── disabled by default ──────────────────────────────────────────────────────
ck('tracking is off when DATABASE_URL is unset', process.env.DATABASE_URL ? true : usageDbConfigured() === false);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
