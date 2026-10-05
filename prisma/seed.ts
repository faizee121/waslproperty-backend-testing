import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/password.js';
import { buildPublicReference } from '../src/lib/public-reference.js';

const prisma = new PrismaClient();

const DEMO_SLUG = 'marina-bay-properties-demo';
const DEMO_EMAIL = 'demo@waslproperty.dev';
const DEMO_PASSWORD = 'Demo1234!';

async function resetDemoOrg() {
  const existing = await prisma.organisation.findUnique({ where: { slug: DEMO_SLUG } });
  if (!existing) return;

  const properties = await prisma.property.findMany({
    where: { organisationId: existing.id },
    select: { id: true },
  });
  const propertyIds = properties.map((p) => p.id);

  // Break WorkOrder<->ContractorQuote's circular FK pair before either side
  // can be deleted — same pattern as test/helpers/db.ts's resetDb().
  await prisma.workOrder.updateMany({
    where: { organisationId: existing.id },
    data: { selectedQuoteId: null },
  });
  await prisma.quoteRound.updateMany({
    where: { organisationId: existing.id },
    data: { awardedQuoteId: null },
  });

  await prisma.$transaction([
    prisma.activityEvent.deleteMany({ where: { organisationId: existing.id } }),
    prisma.notification.deleteMany({ where: { organisationId: existing.id } }),
    prisma.communicationRecipient.deleteMany({
      where: { communication: { organisationId: existing.id } },
    }),
    prisma.communication.deleteMany({ where: { organisationId: existing.id } }),
    prisma.workOrderVariation.deleteMany({ where: { organisationId: existing.id } }),
    prisma.contractorQuote.deleteMany({ where: { organisationId: existing.id } }),
    prisma.quoteRoundInvitation.deleteMany({ where: { organisationId: existing.id } }),
    prisma.quoteRound.deleteMany({ where: { organisationId: existing.id } }),
    prisma.workOrder.deleteMany({ where: { organisationId: existing.id } }),
    prisma.maintenanceRequestAttachment.deleteMany({
      where: { maintenanceRequest: { organisationId: existing.id } },
    }),
    prisma.maintenanceRequest.deleteMany({ where: { organisationId: existing.id } }),
    prisma.contractorCredential.deleteMany({
      where: { contractor: { organisationId: existing.id } },
    }),
    prisma.contractorComplianceRequirement.deleteMany({ where: { organisationId: existing.id } }),
    prisma.contractor.deleteMany({ where: { organisationId: existing.id } }),
    prisma.propertyMembership.deleteMany({ where: { organisationId: existing.id } }),
    prisma.propertyContact.deleteMany({ where: { organisationId: existing.id } }),
    prisma.space.deleteMany({ where: { propertyId: { in: propertyIds } } }),
    prisma.property.deleteMany({ where: { organisationId: existing.id } }),
    prisma.session.deleteMany({ where: { organisationId: existing.id } }),
    prisma.organisationMembership.deleteMany({ where: { organisationId: existing.id } }),
    prisma.organisation.delete({ where: { id: existing.id } }),
  ]);
}

