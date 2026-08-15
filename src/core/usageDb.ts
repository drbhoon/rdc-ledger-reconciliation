import type { Pool as PgPool, PoolClient } from 'pg';

/**
 * Usage log — one row per reconciliation run, in Postgres.
 *
 * Two rules govern everything here:
 *  1. NOTHING in this file may break a reconciliation. Every call is wrapped;
 *     a database that is down, slow or absent costs us a log line, never a
 *     customer's reconciliation.
 *  2. No ledger content is stored. Only the file NAMES, counts, the verdict and
 *     the AI usage — enough to answer "what did we run and what did it cost",
 *     nothing that would put customer financials in a second place.
 */

export type RunRecord = {
  runId: string;
  partyName: string;
  periodStart?: string;
  periodEnd?: string;
  rdcFile?: string;
  customerFile?: string;
  rdcRows: number;
  customerRows: number;
  matchedCount: number;
  unmatchedRdcCount: number;
  unmatchedCustomerCount: number;
  matchedCoveragePct: number;
  verdict: string;
  certified: boolean;
  rdcAudit?: string;
  customerAudit?: string;
  unexplainedDifference: number;
  aiEnabled: boolean;
  aiModel?: string;
  aiCalls: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  aiCostUsd: number;
  aiRescueRows: number;
  durationMs: number;
  status: 'COMPLETED' | 'FAILED';
  errorMessage?: string;
};

export type UsageFilters = { from?: string; to?: string; party?: string };

let pool: PgPool | undefined;
let schemaReady: Promise<void> | undefined;
let disabledReason: string | undefined;

export function usageDbConfigured() {
  return !!process.env.DATABASE_URL;
}

async function getPool(): Promise<PgPool | undefined> {
  if (!process.env.DATABASE_URL) return undefined;
  if (pool) return pool;
  const { Pool } = await import('pg');
  const url = process.env.DATABASE_URL;
  // Railway's private network needs no TLS; anything else (a public proxy URL,
  // an external host) does, and its certificate is not one we can chain-verify.
  const isLocal = /localhost|127\.0\.0\.1|\.railway\.internal/.test(url);
  const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
  const ssl = sslMode === 'disable' ? false : (isLocal && sslMode !== 'require' ? false : { rejectUnauthorized: false });
  pool = new Pool({ connectionString: url, ssl, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8_000 });
  pool.on('error', (error) => console.error('[usage-db] idle client error', error.message));
  return pool;
}

async function withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T | undefined> {
  const p = await getPool();
  if (!p) return undefined;
  let client: PoolClient | undefined;
  try {
    client = await p.connect();
    return await work(client);
  } catch (error) {
    disabledReason = error instanceof Error ? error.message : String(error);
    console.error('[usage-db] query failed:', disabledReason);
    return undefined;
  } finally {
    client?.release();
  }
}

/** Created on first use so deploying needs no migration step. */
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await withClient(async (client) => {
        await client.query(`
          CREATE TABLE IF NOT EXISTS reconciliation_runs (
            id                       BIGSERIAL PRIMARY KEY,
            run_id                   TEXT UNIQUE NOT NULL,
            ran_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            party_name               TEXT NOT NULL,
            period_start             DATE,
            period_end               DATE,
            rdc_file                 TEXT,
            customer_file            TEXT,
            rdc_rows                 INTEGER NOT NULL DEFAULT 0,
            customer_rows            INTEGER NOT NULL DEFAULT 0,
            matched_count            INTEGER NOT NULL DEFAULT 0,
            unmatched_rdc_count      INTEGER NOT NULL DEFAULT 0,
            unmatched_customer_count INTEGER NOT NULL DEFAULT 0,
            matched_coverage_pct     NUMERIC(6,2) NOT NULL DEFAULT 0,
            verdict                  TEXT,
            certified                BOOLEAN NOT NULL DEFAULT FALSE,
            rdc_audit                TEXT,
            customer_audit           TEXT,
            unexplained_difference   NUMERIC(18,2) NOT NULL DEFAULT 0,
            ai_enabled               BOOLEAN NOT NULL DEFAULT FALSE,
            ai_model                 TEXT,
            ai_calls                 INTEGER NOT NULL DEFAULT 0,
            ai_input_tokens          BIGINT NOT NULL DEFAULT 0,
            ai_output_tokens         BIGINT NOT NULL DEFAULT 0,
            ai_cost_usd              NUMERIC(12,6) NOT NULL DEFAULT 0,
            ai_rescue_rows           INTEGER NOT NULL DEFAULT 0,
            duration_ms              INTEGER NOT NULL DEFAULT 0,
            status                   TEXT NOT NULL DEFAULT 'COMPLETED',
            error_message            TEXT
          )`);
        await client.query('CREATE INDEX IF NOT EXISTS reconciliation_runs_ran_at_idx ON reconciliation_runs (ran_at DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS reconciliation_runs_party_idx ON reconciliation_runs (party_name)');
      });
    })().catch((error) => {
      console.error('[usage-db] schema setup failed', error);
    });
  }
  return schemaReady;
}

/**
 * The period fields arrive straight from a form and can be '', 'undefined' or
 * anything a browser sends. Postgres would reject those against a DATE column
 * and lose the whole row, so only a real ISO date is passed through.
 */
export function asDateOrNull(value?: string): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : text;
}

