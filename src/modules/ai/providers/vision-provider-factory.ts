import { env } from '../../../config/env.js';
import { DeepSeekVisionProvider } from './deepseek-vision.provider.js';
import type { VisionProvider } from './vision-provider.interface.js';

/** Vision's own platform-availability check — intentionally separate
 * from isAiPlatformAvailable() (provider-factory.ts). AI_ENABLED=true
 * does NOT imply vision is available; DOCUMENT_ANALYSIS_VISION_ENABLED
 * must be explicitly set too. This is the fail-closed default this
 * feature ships with — no deployment gets vision just by having
 * DEEPSEEK_API_KEY and AI_ENABLED set for the unrelated M14 assistant. */
export function isVisionPlatformAvailable(): boolean {
  if (!env.DOCUMENT_ANALYSIS_VISION_ENABLED) return false;
  if (env.VISION_PROVIDER === 'deepseek') return Boolean(env.DEEPSEEK_API_KEY);
  return false;
}

/** Returns null (never throws) when vision is platform-unavailable —
 * every caller (vision-fallback.ts) must treat null as "cannot attempt
 * vision", falling back to the OCR-only result rather than failing the
 * whole analysis. */
export function getVisionProvider(): VisionProvider | null {
  if (!isVisionPlatformAvailable()) return null;

  if (env.VISION_PROVIDER === 'deepseek') {
    // isVisionPlatformAvailable already confirmed DEEPSEEK_API_KEY is set.
    return new DeepSeekVisionProvider(env.DEEPSEEK_VISION_MODEL, env.DEEPSEEK_API_KEY as string);
  }

  return null;
}
