import type { PlatformRole, PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../../errors/AppError.js';
import { generateTemporaryPassword, hashPassword } from '../../../lib/password.js';
import { recordPlatformActivity } from '../../../platform/audit.js';
import type {
  GrantPlatformAccessInput,
  ResetPlatformUserPasswordInput,
  UpdatePlatformUserInput,
} from './backoffice-platform-users.schemas.js';

export class BackofficePlatformUsersService {
  constructor(private readonly prisma: PrismaClient) {}

  async list() {
    const employees = await this.prisma.employee.findMany({
      orderBy: { createdAt: 'asc' },
      include: { grantedByEmployee: { select: { firstName: true, lastName: true } } },
    });

    return employees.map((e) => ({
      id: e.id,
      username: e.username,
      name: `${e.firstName} ${e.lastName}`,
      role: e.role,
      isActive: e.isActive,
      grantedBy: e.grantedByEmployee
        ? `${e.grantedByEmployee.firstName} ${e.grantedByEmployee.lastName}`
        : null,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));
  }

  /** Always creates a brand-new Employee — no email, no relationship to any
   * User. Returns a generated temporary password once; it is never stored
   * in plaintext or written to the audit log. */
  async grant(
    input: GrantPlatformAccessInput,
    actor: { employeeId: string; platformRole: PlatformRole },
  ) {
    const usernameTaken = await this.prisma.employee.findFirst({
      where: { username: input.username },
    });
    if (usernameTaken) throw new ConflictError('That username is already taken');

    const temporaryPassword = generateTemporaryPassword();

    const employee = await this.prisma.$transaction(async (tx) => {
      const created = await tx.employee.create({
        data: {
          username: input.username,
          passwordHash: await hashPassword(temporaryPassword),
          firstName: input.firstName,
          lastName: input.lastName,
          role: input.role,
          isActive: true,
          grantedByEmployeeId: actor.employeeId,
        },
      });

      await recordPlatformActivity(tx, {
        actorEmployeeId: actor.employeeId,
        platformRole: actor.platformRole,
        action: 'employee.created',
        entityType: 'Employee',
        entityId: created.id,
        reason: input.reason,
        after: { username: input.username, role: input.role },
      });

      return created;
    });

    return { ...employee, temporaryPassword };
  }

  async update(
    id: string,
    input: UpdatePlatformUserInput,
    actor: { employeeId: string; platformRole: PlatformRole },
  ) {
    const existing = await this.prisma.employee.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Employee not found');

    if (input.username && input.username !== existing.username) {
      const usernameTaken = await this.prisma.employee.findFirst({
        where: { username: input.username, id: { not: id } },
      });
      if (usernameTaken) throw new ConflictError('That username is already taken');
    }

    const deactivating = input.isActive === false;
    const demoting =
      input.role !== undefined &&
      existing.role === 'PLATFORM_SUPER_ADMIN' &&
      input.role !== 'PLATFORM_SUPER_ADMIN';

    if ((deactivating || demoting) && existing.role === 'PLATFORM_SUPER_ADMIN') {
      const activeSuperAdmins = await this.prisma.employee.count({
        where: { role: 'PLATFORM_SUPER_ADMIN', isActive: true },
      });
      if (activeSuperAdmins <= 1) {
        throw new ConflictError('Cannot remove the last active Super Admin');
      }
    }

    const { reason, ...changes } = input;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({ where: { id }, data: changes });

      await recordPlatformActivity(tx, {
        actorEmployeeId: actor.employeeId,
        platformRole: actor.platformRole,
        action: 'employee.updated',
        entityType: 'Employee',
        entityId: id,
        reason,
        before: { role: existing.role, isActive: existing.isActive },
        after: { role: updated.role, isActive: updated.isActive },
      });

      return updated;
    });
  }

  /** A Super Admin forcing a reset — distinct from the self-service
   * changePassword on PlatformAuthService, which requires knowing the
   * current password. Returns the new password once; it is never stored
   * in plaintext or written to the audit log. */
  async resetPassword(
    id: string,
    input: ResetPlatformUserPasswordInput,
    actor: { employeeId: string; platformRole: PlatformRole },
  ) {
    const employee = await this.prisma.employee.findUnique({ where: { id } });
    if (!employee) throw new NotFoundError('Employee not found');

    const temporaryPassword = generateTemporaryPassword();

    await this.prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id },
        data: { passwordHash: await hashPassword(temporaryPassword) },
      });

      await recordPlatformActivity(tx, {
        actorEmployeeId: actor.employeeId,
        platformRole: actor.platformRole,
        action: 'employee.passwordReset',
        entityType: 'Employee',
        entityId: id,
        reason: input.reason,
        after: { username: employee.username },
      });
    });

    return { username: employee.username, temporaryPassword };
  }
}
