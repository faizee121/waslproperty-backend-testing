import type { Communication, CommunicationChannel, PrismaClient } from '@prisma/client';
import { recordActivity } from '../activity/activity.js';
import { emailService } from '../../lib/email.js';
import { getPrismaClient } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { notifyUsers } from '../notifications/notifications.js';
import {
  AudienceResolver,
  type AudienceCriteria,
  type ResolvedRecipient,
} from './communications.audience.js';
import { renderAnnouncementEmail } from './communications.email.js';

/** A large announcement audience (hundreds/thousands of residents) must
 * never fire every recipient's email send at once — that's both a
 * straightforward way to get the outbound mail provider to start
 * throttling/blocking this account, and a spike of fully-concurrent DB
 * round trips + provider API calls with nothing bounding it. Bounded to a
 * small worker-pool instead; each recipient's own send/write is already
 * independent and error-isolated (see sendEmails below), so this changes
 * nothing about per-recipient delivery status or error handling — only
 * how many run at once. */
const EMAIL_SEND_CONCURRENCY = 5;

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/**
 * The processing side of communication delivery, deliberately behind this
 * interface so the MVP in-process poller (InProcessDeliveryScheduler below)
 * can later be swapped for SQS/EventBridge/Lambda or another worker without
 * the Communication/CommunicationRecipient/CommunicationDelivery domain
 * model — or the CommunicationDeliveryService that does the actual work —
 * changing at all. Whatever triggers it, delivery always goes through
 * CommunicationDeliveryService.processDue / .deliverOne.
 */
export interface DeliveryScheduler {
  start(): void;
  stop(): void;
}

/**
 * Resolves the audience, creates the per-recipient/per-channel rows
 * (idempotently — safe to re-run against a partially-processed
 * communication after a crash or restart), sends in-app notifications and
 * emails, and marks the communication SENT. Email sending happens only
 * after the DB transaction committing recipients/deliveries/SENT status —
 * an SMTP failure updates that one recipient's delivery row, never the
 * announcement itself (same "never let mail failure corrupt the record"
 * principle as invites.service.ts).
 */
export class CommunicationDeliveryService {
  private readonly audience: AudienceResolver;

  constructor(private readonly prisma: PrismaClient) {
    this.audience = new AudienceResolver(prisma);
  }

