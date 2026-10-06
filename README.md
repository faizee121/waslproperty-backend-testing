# WaslProperty Backend

Backend services and APIs for **WaslProperty** — an independent property & strata operations SaaS product.

## Architecture

WaslProperty is an independent application with its own backend, database and domain models.

WaslSign provides the underlying approval, signature and audit capabilities through API integration only — WaslProperty never accesses the WaslSign database directly, and the integration is optional (see `WASLSIGN_*` below).

## Stack

- Node.js 22, TypeScript, Express
- Prisma + PostgreSQL (own database instance)
- Zod for request validation
- Pino for structured logging with request correlation IDs
- Vitest + Supertest for tests

## Prerequisites

- Node.js 22+ (see `engines` in `package.json`)
- pnpm (via [Corepack](https://nodejs.org/api/corepack.html), bundled with Node.js)
- Docker (for the local PostgreSQL instance via `docker-compose.yml`) — or any local PostgreSQL 16 server if you'd rather not use Docker

## Local development

```bash
corepack enable
pnpm install
cp .env.example .env            # edit DATABASE_URL etc. if not using the default docker-compose setup
docker compose up -d            # starts local Postgres on localhost:5433
pnpm prisma:generate
pnpm prisma:migrate             # applies migrations to DATABASE_URL (non-interactive: use prisma:migrate:deploy)
pnpm db:seed                    # optional — creates a demo organisation (see prisma/seed.ts for credentials)
pnpm dev                        # http://localhost:4100
```

`.env.example` documents every environment variable, including which are optional. At minimum, `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `FRONTEND_URL` (CORS origin — must match the frontend dev server, default `http://localhost:5174`) are required to start the API. The `WASLSIGN_*`, `AWS_*`/S3, and `SMTP_*` variables are optional in development — the app degrades gracefully (e.g. `WaslSignService` treats an unset `WASLSIGN_API_BASE_URL` as "unavailable," and unset `SMTP_HOST` falls back to a logged Ethereal test inbox) rather than failing to start.

For a Backoffice (internal admin) account, use `pnpm platform:create-user` (see `prisma/create-platform-user.ts`).

## Scripts

- `pnpm dev` — run the API with hot reload (http://localhost:4100)
- `pnpm build` / `pnpm start` — production build (`dist/`) and run
- `pnpm typecheck` — TypeScript project check, no emit
- `pnpm lint` / `pnpm lint:fix` — ESLint
- `pnpm format` / `pnpm format:check` — Prettier
- `pnpm test` — Vitest unit/integration tests (requires a running database — see `.env.test`)
- `pnpm test:watch` — Vitest in watch mode
- `pnpm prisma:generate` — regenerate the Prisma client after a schema change
- `pnpm prisma:migrate` — create/apply migrations interactively (local dev)
- `pnpm prisma:migrate:deploy` — apply existing migrations non-interactively (CI, or a non-interactive shell)
- `pnpm prisma:studio` — open Prisma Studio against `DATABASE_URL`
- `pnpm db:seed` — seed a demo organisation
- `pnpm platform:create-user` — create a Backoffice (platform) user

## Tests

Integration tests run against a real Postgres database configured by `.env.test` (a separate database from `.env`'s `DATABASE_URL`, so `pnpm test` never touches your dev data). Apply the same migrations to it before running tests:

```bash
DATABASE_URL="$(grep '^DATABASE_URL' .env.test | cut -d= -f2-)" pnpm prisma:migrate:deploy
pnpm test
```

## Before committing

```bash
pnpm typecheck && pnpm lint && pnpm test
```

## Staging (temporary)

A **temporary** staging deployment — replaced by real AWS infrastructure later, not meant to be maintained long-term. Database is Supabase (Postgres hosting only; no app logic runs there), WaslSign runs locally and is reached through a temporary HTTPS tunnel.

- **Render Web Service**: `waslprop-api-staging` (free instance)
- Build command: `corepack enable && pnpm install --frozen-lockfile && pnpm prisma:generate && pnpm build`
- Start command: `pnpm prisma:migrate:deploy && pnpm start`
- Health check path: `/health` (already exists, returns `{"status":"ok"}`)
- `DATABASE_URL` — Supabase's **direct** (non-pooled, port 5432) connection string, not the pgbouncer/transaction pooler one — avoids needing a separate `DIRECT_URL` for `prisma migrate deploy`
- `FRONTEND_URL` — comma-separated allowed origins, e.g. `https://waslprop-staging.onrender.com,http://localhost:5174`
- `COOKIE_SECURE=true`, `COOKIE_SAME_SITE=none`, `COOKIE_DOMAIN=` (empty) — required because the Render frontend and backend are on different registrable domains; see `src/lib/cookies.ts`
- `BACKEND_PUBLIC_URL` — this service's own Render URL, e.g. `https://waslprop-api-staging.onrender.com` (used as the WaslSign webhook callback target)
- `WASLSIGN_API_BASE_URL` — the temporary tunnel URL exposing local WaslSign (see `waslsign-backend`'s README)
- `WASLSIGN_SERVICE_CLIENT_ID` / `WASLSIGN_SERVICE_CLIENT_SECRET` — from WaslSign's `scripts/create-service-client.ts`
- `WASLSIGN_WEBHOOK_SECRET` — must exactly match the same variable in the local WaslSign `.env`
- All other required vars (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `AWS_REGION`, `S3_BUCKET_NAME`, etc.) as documented in `.env.example`



<!-- testing full CI/CD pipeline --><!-- testing full CI/CD pipeline -->
