import { env } from '../../../config/env.js';
import type { AiProvider } from './ai-provider.interface.js';
import { DeepSeekAiProvider } from './deepseek.provider.js';

/** Lightweight ROUTINE/ANALYSIS routing seam — both tiers currently point
 * at DeepSeek (ROUTINE at the chat model, ANALYSIS at the reasoning model),
 * deliberately not a full router. A tool-heavy investigation turn asks for
 * ROUTINE; a synthesis-heavy step (quote/pattern reasoning over an
 * already-assembled evidence set) may ask for ANALYSIS. Never over-built
 * beyond this seam for M14. */
export type AiModelIntent = 'ROUTINE' | 'ANALYSIS';

/** Platform-wide half of the AI kill switch — true only when AI_ENABLED is
 * set AND the configured provider is actually usable (has credentials).
 * The other two ANDed conditions (organisation.aiEnabled, the requesting
 * user's `ai.use` capability) are checked by AiService, not here — this
 * function knows nothing about a specific organisation or user. */
export function isAiPlatformAvailable(): boolean {
  if (!env.AI_ENABLED) return false;
  if (env.AI_PROVIDER === 'deepseek') return Boolean(env.DEEPSEEK_API_KEY);
  return false;
}

/** Returns null (never throws) when AI is platform-unavailable — every
 * caller must treat null as "cannot proceed", the fail-closed default. */
export function getAiProvider(intent: AiModelIntent): AiProvider | null {
  if (!isAiPlatformAvailable()) return null;

  if (env.AI_PROVIDER === 'deepseek') {
    const model = intent === 'ANALYSIS' ? env.DEEPSEEK_ANALYSIS_MODEL : env.DEEPSEEK_MODEL;
    // isAiPlatformAvailable already confirmed DEEPSEEK_API_KEY is set.
    return new DeepSeekAiProvider(model, env.DEEPSEEK_API_KEY as string);
  }

  return null;
}
