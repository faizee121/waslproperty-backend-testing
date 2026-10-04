/**
 * Creates (or updates) a WaslProperty Employee — the only way to create the
 * first PLATFORM_SUPER_ADMIN, since every UI path into the Internal Users
 * screen itself requires platformUsers.manage, which only a
 * PLATFORM_SUPER_ADMIN already holds.
 *
 * Employee is a fully separate identity from User: no email, no customer
 * organisation relationship, sign-in by username only.
 *
 * Usage:
 *   npx tsx prisma/create-platform-user.ts \
 *     --username admin.hamza.tariq \
 *     --password "temporary-strong-password" \
 *     --firstName Hamza --lastName Tariq \
 *     --role PLATFORM_SUPER_ADMIN
 */
import { PrismaClient, type PlatformRole } from '@prisma/client';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const eqForm = process.argv.find((a) => a.startsWith(prefix));
  if (eqForm) return eqForm.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

const VALID_ROLES: PlatformRole[] = [
  'PLATFORM_SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'PLATFORM_SUPPORT',
  'PLATFORM_DEVELOPER',
];

async function main() {
  const username = readArg('username')?.trim().toLowerCase();
  const password = readArg('password');
  const firstName = readArg('firstName') ?? 'Platform';
  const lastName = readArg('lastName') ?? 'User';
  const role = readArg('role') as PlatformRole | undefined;

  if (!username || !password || !role) {
    console.error('Usage: --username <username> --password <password> --role <PlatformRole>');
    console.error(`Valid roles: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }
  if (!VALID_ROLES.includes(role)) {
    console.error(`Invalid role "${role}". Valid roles: ${VALID_ROLES.join(', ')}`);
    process.exit(1);
  }

  const employee = await prisma.employee.upsert({
    where: { username },
    update: {
      passwordHash: await hashPassword(password),
      firstName,
      lastName,
      role,
      isActive: true,
    },
    create: {
      username,
      passwordHash: await hashPassword(password),
      firstName,
      lastName,
      role,
      isActive: true,
    },
  });

  console.log(`Employee "${username}" (${employee.id}) is now ${role}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
