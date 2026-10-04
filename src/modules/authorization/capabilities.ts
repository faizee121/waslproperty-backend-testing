import type { PropertyRole } from '@prisma/client';

/**
 * Every property-scoped capability WaslProp currently backs with real
 * functionality, in one place — mirrors the existing PLATFORM_CAPABILITIES
 * pattern (src/platform/capabilities.ts). Controllers/services never check
 * `role === 'PROPERTY_MANAGER'`; they call the central AuthorizationService,
 * which resolves a role's effective capabilities and checks them here.
 *
 * `capability` is stored as a plain string (not a Prisma enum) on
 * OrganisationRolePermission deliberately: adding a new capability must
 * never require a schema migration, only a code change to this file plus
 * (optionally) an organisation override row. A capability that doesn't
 * appear in CAPABILITIES below is never granted, even if an override row
 * for it somehow exists (defensive — see AuthorizationService).
 *
 * Deliberately NOT included (no real functionality behind them yet):
 * - documents.* — no document storage feature exists.
 * - levies.*, financials.*, funds.* — explicitly out of scope for this
 *   milestone (M11 strata levy/fund business rules are still unconfirmed).
 * - approvals.* as a standalone resource — "Approval & Acceptance" is not
 *   a separate entity/route in this codebase; it's the workflow embedded
 *   in ContractorQuote (workflowMode/approve/reject) and WorkOrder status.
 *   See quotes.approve.
 */
