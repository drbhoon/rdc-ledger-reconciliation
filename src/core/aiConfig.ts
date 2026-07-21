import type { AiUsageStats } from './types';

export type AiConfig = {
  enabled: boolean;
  model: string;
  confidenceThreshold: number;
  maxRows: number;
  concurrency: number;
  requestTimeoutMs: number;
  rescueMaxChunks: number;
  timeBudgetMs: number;
};

export function getAiConfig(): AiConfig {
  return {
    enabled: process.env.AI_ENABLED === 'true' && !!process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    confidenceThreshold: Number(process.env.AI_CONFIDENCE_THRESHOLD || 0.75),
    maxRows: Number(process.env.AI_MAX_ROWS || 80),
    concurrency: Math.max(1, Number(process.env.AI_CONCURRENCY || 4)),
    requestTimeoutMs: Math.max(5000, Number(process.env.AI_REQUEST_TIMEOUT_MS || 45000)),
    rescueMaxChunks: Math.max(1, Number(process.env.AI_RESCUE_MAX_CHUNKS || 60)),
    // Total wall-clock the whole run may spend on AI calls. Railway's proxy
    // gives up on long requests ("upstream error"), so all AI work must stay
    // comfortably inside its window; deterministic output is never blocked.
    timeBudgetMs: Math.max(30_000, Number(process.env.AI_TIME_BUDGET_MS || 210_000)),
  };
}

// USD per 1M tokens [input, output]; first regex match wins, most specific first.
const MODEL_PRICES: Array<[RegExp, [number, number]]> = [
  [/gpt-5-nano/i, [0.05, 0.4]],
  [/gpt-5-mini/i, [0.25, 2.0]],
  [/gpt-5/i, [1.25, 10.0]],
  [/gpt-4\.1-nano/i, [0.1, 0.4]],
  [/gpt-4\.1-mini/i, [0.4, 1.6]],
  [/gpt-4\.1/i, [2.0, 8.0]],
  [/gpt-4o-mini/i, [0.15, 0.6]],
  [/gpt-4o/i, [2.5, 10.0]],
];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number) {
  const [inP, outP] = MODEL_PRICES.find(([re]) => re.test(model))?.[1] ?? [1.0, 4.0];
  return (inputTokens * inP + outputTokens * outP) / 1_000_000;
}

/** Per-run token accumulator (reset at the start of each reconciliation run). */
const runTokens = { input: 0, output: 0, calls: 0 };
export function resetAiRunUsage() { runTokens.input = 0; runTokens.output = 0; runTokens.calls = 0; }

/**
 * Per-run AI guardrails: a wall-clock budget plus a consecutive-failure
 * circuit breaker. Either one being hit makes every remaining AI call return
 * instantly (skipped), so a slow or broken model can never push the request
 * past the hosting proxy's timeout — the run always finishes and the
 * deterministic result ships.
 */
const runState = { deadline: Number.POSITIVE_INFINITY, consecutiveFailures: 0, tripped: false, skippedCalls: 0 };
const BREAKER_THRESHOLD = 6;

export function startAiRun(config = getAiConfig()) {
  resetAiRunUsage();
  runState.deadline = Date.now() + config.timeBudgetMs;
  runState.consecutiveFailures = 0;
  runState.tripped = false;
  runState.skippedCalls = 0;
}
export function aiCallAllowed(): boolean {
  if (runState.tripped || Date.now() >= runState.deadline) { runState.skippedCalls += 1; return false; }
  return true;
}
export function recordAiCallSuccess() { runState.consecutiveFailures = 0; }
export function recordAiCallFailure() {
  runState.consecutiveFailures += 1;
  if (runState.consecutiveFailures >= BREAKER_THRESHOLD && !runState.tripped) {
    runState.tripped = true;
    console.error(`[ai] circuit breaker tripped after ${BREAKER_THRESHOLD} consecutive AI call failures; skipping remaining AI calls this run`);
  }
}
export function getAiRunState() {
  return { tripped: runState.tripped, skippedCalls: runState.skippedCalls, budgetExhausted: Date.now() >= runState.deadline };
}
export function addAiRunUsage(inputTokens = 0, outputTokens = 0) {
  runTokens.input += inputTokens; runTokens.output += outputTokens; runTokens.calls += 1;
}
export function getAiRunUsage() { return { ...runTokens }; }

export function emptyAiUsage(config = getAiConfig()): AiUsageStats {
  return {
    enabled: config.enabled,
    model: config.model,
    rowsReviewed: 0,
    referencesExtracted: 0,
    journalRowsClassified: 0,
    possibleMatchesSuggested: 0,
    autoAccepted: 0,
    requiresHumanReview: 0,
    rescueRowsExtracted: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
}
