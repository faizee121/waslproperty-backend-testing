/**
 * The Data Explorer's entire security surface starts here. Every model,
 * every field, every relation shown or editable in the Backoffice Data
 * Explorer must be listed explicitly — nothing is ever derived from Prisma
 * introspection or DMMF. If a model or field isn't in this file, the
 * explorer cannot see it, list it, or write to it, no matter what exists in
 * the schema.
 *
 * Deliberately excluded models (never add these, even read-only):
 * - Session / EmployeeSession: hold refreshTokenHash (SECRET_FIELDS) and are
 *   live authentication artifacts, not a debugging target.
 * - PlatformAuditEvent: append-only by design (see platform/audit.ts) —
 *   exposing it here, even read-only, would invite someone to eventually
 *   wire up editing. Already has its own read-only Audit Log screen.
 * - ContactInvite: holds tokenHash (SECRET_FIELDS), a single-use activation
 *   secret.
 * - WaslSignWebhookEvent: raw third-party webhook payloads; not part of the
 *   Wasl Property operational domain.
 * - MaintenanceRequestAttachment: holds storageKey, which application code
 *   elsewhere is explicit must never reach the frontend un-mediated.
 *
 * Employee is deliberately INCLUDED but field-edits are entirely blocked
 * (every field editable: false) — mutating an employee's role/username/
 * active-status/password stays exclusively on the dedicated Internal Users
 * screen, which has its own last-Super-Admin and password-reset safeguards
 * this generic explorer doesn't replicate. passwordHash is never listed in
 * its fields at all (structurally unselectable, not just masked), the same
 * pattern used for User.passwordHash. Row *deletion* IS allowed
 * (PLATFORM_SUPER_ADMIN-only) — including a Super Admin deleting their own
 * account or the last active Super Admin, which is a real, known,
 * deliberately-unblocked risk — see the Employee entry's own comment below.
 */
import type { PlatformCapability } from './capabilities.js';

export type DataExplorerFieldType =
  'string' | 'text' | 'int' | 'decimal' | 'boolean' | 'datetime' | 'json' | 'enum' | 'stringArray';

export interface DataExplorerFieldMeta {
  readonly name: string;
  readonly type: DataExplorerFieldType;
  readonly editable: boolean;
  readonly enumValues?: readonly string[];
  /** Requires the actor to satisfy canViewUnmaskedPii before this field may
   * be edited — never before it may merely be viewed (masking, not
   * visibility, is what PII policy governs for reads). */
  readonly piiSensitive?: boolean;
}

export interface DataExplorerRelationMeta {
  /** The actual Prisma relation property name on this model (not the FK
   * scalar column) — e.g. "property", not "propertyId". */
  readonly field: string;
  readonly label: string;
  readonly targetModel: string;
}

export interface DataExplorerModelMeta {
  readonly model: string;
  readonly delegate: string;
  readonly label: string;
  readonly searchableFields: readonly string[];
  readonly fields: readonly DataExplorerFieldMeta[];
  readonly relations: readonly DataExplorerRelationMeta[];
  readonly defaultOrderBy: string;
  /** Whether a whole row may be deleted via the explorer (PLATFORM_SUPER_ADMIN
   * only regardless — see requirePlatformSuperAdmin on the delete route).
   * True for every model, including the otherwise field-view-only ones
   * (Employee, Communication, ActivityEvent, ...) — an explicit product
   * decision that Super Admin gets real, unrestricted delete power here,
   * matching the trust model already given to raw SQL DELETE in the SQL
   * Console. Kept as a per-model flag (not just always-true) so a future
   * model can still opt out deliberately and visibly, the same allowlist
   * philosophy as every other field in this file. */
  readonly deletable: boolean;
}

const f = (
  name: string,
  type: DataExplorerFieldType,
  editable: boolean,
  extra?: Partial<Pick<DataExplorerFieldMeta, 'enumValues' | 'piiSensitive'>>,
): DataExplorerFieldMeta => ({ name, type, editable, ...extra });

