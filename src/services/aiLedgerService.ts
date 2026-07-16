import { v4 as uuid } from 'uuid';
import { extractChequeNo, extractReferences, normalizeReference } from '../core/reference';
import { parseAmount, signedFromDebitCredit } from '../core/amount';
import { parseDate } from '../core/date';
import type { MatchRow, NormalizedTxn, ParseResult, ReconcileResult, VoucherType } from '../core/types';
import { addAiRunUsage, emptyAiUsage, getAiConfig, type AiConfig } from '../core/aiConfig';

type JsonSchema = Record<string, unknown>;

export type AiReferenceExtraction = {
  rowId: string;
  fullReferences: string[];
  partialReferences: string[];
  shortBillNumbers: string[];
  chequeNumbers: string[];
  poNumbers: string[];
  confidence: number;
  reason: string;
};

export type AiJournalClassification = {
  rowId: string;
  voucherType:
    | 'TDS'
    | 'JOURNAL_TDS'
    | 'JOURNAL_INVOICE'
    | 'CREDIT_NOTE'
    | 'DEBIT_NOTE'
    | 'REVERSAL'
    | 'PAYMENT'
    | 'OPENING'
    | 'JOURNAL_ADJUSTMENT'
    | 'OTHER';
  confidence: number;
  reason: string;
};

export type AiPossibleMatch = {
  rdcRowId: string;
  customerRowId: string;
  matchType: 'POSSIBLE_MATCH';
  confidence: number;
  reason: string;
  suggestedStatus: 'MATCHED_AI_REVIEW_REQUIRED' | 'POSSIBLE_MATCH_REVIEW_REQUIRED';
};

async function client(config = getAiConfig()) {
  if (!config.enabled) return undefined;
  const { default: OpenAI } = await import('openai');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function strictJson<T>(name: string, schema: JsonSchema, input: unknown, config = getAiConfig()): Promise<T | undefined> {
  try {
    const openai = await client(config);
    if (!openai) return undefined;
    const response = await withTimeout(openai.responses.create({
      model: config.model,
      instructions: [
        'You are an expert Indian accounting ledger reconciliation assistant for RDC customer/vendor ledger reconciliation.',
        'Respect this sign convention: RDC debit to customer is positive receivable; RDC credit is negative. In customer books, credit to RDC is positive in RDC receivable view and debit to RDC is negative.',
        'Return strict JSON only. Do not include prose, markdown, or commentary.',
        'AI is not final authority. Provide extraction/classification suggestions with confidence and reason for audit review.',
      ].join('\n'),
      input: JSON.stringify(input),
      text: {
        format: {
          type: 'json_schema',
          name,
          strict: true,
          schema,
        },
      },
    }), config.requestTimeoutMs, name);
    // Exact token accounting for the per-run cost line on the certificate.
    const u: any = (response as any).usage;
    if (u) addAiRunUsage(u.input_tokens ?? u.prompt_tokens ?? 0, u.output_tokens ?? u.completion_tokens ?? 0);
    return JSON.parse(response.output_text) as T;
  } catch (error) {
    console.error(`[ai] ${name} failed; continuing deterministic reconciliation`, error);
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(workers);
}

const referencesSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rowId: { type: 'string' },
    fullReferences: { type: 'array', items: { type: 'string' } },
    partialReferences: { type: 'array', items: { type: 'string' } },
    shortBillNumbers: { type: 'array', items: { type: 'string' } },
    chequeNumbers: { type: 'array', items: { type: 'string' } },
    poNumbers: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['rowId', 'fullReferences', 'partialReferences', 'shortBillNumbers', 'chequeNumbers', 'poNumbers', 'confidence', 'reason'],
};

const journalSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rowId: { type: 'string' },
    voucherType: { type: 'string', enum: ['TDS', 'JOURNAL_TDS', 'JOURNAL_INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'REVERSAL', 'PAYMENT', 'OPENING', 'JOURNAL_ADJUSTMENT', 'OTHER'] },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['rowId', 'voucherType', 'confidence', 'reason'],
};

const possibleMatchesSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rdcRowId: { type: 'string' },
          customerRowId: { type: 'string' },
          matchType: { type: 'string', enum: ['POSSIBLE_MATCH'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          suggestedStatus: { type: 'string', enum: ['MATCHED_AI_REVIEW_REQUIRED', 'POSSIBLE_MATCH_REVIEW_REQUIRED'] },
        },
        required: ['rdcRowId', 'customerRowId', 'matchType', 'confidence', 'reason', 'suggestedStatus'],
      },
    },
  },
  required: ['matches'],
};

