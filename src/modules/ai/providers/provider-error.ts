/**
 * The one error shape every AiProvider/VisionProvider implementation must
 * throw for a failed call — never a plain Error. `message` is always a
 * short, hand-written, safe-to-log description (e.g. "DeepSeek API
 * responded with status 500"); it must NEVER embed the provider's raw
 * response body, which may reflect back document/customer content or
 * other data this process has no business persisting into logs. Any
 * caller that needs to distinguish failure modes (observability logging,
 * a different retry policy) should branch on `kind`/`status`, not parse
 * `message`.
 */
export type AiProviderErrorKind =
  'TIMEOUT' | 'AUTH_ERROR' | 'HTTP_ERROR' | 'MALFORMED_RESPONSE' | 'NETWORK_ERROR';

export class AiProviderError extends Error {
  constructor(
    readonly kind: AiProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
