# M11 — Australian Strata: confirmed foundation vs. open business questions

This document exists so a future developer (or a future Claude session)
never has to guess Australian strata business rules from general knowledge,
a Stratafy screenshot, or "what seems reasonable." M11-A deliberately
implemented only the foundation below and left everything financial
unimplemented, pending real answers from the business.

**Read this before touching anything levy/fund/notice-related.**

## CONFIRMED / IMPLEMENTED FOUNDATION (M11-A)

- **Organisation-level jurisdiction**: `Organisation.countryCode` (ISO
  3166-1 alpha-2, nullable — unset for every organisation until an
  OWNER/ADMIN explicitly sets it via `PATCH /organisations/me` or the
  Organisation Settings page). Independent of `Organisation.currencyCode` —
  neither is ever inferred from the other.
- **Jurisdiction-specific feature gating**: `src/modules/organisations/
organisation-features.ts` resolves an organisation's `countryCode` to a
  feature set. Today: `AU` → `['STRATA_MANAGEMENT']`; every other value
  (including `null`) → `[]`. Enforced on both sides:
  - Frontend: `useOrganisationFeature('STRATA_MANAGEMENT')` (a convenience
    for hiding UI, not real enforcement on its own).
  - Backend: `assertOrganisationFeature(prisma, organisationId,
'STRATA_MANAGEMENT')`, called from `PropertiesService`/`SpacesService`
    whenever a request tries to set a strata-specific field. Confirmed by
    test: a direct API call that bypasses the UI still gets rejected
    (`test/integration/strata-foundation.test.ts`, "a UI bypass attempt").
  - Adding a future jurisdiction feature (`LEVY_MANAGEMENT`,
    `FUND_MANAGEMENT`) means adding one entry to `ORGANISATION_FEATURES`
    and one line to `COUNTRY_FEATURES` — no model redesign.
- **Strata scheme = existing `Property`, extended**: `isStrataManaged`
  (boolean, default false), `strataPlanNumber` (free text, e.g. an
  Australian "SP" number — stored as an identifying reference only, not
  validated against any registry), `strataSchemeName` (optional display
  name). No parallel "Scheme" model.
- **Strata lot/unit = existing `Space`, extended**: `isStrataLot` (boolean,
  default false — can only be true if the parent `Property.isStrataManaged`
  is true, enforced in `SpacesService`), `lotNumber` (free text),
  `entitlementValue` (`Decimal(12,2)`, nullable). **`entitlementValue` is
  stored for future use only — no code anywhere reads it to calculate
  anything.** Grep `entitlementValue` before changing this if that's ever
  in doubt.
- **Ownership reuses the existing model exactly**: `PropertyContact` +
  `PropertyMembership` (role `OWNER`, `TENANT`, `RESIDENT`, or the
  already-existing `COMMITTEE_MEMBER`) + `Space`. No second contact/owner
  system was introduced. A lot's current owner(s) are simply the `OWNER`-role
  memberships on its `Space`, exactly like every other property type.
- **Migration safety**: every new column is nullable or defaulted; every
  existing organisation/property/space keeps working completely unchanged
  (`prisma/migrations/20260911191748_m11a_strata_foundation`). No existing
  organisation is silently opted into strata functionality — `countryCode`
  defaults to `NULL`, which resolves to zero features.