export async function aiDetectLedgerFormat(sampleRows: unknown[], fileMeta: unknown, config?: AiConfig) {
  return strictJson('ledger_format_detection', {
    type: 'object',
    additionalProperties: false,
    properties: {
      format: { type: 'string' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['format', 'confidence', 'reason'],
  }, { sampleRows, fileMeta }, config);
}

export async function aiMapColumns(sampleRows: unknown[], detectedHeaders: string[], config?: AiConfig) {
  return strictJson('ledger_column_mapping', {
    type: 'object',
    additionalProperties: false,
    properties: {
      date: { type: 'string' },
      voucherType: { type: 'string' },
      voucherNo: { type: 'string' },
      reference: { type: 'string' },
      narration: { type: 'string' },
      debit: { type: 'string' },
      credit: { type: 'string' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['date', 'voucherType', 'voucherNo', 'reference', 'narration', 'debit', 'credit', 'confidence', 'reason'],
  }, { sampleRows, detectedHeaders }, config);
}

export async function aiExtractReferences(row: NormalizedTxn, context: unknown, config?: AiConfig) {
  return strictJson<AiReferenceExtraction>('reference_extraction', referencesSchema, { row, context }, config);
}

export async function aiClassifyJournal(row: NormalizedTxn, context: unknown, config?: AiConfig) {
  return strictJson<AiJournalClassification>('journal_classification', journalSchema, { row, context }, config);
}

export async function aiClassifyTransaction(row: NormalizedTxn, context: unknown, config?: AiConfig) {
  return aiClassifyJournal(row, context, config);
}

export async function aiReviewPossibleMatches(unmatchedRdcRows: MatchRow[], unmatchedCustomerRows: MatchRow[], config?: AiConfig) {
  const result = await strictJson<{ matches: AiPossibleMatch[] }>('possible_match_review', possibleMatchesSchema, {
    unmatchedRdcRows: unmatchedRdcRows.slice(0, 60).map(slimMatch),
    unmatchedCustomerRows: unmatchedCustomerRows.slice(0, 60).map(slimMatch),
  }, config);
  return result?.matches || [];
}

export async function aiGenerateRecoStatement(summary: unknown, exceptions: unknown, config?: AiConfig) {
  return strictJson('reco_statement_review', {
    type: 'object',
    additionalProperties: false,
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string' },
            particular: { type: 'string' },
            amount: { type: 'number' },
            remarks: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['action', 'particular', 'amount', 'remarks', 'confidence'],
        },
      },
    },
    required: ['lines'],
  }, { summary, exceptions }, config);
}

export async function aiEnhanceParseResult(parseResult: ParseResult, sourceSide: 'RDC' | 'CUSTOMER', config = getAiConfig()) {
  const usage = emptyAiUsage(config);
  if (!config.enabled || sourceSide !== 'CUSTOMER') return usage;
  const candidates = parseResult.transactions
    .filter((txn) => txn.parseConfidence < 85 || !txn.normalizedReferenceNo || txn.voucherType.startsWith('JOURNAL'))
    .slice(0, config.maxRows);
  await mapLimit(candidates, config.concurrency, async (txn) => {
    usage.rowsReviewed += 1;
    const context = { sourceSide, signConvention: 'customer credit to RDC is positive; customer debit to RDC is negative' };
    if (!txn.normalizedReferenceNo || txn.parseConfidence < 85) {
      const aiRefs = await aiExtractReferences(txn, context, config);
      if (aiRefs) {
        txn.aiExtractedReferences = aiRefs.fullReferences;
        txn.aiConfidence = aiRefs.confidence;
        txn.aiReason = aiRefs.reason;
        txn.parserNotes = [...(txn.parserNotes || []), `AI reference review: ${aiRefs.reason}`];
        if (aiRefs.fullReferences.length && aiRefs.confidence >= config.confidenceThreshold) {
          txn.extractedReferences = Array.from(new Set([...(txn.extractedReferences || []), ...aiRefs.fullReferences]));
          txn.referenceNo ||= aiRefs.fullReferences[0];
          txn.normalizedReferenceNo ||= normalizeReference(aiRefs.fullReferences[0]);
          txn.parseConfidence = Math.max(txn.parseConfidence, Math.round(aiRefs.confidence * 100));
          usage.referencesExtracted += aiRefs.fullReferences.length;
        } else if (aiRefs.partialReferences.length) {
          txn.parserNotes = [...(txn.parserNotes || []), 'LOW_PARSE_CONFIDENCE_REFERENCE_REVIEW'];
        }
      }
    }
    if (txn.voucherType.startsWith('JOURNAL')) {
      const aiJournal = await aiClassifyJournal(txn, context, config);
      if (aiJournal) {
        txn.aiSuggestedVoucherType = aiJournal.voucherType as VoucherType;
        txn.aiConfidence = aiJournal.confidence;
        txn.aiReason = aiJournal.reason;
        txn.parserNotes = [...(txn.parserNotes || []), `AI journal review: ${aiJournal.reason}`];
        if (aiJournal.confidence >= config.confidenceThreshold) {
          txn.voucherType = aiJournal.voucherType as VoucherType;
          usage.journalRowsClassified += 1;
        }
      }
    }
  });
  parseResult.parserLog.push({ sourceFile: 'AI', level: 'info', message: `AI reviewed ${usage.rowsReviewed} rows; extracted ${usage.referencesExtracted} references; classified ${usage.journalRowsClassified} journals`, confidence: 100 });
  return usage;
}

export async function aiEnhanceReconciliation(result: ReconcileResult, config = getAiConfig()) {
  const usage = result.aiUsage || emptyAiUsage(config);
  if (!config.enabled) {
    result.aiUsage = usage;
    addAiCards(result, usage);
    return result;
  }
  const suggestions = await aiReviewPossibleMatches(result.unmatchedRdc, result.unmatchedCustomer, config);
  usage.possibleMatchesSuggested += suggestions.length;
  for (const suggestion of suggestions) {
    const rdc = result.unmatchedRdc.find((row) => row.rdcTxn?.id === suggestion.rdcRowId);
    const customer = result.unmatchedCustomer.find((row) => row.customerTxn?.id === suggestion.customerRowId);
    if (!rdc || !customer) continue;
    usage.requiresHumanReview += 1;
    result.possibleMatches.push({
      matchId: `ai-${suggestion.rdcRowId}-${suggestion.customerRowId}`,
      matchStatus: 'POSSIBLE',
      reasonCode: 'POSSIBLE_MATCH_REVIEW_REQUIRED',
      rdcTxn: rdc.rdcTxn,
      customerTxn: customer.customerTxn,
      rdcAmount: rdc.rdcAmount,
      customerAmount: customer.customerAmount,
      difference: (rdc.rdcAmount || 0) - (customer.customerAmount || 0),
      confidence: Math.round(suggestion.confidence * 100),
      remarks: `AI review: ${suggestion.reason}`,
    });
  }
  result.aiUsage = usage;
  addAiCards(result, usage);
  return result;
}

export function attachAiUsage(result: ReconcileResult, usage = emptyAiUsage()) {
  result.aiUsage = usage;
  addAiCards(result, usage);
  return result;
}

function addAiCards(result: ReconcileResult, usage: ReturnType<typeof emptyAiUsage>) {
  result.cards.aiEnabled = usage.enabled ? 1 : 0;
  result.cards.aiRowsReviewed = usage.rowsReviewed;
  result.cards.aiReferencesExtracted = usage.referencesExtracted;
  result.cards.aiJournalRowsClassified = usage.journalRowsClassified;
  result.cards.aiPossibleMatchesSuggested = usage.possibleMatchesSuggested;
  result.cards.aiAutoAccepted = usage.autoAccepted;
  result.cards.aiRequiresHumanReview = usage.requiresHumanReview;
}

// ── AI rescue parser (unknown-format insurance) ──────────────────────────────
// When the deterministic parsers cannot read a ledger (0 rows) or misread it
// (large integrity gap), the raw text is sent to the model chunk-by-chunk with
// a strict row schema. The result is accepted ONLY if it ties to the stated
// closing balance better than the deterministic attempt — the certificate
// remains the gatekeeper, so the AI can rescue but never degrade.

export type AiLedgerRow = {
  date: string;
  voucherType: 'INVOICE' | 'RECEIPT' | 'PAYMENT' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'TDS' | 'JOURNAL_INVOICE' | 'JOURNAL_TDS' | 'JOURNAL_ADJUSTMENT' | 'OPENING' | 'CLOSING' | 'OTHER';
  voucherNo: string;
  reference: string;
  narration: string;
  debit: number;
  credit: number;
};

const rescueSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          voucherType: { type: 'string', enum: ['INVOICE', 'RECEIPT', 'PAYMENT', 'CREDIT_NOTE', 'DEBIT_NOTE', 'TDS', 'JOURNAL_INVOICE', 'JOURNAL_TDS', 'JOURNAL_ADJUSTMENT', 'OPENING', 'CLOSING', 'OTHER'] },
          voucherNo: { type: 'string' },
          reference: { type: 'string' },
          narration: { type: 'string' },
          debit: { type: 'number' },
          credit: { type: 'number' },
        },
        required: ['date', 'voucherType', 'voucherNo', 'reference', 'narration', 'debit', 'credit'],
      },
    },
  },
  required: ['rows'],
};

