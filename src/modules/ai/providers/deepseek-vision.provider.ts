import type {
  VisionProvider,
  VisionProviderChatParams,
  VisionProviderChatResult,
} from './vision-provider.interface.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * DeepSeek's vision-capable model (deepseek-flash, GA Sept 2026) is
 * served from the SAME chat-completions endpoint as the text-only
 * models, but requires the OpenAI-compatible multimodal message shape —
 * `content` as an array of {type:'text'|'image_url', ...} parts, rather
 * than a plain string. This is a deliberately separate class from
 * DeepSeekAiProvider (ai-provider.interface.ts's text-only contract):
 * the two are never interchangeable, and nothing here is reachable
 * unless DOCUMENT_ANALYSIS_VISION_ENABLED + DEEPSEEK_VISION_MODEL were
 * explicitly set (see vision-provider-factory.ts) — nothing infers vision
 * capability from DEEPSEEK_MODEL just because its value happens to also
 * be "deepseek-flash".
 */
export class DeepSeekVisionProvider implements VisionProvider {
  readonly name = 'deepseek';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async chat(params: VisionProviderChatParams): Promise<VisionProviderChatResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

    try {
      const content: Array<
        { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
      > = [{ type: 'text', text: params.prompt }];
      for (const image of params.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
        });
      }

      const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content },
          ],
          max_tokens: params.maxOutputTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`DeepSeek Vision API error ${response.status}: ${body.slice(0, 500)}`);
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string | null }; finish_reason: string }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const choice = data.choices[0];
      if (!choice) throw new Error('DeepSeek Vision API returned no choices');

      return {
        content: choice.message.content ?? '',
        usage: data.usage
          ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
          : undefined,
        finishReason: choice.finish_reason,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
