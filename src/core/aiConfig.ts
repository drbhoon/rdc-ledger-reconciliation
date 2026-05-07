import type { AiUsageStats } from './types';

export type AiConfig = {
  enabled: boolean;
  model: string;
  confidenceThreshold: number;
  maxRows: number;
};

export function getAiConfig(): AiConfig {
  return {
    enabled: process.env.AI_ENABLED === 'true' && !!process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    confidenceThreshold: Number(process.env.AI_CONFIDENCE_THRESHOLD || 0.75),
    maxRows: Number(process.env.AI_MAX_ROWS || 80),
  };
}

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
  };
}
