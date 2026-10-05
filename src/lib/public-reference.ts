import { randomInt } from 'node:crypto';

/**
 * Customer-facing Public Reference system (e.g. PROP-K7M4Q2, MR-P8X3DF) —
 * short, immutable, human-friendly identifiers that replace raw CUIDs in
 * customer-facing URLs, AI resource references, and operational display
 * text. This is NOT a primary key system: `id` (the cuid) remains the sole
 * internal technical identity and every FK relationship in the schema is
 * completely unaffected — see the model doc comments on each
 * `publicReference` column.
 *
 * A public reference is an IDENTIFIER, never authorization — every service
 * method that resolves one still runs the exact same organisation/property/
 * capability checks it already did for a plain id (see idOrPublicReference
 * below, which only widens the lookup key, not what happens after a match).
 */

/** Visually unambiguous alphabet — no 0/O or 1/I, so a reference read aloud
 * or typed from memory (e.g. in a future WhatsApp message) is never
 * misheard/mistyped into a different valid-looking token. */
const TOKEN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const TOKEN_LENGTH = 6;

function randomToken(): string {
  let token = '';
  for (let i = 0; i < TOKEN_LENGTH; i++) {
    token += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  }
  return token;
}

/** Builds one candidate reference, e.g. buildPublicReference('PROP') ->
 * "PROP-K7M4Q2". Never derived from the row's own id/name/row count/any
 * other existing data — see this file's doc comment on why (predictable
 * references would be enumerable). Server-side only; the frontend never
 * generates one. */
export function buildPublicReference(prefix: string): string {
  return `${prefix}-${randomToken()}`;
}

/**
 * Specifically the publicReference unique constraint — NOT any P2002.
 * Checked via the constraint/index name Postgres reports in `meta.target`,
 * never assumed just because the error code matches. This matters: `persist`
 * may insert/update other unique-constrained columns too (e.g. a Space's
 * `code`, or the new lotNumber partial index), and retrying with a freshly
 * generated publicReference would never resolve a collision on a DIFFERENT
 * column — it would just waste attempts, and when `persist` runs inside an
 * open Prisma $transaction, retrying the same transaction client after ANY
 * error leaves Postgres in an aborted-transaction state, so the retry's own
 * error (25P02, "current transaction is aborted") would then overwrite and
 * hide the real, original error entirely by the time maxAttempts is
 * exhausted.
 */
function isPublicReferenceCollision(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002' &&
    String((err as { meta?: { target?: unknown } }).meta?.target ?? '').includes('publicReference')
  );
}

/**
 * Wraps a single Prisma `.create()`/`.update()` (or `$transaction`) call
 * that needs a freshly generated, collision-safe public reference — used
 * both for new-resource creation and for the one-time existing-data
 * backfill (prisma/backfill-public-references.ts). Relies on the
 * database's own unique constraint to detect a collision — never a
 * separate "check then insert" query, which is inherently racy — and
 * retries with a new candidate only on that specific error. With a
 * 32-character alphabet and 6 characters (~1.07 billion combinations per
 * prefix), a real collision is astronomically unlikely; the bounded retry
 * exists purely as a correctness guarantee, not because collisions are
 * expected in practice.
 */
export async function withPublicReference<T>(
  prefix: string,
  persist: (publicReference: string) => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await persist(buildPublicReference(prefix));
    } catch (err) {
      if (isPublicReferenceCollision(err) && attempt < maxAttempts) continue;
      throw err;
    }
  }
  /* istanbul ignore next -- unreachable: the loop above always returns or throws */
  throw new Error('withPublicReference: exhausted retry attempts');
}

/**
 * The one place a route param is turned into a Prisma lookup that accepts
 * EITHER the internal cuid OR the public reference — used as a drop-in
 * replacement for `{ id: value }` in every `findFirst`/`findUnique` a
 * controller already scopes by organisationId (or any other authorization
 * filter). Resolution happens first; authorization is whatever the caller
 * already enforces on the result — this function adds no trust of its own
 * (see this file's doc comment: a public reference is never authorization).
 */
export function idOrPublicReferenceWhere(value: string): {
  OR: [{ id: string }, { publicReference: string }];
} {
  return { OR: [{ id: value }, { publicReference: value }] };
}
