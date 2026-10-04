/**
 * The vision-equivalent of ai-provider.interface.ts's AiProvider seam —
 * deliberately a SEPARATE interface, not an optional image field bolted
 * onto AiProviderChatParams. A text-only AiProvider (e.g. a DeepSeek
 * model with no multimodal support) must never be mistaken for a
 * VisionProvider by the type system or by callers — see property-
 * documents' vision-fallback.ts, which only ever calls a provider
 * obtained from getVisionProvider() (vision-provider-factory.ts), which
 * itself only returns non-null when a vision-capable model was
 * EXPLICITLY configured (DOCUMENT_ANALYSIS_VISION_ENABLED +
 * DEEPSEEK_VISION_MODEL) — never inferred from the general AI_ENABLED/
 * DEEPSEEK_MODEL text-tier config.
 */
export interface VisionImageInput {
  mimeType: 'image/png' | 'image/jpeg';
  /** Raw base64, no "data:...;base64," prefix — each provider adapter
   * builds whatever URL/inline shape its own API expects. */
  base64: string;
}

export interface VisionProviderChatParams {
  systemPrompt: string;
  prompt: string;
  images: VisionImageInput[];
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface VisionProviderChatResult {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason: string;
}

export interface VisionProvider {
  readonly name: string;
  readonly model: string;
  chat(params: VisionProviderChatParams): Promise<VisionProviderChatResult>;
}
