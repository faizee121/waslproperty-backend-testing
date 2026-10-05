import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { requestLogger } from './middlewares/requestLogger.js';
import { asyncHandler } from './middlewares/asyncHandler.js';
import { handleWaslSignCallback } from './modules/integrations/waslsign/waslsign.controller.js';
import { apiV1Router } from './routes/v1/index.js';
import { getOpenApiDocument } from './openapi/index.js';

export function createApp() {
  const app = express();

  // Trust exactly ONE hop of reverse proxy — correct for this platform's
  // deployment topology (a single edge/load balancer in front of the app,
  // e.g. Render), and deliberately NOT `true`/a blind boolean: that would
  // trust an arbitrarily long, client-controlled X-Forwarded-For chain,
  // letting any direct caller spoof req.ip by just sending their own
  // X-Forwarded-For header — exactly what IP-based rate limiting (see
  // middlewares/authRateLimit.ts) depends on NOT being spoofable. Only set
  // outside local development/test, where there IS no real proxy in front
  // — setting this locally would have the opposite effect, trusting a
  // spoofable header instead of the real socket address.
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  // FRONTEND_URL is comma-separated so staging can allow both a deployed
  // frontend and a local dev one (or any other legitimate origin) without
  // wildcarding — a request from anything else is still rejected.
  const allowedOrigins = env.FRONTEND_URL.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(requestLogger);
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header (e.g. curl, server-to-server, the WaslSign
        // webhook) is never a browser CORS request — nothing to check.
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`Origin ${origin} is not allowed`));
        }
      },
      credentials: true,
    }),
  );

  // WaslSign webhook — MUST be registered before express.json() consumes the
  // raw body stream, same pattern WaslSign itself uses for its Stripe
  // webhook. express.raw() captures the exact bytes needed for HMAC
  // verification; JSON-parsing first and re-serializing to verify would
  // silently accept a tampered payload that happens to re-serialize the same.
  app.post(
    '/api/v1/integrations/waslsign/callback',
    express.raw({ type: 'application/json' }),
    asyncHandler(handleWaslSignCallback),
  );

  app.use(express.json());
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // The authoritative, machine-readable API contract (see ADR-driven
  // "WaslProp API Documentation" milestone) — generated once, from the same
  // Zod schemas the routes below validate against, never hand-maintained
  // separately. /api/docs renders it as interactive Swagger UI.
  app.get('/api/openapi.json', (_req, res) => {
    res.json(getOpenApiDocument());
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(getOpenApiDocument(), {
      customSiteTitle: 'WaslProp API',
      swaggerOptions: { docExpansion: 'list', displayRequestDuration: true },
    }),
  );

  app.use('/api/v1', apiV1Router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
