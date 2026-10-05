import type { Prisma, PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../errors/AppError.js';
import type { AuthContext } from '../../middlewares/auth.middleware.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import {
  assertAudienceWithinScope,
  AudienceResolver,
  type AudienceCriteria,
} from '../communications/communications.audience.js';
import type {
  CreateSavedAudienceInput,
  UpdateSavedAudienceInput,
} from './saved-audiences.schemas.js';

export class SavedAudiencesService {
  private readonly audience: AudienceResolver;
  private readonly authz: AuthorizationService;

  constructor(private readonly prisma: PrismaClient) {
    this.audience = new AudienceResolver(prisma);
    this.authz = new AuthorizationService(prisma);
  }

  private async getOwned(organisationId: string, id: string) {
    const audience = await this.prisma.savedAudience.findFirst({ where: { id, organisationId } });
    if (!audience) {
      throw new NotFoundError('Saved audience not found');
    }
    return audience;
  }

  /** A property-scoped manager only ever sees saved audiences whose
   * criteria resolve within properties they hold `communications.view` on
   * — never an organisation-wide rule, never another property's. Org
   * staff (accessible === 'ALL') see every saved audience, unchanged. */
  async list(organisationId: string, auth: AuthContext) {
    const accessible = await this.authz.getAccessiblePropertyIds(auth, 'communications.view');
    if (accessible !== 'ALL' && accessible.length === 0) return [];

    const audiences = await this.prisma.savedAudience.findMany({
      where: { organisationId },
      orderBy: { name: 'asc' },
    });

    const visible =
      accessible === 'ALL'
        ? audiences
        : await filterCriteriaWithinAccessible(this.prisma, audiences, accessible);

    // Live-resolved count per audience — always reflects current
    // memberships, never a frozen number stored on the row itself.
    return Promise.all(
      visible.map(async (a) => {
        const preview = await this.audience.preview(
          organisationId,
          a.criteria as unknown as AudienceCriteria,
        );
        return { ...a, resolvedCount: preview.count, summary: preview.summary };
      }),
    );
  }

  async create(
    organisationId: string,
    auth: AuthContext,
    actorUserId: string,
    input: CreateSavedAudienceInput,
  ) {
    const criteria = input.criteria as AudienceCriteria;
    await this.audience.validate(organisationId, criteria);
    await assertAudienceWithinScope(
      this.prisma,
      this.authz,
      auth,
      'communications.manage',
      criteria,
    );

    const existing = await this.prisma.savedAudience.findUnique({
      where: { organisationId_name: { organisationId, name: input.name } },
    });
    if (existing) {
      throw new ConflictError('A saved audience with this name already exists');
    }

    return this.prisma.savedAudience.create({
      data: {
        organisationId,
        name: input.name,
        criteria: criteria as unknown as Prisma.InputJsonValue,
        createdByUserId: actorUserId,
      },
    });
  }

  async update(
    organisationId: string,
    auth: AuthContext,
    id: string,
    input: UpdateSavedAudienceInput,
  ) {
    const existing = await this.getOwned(organisationId, id);
    // Scope-check the audience's *current* criteria too, not just the
    // incoming change — a property-scoped manager may never edit a saved
    // audience outside their portfolio, even to change just its name.
    await assertAudienceWithinScope(
      this.prisma,
      this.authz,
      auth,
      'communications.manage',
      existing.criteria as unknown as AudienceCriteria,
    );
    if (input.criteria) {
      const criteria = input.criteria as AudienceCriteria;
      await this.audience.validate(organisationId, criteria);
      await assertAudienceWithinScope(
        this.prisma,
        this.authz,
        auth,
        'communications.manage',
        criteria,
      );
    }

    return this.prisma.savedAudience.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.criteria !== undefined
          ? { criteria: input.criteria as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async delete(organisationId: string, auth: AuthContext, id: string) {
    const existing = await this.getOwned(organisationId, id);
    await assertAudienceWithinScope(
      this.prisma,
      this.authz,
      auth,
      'communications.manage',
      existing.criteria as unknown as AudienceCriteria,
    );
    // A saved audience referenced by past communications stays referenced
    // (Communication.savedAudienceId → SET NULL on delete would be wrong —
    // we keep the row's own audienceCriteria snapshot regardless, so
    // deleting the saved rule is always safe).
    await this.prisma.savedAudience.delete({ where: { id } });
  }
}

async function filterCriteriaWithinAccessible<T extends { criteria: Prisma.JsonValue }>(
  prisma: PrismaClient,
  audiences: T[],
  accessible: string[],
): Promise<T[]> {
  const spaceIds = new Set<string>();
  for (const a of audiences) {
    const criteria = a.criteria as unknown as AudienceCriteria;
    if (criteria.scope === 'SPACE') {
      for (const id of criteria.spaceIds ?? []) spaceIds.add(id);
    }
  }
  const spacePropertyById = spaceIds.size
    ? new Map(
        (
          await prisma.space.findMany({
            where: { id: { in: [...spaceIds] } },
            select: { id: true, propertyId: true },
          })
        ).map((s) => [s.id, s.propertyId]),
      )
    : new Map<string, string>();

  return audiences.filter((a) => {
    const criteria = a.criteria as unknown as AudienceCriteria;
    if (criteria.scope === 'ORGANISATION') return false;
    if (criteria.scope === 'PROPERTY') {
      return (criteria.propertyIds ?? []).every((id) => accessible.includes(id));
    }
    return (criteria.spaceIds ?? []).every((id) => {
      const propertyId = spacePropertyById.get(id);
      return propertyId !== undefined && accessible.includes(propertyId);
    });
  });
}