/** Pure conversion of AI-extracted rows into a ParseResult (unit-testable). */
export function aiRowsToParseResult(rows: AiLedgerRow[], sourceFile: string, sourceSide: 'RDC' | 'CUSTOMER'): ParseResult {
  const balances: ParseResult['balances'] = { openingRows: [], closingRows: [] };
  const transactions: NormalizedTxn[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const debit = Math.abs(parseAmount(r.debit));
    const credit = Math.abs(parseAmount(r.credit));
    const signed = signedFromDebitCredit(sourceSide, debit, credit);
    if (r.voucherType === 'OPENING') { if (balances.opening == null) balances.opening = signed; continue; }
    if (r.voucherType === 'CLOSING') { balances.closing = signed; continue; }
    if (!debit && !credit) continue;
    // de-dupe rows that chunk boundaries may have produced twice
    const key = [r.date, r.voucherNo, r.reference, debit, credit].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const refs = extractReferences([r.reference, r.narration]);
    const referenceNo = refs[0] || (r.reference || '').trim();
    transactions.push({
      id: uuid(),
      sourceSide, sourceFile, sourceRow: transactions.length + 1,
      date: parseDate(r.date), voucherType: r.voucherType as VoucherType,
      voucherNo: r.voucherNo, referenceNo,
      normalizedReferenceNo: normalizeReference(referenceNo),
      extractedReferences: refs, chequeNo: extractChequeNo([r.narration]),
      allocationType: 'Inferred',
      particulars: (r.narration || '').slice(0, 160), narration: (r.narration || '').slice(0, 400),
      debit, credit, signedAmountRdcView: signed,
      amountOriginalSign: debit ? 'Dr' : 'Cr',
      parseConfidence: 70,
      parserNotes: ['AI-extracted row (rescue parser)'],
    });
  }
  return { transactions, balances, parserLog: [] };
}