  /** Atomically claims up to `batchSize` due communications so a second
   * concurrent caller (e.g. a rolling deploy with two instances briefly
   * overlapping) can never double-process the same one. Also reclaims
   * any communication stuck in SENDING past
   * COMMUNICATION_SENDING_STUCK_THRESHOLD_MS — see that env var's doc
   * comment for why retrying from scratch is safe. */
  async processDue(now = new Date(), batchSize = 10): Promise<{ processed: number }> {
    await this.reclaimStuckSending(now);

    const due = await this.prisma.communication.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: now } },
      take: batchSize,
      select: { id: true },
    });

    let processed = 0;
    for (const { id } of due) {
      const claim = await this.prisma.communication.updateMany({
        where: { id, status: 'SCHEDULED' },
        data: { status: 'SENDING' },
      });
      if (claim.count === 0) continue; // already claimed elsewhere

      await this.deliverOne(id);
      processed++;
    }
    return { processed };
  }

  /** A communication can only ever reach SENDING via the atomic claim
   * above, and only ever leave it via deliverOne's own try/catch (SENT
   * or FAILED) — so one still in SENDING after this long has no live
   * process working on it; the process that claimed it crashed or was
   * killed mid-delivery. Reclaiming it (SENDING -> SCHEDULED, so the
   * normal claim loop above picks it straight back up) is safe only
   * because deliverOne's own writes are idempotent/status-guarded for
   * exactly this resume case; this does not introduce that guarantee,
   * it relies on it. */
  private async reclaimStuckSending(now: Date): Promise<void> {
    const staleBefore = new Date(now.getTime() - env.COMMUNICATION_SENDING_STUCK_THRESHOLD_MS);
    const reclaimed = await this.prisma.communication.updateMany({
      where: { status: 'SENDING', updatedAt: { lt: staleBefore } },
      data: { status: 'SCHEDULED' },
    });
    if (reclaimed.count > 0) {
      logger.warn(
        { count: reclaimed.count, staleBefore },
        'Reclaimed communication(s) stuck in SENDING for retry',
      );
    }
  }

  async deliverOne(communicationId: string): Promise<void> {
    const communication = await this.prisma.communication.findUnique({
      where: { id: communicationId },
    });
    if (!communication) return;

    try {
      const criteria = communication.audienceCriteria as unknown as AudienceCriteria;
      const recipients = await this.audience.resolve(communication.organisationId, criteria);

      // Recipient/delivery/notification rows are written as fast, batched,
      // idempotent operations — never inside one long-lived interactive
      // transaction. The previous implementation ran every recipient's
      // upserts (recipient row, one delivery row per channel, an in-app
      // notification, a delivery status update) sequentially inside a
      // single `$transaction`, so the transaction's total duration scaled
      // with audience size. Against a pooled remote connection (Supabase's
      // Supavisor Session Pooler in staging vs. loopback Postgres locally)
      // that easily exceeds Prisma's 5s default interactive-transaction
      // timeout well before a realistic audience finishes — the exact
      // cause of the P2028 "transaction not found" failure this fixes.
      // Each step below is O(1) round trips regardless of recipient count,
      // and `createMany({ skipDuplicates: true })` is exactly as safe to
      // re-run against a partially-processed communication as the original
      // per-row upserts were — resuming after a crash just no-ops the rows
      // that already exist.
      if (recipients.length > 0) {
        await this.prisma.communicationRecipient.createMany({
          data: recipients.map((r) => ({
            communicationId,
            contactId: r.contactId,
            userId: r.userId,
            propertyId: r.propertyId,
            spaceId: r.spaceId,
          })),
          skipDuplicates: true,
        });

        const recipientRows = await this.prisma.communicationRecipient.findMany({
          where: { communicationId },
          select: { id: true, contactId: true, userId: true },
        });
        const recipientByContactId = new Map(recipientRows.map((r) => [r.contactId, r]));

        const deliveryRows: Array<{
          communicationRecipientId: string;
          channel: CommunicationChannel;
          status: 'PENDING';
        }> = [];
        for (const recipient of recipients) {
          const row = recipientByContactId.get(recipient.contactId);
          if (!row) continue; // should be unreachable — never let a map miss crash delivery
          for (const channel of communication.channels) {
            if (channel === 'WHATSAPP') continue; // never attempted — not live yet
            // An IN_APP delivery is only meaningful for a recipient who
            // actually has portal access — with no userId there is no
            // inbox to deliver to, so no placeholder row is created for
            // that channel rather than leaving a permanently-PENDING one.
            if (channel === 'IN_APP' && !row.userId) continue;
            deliveryRows.push({ communicationRecipientId: row.id, channel, status: 'PENDING' });
          }
        }
        if (deliveryRows.length > 0) {
          await this.prisma.communicationDelivery.createMany({
            data: deliveryRows,
            skipDuplicates: true,
          });
        }

        if (communication.channels.includes('IN_APP')) {
          const inAppRecipients = recipients.filter((r) => r.userId);
          if (inAppRecipients.length > 0) {
            await notifyUsers(
              this.prisma,
              inAppRecipients.map((r) => ({
                organisationId: communication.organisationId,
                userId: r.userId as string,
                title: communication.title,
                body: communication.body,
                entityType: 'Communication',
                entityId: communication.id,
                sourceCommunicationId: communication.id,
              })),
            );

            const inAppRecipientIds = inAppRecipients
              .map((r) => recipientByContactId.get(r.contactId)?.id)
              .filter((id): id is string => Boolean(id));
            await this.prisma.communicationDelivery.updateMany({
              where: { communicationRecipientId: { in: inAppRecipientIds }, channel: 'IN_APP' },
              data: { status: 'DELIVERED', sentAt: new Date(), deliveredAt: new Date() },
            });
          }
        }
      }

      // Short, fast, constant-time transaction — its duration never scales
      // with audience size, so it can never hit the same timeout.
      await this.prisma.$transaction(async (tx) => {
        await recordActivity(tx, {
          organisationId: communication.organisationId,
          actorUserId: communication.createdByUserId,
          eventType: 'ANNOUNCEMENT_SENT',
          entityType: 'Communication',
          entityId: communication.id,
          title: `Announcement sent: ${communication.title}`,
          description: `${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`,
        });

        await tx.communication.update({
          where: { id: communicationId },
          data: { status: 'SENT', sentAt: new Date() },
        });
      });

      if (communication.channels.includes('EMAIL')) {
        await this.sendEmails(communication, recipients);
      }
    } catch (err) {
      await this.prisma.communication.update({
        where: { id: communicationId },
        data: { status: 'FAILED' },
      });
      logger.error({ err, communicationId }, 'Failed to process communication delivery');
    }
  }

  private async sendEmails(communication: Communication, recipients: ResolvedRecipient[]) {
    const organisation = await this.prisma.organisation.findUnique({
      where: { id: communication.organisationId },
      select: { name: true },
    });

    await mapWithConcurrency(recipients, EMAIL_SEND_CONCURRENCY, async (recipient) => {
      const recipientRow = await this.prisma.communicationRecipient.findUnique({
        where: {
          communicationId_contactId: {
            communicationId: communication.id,
            contactId: recipient.contactId,
          },
        },
      });
      if (!recipientRow) return;

      const deliveryRow = await this.prisma.communicationDelivery.findUnique({
        where: {
          communicationRecipientId_channel: {
            communicationRecipientId: recipientRow.id,
            channel: 'EMAIL',
          },
        },
      });
      if (!deliveryRow) return;
      // The actual duplicate-send guard: the external email call can't be
      // made transactional with the DB write that records it, so if
      // deliverOne is ever resumed/retried after this recipient's email
      // already went out (status SENT or DELIVERED), never send it again.
      // A PENDING or FAILED row is retried, matching existing behaviour.
      if (deliveryRow.status === 'SENT' || deliveryRow.status === 'DELIVERED') return;

      try {
        const rendered = renderAnnouncementEmail({
          title: communication.title,
          body: communication.body,
          organisationName: organisation?.name ?? 'Wasl Property',
          recipientFirstName: recipient.firstName,
        });
        const { providerMessageId } = await emailService.send({
          to: recipient.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });
        await this.prisma.communicationDelivery.update({
          where: { id: deliveryRow.id },
          data: {
            status: 'SENT',
            attemptedAt: new Date(),
            sentAt: new Date(),
            providerMessageId: providerMessageId ?? null,
          },
        });
      } catch (err) {
        logger.error(
          { err, communicationId: communication.id, contactId: recipient.contactId },
          'Failed to send announcement email',
        );
        await this.prisma.communicationDelivery.update({
          where: { id: deliveryRow.id },
          data: {
            status: 'FAILED',
            attemptedAt: new Date(),
            failedAt: new Date(),
            failureReason: err instanceof Error ? err.message : String(err),
          },
        });
      }
    });
  }
}