- **Currency independence**: verified by test — changing
  `Organisation.currencyCode` never changes `countryCode`/features, and
  vice versa (`test/integration/strata-foundation.test.ts`, "changing
  currencyCode never changes countryCode/features").
- **Strata 360 UX**: a "Strata" tab on Property 360 (only rendered when
  `STRATA_MANAGEMENT` is enabled **and** the property itself is
  `isStrataManaged`) showing the two real fields above plus a navigation
  grid: **Lots / Units** and **Owners & Committee** are real, active links
  into the existing Spaces/People tabs; **Notices**, **Levies**, **Funds &
  Financials** are visibly disabled "Coming soon" cards with zero numbers,
  balances, or transactions. Designed in Stitch first (project
  `17365736688974073408`, screen `c9372ddb16744d56abb582afce4debdd`),
  implemented faithfully in `src/routes/properties/components/StrataTab.tsx`
  after stripping several fabricated fields Stitch's output included (see
  that file's doc comment for exactly what was removed and why).

## AWAITING BUSINESS CLARIFICATION

Nothing below has been implemented. Do not infer answers from Stratafy,
general Australian strata knowledge, or "what other products do" — wait for
the actual answer from the business, then implement only that.

**Levy creation & calculation**

- What levy types exist (Administrative Fund, Capital Works Fund, special
  levy, other)? Is this a fixed enum or organisation-configurable?
- How is a levy amount calculated — is `Space.entitlementValue` actually
  used (this field exists today purely as inert storage), and if so, what
  is the exact formula (entitlement ÷ total scheme entitlement × fund
  budget, or something else)?
- What's the billing cadence — quarterly, annual, ad hoc? Fixed per
  organisation or per scheme?

**Entitlement usage**

- Is `entitlementValue` per lot, and does the scheme also need a stored
  _total_ entitlement (currently nowhere in the schema)?
- Does entitlement ever change after a scheme is set up (subdivision,
  re-survey), and if so, does that need its own history/audit trail
  separate from `Space`'s own `updatedAt`?

**Fund structures**

- Is a two-fund model (Administrative + Capital Works) universal, or does
  it vary by state/scheme type? Are there other fund types this needs to
  support?
- Does each fund need its own running balance, and if so, sourced from
  what — manually entered, or derived from a full transaction ledger?

**Payments**

- What payment methods/processors, if any? Is WaslProperty expected to
  process payments directly, or only record that a payment happened
  (reconciled against an external system)?
- Who can record a payment — any staff role, or a restricted subset?

**Overdue levies / arrears**

- Interest and penalty rules are jurisdiction- and often
  scheme-by-law-specific in Australia — do not assume a rate or formula.
  What's the actual policy (if any) the business wants encoded, and does it
  vary by state (NSW vs. VIC vs. QLD, etc. — `countryCode` alone is `AU`,
  not state-level today)?
- Is there a formal arrears/collections workflow expected (notices,
  escalation stages), or just a visible overdue amount?

**Levy notices**

- Do levy notices have legally-specific content/format requirements per
  state? Are they a special case of the Communications system below, or
  something that must stay entirely separate because of compliance
  requirements around levy notices specifically?

**Non-levy notices**

- What actually qualifies as a "non-levy notice" from the business's
  perspective — AGM/committee meeting notices, maintenance notices, general
  announcements? Is this simply "any Communication sent to a strata
  scheme's audience," or does it need levy-notice-style formality
  (e.g. immutability, a specific delivery-proof requirement)?
- **Reuse path already investigated** (see `src/modules/communications/`):
  `Communication` already supports exactly this shape today, with zero
  schema changes needed for the "notice" concept itself —
  `audienceCriteria` is a structured targeting rule (e.g.
  `{"scope":"PROPERTY","propertyIds":[...],"roles":[...]}`), so a
  strata-scheme notice to just its `OWNER`/`COMMITTEE_MEMBER` memberships
  is already expressible without any new field. `CommunicationDelivery`
  already gives per-recipient, per-channel delivery tracking. What's
  _missing_ is only product/business decisions: whether "Notices" needs a
  distinct `Communication` sub-type/tag for reporting, a different
  immutability or audit requirement than a normal announcement, or
  strata-specific composition UI (e.g. a "this is a scheme notice, not a
  general announcement" toggle). None of that should be built until the
  business defines what actually distinguishes a notice from an
  announcement.

**Owner financial visibility**

- What should an OWNER see about their own lot's levies/balance? (Today,
  the existing hard rule is that residents/owners never see cost/contractor/
  quote detail for maintenance — does the same opacity apply to levies, or
  is levy visibility to the paying owner expected to be the opposite?)

**Manager financial reporting**

- What reports does a manager actually need (arrears list, fund balance
  summary, levy schedule export, something else)? Any specific format
  requirement (e.g. for handover to an external strata accountant)?

## Do not build ahead of this list

If a future task asks for any of the above without a business answer
recorded here first, update this document with the answer before writing
code — not the other way around.
