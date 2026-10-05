import { z } from 'zod';
import { commonErrors, errorResponse, jsonContent } from '../components/common.schemas.js';
import { registry, SECURITY_PUBLIC } from '../registry.js';

const TAG = 'Integrations';

const waslSignCallbackSchema = registry.register(
  'WaslSignCallbackPayload',
  z.object({
    eventId: z.string().min(1),
    eventType: z.string().min(1).openapi({ example: 'agreement.signed' }),
    sourceSystem: z.string().min(1).openapi({ example: 'waslsign' }),
    sourceEntityId: z.string().min(1),
    waslSignAgreementId: z.string(),
    status: z.string().optional(),
    occurredAt: z.string().optional(),
  }),
);

registry.registerPath({
  method: 'post',
  path: '/integrations/waslsign/callback',
  operationId: 'handleWaslSignCallback',
  tags: [TAG],
  summary: 'Webhook — receives agreement/signature status callbacks from WaslSign.',
  description:
    'Not a customer-callable endpoint. Authenticated by HMAC-SHA256 signature, never a bearer ' +
    'token: the `X-WaslSign-Signature: sha256=<hex>` header is verified against the raw request ' +
    'body (registered ahead of the global JSON body parser specifically so the exact signed bytes ' +
    'are available — never re-serialized JSON) using a shared secret ' +
    '(`WASLSIGN_WEBHOOK_SECRET`, never exposed here). Routes to the Quotes or Work Order ' +
    'Variations service depending on `sourceSystem`/`sourceEntityId`. See WaslSign Integration → Webhook Processing.',
  security: SECURITY_PUBLIC,
  request: {
    body: {
      content: { 'application/json': { schema: waslSignCallbackSchema } },
      description: 'Signed by WaslSign — see the `X-WaslSign-Signature` header requirement above.',
    },
  },
  responses: {
    200: jsonContent(z.object({ received: z.literal(true) }), 'Processed.'),
    401: errorResponse('Missing or invalid X-WaslSign-Signature.'),
    404: commonErrors[404],
    503: {
      description: 'The webhook receiver is not configured (WASLSIGN_WEBHOOK_SECRET missing).',
      content: {
        'application/json': {
          schema: z.object({
            error: z.object({ code: z.literal('NOT_CONFIGURED'), message: z.string() }),
          }),
        },
      },
    },
  },
});