/**
 * MVP scheduler: a plain in-process interval poller. Deliberately the
 * *only* thing that knows delivery is triggered on a timer — swapping this
 * for an SQS-consumer or EventBridge-scheduled Lambda later means writing a
 * new DeliveryScheduler and calling the same CommunicationDeliveryService,
 * not touching the domain model or the service itself.
 */
export interface DeliverySchedulerStatus {
  running: boolean;
  intervalMs: number;
  lastTickAt: Date | null;
}

export class InProcessDeliveryScheduler implements DeliveryScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTickAt: Date | null = null;

  constructor(
    private readonly deliveryService: CommunicationDeliveryService,
    private readonly intervalMs = 20_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.lastTickAt = new Date();
      this.deliveryService.processDue().catch((err) => {
        logger.error({ err }, 'Communication delivery poll failed');
      });
    }, this.intervalMs);
    // Don't hold the process open just for this timer in tests/scripts.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Real, genuinely-knowable state only — never a fabricated worker-pool
   * or cluster metric. The Backoffice Jobs screen reads this directly. */
  getStatus(): DeliverySchedulerStatus {
    return {
      running: this.timer !== undefined,
      intervalMs: this.intervalMs,
      lastTickAt: this.lastTickAt,
    };
  }
}

let scheduler: InProcessDeliveryScheduler | undefined;

/** One scheduler instance per process, shared between main.ts (which
 * starts it) and the Backoffice Jobs module (which only reads its status
 * — it never starts a second poller). */
export function getDeliveryScheduler(): InProcessDeliveryScheduler {
  if (!scheduler) {
    scheduler = new InProcessDeliveryScheduler(new CommunicationDeliveryService(getPrismaClient()));
  }
  return scheduler;
}
