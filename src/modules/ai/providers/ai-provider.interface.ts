/** One tool exposed to the model, in the shape every OpenAI-compatible
 * chat-completions API expects. Built from the Secure Tool Gateway's
 * registry (see tools/tool-types.ts) — never handwritten per provider. */
export interface AiToolDefinitionForProvider {
  name: string;
  description: string;
  /** JSON Schema — the model never sees a Prisma type, only this. */
  parameters: Record<string, unknown>;
}

export interface AiProviderToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the provider returned it — parsed and
   * validated by the tool gateway, never trusted as-is. */
  arguments: string;
}

export type AiProviderMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AiProviderMessage {
  role: AiProviderMessageRole;
  /** Empty string for an assistant message that is pure tool calls. */
  content: string;
  /** Present only on an assistant message that requested tool calls. */
  toolCalls?: AiProviderToolCall[];
  /** Present only on a 'tool' role message — pairs the result with the
   * originating call. */
  toolCallId?: string;
  /** Present only on a 'tool' role message — the tool name, required by
   * some providers' message shape. */
  name?: string;
}

export interface AiProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiProviderChatResult {
  message: AiProviderMessage;
  usage?: AiProviderUsage;
  finishReason: string;
}

export interface AiProviderChatParams {
  systemPrompt: string;
  messages: AiProviderMessage[];
  tools: AiToolDefinitionForProvider[];
  maxOutputTokens: number;
  timeoutMs: number;
}

/**
 * The one seam every AI vendor integration must implement — the
 * orchestrator and tool gateway know nothing about DeepSeek, OpenAI, or
 * any other vendor's request/response shape, only this interface. Adding a
 * second provider later means implementing this interface once, never
 * touching orchestrator/gateway/tool code (see provider-factory.ts).
 */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  chat(params: AiProviderChatParams): Promise<AiProviderChatResult>;
}
