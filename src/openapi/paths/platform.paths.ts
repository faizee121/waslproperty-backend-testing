import { z } from 'zod';
import {
  platformChangePasswordSchema,
  platformLoginSchema,
} from '../../modules/backoffice/auth/platform-auth.schemas.js';
import {
  backofficeOrganisationsQuerySchema,
  updateOrganisationSchema as updateBackofficeOrganisationSchema,
} from '../../modules/backoffice/organisations/backoffice-organisations.schemas.js';
import { backofficeUsersQuerySchema } from '../../modules/backoffice/users/backoffice-users.schemas.js';
import { backofficeSearchQuerySchema } from '../../modules/backoffice/search/backoffice-search.schemas.js';
import { deliveryStatusQuerySchema } from '../../modules/backoffice/jobs/backoffice-jobs.schemas.js';
import {
  grantPlatformAccessSchema,
  resetPlatformUserPasswordSchema,
  updatePlatformUserSchema,
} from '../../modules/backoffice/platform-users/backoffice-platform-users.schemas.js';
import {
  dataExplorerDeleteSchema,
  dataExplorerListQuerySchema,
  dataExplorerUpdateSchema,
} from '../../modules/backoffice/data-explorer/backoffice-data-explorer.schemas.js';
import {
  executeSqlSchema,
  sqlConsoleHistoryQuerySchema,
} from '../../modules/backoffice/sql-console/backoffice-sql-console.schemas.js';
import {
  commonErrors,
  jsonContent,
  pageQueryParams,
  paginatedSchema,
} from '../components/common.schemas.js';
import { registry, SECURITY_PLATFORM, SECURITY_PUBLIC } from '../registry.js';

const TAG = 'Platform';

const idParam = registry.register('PlatformIdParam', z.object({ id: z.string() }));
const modelParam = registry.register('PlatformModelParam', z.object({ model: z.string() }));
const modelRecordParams = registry.register(
  'PlatformModelRecordParams',
  z.object({ model: z.string(), id: z.string() }),
);

const platformUserSchema = registry.register(
  'PlatformUser',
  z.object({
    id: z.string(),
    username: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    role: z.enum([
      'PLATFORM_SUPER_ADMIN',
      'PLATFORM_ADMIN',
      'PLATFORM_SUPPORT',
      'PLATFORM_DEVELOPER',
    ]),
    isActive: z.boolean(),
  }),
);

const anyRecord = z.record(z.string(), z.unknown());

// --- Platform Auth ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/auth/environment',
  operationId: 'getBackofficeEnvironment',
  tags: [TAG],
  summary:
    'Reports which environment the Backoffice is running against (never production — none exists yet).',
  security: SECURITY_PUBLIC,
  responses: { 200: jsonContent(z.object({ environment: z.string() }), 'Environment label.') },
});

