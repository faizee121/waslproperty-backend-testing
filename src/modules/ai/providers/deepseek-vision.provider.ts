import type {
  VisionProvider,
  VisionProviderChatParams,
  VisionProviderChatResult,
} from './vision-provider.interface.js';
import { AiProviderError } from './provider-error.js';

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

      let response: Response;
      try {
        response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
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
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new AiProviderError(
            'TIMEOUT',
            `DeepSeek Vision API request timed out after ${params.timeoutMs}ms`,
          );
        }
        throw new AiProviderError(
          'NETWORK_ERROR',
          'DeepSeek Vision API request failed before receiving a response',
        );
      }

      if (!response.ok) {
        // Drain the body so the connection can be released, but never
        // surface it — see provider-error.ts's doc comment on why.
        await response.text().catch(() => '');
        throw new AiProviderError(
          response.status === 401 || response.status === 403 ? 'AUTH_ERROR' : 'HTTP_ERROR',
          `DeepSeek Vision API responded with status ${response.status}`,
          response.status,
        );
      }

      let data: {
        choices: Array<{ message: { content: string | null }; finish_reason: string }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      try {
        data = (await response.json()) as typeof data;
      } catch {
        throw new AiProviderError(
          'MALFORMED_RESPONSE',
          'DeepSeek Vision API returned a response that was not valid JSON',
        );
      }

      const choice = data.choices[0];
      if (!choice) {
        throw new AiProviderError('MALFORMED_RESPONSE', 'DeepSeek Vision API returned no choices');
      }

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
