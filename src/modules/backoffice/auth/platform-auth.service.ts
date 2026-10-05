import type { Employee, PlatformRole, PrismaClient } from '@prisma/client';
import { UnauthorizedError } from '../../../errors/AppError.js';
import { hashPassword, verifyPassword } from '../../../lib/password.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
  signPlatformAccessToken,
} from '../../../lib/tokens.js';
import { recordPlatformActivity } from '../../../platform/audit.js';
import { resolvePlatformCapabilities } from '../../../platform/capabilities.js';
import type { PlatformChangePasswordInput, PlatformLoginInput } from './platform-auth.schemas.js';

export interface PlatformAuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface PlatformAuthResult {
  user: { id: string; firstName: string; lastName: string };
  username: string;
  platformRole: PlatformRole;
  platformCapabilities: string[];
  tokens: PlatformAuthTokens;
}

/**
 * Entirely separate from AuthService — a WaslProperty Employee is not a
 * User and never a customer organisation member, so this never touches
 * OrganisationMembership/PropertyContact/listAccessOptions, and Employee
 * sessions live in EmployeeSession, never Session. Reuses only the
 * low-level password/token utilities.
 */
export class PlatformAuthService {
  constructor(private readonly prisma: PrismaClient) {}

  async login(input: PlatformLoginInput): Promise<PlatformAuthResult> {
    const employee = await this.prisma.employee.findUnique({ where: { username: input.username } });
    if (!employee || !employee.isActive) {
      throw new UnauthorizedError('Invalid username or password');
    }

    const validPassword = await verifyPassword(employee.passwordHash, input.password);
    if (!validPassword) {
      throw new UnauthorizedError('Invalid username or password');
    }

    return this.issueAuthResult(employee);
  }

  async refresh(rawRefreshToken: string): Promise<PlatformAuthTokens> {
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const session = await this.prisma.employeeSession.findFirst({
      where: { refreshTokenHash: tokenHash, revokedAt: null },
    });

    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedError('Session expired, please sign in again');
    }

    // Re-checked on every refresh, not just at login — access revoked
    // mid-session (isActive: false) must take effect immediately, not
    // merely block the next fresh login.
    const employee = await this.prisma.employee.findUnique({ where: { id: session.employeeId } });
    if (!employee || !employee.isActive) {
      throw new UnauthorizedError('Session expired, please sign in again');
    }

    await this.prisma.employeeSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(employee);
  }

  async logout(rawRefreshToken: string): Promise<void> {
    const tokenHash = hashRefreshToken(rawRefreshToken);
    await this.prisma.employeeSession.updateMany({
      where: { refreshTokenHash: tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Self-service — requires knowing the current password, unlike
   * BackofficePlatformUsersService.resetPassword (a Super Admin forcing a
   * reset on someone else's account, no current password needed). */
  async changePassword(
    actor: { employeeId: string; platformRole: PlatformRole },
    input: PlatformChangePasswordInput,
  ): Promise<void> {
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: actor.employeeId },
    });
    const valid = await verifyPassword(employee.passwordHash, input.currentPassword);
    if (!valid) throw new UnauthorizedError('Current password is incorrect');

    await this.prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id: actor.employeeId },
        data: { passwordHash: await hashPassword(input.newPassword) },
      });

      await recordPlatformActivity(tx, {
        actorEmployeeId: actor.employeeId,
        platformRole: actor.platformRole,
        action: 'employee.passwordChanged',
        entityType: 'Employee',
        entityId: actor.employeeId,
        reason: 'Self-service password change',
      });
    });
  }

  private async issueAuthResult(employee: Employee): Promise<PlatformAuthResult> {
    const tokens = await this.issueTokens(employee);
    return {
      user: { id: employee.id, firstName: employee.firstName, lastName: employee.lastName },
      username: employee.username,
      platformRole: employee.role,
      platformCapabilities: resolvePlatformCapabilities(employee.role),
      tokens,
    };
  }

  private async issueTokens(employee: Employee): Promise<PlatformAuthTokens> {
    const capabilities = resolvePlatformCapabilities(employee.role);
    const accessToken = signPlatformAccessToken({
      sub: employee.id,
      sessionType: 'PLATFORM',
      username: employee.username,
      platformRole: employee.role,
      platformCapabilities: capabilities,
    });
    const refreshToken = generateRefreshToken();
    const expiresAt = refreshTokenExpiresAt();

    await this.prisma.employeeSession.create({
      data: {
        employeeId: employee.id,
        refreshTokenHash: hashRefreshToken(refreshToken),
        expiresAt,
      },
    });

    return { accessToken, refreshToken, refreshTokenExpiresAt: expiresAt };
  }
}
