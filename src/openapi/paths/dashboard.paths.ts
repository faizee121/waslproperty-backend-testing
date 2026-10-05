import { z } from 'zod';
import { dashboardQuerySchema } from '../../modules/dashboard/dashboard.schemas.js';
import { commonErrors, jsonContent } from '../components/common.schemas.js';
import { registry, SECURITY_CUSTOMER } from '../registry.js';

const TAG = 'Dashboard';

registry.registerPath({
  method: 'get',
  path: '/dashboard',
  operationId: 'getDashboard',
  tags: [TAG],
  summary: 'Returns the caller’s operational dashboard metrics for the given period.',
  description:
    'Scoped to the organisations/properties the caller can access, same resolution as every other list endpoint.',
  security: SECURITY_CUSTOMER,
  request: { query: dashboardQuerySchema },
  responses: {
    200: jsonContent(
      z.record(z.string(), z.unknown()).openapi({
        description: 'Aggregate counts/trends; shape evolves with the dashboard UI.',
      }),
      'Dashboard metrics.',
    ),
    401: commonErrors[401],
  },
});
