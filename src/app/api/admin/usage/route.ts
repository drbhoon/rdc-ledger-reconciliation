import { NextResponse } from 'next/server';
import { getUsageByDay, getUsageRuns, getUsageTotals, usageDbConfigured } from '@/core/usageDb';

export const dynamic = 'force-dynamic';

/**
 * Usage for a period, as JSON or CSV. Behind the same Basic auth as the
 * console (see src/middleware.ts).
 *
 *   /api/admin/usage?from=2026-08-01&to=2026-08-31[&party=Dalmia][&format=csv]
 */
export async function GET(request: Request) {
  if (!usageDbConfigured()) {
    return NextResponse.json({ error: 'DATABASE_URL is not set; usage tracking is disabled.' }, { status: 503 });
  }
  const url = new URL(request.url);
  const filters = {
    from: url.searchParams.get('from') || undefined,
    to: url.searchParams.get('to') || undefined,
    party: url.searchParams.get('party') || undefined,
  };
  const [totals, byDay, runs] = await Promise.all([
    getUsageTotals(filters),
    getUsageByDay(filters),
    getUsageRuns(filters, Number(url.searchParams.get('limit') || 1000)),
  ]);
  if (!totals) return NextResponse.json({ error: 'Could not reach the usage database.' }, { status: 502 });

  if ((url.searchParams.get('format') || '').toLowerCase() === 'csv') {
    const columns = ['ran_at', 'party_name', 'verdict', 'certified', 'rdc_rows', 'customer_rows', 'matched_count',
      'matched_coverage_pct', 'unexplained_difference', 'ai_model', 'ai_calls', 'ai_input_tokens',
      'ai_output_tokens', 'ai_cost_usd', 'duration_ms', 'status', 'rdc_file', 'customer_file', 'run_id'];
    const escape = (value: unknown) => {
      const text = value == null ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.join(','), ...(runs || []).map(r => columns.map(c => escape(r[c])).join(','))];
    return new NextResponse(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rdc-recon-usage-${filters.from || 'all'}-to-${filters.to || 'now'}.csv"`,
      },
    });
  }
  return NextResponse.json({ filters, totals, byDay, runs });
}
