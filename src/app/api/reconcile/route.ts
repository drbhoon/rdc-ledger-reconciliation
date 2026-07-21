import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { v4 as uuid } from 'uuid';
import { extractRawText, parseLedger } from '@/core/parser';
import { ledgerIntegrityGap, reconcile } from '@/core/reconcile';
import { writeReport } from '@/core/report';
import { emptyAiUsage, estimateCostUsd, getAiConfig, getAiRunState, getAiRunUsage, startAiRun, type AiConfig } from '@/core/aiConfig';
import { aiEnhanceParseResult, aiEnhanceReconciliation, aiRescueParse } from '@/services/aiLedgerService';
import type { ParseResult } from '@/core/types';

async function saveUpload(file: File, dir: string) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const safe = file.name.replace(/[^A-Za-z0-9 ._-]/g, '_');
  const out = path.join(dir, Date.now() + '_' + safe);
  fs.writeFileSync(out, bytes);
  return out;
}

/**
 * Unknown-format insurance: when the deterministic parsers read nothing (0
 * rows) or misread the ledger (integrity gap beyond tolerance), let the AI
 * extract the rows from raw text — and accept that result ONLY when it ties
 * to the stated closing balance better than the deterministic attempt. The
 * certificate remains the final gatekeeper either way.
 */