/** Fire-and-forget: awaited, but a failure only costs the log line. */
export async function recordRun(record: RunRecord) {
  if (!usageDbConfigured()) return;
  await ensureSchema();
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO reconciliation_runs (
         run_id, party_name, period_start, period_end, rdc_file, customer_file,
         rdc_rows, customer_rows, matched_count, unmatched_rdc_count, unmatched_customer_count,
         matched_coverage_pct, verdict, certified, rdc_audit, customer_audit, unexplained_difference,
         ai_enabled, ai_model, ai_calls, ai_input_tokens, ai_output_tokens, ai_cost_usd, ai_rescue_rows,
         duration_ms, status, error_message
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        record.runId, record.partyName, asDateOrNull(record.periodStart), asDateOrNull(record.periodEnd),
        record.rdcFile || null, record.customerFile || null,
        record.rdcRows, record.customerRows, record.matchedCount,
        record.unmatchedRdcCount, record.unmatchedCustomerCount, record.matchedCoveragePct,
        record.verdict, record.certified, record.rdcAudit || null, record.customerAudit || null,
        record.unexplainedDifference, record.aiEnabled, record.aiModel || null,
        record.aiCalls, record.aiInputTokens, record.aiOutputTokens, record.aiCostUsd,
        record.aiRescueRows, record.durationMs, record.status, record.errorMessage || null,
      ],
    );
  });
}

export type UsageTotals = {
  runs: number; certified: number; reviewRequired: number; failed: number;
  aiRuns: number; aiCalls: number; inputTokens: number; outputTokens: number; costUsd: number;
  parties: number; firstRun?: string; lastRun?: string;
};

/** Exported for offline testing: parameter numbering here is easy to get wrong. */
export const rangeWhere = (filters: UsageFilters) => {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.from) { values.push(filters.from); where.push(`ran_at >= $${values.length}::date`); }
  // inclusive of the whole "to" day
  if (filters.to) { values.push(filters.to); where.push(`ran_at < ($${values.length}::date + INTERVAL '1 day')`); }
  if (filters.party) { values.push(`%${filters.party}%`); where.push(`party_name ILIKE $${values.length}`); }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
};

export async function getUsageTotals(filters: UsageFilters): Promise<UsageTotals | undefined> {
  if (!usageDbConfigured()) return undefined;
  await ensureSchema();
  const { clause, values } = rangeWhere(filters);
  return withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS runs,
              COUNT(*) FILTER (WHERE certified)::int AS certified,
              COUNT(*) FILTER (WHERE NOT certified AND status = 'COMPLETED')::int AS review_required,
              COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
              COUNT(*) FILTER (WHERE ai_calls > 0)::int AS ai_runs,
              COALESCE(SUM(ai_calls),0)::int AS ai_calls,
              COALESCE(SUM(ai_input_tokens),0)::bigint AS input_tokens,
              COALESCE(SUM(ai_output_tokens),0)::bigint AS output_tokens,
              COALESCE(SUM(ai_cost_usd),0)::float8 AS cost_usd,
              COUNT(DISTINCT party_name)::int AS parties,
              MIN(ran_at) AS first_run, MAX(ran_at) AS last_run
         FROM reconciliation_runs ${clause}`,
      values,
    );
    const r = rows[0] || {};
    return {
      runs: r.runs ?? 0, certified: r.certified ?? 0, reviewRequired: r.review_required ?? 0,
      failed: r.failed ?? 0, aiRuns: r.ai_runs ?? 0, aiCalls: r.ai_calls ?? 0,
      inputTokens: Number(r.input_tokens ?? 0), outputTokens: Number(r.output_tokens ?? 0),
      costUsd: Number(r.cost_usd ?? 0), parties: r.parties ?? 0,
      firstRun: r.first_run ? new Date(r.first_run).toISOString() : undefined,
      lastRun: r.last_run ? new Date(r.last_run).toISOString() : undefined,
    };
  });
}

export type UsageRow = Record<string, unknown>;

export async function getUsageRuns(filters: UsageFilters, limit = 200): Promise<UsageRow[] | undefined> {
  if (!usageDbConfigured()) return undefined;
  await ensureSchema();
  const { clause, values } = rangeWhere(filters);
  values.push(Math.min(Math.max(limit, 1), 1000));
  return withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT run_id, ran_at, party_name, rdc_file, customer_file, rdc_rows, customer_rows,
              matched_count, matched_coverage_pct, verdict, certified, unexplained_difference,
              ai_calls, ai_input_tokens, ai_output_tokens, ai_cost_usd, ai_model,
              duration_ms, status, error_message
         FROM reconciliation_runs ${clause}
        ORDER BY ran_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return rows;
  });
}

/** Per-day totals, for the trend table. */
export async function getUsageByDay(filters: UsageFilters): Promise<UsageRow[] | undefined> {
  if (!usageDbConfigured()) return undefined;
  await ensureSchema();
  const { clause, values } = rangeWhere(filters);
  return withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT (ran_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
              COUNT(*)::int AS runs,
              COALESCE(SUM(ai_calls),0)::int AS ai_calls,
              COALESCE(SUM(ai_input_tokens + ai_output_tokens),0)::bigint AS tokens,
              COALESCE(SUM(ai_cost_usd),0)::float8 AS cost_usd
         FROM reconciliation_runs ${clause}
        GROUP BY 1 ORDER BY 1 DESC LIMIT 120`,
      values,
    );
    return rows;
  });
}

export function usageDbStatus() {
  return { configured: usageDbConfigured(), lastError: disabledReason };
}
