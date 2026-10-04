import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4100),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(1, 'JWT_ACCESS_SECRET is required'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
  JWT_REFRESH_EXPIRES_IN_DAYS: z.coerce.number().default(30),
  // Empty string means "omit the Domain attribute" (host-only cookie) — see
  // setRefreshCookie in lib/cookies.ts. Required when the frontend and
  // backend are on different registrable domains (e.g. two separate
  // *.onrender.com services), where a shared Domain attribute is neither
  // valid nor desired.
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // 'none' is required (together with COOKIE_SECURE=true) for the refresh
  // cookie to be sent on cross-site requests — e.g. a frontend and backend
  // deployed as separate Render services. Left at the 'lax' default
  // everywhere frontend and backend share a site (local dev, and any
  // same-registrable-domain production setup).
  COOKIE_SAME_SITE: z.enum(['lax', 'none', 'strict']).default('lax'),
  // Comma-separated for staging/prod, where more than one origin (e.g. a
  // local dev frontend and a deployed one) may need to call the same
  // backend. A single value works exactly as before.
  FRONTEND_URL: z.string().default('http://localhost:5174'),
  BACKEND_PUBLIC_URL: z.string().default('http://localhost:4100'),
  LOG_LEVEL: z.string().default('info'),

  INVITE_TOKEN_EXPIRES_IN_HOURS: z.coerce.number().default(72),
  // How long a contractor's own RFQ response link stays valid — deliberately
  // longer than a resident/staff invite (a contractor may need days to
  // price a job), and independent of the quote round's own dueAt (the
  // token can outlive an informal deadline; the round's status, not token
  // expiry, is what actually closes a round to new responses).
  RFQ_TOKEN_EXPIRES_IN_DAYS: z.coerce.number().default(21),

  AWS_REGION: z.string().min(1, 'AWS_REGION is required'),
  S3_BUCKET_NAME: z.string().min(1, 'S3_BUCKET_NAME is required'),
  MAINTENANCE_ATTACHMENT_MAX_FILES: z.coerce.number().default(5),
  MAINTENANCE_ATTACHMENT_MAX_SIZE_MB: z.coerce.number().default(10),
  // Credential evidence (licence scans, Certificates of Currency, ...) — a
  // separate limit from maintenance photos since these are commonly
  // multi-page PDF scans, not single photos.
  CREDENTIAL_DOCUMENT_MAX_SIZE_MB: z.coerce.number().default(15),
  // Days out from expiry a VERIFIED credential is considered
  // EXPIRING_SOON rather than CURRENT — a sensible central default, not
  // organisation-configurable this milestone (see the compliance
  // milestone report).
  CREDENTIAL_EXPIRING_SOON_DAYS: z.coerce.number().default(30),

  // --- Outbound email ---
  // RESEND_API_KEY is the production/staging transport (Resend's HTTPS
  // API) — required anywhere the platform blocks outbound SMTP ports (e.g.
  // Render's Free Web Service tier blocks 25/465/587 entirely, so SMTP is
  // a hard outage there regardless of which mail provider is behind it).
  // Left unset, EmailService falls back to SMTP, which only ever makes
  // sense in local development. See src/lib/email/selectEmailProvider.ts.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Wasl Property <no-reply@waslproperty.dev>'),

  // SMTP: local-development-only fallback transport (see
  // SmtpEmailProvider). Leave SMTP_HOST unset in development to use an
  // ad-hoc Ethereal test inbox instead of a real mailbox.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Wasl Property <no-reply@waslproperty.dev>'),

  // --- WaslSign integration (M9-A) ---
  // Optional: an environment with none of these set simply can't offer
  // SIGNATURE_ONLY / APPROVAL_THEN_SIGNATURE — WaslSignService treats that
  // as "unavailable", never as a hard startup failure.
  //
  // NOTE: WORK_ORDER_WASLSIGN_THRESHOLD_AED / WORK_ORDER_DEFAULT_WORKFLOW_MODE
  // used to live here, deciding whether a quote needed approval/signature
  // purely from a hard-coded AED amount. That was wrong on two counts: it's
  // customer business policy, not deployment config, and it ignored
  // currency entirely. Removed as of the M12 Approval & Acceptance Policy
  // milestone — see src/modules/approval-policy/approval-policy.service.ts,
  // the one remaining source of truth for this decision.
  WASLSIGN_API_BASE_URL: z.string().optional(),
  WASLSIGN_SERVICE_CLIENT_ID: z.string().optional(),
  WASLSIGN_SERVICE_CLIENT_SECRET: z.string().optional(),
  WASLSIGN_WEBHOOK_SECRET: z.string().optional(),

  // --- Backoffice / Platform Operations (M10.5) ---
  // Every one of these defaults to the safe/disabled state when absent —
  // production is never accidentally opened up just because a var wasn't
  // set. See src/platform/privacy-policy.ts for how NODE_ENV interacts
  // with BACKOFFICE_PII_MODE (the mode itself isn't a plain default here
  // because "masked in production unless explicitly overridden" depends on
  // NODE_ENV too, not just this one var in isolation).
  BACKOFFICE_PII_MODE: z.enum(['masked', 'full']).optional(),
  BACKOFFICE_RAW_SQL_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  BACKOFFICE_RAW_SQL_WRITE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  BACKOFFICE_RAW_SQL_UNMASKED_PII_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  BACKOFFICE_SQL_MAX_UPDATE_ROWS: z.coerce.number().default(500),
  BACKOFFICE_SQL_RESULT_ROW_LIMIT: z.coerce.number().default(500),
  BACKOFFICE_SQL_STATEMENT_TIMEOUT_MS: z.coerce.number().default(5000),

  // --- Wasl AI (M14) ---
  // Platform-wide kill switch — one of three ANDed conditions for AI to be
  // usable at all (see AiService.isAiAvailableForUser); defaults off so no
  // deployment accidentally exposes AI just by having a key present.
  AI_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Only one provider is implemented this milestone (see
  // src/modules/ai/providers) — the field exists so a second provider
  // never requires touching call sites, only provider-factory.ts.
  AI_PROVIDER: z.enum(['deepseek']).default('deepseek'),
  DEEPSEEK_API_KEY: z.string().optional(),
  // Used for the lightweight ROUTINE model-routing tier (most tool-using
  // investigation turns).
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  // Used for the ANALYSIS tier (heavier synthesis, e.g. quote/pattern
  // reasoning over an already-assembled evidence set) — both tiers may
  // point at the same model; this is a routing seam, not a second
  // integration. See providers/provider-factory.ts.
  DEEPSEEK_ANALYSIS_MODEL: z.string().default('deepseek-reasoner'),
  // Reserved for a future milestone — no write action exists yet (M14 is
  // strictly read-only), but the flag is defined now so the eventual
  // PreparedAiAction execution path has a kill switch from day one rather
  // than being retrofitted. Always false until that milestone ships.
  AI_WRITE_ACTIONS_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Execution budgets — every one fails closed (see
  // src/modules/ai/budget/execution-budget.ts): exceeding any of these
  // ends the turn with a clear "couldn't complete" response, never a
  // fabricated answer.
  AI_MAX_TURNS: z.coerce.number().default(4),
  AI_MAX_TOOL_CALLS: z.coerce.number().default(8),
  AI_MAX_TOOL_CALLS_PER_TOOL: z.coerce.number().default(3),
  AI_TOOL_TIMEOUT_MS: z.coerce.number().default(15000),
  AI_PROVIDER_TIMEOUT_MS: z.coerce.number().default(45000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().default(2000),
  // Best-effort, single-process rate limiting (src/modules/ai/rate-limit) —
  // not distributed/Redis-backed, since no shared cache layer exists
  // elsewhere in this stack. Sufficient to blunt runaway usage from one
  // deployment instance; documented as a deliberate simplification in the
  // M14 report, not a scaling-safe primitive.
  AI_RATE_LIMIT_PER_USER_PER_HOUR: z.coerce.number().default(30),

  // --- Property Document Intelligence (M15) ---
  // Cost/execution bounds for the document-analysis pipeline — every one
  // fails closed (an exceeded bound ends the analysis as FAILED/
  // REVIEW_REQUIRED, never a silently-truncated "best effort" extraction
  // treated as complete).
  DOCUMENT_ANALYSIS_MAX_FILE_SIZE_MB: z.coerce.number().default(15),
  DOCUMENT_ANALYSIS_MAX_PAGES: z.coerce.number().default(20),
  // Per-page OCR text is truncated to this many characters before being
  // handed to the AI interpretation stage — bounds both AI input size and
  // the stored extraction/provenance payload.
  DOCUMENT_ANALYSIS_MAX_OCR_TEXT_CHARS_PER_PAGE: z.coerce.number().default(6000),
  DOCUMENT_ANALYSIS_MAX_AI_OUTPUT_TOKENS: z.coerce.number().default(3000),
  DOCUMENT_ANALYSIS_OCR_TIMEOUT_MS: z.coerce.number().default(90000),
  DOCUMENT_ANALYSIS_PROVIDER_TIMEOUT_MS: z.coerce.number().default(60000),
  // The whole pipeline (render -> OCR -> AI interpretation -> validation)
  // is abandoned (FAILED) past this — the single top-level bound the async
  // analysis runner enforces around everything else.
  DOCUMENT_ANALYSIS_TOTAL_TIMEOUT_MS: z.coerce.number().default(240000),
  // A document stuck in ANALYSING past this long (server restarted
  // mid-analysis, no job recovery exists — see the M15 report's
  // documented limitation) is treated as FAILED the next time it's read,
  // rather than polling forever.
  DOCUMENT_ANALYSIS_STUCK_THRESHOLD_MS: z.coerce.number().default(300000),

  // --- Vision fallback (M15.1) ---
  // A SEPARATE kill switch from AI_ENABLED — OCR+text-interpretation
  // stays the default path even when general AI is on; vision only runs
  // when this is explicitly true AND a critical field genuinely failed
  // OCR/reconciliation (see nsw-strata-plan/vision-fallback.ts). Fails
  // closed: unset/false means the pipeline behaves exactly as it did
  // before this feature existed.
  DOCUMENT_ANALYSIS_VISION_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Mirrors AI_PROVIDER's shape (a routing seam, not a built-out router) —
  // the field exists so a second vision vendor never requires touching
  // call sites, only vision-provider-factory.ts.
  VISION_PROVIDER: z.enum(['deepseek']).default('deepseek'),
  // Deliberately a DIFFERENT env var from DEEPSEEK_MODEL/
  // DEEPSEEK_ANALYSIS_MODEL — vision capability must be named explicitly,
  // never inferred just because one of those happens to also be set to a
  // vision-capable model name (see vision-provider.interface.ts's doc
  // comment).
  DEEPSEEK_VISION_MODEL: z.string().default('deepseek-flash'),
  // Bounded: at most this many candidate pages are ever rendered and sent
  // to vision for one document — cost control, never the whole document.
  DOCUMENT_ANALYSIS_VISION_MAX_PAGES: z.coerce.number().default(1),
  DOCUMENT_ANALYSIS_VISION_RENDER_SCALE: z.coerce.number().default(4),
  DOCUMENT_ANALYSIS_VISION_TIMEOUT_MS: z.coerce.number().default(60000),
  DOCUMENT_ANALYSIS_VISION_MAX_OUTPUT_TOKENS: z.coerce.number().default(2000),
  // Bounded retries on an invalid/unparseable vision response — mirrors
  // interpretStrataPlan()'s own retry bound, never open-ended.
  DOCUMENT_ANALYSIS_VISION_MAX_RETRIES: z.coerce.number().default(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
