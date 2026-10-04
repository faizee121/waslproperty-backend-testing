import type {
  AiProvider,
  AiProviderChatParams,
  AiProviderChatResult,
  AiProviderMessage,
  AiProviderToolCall,
} from './ai-provider.interface.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

interface DeepSeekChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

function toDeepSeekMessages(
  systemPrompt: string,
  messages: AiProviderMessage[],
): DeepSeekChatMessage[] {
  const out: DeepSeekChatMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function fromDeepSeekToolCalls(
  raw: Array<{ id: string; function: { name: string; arguments: string } }> | undefined,
): AiProviderToolCall[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
}

/**
 * DeepSeek's chat-completions API is OpenAI-compatible (same request/
 * response shape, same function/tool-calling convention) — this is a thin,
 * faithful translation layer, never a place for orchestration logic (that
 * all lives in orchestrator/ai-orchestrator.ts, which knows nothing about
 * DeepSeek specifically). The API key is read once at construction from
 * server-side env config; it is never sent to, or derivable by, the
 * frontend.
 */
export class DeepSeekAiProvider implements AiProvider {
  readonly name = 'deepseek';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async chat(params: AiProviderChatParams): Promise<AiProviderChatResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

    try {
      const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: toDeepSeekMessages(params.systemPrompt, params.messages),
          tools:
            params.tools.length > 0
              ? params.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                }))
              : undefined,
          max_tokens: params.maxOutputTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`DeepSeek API error ${response.status}: ${body.slice(0, 500)}`);
      }

      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
          finish_reason: string;
        }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const choice = data.choices[0];
      if (!choice) throw new Error('DeepSeek API returned no choices');

      return {
        message: {
          role: 'assistant',
          content: choice.message.content ?? '',
          toolCalls: fromDeepSeekToolCalls(choice.message.tool_calls),
        },
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