export const DATA_EXPLORER_MODELS: Record<string, DataExplorerModelMeta> = {
  Organisation: {
    model: 'Organisation',
    delegate: 'organisation',
    label: 'Organisation',
    searchableFields: ['name', 'slug'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('name', 'string', true),
      f('slug', 'string', false),
      f('status', 'enum', true, { enumValues: ['ACTIVE', 'SUSPENDED'] }),
      f('currencyCode', 'string', true),
      f('countryCode', 'string', true),
      f('waslSignOrganisationId', 'string', false),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [],
  },

  User: {
    model: 'User',
    delegate: 'user',
    label: 'User',
    searchableFields: ['email', 'firstName', 'lastName'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('email', 'string', false, { piiSensitive: true }),
      f('firstName', 'string', true),
      f('lastName', 'string', true),
      f('status', 'enum', true, { enumValues: ['ACTIVE', 'INVITED', 'SUSPENDED'] }),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [],
  },

  OrganisationMembership: {
    model: 'OrganisationMembership',
    delegate: 'organisationMembership',
    label: 'Organisation Membership',
    searchableFields: [],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('userId', 'string', false),
      f('role', 'enum', true, { enumValues: ['OWNER', 'ADMIN', 'MEMBER'] }),
      f('status', 'enum', true, { enumValues: ['ACTIVE', 'INVITED', 'SUSPENDED'] }),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [
      { field: 'organisation', label: 'Organisation', targetModel: 'Organisation' },
      { field: 'user', label: 'User', targetModel: 'User' },
    ],
  },

  Property: {
    model: 'Property',
    delegate: 'property',
    label: 'Property',
    searchableFields: ['name', 'code', 'city'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('name', 'string', true),
      f('code', 'string', true),
      f('addressLine1', 'string', true),
      f('addressLine2', 'string', true),
      f('city', 'string', true),
      f('state', 'string', true),
      f('country', 'string', true),
      f('postalCode', 'string', true),
      f('propertyType', 'enum', true, { enumValues: ['RESIDENTIAL', 'COMMERCIAL', 'MIXED_USE'] }),
      f('status', 'enum', true, { enumValues: ['ACTIVE', 'INACTIVE', 'ARCHIVED'] }),
      f('isStrataManaged', 'boolean', true),
      f('strataPlanNumber', 'string', true),
      f('strataSchemeName', 'string', true),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [{ field: 'organisation', label: 'Organisation', targetModel: 'Organisation' }],
  },

  Space: {
    model: 'Space',
    delegate: 'space',
    label: 'Space',
    searchableFields: ['name', 'code'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('propertyId', 'string', false),
      f('name', 'string', true),
      f('code', 'string', true),
      f('spaceType', 'enum', true, {
        enumValues: [
          'APARTMENT',
          'VILLA',
          'OFFICE',
          'RETAIL',
          'WAREHOUSE',
          'PARKING',
          'STORAGE',
          'COMMON_AREA',
          'OTHER',
        ],
      }),
      f('floor', 'string', true),
      f('sizeSqft', 'int', true),
      f('status', 'enum', true, {
        enumValues: ['VACANT', 'OCCUPIED', 'UNDER_MAINTENANCE', 'RESERVED'],
      }),
      f('isStrataLot', 'boolean', true),
      f('lotNumber', 'string', true),
      f('entitlementValue', 'decimal', true),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [{ field: 'property', label: 'Property', targetModel: 'Property' }],
  },

  PropertyContact: {
    model: 'PropertyContact',
    delegate: 'propertyContact',
    label: 'Property Contact',
    searchableFields: ['firstName', 'lastName', 'email'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('userId', 'string', false),
      f('firstName', 'string', true),
      f('lastName', 'string', true),
      f('email', 'string', false, { piiSensitive: true }),
      f('phone', 'string', true, { piiSensitive: true }),
      f('status', 'enum', true, { enumValues: ['ACTIVE', 'INVITED', 'SUSPENDED'] }),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [
      { field: 'organisation', label: 'Organisation', targetModel: 'Organisation' },
      { field: 'user', label: 'User', targetModel: 'User' },
    ],
  },

  PropertyMembership: {
    model: 'PropertyMembership',
    delegate: 'propertyMembership',
    label: 'Property Membership',
    searchableFields: [],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('propertyId', 'string', false),
      f('spaceId', 'string', false),
      f('contactId', 'string', false),
      f('role', 'enum', true, {
        enumValues: [
          'OWNER',
          'TENANT',
          'RESIDENT',
          'PROPERTY_MANAGER',
          'FACILITY_MANAGER',
          'AGENT',
          'COMMITTEE_MEMBER',
        ],
      }),
      f('startDate', 'datetime', true),
      f('endDate', 'datetime', true),
      f('status', 'enum', true, { enumValues: ['ACTIVE', 'ENDED'] }),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [
      { field: 'property', label: 'Property', targetModel: 'Property' },
      { field: 'space', label: 'Space', targetModel: 'Space' },
      { field: 'contact', label: 'Property Contact', targetModel: 'PropertyContact' },
    ],
  },

  MaintenanceRequest: {
    model: 'MaintenanceRequest',
    delegate: 'maintenanceRequest',
    label: 'Maintenance Request',
    searchableFields: ['title'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('propertyId', 'string', false),
      f('spaceId', 'string', false),
      f('reportedByUserId', 'string', false),
      f('title', 'string', true),
      f('description', 'text', true),
      f('category', 'enum', true, {
        enumValues: [
          'PLUMBING',
          'ELECTRICAL',
          'HVAC',
          'APPLIANCE',
          'STRUCTURAL',
          'COMMON_AREA',
          'SECURITY',
          'CLEANING',
          'PEST_CONTROL',
          'OTHER',
        ],
      }),
      f('priority', 'enum', true, { enumValues: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] }),
      f('status', 'enum', true, {
        enumValues: ['NEW', 'UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'CANCELLED'],
      }),
      f('reportedAt', 'datetime', false),
      f('resolvedAt', 'datetime', true),
      f('closedAt', 'datetime', true),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [
      { field: 'property', label: 'Property', targetModel: 'Property' },
      { field: 'space', label: 'Space', targetModel: 'Space' },
      { field: 'reportedBy', label: 'Reported By', targetModel: 'User' },
    ],
  },

  WorkOrder: {
    model: 'WorkOrder',
    delegate: 'workOrder',
    label: 'Work Order',
    searchableFields: ['title'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('propertyId', 'string', false),
      f('spaceId', 'string', false),
      f('maintenanceRequestId', 'string', false),
      f('title', 'string', true),
      f('description', 'text', true),
      f('status', 'enum', true, {
        enumValues: ['DRAFT', 'READY', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
      }),
      f('priority', 'enum', true, { enumValues: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] }),
      f('scheduledAt', 'datetime', true),
      f('startedAt', 'datetime', true),
      f('completedAt', 'datetime', true),
      f('estimatedCost', 'decimal', true),
      f('actualCost', 'decimal', true),
      f('currencyCode', 'string', false),
      f('contractorId', 'string', false),
      f('createdByUserId', 'string', false),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [
      { field: 'property', label: 'Property', targetModel: 'Property' },
      { field: 'space', label: 'Space', targetModel: 'Space' },
      {
        field: 'maintenanceRequest',
        label: 'Maintenance Request',
        targetModel: 'MaintenanceRequest',
      },
      { field: 'contractor', label: 'Contractor', targetModel: 'Contractor' },
      { field: 'createdBy', label: 'Created By', targetModel: 'User' },
    ],
  },

  Contractor: {
    model: 'Contractor',
    delegate: 'contractor',
    label: 'Contractor',
    searchableFields: ['name', 'companyName', 'email'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('name', 'string', true),
      f('companyName', 'string', true),
      f('email', 'string', true, { piiSensitive: true }),
      f('phone', 'string', true, { piiSensitive: true }),
      f('status', 'enum', true, { enumValues: ['ACTIVE', 'INACTIVE'] }),
      f('tradeTypes', 'stringArray', true),
      f('notes', 'text', true),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [{ field: 'organisation', label: 'Organisation', targetModel: 'Organisation' }],
  },

  /** Almost entirely read-only: amount/currency/description are simple
   * data-correction fields, but status/approvalStatus/signatureStatus are
   * driven by the quotes workflow engine and WaslSign webhooks — hand-
   * editing them here would desync this record from the real approval/
   * e-signature state machine (see ContractorQuote's own schema doc). */
  ContractorQuote: {
    model: 'ContractorQuote',
    delegate: 'contractorQuote',
    label: 'Contractor Quote',
    searchableFields: [],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('workOrderId', 'string', false),
      f('contractorId', 'string', false),
      f('amount', 'decimal', true),
      f('currencyCode', 'string', true),
      f('description', 'text', true),
      f('status', 'enum', false, {
        enumValues: ['REQUESTED', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED'],
      }),
      f('submittedAt', 'datetime', false),
      f('approvedAt', 'datetime', false),
      f('rejectedAt', 'datetime', false),
      f('workflowMode', 'enum', false, {
        enumValues: ['NONE', 'APPROVAL_ONLY', 'SIGNATURE_ONLY', 'APPROVAL_THEN_SIGNATURE'],
      }),
      f('approvalStatus', 'enum', false, {
        enumValues: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
      }),
      f('approvedByUserId', 'string', false),
      f('signatureStatus', 'enum', false, {
        enumValues: ['PENDING', 'PARTIALLY_SIGNED', 'SIGNED', 'DECLINED', 'EXPIRED', 'CANCELLED'],
      }),
      f('signedAt', 'datetime', false),
      f('waslSignAgreementId', 'string', false),
      f('waslSignStatus', 'string', false),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [
      { field: 'workOrder', label: 'Work Order', targetModel: 'WorkOrder' },
      { field: 'contractor', label: 'Contractor', targetModel: 'Contractor' },
      { field: 'approvedByUser', label: 'Approved By', targetModel: 'User' },
    ],
  },

  /** Immutable once SENT by product rule (see Communication's schema doc) —
   * Data Explorer never edits title/body/status, to avoid an end-run around
   * that invariant. View-only. */
  Communication: {
    model: 'Communication',
    delegate: 'communication',
    label: 'Communication',
    searchableFields: ['title'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('title', 'string', false),
      f('body', 'text', false),
      f('status', 'enum', false, {
        enumValues: ['DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED', 'FAILED'],
      }),
      f('channels', 'stringArray', false),
      f('audienceCriteria', 'json', false),
      f('savedAudienceId', 'string', false),
      f('createdByUserId', 'string', false),
      f('scheduledAt', 'datetime', false),
      f('sentAt', 'datetime', false),
      f('cancelledAt', 'datetime', false),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [
      { field: 'savedAudience', label: 'Saved Audience', targetModel: 'SavedAudience' },
      { field: 'createdBy', label: 'Created By', targetModel: 'User' },
    ],
  },

  /** Audit snapshot of who a Communication was addressed to — view-only. */
  CommunicationRecipient: {
    model: 'CommunicationRecipient',
    delegate: 'communicationRecipient',
    label: 'Communication Recipient',
    searchableFields: [],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('communicationId', 'string', false),
      f('contactId', 'string', false),
      f('userId', 'string', false),
      f('propertyId', 'string', false),
      f('spaceId', 'string', false),
      f('createdAt', 'datetime', false),
    ],
    relations: [
      { field: 'communication', label: 'Communication', targetModel: 'Communication' },
      { field: 'contact', label: 'Contact', targetModel: 'PropertyContact' },
    ],
  },

  /** Already has a dedicated, workflow-aware transition — the Jobs screen's
   * "retry" action (backoffice-jobs.service.ts). Editing status freely here
   * would bypass that and desync from the real send attempt. View-only. */
  CommunicationDelivery: {
    model: 'CommunicationDelivery',
    delegate: 'communicationDelivery',
    label: 'Communication Delivery',
    searchableFields: [],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('communicationRecipientId', 'string', false),
      f('channel', 'enum', false, { enumValues: ['IN_APP', 'EMAIL', 'WHATSAPP'] }),
      f('status', 'enum', false, {
        enumValues: ['PENDING', 'SENDING', 'SENT', 'DELIVERED', 'FAILED'],
      }),
      f('providerMessageId', 'string', false),
      f('attemptedAt', 'datetime', false),
      f('sentAt', 'datetime', false),
      f('deliveredAt', 'datetime', false),
      f('failedAt', 'datetime', false),
      f('failureReason', 'string', false),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [
      {
        field: 'communicationRecipient',
        label: 'Communication Recipient',
        targetModel: 'CommunicationRecipient',
      },
    ],
  },

  Notification: {
    model: 'Notification',
    delegate: 'notification',
    label: 'Notification',
    searchableFields: ['title'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('userId', 'string', false),
      f('title', 'string', true),
      f('body', 'text', true),
      f('entityType', 'string', false),
      f('entityId', 'string', false),
      f('sourceCommunicationId', 'string', false),
      f('sourceActivityEventId', 'string', false),
      f('readAt', 'datetime', true),
      f('createdAt', 'datetime', false),
    ],
    relations: [{ field: 'user', label: 'User', targetModel: 'User' }],
  },

  /** criteria drives real audience-resolution logic elsewhere; editing raw
   * JSON here without validation could silently break it. View-only for
   * that field; name is a safe correction. */
  SavedAudience: {
    model: 'SavedAudience',
    delegate: 'savedAudience',
    label: 'Saved Audience',
    searchableFields: ['name'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('name', 'string', true),
      f('criteria', 'json', false),
      f('createdByUserId', 'string', false),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [{ field: 'createdBy', label: 'Created By', targetModel: 'User' }],
  },

  /** Wasl Property's own operational log — an event/history table, kept
   * view-only by the same convention as CommunicationDelivery/
   * CommunicationRecipient above (log rows aren't hand-edited). */
  ActivityEvent: {
    model: 'ActivityEvent',
    delegate: 'activityEvent',
    label: 'Activity Event',
    searchableFields: ['title'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('organisationId', 'string', false),
      f('propertyId', 'string', false),
      f('spaceId', 'string', false),
      f('actorUserId', 'string', false),
      f('eventType', 'string', false),
      f('entityType', 'string', false),
      f('entityId', 'string', false),
      f('title', 'string', false),
      f('description', 'string', false),
      f('metadata', 'json', false),
      f('createdAt', 'datetime', false),
    ],
    relations: [
      { field: 'property', label: 'Property', targetModel: 'Property' },
      { field: 'space', label: 'Space', targetModel: 'Space' },
      { field: 'actorUser', label: 'Actor', targetModel: 'User' },
    ],
  },

  /** Field-level edits are entirely blocked — see the module doc comment
   * above for why (role/username/active-status mutation stays on the
   * dedicated Internal Users screen, which has its own last-Super-Admin
   * safeguard this generic explorer does not replicate). Row deletion IS
   * allowed, PLATFORM_SUPER_ADMIN-only exactly like every other Data
   * Explorer delete — deliberately, per explicit product decision, the
   * same trust model already given to raw SQL DELETE in the SQL Console.
   * This means a Super Admin can delete their own account, or the last
   * active Super Admin, via this path — recoverable only via
   * prisma/create-platform-user.ts or direct DB access, a real and known
   * operational risk that is not blocked here on purpose. passwordHash is
   * not merely masked, it is never listed here at all. */
  Employee: {
    model: 'Employee',
    delegate: 'employee',
    label: 'Employee',
    searchableFields: ['username', 'firstName', 'lastName'],
    defaultOrderBy: 'createdAt',
    deletable: true,
    fields: [
      f('id', 'string', false),
      f('username', 'string', false),
      f('firstName', 'string', false),
      f('lastName', 'string', false),
      f('role', 'enum', false, {
        enumValues: [
          'PLATFORM_SUPER_ADMIN',
          'PLATFORM_ADMIN',
          'PLATFORM_SUPPORT',
          'PLATFORM_DEVELOPER',
        ],
      }),
      f('isActive', 'boolean', false),
      f('grantedByEmployeeId', 'string', false),
      f('createdAt', 'datetime', false),
      f('updatedAt', 'datetime', false),
    ],
    relations: [{ field: 'grantedByEmployee', label: 'Granted By', targetModel: 'Employee' }],
  },
};

export const DATA_EXPLORER_MODEL_NAMES = Object.keys(DATA_EXPLORER_MODELS);

/** Fields selected on a relation's target model purely for a friendly
 * display label in the Linked Relations panel — cosmetic only, never used
 * for editability or PII decisions. Deliberately excludes PII fields
 * (email/phone) so this nested lookup never needs its own masking pass. */
export const RELATION_DISPLAY_SELECT: Record<string, readonly string[]> = {
  Organisation: ['name'],
  User: ['firstName', 'lastName'],
  Property: ['name', 'code'],
  Space: ['name', 'code'],
  PropertyContact: ['firstName', 'lastName'],
  Contractor: ['name'],
  WorkOrder: ['title'],
  MaintenanceRequest: ['title'],
  Communication: ['title'],
  SavedAudience: ['name'],
  CommunicationRecipient: [],
  ContractorQuote: [],
  Employee: ['firstName', 'lastName'],
};

export function formatRelationDisplay(
  targetModel: string,
  related: Record<string, unknown> | null,
): string | null {
  if (!related) return null;
  const { firstName, lastName, name, code, title } = related as Record<string, unknown>;
  if (targetModel === 'User' || targetModel === 'PropertyContact' || targetModel === 'Employee') {
    const full = [firstName, lastName].filter(Boolean).join(' ').trim();
    return full || null;
  }
  if (targetModel === 'Property' || targetModel === 'Space') {
    return code ? `${String(name)} (${String(code)})` : ((name as string | null) ?? null);
  }
  if (typeof name === 'string') return name;
  if (typeof title === 'string') return title;
  return null;
}

export const DATA_EXPLORER_VIEW_CAPABILITY: PlatformCapability = 'database.view';
export const DATA_EXPLORER_EDIT_CAPABILITY: PlatformCapability = 'database.edit';
