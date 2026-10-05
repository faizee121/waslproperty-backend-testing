import type { ContactInvite, PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../errors/AppError.js';
import { emailService } from '../../lib/email.js';
import { env } from '../../config/env.js';
import { generateInviteToken, hashInviteToken, inviteTokenExpiresAt } from '../../lib/tokens.js';
import { logger } from '../../lib/logger.js';
import type { AuthResult, AuthService } from '../auth/auth.service.js';
import { hashPassword } from '../../lib/password.js';
import { renderInviteEmail } from './invites.email.js';

export interface PublicInvite {
  id: string;
  status: ContactInvite['status'];
  expiresAt: string;
  createdAt: string;
}

export interface InvitePreview {
  email: string;
  firstName: string;
  lastName: string;
  organisationName: string;
  propertyName: string | null;
  expiresAt: string;
  /** True when this email already has a Wasl Property account — the
   * frontend must route this case through Sign In, never a password form. */
  accountExists: boolean;
}

export class InvitesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly authService: AuthService,
  ) {}

  private async assertContactInOrg(organisationId: string, contactId: string) {
    const contact = await this.prisma.propertyContact.findFirst({
      where: { id: contactId, organisationId },
    });
    if (!contact) {
      throw new NotFoundError('Person not found');
    }
    return contact;
  }

  private async contextForContact(contactId: string) {
    const membership = await this.prisma.propertyMembership.findFirst({
      where: { contactId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      include: { property: { select: { name: true } } },
    });
    return membership?.property.name ?? null;
  }

  private async sendInviteEmail(
    organisationName: string,
    contact: { email: string; firstName: string },
    propertyName: string | null,
    rawToken: string,
    expiresAt: Date,
  ) {
    const activationUrl = `${env.FRONTEND_URL}/activate-account?token=${rawToken}`;
    const { subject, html, text } = renderInviteEmail({
      firstName: contact.firstName,
      organisationName: propertyName ?? organisationName,
      activationUrl,
      expiresAt,
    });

    try {
      await emailService.send({ to: contact.email, subject, html, text });
    } catch (error) {
      // Never let a transient mail-provider failure roll back invite
      // creation — the invite row (and its "Resend" action) is the recovery
      // path if the email genuinely didn't arrive.
      logger.error({ err: error }, 'Failed to send invite email');
    }
  }

  private toPublicInvite(invite: ContactInvite): PublicInvite {
    return {
      id: invite.id,
      status: invite.status,
      expiresAt: invite.expiresAt.toISOString(),
      createdAt: invite.createdAt.toISOString(),
    };
  }

  async createInvite(
    organisationId: string,
    invitedByUserId: string,
    contactId: string,
  ): Promise<PublicInvite> {
    const contact = await this.assertContactInOrg(organisationId, contactId);
    if (contact.userId) {
      throw new ConflictError('This person already has an active account');
    }

    const existingPending = await this.prisma.contactInvite.findFirst({
      where: { propertyContactId: contactId, status: 'PENDING' },
    });
    if (existingPending) {
      if (existingPending.expiresAt > new Date()) {
        throw new ConflictError(
          'An invitation is already pending for this person. Use resend instead.',
        );
      }
      // Housekeeping: a PENDING row whose expiry has silently passed reads
      // as EXPIRED from here on rather than blocking a fresh invite.
      await this.prisma.contactInvite.update({
        where: { id: existingPending.id },
        data: { status: 'EXPIRED' },
      });
    }

    const organisation = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
    });
    const propertyName = await this.contextForContact(contactId);

    const rawToken = generateInviteToken();
    const expiresAt = inviteTokenExpiresAt();

    const invite = await this.prisma.contactInvite.create({
      data: {
        organisationId,
        propertyContactId: contactId,
        invitedByUserId,
        tokenHash: hashInviteToken(rawToken),
        expiresAt,
        status: 'PENDING',
      },
    });

    logger.info({ inviteId: invite.id, contactId }, 'Contact invite created');
    await this.sendInviteEmail(organisation.name, contact, propertyName, rawToken, expiresAt);
    return this.toPublicInvite(invite);
  }

  async resendInvite(
    organisationId: string,
    invitedByUserId: string,
    contactId: string,
  ): Promise<PublicInvite> {
    const contact = await this.assertContactInOrg(organisationId, contactId);
    if (contact.userId) {
      throw new ConflictError('This person already has an active account');
    }

    const latest = await this.prisma.contactInvite.findFirst({
      where: { propertyContactId: contactId },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) {
      throw new NotFoundError('No invitation to resend — invite this person first');
    }
    if (latest.status === 'ACCEPTED') {
      throw new ConflictError('This person already has an active account');
    }

    const organisation = await this.prisma.organisation.findUniqueOrThrow({
      where: { id: organisationId },
    });
    const propertyName = await this.contextForContact(contactId);

    const rawToken = generateInviteToken();
    const expiresAt = inviteTokenExpiresAt();

    const invite = await this.prisma.contactInvite.update({
      where: { id: latest.id },
      data: {
        invitedByUserId,
        tokenHash: hashInviteToken(rawToken),
        expiresAt,
        status: 'PENDING',
        acceptedAt: null,
        revokedAt: null,
      },
    });

    logger.info({ inviteId: invite.id, contactId }, 'Contact invite resent');
    await this.sendInviteEmail(organisation.name, contact, propertyName, rawToken, expiresAt);
    return this.toPublicInvite(invite);
  }

  async revokeInvite(organisationId: string, contactId: string): Promise<PublicInvite> {
    await this.assertContactInOrg(organisationId, contactId);

    const latest = await this.prisma.contactInvite.findFirst({
      where: { propertyContactId: contactId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) {
      throw new NotFoundError('No pending invitation to revoke');
    }

    const invite = await this.prisma.contactInvite.update({
      where: { id: latest.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    logger.info({ inviteId: invite.id, contactId }, 'Contact invite revoked');
    return this.toPublicInvite(invite);
  }

  /** Loads a PENDING, unexpired invite by its raw token, or throws. Lazily
   * flips a stale PENDING row to EXPIRED as a side effect of being read. */
  private async findUsableInviteOrThrow(rawToken: string): Promise<ContactInvite> {
    const tokenHash = hashInviteToken(rawToken);
    const invite = await this.prisma.contactInvite.findUnique({ where: { tokenHash } });
    if (!invite) {
      throw new NotFoundError('Invitation not found');
    }
    if (invite.status === 'REVOKED') {
      throw new ConflictError('This invitation has been revoked');
    }
    if (invite.status === 'ACCEPTED') {
      throw new ConflictError('This invitation has already been used');
    }
    if (invite.status === 'EXPIRED' || invite.expiresAt < new Date()) {
      if (invite.status !== 'EXPIRED') {
        await this.prisma.contactInvite.update({
          where: { id: invite.id },
          data: { status: 'EXPIRED' },
        });
      }
      throw new ConflictError(
        'This invitation has expired. Ask your property manager to resend it.',
      );
    }
    return invite;
  }

  async previewInvite(rawToken: string): Promise<InvitePreview> {
    const invite = await this.findUsableInviteOrThrow(rawToken);
    const contact = await this.prisma.propertyContact.findUniqueOrThrow({
      where: { id: invite.propertyContactId },
      include: { organisation: { select: { name: true } } },
    });
    const propertyName = await this.contextForContact(contact.id);
    const existingUser = await this.prisma.user.findUnique({ where: { email: contact.email } });

    return {
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      organisationName: contact.organisation.name,
      propertyName,
      expiresAt: invite.expiresAt.toISOString(),
      accountExists: Boolean(existingUser),
    };
  }

  /**
   * New-account path only. If the invited email already belongs to a User,
   * this always rejects — see acceptInviteForExistingUser for why we don't
   * let mere possession of the invite link set a password on an existing
   * account (that would be an account-takeover vector for anyone who
   * intercepts the email).
   */
  async acceptInvite(rawToken: string, password: string): Promise<AuthResult> {
    const invite = await this.findUsableInviteOrThrow(rawToken);

    const userId = await this.prisma.$transaction(async (tx) => {
      const contact = await tx.propertyContact.findUniqueOrThrow({
        where: { id: invite.propertyContactId },
      });

      if (contact.userId) {
        throw new ConflictError('This invitation has already been used');
      }

      const existingUser = await tx.user.findUnique({ where: { email: contact.email } });
      if (existingUser) {
        throw new ConflictError(
          'An account already exists for this email. Please sign in to accept this invitation.',
        );
      }

      const passwordHash = await hashPassword(password);
      const user = await tx.user.create({
        data: {
          email: contact.email,
          passwordHash,
          firstName: contact.firstName,
          lastName: contact.lastName,
        },
      });

      await tx.propertyContact.update({
        where: { id: contact.id },
        data: { userId: user.id, status: 'ACTIVE' },
      });
      await tx.contactInvite.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });

      return user.id;
    });

    logger.info({ inviteId: invite.id, userId }, 'Contact invite accepted (new account)');
    return this.authService.signInAfterActivation(userId);
  }

  /**
   * Existing-account path. The caller must already be authenticated as the
   * exact user whose email matches the invite's contact — this is the
   * "prove you own the account via its real password, not just the email
   * inbox" step required by an invite sent to an email that already has a
   * Wasl Property login.
   */
  async acceptInviteForExistingUser(rawToken: string, authenticatedUserId: string): Promise<void> {
    const invite = await this.findUsableInviteOrThrow(rawToken);

    await this.prisma.$transaction(async (tx) => {
      const contact = await tx.propertyContact.findUniqueOrThrow({
        where: { id: invite.propertyContactId },
      });

      if (contact.userId) {
        throw new ConflictError('This invitation has already been used');
      }

      const authenticatedUser = await tx.user.findUniqueOrThrow({
        where: { id: authenticatedUserId },
      });
      if (authenticatedUser.email !== contact.email) {
        throw new ConflictError(
          'This invitation was sent to a different email than the account you are signed in as.',
        );
      }

      // Scoped to this same organisation — a user may already be a
      // property-scoped identity in other organisations (that's fine, see
      // PeopleService.findOrCreateContact), but never two contacts within
      // this one.
      const alreadyLinkedInThisOrg = await tx.propertyContact.findUnique({
        where: {
          organisationId_userId: {
            organisationId: contact.organisationId,
            userId: authenticatedUserId,
          },
        },
      });
      if (alreadyLinkedInThisOrg && alreadyLinkedInThisOrg.id !== contact.id) {
        throw new ConflictError(
          'Your account is already linked to a different property contact in this organisation',
        );
      }

      await tx.propertyContact.update({
        where: { id: contact.id },
        data: { userId: authenticatedUserId, status: 'ACTIVE' },
      });
      await tx.contactInvite.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
    });

    logger.info(
      { inviteId: invite.id, userId: authenticatedUserId },
      'Contact invite accepted (existing account linked)',
    );
  }
}