export async function aiRescueParse(rawText: string, sourceFile: string, sourceSide: 'RDC' | 'CUSTOMER', config = getAiConfig()): Promise<ParseResult | undefined> {
  if (!config.enabled || !rawText.trim()) return undefined;
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const CHUNK = 90;
  const chunks: string[] = [];
  for (let i = 0; i < lines.length && chunks.length < config.rescueMaxChunks; i += CHUNK) {
    chunks.push(lines.slice(i, i + CHUNK).join('\n'));
  }
  const truncated = lines.length > config.rescueMaxChunks * CHUNK;
  const all: AiLedgerRow[] = [];
  let failed = 0;
  await mapLimit(chunks.map((c, idx) => ({ c, idx })), config.concurrency, async ({ c, idx }) => {
    const out = await strictJson<{ rows: AiLedgerRow[] }>('ledger_rescue_extraction', rescueSchema, {
      task: 'Extract EVERY transaction row from this Indian accounting ledger text chunk. One output row per ledger transaction. Amounts as plain numbers. Include Opening/Closing Balance rows with voucherType OPENING/CLOSING. Skip page headers, column headers, totals and carried-forward lines.',
      sourceSide,
      chunkIndex: idx,
      text: c,
    }, config);
    if (out?.rows) all.push(...out.rows);
    else failed += 1;
  });
  if (!all.length) return undefined;
  const result = aiRowsToParseResult(all, sourceFile, sourceSide);
  result.parserLog.push({
    sourceFile, level: 'warn',
    message: `AI rescue parser extracted ${result.transactions.length} rows from ${chunks.length} chunks${failed ? ` (${failed} chunks failed)` : ''}${truncated ? ' — document truncated at chunk cap' : ''}; verify via the certificate`,
    confidence: 70,
  });
  return result;
}

function slimMatch(row: MatchRow) {
  const txn = row.rdcTxn || row.customerTxn;
  return {
    rowId: txn?.id,
    sourceSide: txn?.sourceSide,
    sourceRow: txn?.sourceRow,
    date: txn?.date,
    voucherType: txn?.voucherType,
    referenceNo: txn?.referenceNo,
    normalizedReferenceNo: txn?.normalizedReferenceNo,
    chequeNo: txn?.chequeNo,
    narration: txn?.narration || txn?.particulars,
    amount: txn?.signedAmountRdcView,
    reasonCode: row.reasonCode,
  };
}
