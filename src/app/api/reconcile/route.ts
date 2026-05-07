import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { v4 as uuid } from 'uuid';
import { parseLedger } from '@/core/parser';
import { reconcile } from '@/core/reconcile';
import { writeReport } from '@/core/report';
import { emptyAiUsage, getAiConfig } from '@/core/aiConfig';
import { aiEnhanceParseResult, aiEnhanceReconciliation } from '@/services/aiLedgerService';
async function saveUpload(file: File, dir: string) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const safe = file.name.replace(/[^A-Za-z0-9 ._-]/g, '_');
  const out = path.join(dir, Date.now() + '_' + safe);
  fs.writeFileSync(out, bytes);
  return out;
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
    const rdc = await parseLedger(rdcPath, 'RDC');
    const customer = await parseLedger(customerPath, 'CUSTOMER');
    const aiConfig = getAiConfig();
    const aiUsage = emptyAiUsage(aiConfig);
    const customerAiUsage = await aiEnhanceParseResult(customer, 'CUSTOMER', aiConfig);
    Object.assign(aiUsage, customerAiUsage);
    const result = reconcile(rdc, customer, { partyName, periodStart, periodEnd, invoiceTolerance: Number(form.get('invoiceTolerance') || 1), paymentTolerance: Number(form.get('paymentTolerance') || 1), invoiceDateToleranceDays: 7, paymentDateToleranceDays: 15 });
    result.aiUsage = aiUsage;
    await aiEnhanceReconciliation(result, aiConfig);
    const reportsDir = path.join(process.cwd(), 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, runId + '_reconciliation.xlsx');
    await writeReport(result, reportPath);
    fs.writeFileSync(path.join(reportsDir, runId + '_summary.json'), JSON.stringify({ partyName, cards: result.cards, summaryLines: result.summaryLines, aiUsage: result.aiUsage }, null, 2));
    console.log(`[reconcile] ${runId} report written`, reportPath);
    return NextResponse.json({ runId, reportPath, cards: result.cards, summaryLines: result.summaryLines, aiUsage: result.aiUsage });
  } catch (err) {
    console.error('[reconcile] failed', err);
    return new NextResponse(err instanceof Error ? err.message : 'Reconciliation failed unexpectedly', { status: 500 });
  }
}