export const CAPABILITIES = [
  'property.view',
  'property.manage',
  'spaces.view',
  'spaces.manage',
  'people.view',
  'people.manage',
  'maintenance.view',
  'maintenance.manage',
  'work_orders.view',
  'work_orders.manage',
  'contractors.view',
  'contractors.manage',
  /** Credentials/licences/insurance a contractor holds, and the
   * organisation's compliance requirements that judge them. Deliberately
   * separate from contractors.view/manage: seeing a contractor's basic
   * profile never implies seeing (or worse, verifying) their compliance
   * documents — see the contractor-compliance milestone report. */
  'contractor_compliance.view',
  'contractor_compliance.manage',
  /** Marking a credential VERIFIED/REJECTED is a meaningful trust decision,
   * not a data-entry action — held separately from
   * contractor_compliance.manage so an organisation can let more people add
   * credentials than can attest to their validity. */
  'contractor_compliance.verify',
  'quotes.view',
  'quotes.manage',
  'quotes.approve',
  'communications.view',
  'communications.send',
  'communications.manage',
  'analytics.view',
  'activity.view',
  /** Placeholder for the M11-A strata foundation — today this rides along
   * with property.view/property.manage at the route level (strata data
   * lives on Property/Space), included here so the catalogue is already
   * shaped for independent strata routes/screens later without a schema
   * change. Still subject to the STRATA_MANAGEMENT organisation feature
   * gate (src/modules/organisations/organisation-features.ts) — a
   * capability grant here never bypasses that jurisdiction check. */
  'strata.view',
  'strata.manage',
  /** Use the Wasl AI workspace and contextual "Investigate"/"Analyse with
   * Wasl AI" entry points — see the M14 milestone. Deliberately separate
   * from every other capability: holding e.g. maintenance.view never
   * implies ai.use, and ai.use never grants access to data the holder
   * couldn't otherwise see — every AI tool call still independently
   * re-checks the specific capability its underlying domain data requires
   * (see src/modules/ai/gateway/tool-gateway.ts). This capability gates
   * only "is this user allowed to use the assistant at all", one of three
   * ANDed conditions alongside the platform AI_ENABLED env var and the
   * organisation's own aiEnabled toggle — see AiService.isAiAvailableForUser.
   */
  'ai.use',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** Functional groups for the Roles & Permissions editor UI — display only,
 * not consulted by any authorization check. */
export const CAPABILITY_GROUPS: Array<{ label: string; capabilities: Capability[] }> = [
  {
    label: 'Properties & Spaces',
    capabilities: ['property.view', 'property.manage', 'spaces.view', 'spaces.manage'],
  },
  { label: 'People', capabilities: ['people.view', 'people.manage'] },
  { label: 'Maintenance', capabilities: ['maintenance.view', 'maintenance.manage'] },
  { label: 'Work Orders', capabilities: ['work_orders.view', 'work_orders.manage'] },
  {
    label: 'Contractors & Quotes',
    capabilities: [
      'contractors.view',
      'contractors.manage',
      'quotes.view',
      'quotes.manage',
      'quotes.approve',
    ],
  },
  {
    label: 'Contractor Compliance',
    capabilities: [
      'contractor_compliance.view',
      'contractor_compliance.manage',
      'contractor_compliance.verify',
    ],
  },
  {
    label: 'Communications',
    capabilities: ['communications.view', 'communications.send', 'communications.manage'],
  },
  { label: 'Visibility', capabilities: ['analytics.view', 'activity.view'] },
  { label: 'Strata', capabilities: ['strata.view', 'strata.manage'] },
  { label: 'Wasl AI', capabilities: ['ai.use'] },
];

/**
 * WaslProp system defaults per PropertyRole — the baseline every
 * organisation gets until it saves an override (see
 * OrganisationRolePermission). Conservative, derived from actual current
 * product semantics — never organisation-admin-equivalent.
 *
 * TENANT and RESIDENT deliberately get an EMPTY capability set here: their
 * portal access (own maintenance requests, own property/unit view,
 * announcements addressed to them) is handled by existing resident-specific
 * logic (e.g. MaintenanceService.list scoping to reportedByUserId) that
 * predates and is narrower than this capability system — a resident seeing
 * only their own request is intentionally NOT the same as granting
 * `maintenance.view` (which would let them see every request on the whole
 * property, including neighbours'). Capabilities here are strictly about
 * the OPERATIONAL/staff-like roles.
 */
export const DEFAULT_ROLE_CAPABILITIES: Record<PropertyRole, Capability[]> = {
  PROPERTY_MANAGER: [
    'property.view',
    'spaces.view',
    'spaces.manage',
    'people.view',
    'people.manage',
    'maintenance.view',
    'maintenance.manage',
    'work_orders.view',
    'work_orders.manage',
    'contractors.view',
    'contractors.manage',
    'contractor_compliance.view',
    'contractor_compliance.manage',
    'contractor_compliance.verify',
    'quotes.view',
    'quotes.manage',
    'quotes.approve',
    'communications.view',
    'communications.send',
    'communications.manage',
    'analytics.view',
    'activity.view',
    'strata.view',
    'ai.use',
  ],
  FACILITY_MANAGER: [
    'property.view',
    'spaces.view',
    'maintenance.view',
    'maintenance.manage',
    'work_orders.view',
    'work_orders.manage',
    'contractors.view',
    'contractor_compliance.view',
    'quotes.view',
    'communications.view',
    'analytics.view',
    'activity.view',
    'ai.use',
  ],
  AGENT: [
    'property.view',
    'spaces.view',
    'people.view',
    'maintenance.view',
    'work_orders.view',
    'communications.view',
    'activity.view',
  ],
  COMMITTEE_MEMBER: [
    'property.view',
    'spaces.view',
    'people.view',
    'maintenance.view',
    'work_orders.view',
    'quotes.view',
    'quotes.approve',
    'communications.view',
    'activity.view',
    'strata.view',
  ],
  OWNER: ['property.view', 'spaces.view', 'maintenance.view', 'activity.view', 'strata.view'],
  TENANT: [],
  RESIDENT: [],
};

/** Capabilities an organisation MEMBER already effectively has today
 * (every list/get route in these modules was open to any authenticated org
 * member with no role check at all) — preserved exactly as-is by the new
 * authorization model; MEMBER never loses or gains beyond this baseline
 * except by separately holding a PropertyMembership. See
 * AuthorizationService.can's own doc comment for the full reasoning. */
export const ORG_MEMBER_LEGACY_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'property.view',
  'spaces.view',
  'people.view',
  'maintenance.view',
  'activity.view',
  'strata.view',
]);