async function withAiRescue(parsed: ParseResult, filePath: string, fileName: string, side: 'RDC' | 'CUSTOMER', aiConfig: AiConfig): Promise<ParseResult> {
  const gap = ledgerIntegrityGap(parsed);
  const closing = parsed.balances.closing;
  const gapThreshold = Math.max(1000, Math.abs(closing ?? 0) * 0.005);
  const unreadable = parsed.transactions.length === 0;
  const misread = gap != null && Math.abs(gap) > gapThreshold;
  if (!unreadable && !misread) return parsed;
  if (!aiConfig.enabled) {
    parsed.parserLog.push({ sourceFile: fileName, level: 'warn', message: `AI rescue not attempted (AI disabled); deterministic parse ${unreadable ? 'read 0 rows' : `has integrity gap ${gap?.toFixed(2)}`}`, confidence: 40 });
    return parsed;
  }
  console.log(`[reconcile] AI rescue attempt for ${side} ledger "${fileName}" (${unreadable ? '0 rows' : `gap ${gap?.toFixed(2)}`})`);
  try {
    const raw = await extractRawText(filePath);
    const rescued = await aiRescueParse(raw, fileName, side, aiConfig);
    if (!rescued || !rescued.transactions.length) {
      parsed.parserLog.push({ sourceFile: fileName, level: 'warn', message: 'AI rescue produced no rows; keeping deterministic parse', confidence: 40 });
      return parsed;
    }
    // If the deterministic side knew the closing balance but the AI missed it,
    // reuse it so both attempts are judged against the same yardstick.
    if (rescued.balances.closing == null && closing != null) rescued.balances.closing = closing;
    if (rescued.balances.opening == null && parsed.balances.opening != null) rescued.balances.opening = parsed.balances.opening;
    const rescuedGap = ledgerIntegrityGap(rescued);
    const oldAbs = gap == null ? Number.POSITIVE_INFINITY : Math.abs(gap);
    const newAbs = rescuedGap == null ? Number.POSITIVE_INFINITY : Math.abs(rescuedGap);
    const acceptOnZeroRows = unreadable && rescued.transactions.length > 0;
    if (newAbs < oldAbs || (acceptOnZeroRows && !(newAbs > oldAbs))) {
      rescued.parserLog.unshift(...parsed.parserLog);
      rescued.parserLog.push({ sourceFile: fileName, level: 'warn', message: `AI rescue ACCEPTED: integrity gap ${gap == null ? 'n/a' : gap.toFixed(2)} -> ${rescuedGap == null ? 'n/a' : rescuedGap.toFixed(2)} (${rescued.transactions.length} rows). Review the certificate before relying on this run.`, confidence: 70 });
      return rescued;
    }
    parsed.parserLog.push({ sourceFile: fileName, level: 'warn', message: `AI rescue rejected (gap ${rescuedGap == null ? 'n/a' : rescuedGap.toFixed(2)} not better than ${gap == null ? 'n/a' : gap.toFixed(2)}); keeping deterministic parse`, confidence: 50 });
    return parsed;
  } catch (e) {
    parsed.parserLog.push({ sourceFile: fileName, level: 'warn', message: `AI rescue failed (${e instanceof Error ? e.message : 'error'}); keeping deterministic parse`, confidence: 40 });
    return parsed;
  }
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const runId = uuid();
    const uploads = path.join(process.cwd(), 'uploads', runId);
    fs.mkdirSync(uploads, { recursive: true });
    const rdcFile = form.get('rdc') as File | null;
    const customerFile = form.get('customer') as File | null;
    if (!rdcFile?.size || !customerFile?.size) {
      return new NextResponse('Please select both RDC and customer ledger files before running reconciliation.', { status: 400 });
    }
    const partyName = String(form.get('partyName') || 'Customer');
    const periodStart = String(form.get('periodStart'));
    const periodEnd = String(form.get('periodEnd'));
    const rdcPath = await saveUpload(rdcFile, uploads);
    const customerPath = await saveUpload(customerFile, uploads);
    console.log(`[reconcile] ${runId} parsing`, { partyName, rdcFile: rdcFile.name, customerFile: customerFile.name });
    const aiConfig = getAiConfig();
    startAiRun(aiConfig);
    let rdc = await parseLedger(rdcPath, 'RDC');
    let customer = await parseLedger(customerPath, 'CUSTOMER');
    // Unknown-format insurance (0 rows or big integrity gap -> AI rescue).
    rdc = await withAiRescue(rdc, rdcPath, rdcFile.name, 'RDC', aiConfig);
    customer = await withAiRescue(customer, customerPath, customerFile.name, 'CUSTOMER', aiConfig);
    // Never produce a blank/one-sided reconciliation: if either ledger could
    // not be read even with AI rescue, stop with an actionable error.
    if (!rdc.transactions.length) {
      return new NextResponse(
        `Could not read any transactions from the RDC ledger "${rdcFile.name}" (AI rescue also failed). ` +
        'Please upload the RDC debtors ledger as Excel, or contact support with this file.',
        { status: 422 });
    }
    if (!customer.transactions.length) {
      return new NextResponse(
        `Could not read any transactions from the customer ledger "${customerFile.name}" (AI rescue also failed). ` +
        'Please upload the customer ledger as Excel/CSV if possible, or contact support with this file.',
        { status: 422 });
    }
    const aiUsage = emptyAiUsage(aiConfig);
    const customerAiUsage = await aiEnhanceParseResult(customer, 'CUSTOMER', aiConfig);
    Object.assign(aiUsage, customerAiUsage);
    const result = reconcile(rdc, customer, { partyName, periodStart, periodEnd, invoiceTolerance: Number(form.get('invoiceTolerance') || 1), paymentTolerance: Number(form.get('paymentTolerance') || 1), invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
    result.aiUsage = aiUsage;
    await aiEnhanceReconciliation(result, aiConfig);
    // Exact per-run AI cost, printed on the Reconciliation_Certificate sheet.
    const tokens = getAiRunUsage();
    aiUsage.inputTokens = tokens.input;
    aiUsage.outputTokens = tokens.output;
    aiUsage.estimatedCostUsd = Math.round(estimateCostUsd(aiConfig.model, tokens.input, tokens.output) * 10000) / 10000;
    aiUsage.rescueRowsExtracted = [rdc, customer].reduce((s, side) => s + side.transactions.filter(t => t.parserNotes?.includes('AI-extracted row (rescue parser)')).length, 0);
    result.cards.aiInputTokens = tokens.input;
    result.cards.aiOutputTokens = tokens.output;
    result.cards.aiEstimatedCostUsd = aiUsage.estimatedCostUsd;
    const aiState = getAiRunState();
    if (aiConfig.enabled && (aiState.tripped || aiState.skippedCalls > 0)) {
      const reason = aiState.tripped
        ? 'repeated AI call failures (circuit breaker) — check OPENAI_API_KEY / OPENAI_MODEL access'
        : 'AI time budget reached (AI_TIME_BUDGET_MS)';
      result.cards.aiCallsSkipped = aiState.skippedCalls;
      result.parserLog.push({ sourceFile: 'AI', level: 'warn', message: `AI review stopped early: ${reason}; ${aiState.skippedCalls} calls skipped. Deterministic reconciliation is complete and unaffected.`, confidence: 100 });
      console.warn(`[reconcile] ${runId} AI stopped early: ${reason}; skipped ${aiState.skippedCalls} calls`);
    }
    const reportsDir = path.join(process.cwd(), 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, runId + '_reconciliation.xlsx');
    await writeReport(result, reportPath);
    fs.writeFileSync(path.join(reportsDir, runId + '_summary.json'), JSON.stringify({ partyName, cards: result.cards, summaryLines: result.summaryLines, aiUsage: result.aiUsage }, null, 2));
    console.log(`[reconcile] ${runId} report written`, reportPath, `AI cost ~$${aiUsage.estimatedCostUsd}`);
    return NextResponse.json({ runId, reportPath, cards: result.cards, summaryLines: result.summaryLines, aiUsage: result.aiUsage });
  } catch (err) {
    console.error('[reconcile] failed', err);
    return new NextResponse(err instanceof Error ? err.message : 'Reconciliation failed unexpectedly', { status: 500 });
  }
}