async function main() {
  console.log('Resetting existing demo org (if any)...');
  await resetDemoOrg();

  console.log('Creating organisation + owner user...');
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const organisation = await prisma.organisation.create({
    data: { name: 'Marina Bay Properties Management', slug: DEMO_SLUG },
  });

  let user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: DEMO_EMAIL,
        passwordHash,
        firstName: 'Demo',
        lastName: 'Owner',
      },
    });
  }

  await prisma.organisationMembership.create({
    data: { organisationId: organisation.id, userId: user.id, role: 'OWNER' },
  });

  // --- Property 1: Marina Heights (mixed-use, fully populated) ---
  const marinaHeights = await prisma.property.create({
    data: {
      organisationId: organisation.id,
      publicReference: buildPublicReference('PROP'),
      name: 'Marina Heights',
      code: 'MARINA-HT',
      addressLine1: '1 Marina Blvd',
      city: 'Dubai',
      country: 'UAE',
      propertyType: 'MIXED_USE',
      status: 'ACTIVE',
    },
  });

  const [apt1204, apt1205, apt2001] = await Promise.all([
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: marinaHeights.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Apartment 1204',
        code: '1204',
        spaceType: 'APARTMENT',
        floor: '12',
        sizeSqft: 950,
      },
    }),
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: marinaHeights.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Apartment 1205',
        code: '1205',
        spaceType: 'APARTMENT',
        floor: '12',
        sizeSqft: 1100,
      },
    }),
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: marinaHeights.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Apartment 2001',
        code: '2001',
        spaceType: 'APARTMENT',
        floor: '20',
        sizeSqft: 1400,
      },
    }),
  ]);
  await Promise.all([
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: marinaHeights.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Parking Space P-12',
        code: 'P-12',
        spaceType: 'PARKING',
      },
    }),
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: marinaHeights.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Storage Unit 3',
        code: 'ST-3',
        spaceType: 'STORAGE',
      },
    }),
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: marinaHeights.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Lobby',
        code: 'CA-1',
        spaceType: 'COMMON_AREA',
      },
    }),
  ]);

  // --- Property 2: Palm Residences (residential villas) ---
  const palmResidences = await prisma.property.create({
    data: {
      organisationId: organisation.id,
      publicReference: buildPublicReference('PROP'),
      name: 'Palm Residences',
      code: 'PALM-RES',
      addressLine1: 'Frond K, Palm Jumeirah',
      city: 'Dubai',
      country: 'UAE',
      propertyType: 'RESIDENTIAL',
      status: 'ACTIVE',
    },
  });

  const [villa1, villa2, , villa4] = await Promise.all([
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: palmResidences.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Villa 1',
        code: 'V-01',
        spaceType: 'VILLA',
        sizeSqft: 3500,
      },
    }),
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: palmResidences.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Villa 2',
        code: 'V-02',
        spaceType: 'VILLA',
        sizeSqft: 3200,
      },
    }),
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: palmResidences.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Villa 3',
        code: 'V-03',
        spaceType: 'VILLA',
        sizeSqft: 3300,
      },
    }),
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: palmResidences.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Villa 4',
        code: 'V-04',
        spaceType: 'VILLA',
        sizeSqft: 3400,
      },
    }),
  ]);
  await prisma.space.create({
    data: {
      organisationId: organisation.id,
      propertyId: palmResidences.id,
      publicReference: buildPublicReference('LOT'),
      name: 'Clubhouse',
      code: 'CA-1',
      spaceType: 'COMMON_AREA',
    },
  });

  // --- Property 3: Downtown Business Tower (commercial) ---
  const downtownTower = await prisma.property.create({
    data: {
      organisationId: organisation.id,
      publicReference: buildPublicReference('PROP'),
      name: 'Downtown Business Tower',
      code: 'DT-TOWER',
      addressLine1: '5 Sheikh Mohammed Bin Rashid Blvd',
      city: 'Dubai',
      country: 'UAE',
      propertyType: 'COMMERCIAL',
      status: 'ACTIVE',
    },
  });

  const [office501, , retailG01] = await Promise.all([
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: downtownTower.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Office 501',
        code: '501',
        spaceType: 'OFFICE',
        floor: '5',
        sizeSqft: 1800,
      },
    }),
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: downtownTower.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Office 502',
        code: '502',
        spaceType: 'OFFICE',
        floor: '5',
        sizeSqft: 1600,
      },
    }),
    prisma.space.create({
      data: {
        organisationId: organisation.id,
        propertyId: downtownTower.id,
        publicReference: buildPublicReference('LOT'),
        name: 'Retail Unit G01',
        code: 'G-01',
        spaceType: 'RETAIL',
        floor: 'Ground',
        sizeSqft: 900,
      },
    }),
  ]);

  // --- Property 4: Al Barsha Community Center (no spaces yet — empty-state demo) ---
  await prisma.property.create({
    data: {
      organisationId: organisation.id,
      publicReference: buildPublicReference('PROP'),
      name: 'Al Barsha Community Center',
      code: 'AL-BARSHA-CC',
      addressLine1: '12 Al Barsha South Street',
      city: 'Dubai',
      country: 'UAE',
      propertyType: 'MIXED_USE',
      status: 'INACTIVE',
    },
  });

  console.log('Creating people and memberships...');

  async function addPerson(
    propertyId: string,
    email: string,
    firstName: string,
    lastName: string,
    role:
      | 'OWNER'
      | 'TENANT'
      | 'RESIDENT'
      | 'PROPERTY_MANAGER'
      | 'FACILITY_MANAGER'
      | 'AGENT'
      | 'COMMITTEE_MEMBER',
    spaceId?: string,
  ) {
    const contact = await prisma.propertyContact.create({
      data: { organisationId: organisation.id, email, firstName, lastName },
    });
    return prisma.propertyMembership.create({
      data: {
        organisationId: organisation.id,
        propertyId,
        spaceId,
        contactId: contact.id,
        role,
        status: 'ACTIVE',
        startDate: new Date(),
      },
    });
  }

  // Marina Heights people
  await addPerson(
    marinaHeights.id,
    'priya.manager@example.com',
    'Priya',
    'Manager',
    'PROPERTY_MANAGER',
  );
  await addPerson(
    marinaHeights.id,
    'faisal.facilities@example.com',
    'Faisal',
    'Facilities',
    'FACILITY_MANAGER',
  );
  await addPerson(marinaHeights.id, 'omar.owner@example.com', 'Omar', 'Owner', 'OWNER', apt1204.id);
  await addPerson(
    marinaHeights.id,
    'tara.tenant@example.com',
    'Tara',
    'Tenant',
    'TENANT',
    apt1204.id,
  );
  await addPerson(
    marinaHeights.id,
    'layla.owner@example.com',
    'Layla',
    'Owner',
    'OWNER',
    apt1205.id,
  );
  await addPerson(
    marinaHeights.id,
    'ahmed.resident@example.com',
    'Ahmed',
    'Resident',
    'RESIDENT',
    apt2001.id,
  );

  // Palm Residences people
  await addPerson(palmResidences.id, 'sara.agent@example.com', 'Sara', 'Agent', 'AGENT');
  await addPerson(
    palmResidences.id,
    'khalid.committee@example.com',
    'Khalid',
    'Committee',
    'COMMITTEE_MEMBER',
  );
  await addPerson(
    palmResidences.id,
    'fatima.owner@example.com',
    'Fatima',
    'Owner',
    'OWNER',
    villa1.id,
  );
  await addPerson(
    palmResidences.id,
    'mona.resident@example.com',
    'Mona',
    'Resident',
    'RESIDENT',
    villa1.id,
  );
  await addPerson(
    palmResidences.id,
    'youssef.tenant@example.com',
    'Youssef',
    'Tenant',
    'TENANT',
    villa2.id,
  );
  await addPerson(
    palmResidences.id,
    'hassan.owner@example.com',
    'Hassan',
    'Owner',
    'OWNER',
    villa4.id,
  );
  // Villa 3 intentionally left with no membership -> Vacant

  // Downtown Business Tower people
  await addPerson(
    downtownTower.id,
    'nadia.manager@example.com',
    'Nadia',
    'Manager',
    'PROPERTY_MANAGER',
  );
  await addPerson(
    downtownTower.id,
    'ravi.tenant@example.com',
    'Ravi',
    'Kumar',
    'TENANT',
    office501.id,
  );
  await addPerson(
    downtownTower.id,
    'amal.tenant@example.com',
    'Amal',
    'Hassan',
    'TENANT',
    retailG01.id,
  );
  // Office 502 intentionally left with no membership -> Vacant

  console.log('\nDone. Seeded organisation: Marina Bay Properties Management');
  console.log(`Login email:    ${DEMO_EMAIL}`);
  console.log(`Login password: ${DEMO_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
