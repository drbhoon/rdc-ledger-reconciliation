import type { AiUsageStats } from './types';

export type AiConfig = {
  enabled: boolean;
  model: string;
  confidenceThreshold: number;
  maxRows: number;
  concurrency: number;
  requestTimeoutMs: number;
  rescueMaxChunks: number;
};

export function getAiConfig(): AiConfig {
  return {
    enabled: process.env.AI_ENABLED === 'true' && !!process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    confidenceThreshold: Number(process.env.AI_CONFIDENCE_THRESHOLD || 0.75),
    maxRows: Number(process.env.AI_MAX_ROWS || 80),
    concurrency: Math.max(1, Number(process.env.AI_CONCURRENCY || 4)),
    requestTimeoutMs: Math.max(5000, Number(process.env.AI_REQUEST_TIMEOUT_MS || 25000)),
    rescueMaxChunks: Math.max(1, Number(process.env.AI_RESCUE_MAX_CHUNKS || 60)),
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