registry.registerPath({
  method: 'post',
  path: '/backoffice/auth/login',
  operationId: 'platformLogin',
  tags: [TAG],
  summary: 'Authenticates a WaslProperty Employee into the Backoffice.',
  description: 'Structurally separate from customer login — Employee is never a User.',
  security: SECURITY_PUBLIC,
  request: { body: { content: { 'application/json': { schema: platformLoginSchema } } } },
  responses: {
    200: jsonContent(z.object({ accessToken: z.string(), user: platformUserSchema }), 'Signed in.'),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/backoffice/auth/refresh',
  operationId: 'platformRefresh',
  tags: [TAG],
  summary: 'Exchanges the Backoffice refresh-token cookie for a new access token.',
  security: SECURITY_PUBLIC,
  responses: {
    200: jsonContent(z.object({ accessToken: z.string() }), 'New access token.'),
    401: commonErrors[401],
  },
});

registry.registerPath({
  method: 'post',
  path: '/backoffice/auth/logout',
  operationId: 'platformLogout',
  tags: [TAG],
  summary: 'Ends the Backoffice session.',
  security: SECURITY_PUBLIC,
  responses: { 204: { description: 'Signed out.' } },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/auth/me',
  operationId: 'getCurrentPlatformUser',
  tags: [TAG],
  summary: 'Returns the authenticated Employee.',
  security: SECURITY_PLATFORM,
  responses: { 200: jsonContent(platformUserSchema, 'Current Employee.'), 401: commonErrors[401] },
});

registry.registerPath({
  method: 'post',
  path: '/backoffice/auth/change-password',
  operationId: 'changePlatformPassword',
  tags: [TAG],
  summary: 'Changes the authenticated Employee’s own password.',
  security: SECURITY_PLATFORM,
  request: { body: { content: { 'application/json': { schema: platformChangePasswordSchema } } } },
  responses: { 200: { description: 'Changed.' }, 401: commonErrors[401], 422: commonErrors[422] },
});

// --- Dashboard / Search ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/dashboard',
  operationId: 'getBackofficeDashboard',
  tags: [TAG],
  summary: 'Returns platform-wide operational metrics across every organisation.',
  description: 'Requires `platform.dashboard.view`.',
  security: SECURITY_PLATFORM,
  responses: {
    200: jsonContent(anyRecord, 'Metrics.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/search',
  operationId: 'searchBackoffice',
  tags: [TAG],
  summary: 'Cross-entity search across organisations, properties, and users.',
  description: 'Requires `platform.dashboard.view`.',
  security: SECURITY_PLATFORM,
  request: { query: backofficeSearchQuerySchema },
  responses: {
    200: jsonContent(z.array(anyRecord), 'Matches.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

// --- Organisations ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/organisations',
  operationId: 'listBackofficeOrganisations',
  tags: [TAG],
  summary: 'Lists every organisation on the platform.',
  description: 'Requires `organisations.view`.',
  security: SECURITY_PLATFORM,
  request: { query: backofficeOrganisationsQuerySchema },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeOrganisations'), 'Organisations.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/organisations/{id}',
  operationId: 'getBackofficeOrganisation',
  tags: [TAG],
  summary: 'Returns one organisation’s full Backoffice detail view.',
  description: 'Requires `organisations.view`.',
  security: SECURITY_PLATFORM,
  request: { params: idParam },
  responses: {
    200: jsonContent(anyRecord, 'Organisation detail.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/backoffice/organisations/{id}',
  operationId: 'updateBackofficeOrganisation',
  tags: [TAG],
  summary: 'Updates an organisation’s name or status (e.g. suspend).',
  description:
    'Requires `organisations.manage`. Every call requires a `reason`, recorded to the audit log.',
  security: SECURITY_PLATFORM,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: updateBackofficeOrganisationSchema } } },
  },
  responses: {
    200: jsonContent(anyRecord, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

// --- Users ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/users',
  operationId: 'listBackofficeUsers',
  tags: [TAG],
  summary: 'Lists customer Users across every organisation.',
  description: 'Requires `users.view`.',
  security: SECURITY_PLATFORM,
  request: { query: backofficeUsersQuerySchema },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeUsers'), 'Users.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/users/{id}',
  operationId: 'getBackofficeUser',
  tags: [TAG],
  summary: 'Returns one customer User’s Backoffice detail view.',
  description: 'Requires `users.view`.',
  security: SECURITY_PLATFORM,
  request: { params: idParam },
  responses: {
    200: jsonContent(anyRecord, 'User detail.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

// --- Property data (read-only) ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/property-data/properties',
  operationId: 'listBackofficeProperties',
  tags: [TAG],
  summary: 'Lists properties across every organisation.',
  description: 'Requires `properties.view`.',
  security: SECURITY_PLATFORM,
  request: { query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeProperties'), 'Properties.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/property-data/spaces',
  operationId: 'listBackofficeSpaces',
  tags: [TAG],
  summary: 'Lists spaces across every organisation.',
  description: 'Requires `properties.view`.',
  security: SECURITY_PLATFORM,
  request: { query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeSpaces'), 'Spaces.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/property-data/memberships',
  operationId: 'listBackofficeMemberships',
  tags: [TAG],
  summary: 'Lists property memberships across every organisation.',
  description: 'Requires `properties.view`.',
  security: SECURITY_PLATFORM,
  request: { query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeMemberships'), 'Memberships.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

// --- Operations (read-only) ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/operations/requests',
  operationId: 'listBackofficeRequests',
  tags: [TAG],
  summary: 'Lists maintenance requests across every organisation.',
  description: 'Requires `operations.view`.',
  security: SECURITY_PLATFORM,
  request: { query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeRequests'), 'Requests.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/operations/work-orders',
  operationId: 'listBackofficeWorkOrders',
  tags: [TAG],
  summary: 'Lists work orders across every organisation.',
  description: 'Requires `operations.view`.',
  security: SECURITY_PLATFORM,
  request: { query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeWorkOrders'), 'Work orders.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/operations/contractors',
  operationId: 'listBackofficeContractors',
  tags: [TAG],
  summary: 'Lists contractors across every organisation.',
  description: 'Requires `operations.view`.',
  security: SECURITY_PLATFORM,
  request: { query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeContractors'), 'Contractors.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/operations/quotes',
  operationId: 'listBackofficeQuotes',
  tags: [TAG],
  summary: 'Lists contractor quotes across every organisation.',
  description: 'Requires `operations.view`.',
  security: SECURITY_PLATFORM,
  request: { query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeQuotes'), 'Quotes.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

// --- Communications (read-only) ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/communications',
  operationId: 'listBackofficeCommunications',
  tags: [TAG],
  summary: 'Lists communications across every organisation.',
  description:
    'Requires `communications.view` (platform capability, distinct from the customer-facing one).',
  security: SECURITY_PLATFORM,
  request: { query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeCommunications'), 'Communications.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/communications/{id}/deliveries',
  operationId: 'getBackofficeCommunicationDeliveries',
  tags: [TAG],
  summary: 'Returns per-recipient delivery detail for a communication.',
  description: 'Requires `communications.view`.',
  security: SECURITY_PLATFORM,
  request: { params: idParam },
  responses: {
    200: jsonContent(z.array(anyRecord), 'Delivery rows.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

// --- Jobs ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/jobs',
  operationId: 'getBackofficeJobsOverview',
  tags: [TAG],
  summary:
    'Returns the status of the in-process background workers (communications delivery, contractor compliance notifications).',
  description:
    'Requires `jobs.view`. There is no distributed job queue — see Technical Architecture → Background Processing.',
  security: SECURITY_PLATFORM,
  responses: {
    200: jsonContent(anyRecord, 'Worker status.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/jobs/deliveries',
  operationId: 'listBackofficeDeliveries',
  tags: [TAG],
  summary: 'Lists communication delivery attempts, filterable by status.',
  description: 'Requires `jobs.view`.',
  security: SECURITY_PLATFORM,
  request: { query: deliveryStatusQuerySchema },
  responses: {
    200: jsonContent(z.array(anyRecord), 'Delivery attempts.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'post',
  path: '/backoffice/jobs/deliveries/{id}/retry',
  operationId: 'retryBackofficeDelivery',
  tags: [TAG],
  summary: 'Retries one failed delivery attempt.',
  description: 'Requires `jobs.retry` — a narrower capability than `jobs.view`.',
  security: SECURITY_PLATFORM,
  request: { params: idParam },
  responses: {
    200: jsonContent(anyRecord, 'Retry queued.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

// --- Integrations (read-only status) ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/integrations',
  operationId: 'getBackofficeIntegrations',
  tags: [TAG],
  summary:
    'Reports the configuration status of external integrations (WaslSign, S3, AI provider) — never secret values.',
  description: 'Requires `integrations.view`.',
  security: SECURITY_PLATFORM,
  responses: {
    200: jsonContent(anyRecord, 'Integration status.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

// --- Audit ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/audit',
  operationId: 'listBackofficeAudit',
  tags: [TAG],
  summary: 'Lists the platform audit log (every Backoffice mutation, with its `reason`).',
  description: 'Requires `audit.view`.',
  security: SECURITY_PLATFORM,
  request: { query: z.object(pageQueryParams) },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'BackofficeAudit'), 'Audit entries.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

// --- Platform Users (manage Employee accounts) ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/platform-users',
  operationId: 'listBackofficePlatformUsers',
  tags: [TAG],
  summary: 'Lists Backoffice Employee accounts.',
  description: 'Requires `platformUsers.manage`.',
  security: SECURITY_PLATFORM,
  responses: {
    200: jsonContent(z.array(platformUserSchema), 'Employees.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'post',
  path: '/backoffice/platform-users',
  operationId: 'grantBackofficePlatformAccess',
  tags: [TAG],
  summary: 'Creates a new Employee account with Backoffice access.',
  description: 'Requires `platformUsers.manage`. Returns a generated temporary password once.',
  security: SECURITY_PLATFORM,
  request: { body: { content: { 'application/json': { schema: grantPlatformAccessSchema } } } },
  responses: {
    201: jsonContent(platformUserSchema.extend({ temporaryPassword: z.string() }), 'Created.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/backoffice/platform-users/{id}',
  operationId: 'updateBackofficePlatformUser',
  tags: [TAG],
  summary: 'Updates an Employee’s role, username, or active status.',
  description: 'Requires `platformUsers.manage`. Every call requires a `reason`.',
  security: SECURITY_PLATFORM,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: updatePlatformUserSchema } } },
  },
  responses: {
    200: jsonContent(platformUserSchema, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/backoffice/platform-users/{id}/reset-password',
  operationId: 'resetBackofficePlatformUserPassword',
  tags: [TAG],
  summary: 'Resets an Employee’s password, issuing a new temporary one.',
  description: 'Requires `platformUsers.manage`. Every call requires a `reason`.',
  security: SECURITY_PLATFORM,
  request: {
    params: idParam,
    body: { content: { 'application/json': { schema: resetPlatformUserPasswordSchema } } },
  },
  responses: {
    200: jsonContent(z.object({ temporaryPassword: z.string() }), 'Reset.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

// --- Data Explorer (generic Prisma model browser) ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/data-explorer/models',
  operationId: 'listDataExplorerModels',
  tags: [TAG],
  summary: 'Lists the Prisma models browsable through the Data Explorer.',
  description: 'Requires `database.view`.',
  security: SECURITY_PLATFORM,
  responses: {
    200: jsonContent(z.array(z.string()), 'Model names.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/data-explorer/{model}/records',
  operationId: 'listDataExplorerRecords',
  tags: [TAG],
  summary: 'Lists rows of a given model, with filters validated against that model’s own metadata.',
  description: 'Requires `database.view`.',
  security: SECURITY_PLATFORM,
  request: { params: modelParam, query: dataExplorerListQuerySchema },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'DataExplorerRecords'), 'Rows.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/data-explorer/{model}/records/{id}',
  operationId: 'getDataExplorerRecord',
  tags: [TAG],
  summary: 'Returns one row of a given model.',
  description: 'Requires `database.view`.',
  security: SECURITY_PLATFORM,
  request: { params: modelRecordParams },
  responses: {
    200: jsonContent(anyRecord, 'The row.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/backoffice/data-explorer/{model}/records/{id}',
  operationId: 'updateDataExplorerRecord',
  tags: [TAG],
  summary: 'Edits fields on one row of a given model.',
  description:
    'Requires `database.edit`. Every call requires a `reason`, recorded to the audit log.',
  security: SECURITY_PLATFORM,
  request: {
    params: modelRecordParams,
    body: { content: { 'application/json': { schema: dataExplorerUpdateSchema } } },
  },
  responses: {
    200: jsonContent(anyRecord, 'Updated.'),
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/backoffice/data-explorer/{model}/records/{id}',
  operationId: 'deleteDataExplorerRecord',
  tags: [TAG],
  summary: 'Deletes one row of a given model.',
  description:
    'Requires `database.edit` AND PLATFORM_SUPER_ADMIN — deliberately a stronger, narrower gate ' +
    'than the general edit capability for this irreversible operation. Every call requires a `reason`.',
  security: SECURITY_PLATFORM,
  request: {
    params: modelRecordParams,
    body: { content: { 'application/json': { schema: dataExplorerDeleteSchema } } },
  },
  responses: {
    200: { description: 'Deleted.' },
    401: commonErrors[401],
    403: commonErrors[403],
    404: commonErrors[404],
    422: commonErrors[422],
  },
});

// --- SQL Console (PLATFORM_SUPER_ADMIN only) ---

registry.registerPath({
  method: 'get',
  path: '/backoffice/sql-console/config',
  operationId: 'getSqlConsoleConfig',
  tags: [TAG],
  summary:
    'Returns the SQL Console’s operating configuration (e.g. whether confirmation phrases are required).',
  description: 'PLATFORM_SUPER_ADMIN only, on top of `database.sql.read`.',
  security: SECURITY_PLATFORM,
  responses: {
    200: jsonContent(anyRecord, 'Config.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});

registry.registerPath({
  method: 'post',
  path: '/backoffice/sql-console/execute',
  operationId: 'executeSqlStatement',
  tags: [TAG],
  summary: 'Executes a raw SQL statement against the production database.',
  description:
    'PLATFORM_SUPER_ADMIN only. A mutating statement requires a `reason` and the typed ' +
    'confirmation phrase ("CONFIRM", or "PRODUCTION" when NODE_ENV is production) — enforced ' +
    'server-side, never by this documentation. Every execution is recorded to the audit log. This ' +
    'operation is intentionally NOT exercised with a realistic example here — see Security.',
  security: SECURITY_PLATFORM,
  request: { body: { content: { 'application/json': { schema: executeSqlSchema } } } },
  responses: {
    200: jsonContent(z.object({ rows: z.array(anyRecord), rowCount: z.number().int() }), 'Result.'),
    401: commonErrors[401],
    403: commonErrors[403],
    422: commonErrors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/backoffice/sql-console/history',
  operationId: 'listSqlConsoleHistory',
  tags: [TAG],
  summary: 'Lists previously executed SQL Console statements.',
  description: 'PLATFORM_SUPER_ADMIN only.',
  security: SECURITY_PLATFORM,
  request: { query: sqlConsoleHistoryQuerySchema },
  responses: {
    200: jsonContent(paginatedSchema(anyRecord, 'SqlConsoleHistory'), 'History.'),
    401: commonErrors[401],
    403: commonErrors[403],
  },
});
