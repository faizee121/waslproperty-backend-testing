import type { PrismaClient } from '@prisma/client';
import { env } from '../../../config/env.js';
import { getDeliveryScheduler } from '../../../modules/communications/communications.delivery.js';

export type HealthStatus = 'operational' | 'degraded' | 'not_configured' | 'unavailable';

export interface HealthCheck {
  name: string;
  category: string;
  status: HealthStatus;
  context: string;
}

/** Only real, genuinely-performable checks — no uptime percentages, no
 * SLA scores, no external monitoring vendor, no fabricated latency. */
export class BackofficeIntegrationsService {
  constructor(private readonly prisma: PrismaClient) {}

  async getChecks(): Promise<HealthCheck[]> {
    const checks: HealthCheck[] = [
      {
        name: 'Backend API',
        category: 'Core service',
        status: 'operational',
        context: 'Responding to this request',
      },
    ];

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.push({
        name: 'Database (PostgreSQL)',
        category: 'Data store',
        status: 'operational',
        context: 'Connected via Prisma',
      });
    } catch {
      checks.push({
        name: 'Database (PostgreSQL)',
        category: 'Data store',
        status: 'unavailable',
        context: 'Query failed',
      });
    }

    checks.push(
      env.SMTP_HOST
        ? {
            name: 'Email delivery (SMTP)',
            category: 'Notifications',
            status: 'operational',
            context: 'SMTP_HOST configured',
          }
        : {
            name: 'Email delivery (SMTP)',
            category: 'Notifications',
            status: 'not_configured',
            context: 'SMTP_HOST unset in this environment',
          },
    );

    // S3_BUCKET_NAME/AWS_REGION are required at boot, so this is always
    // configured where the app is running at all — reported as configured,
    // not "reachable", since no live connectivity check is performed here.
    checks.push({
      name: 'Amazon S3 (attachments)',
      category: 'Object storage',
      status: 'operational',
      context: 'Bucket configured',
    });

    const waslSignConfigured = Boolean(
      env.WASLSIGN_API_BASE_URL &&
      env.WASLSIGN_SERVICE_CLIENT_ID &&
      env.WASLSIGN_SERVICE_CLIENT_SECRET,
    );
    checks.push(
      waslSignConfigured
        ? {
            name: 'WaslSign integration',
            category: 'Work order signing & approvals',
            status: 'operational',
            context: 'Configured',
          }
        : {
            name: 'WaslSign integration',
            category: 'Work order signing & approvals',
            status: 'not_configured',
            context: 'SIGNATURE_ONLY / APPROVAL_THEN_SIGNATURE unavailable',
          },
    );

    const scheduler = getDeliveryScheduler().getStatus();
    checks.push({
      name: 'Communication delivery scheduler',
      category: 'Background workers',
      status: scheduler.running ? 'operational' : 'unavailable',
      context: scheduler.running
        ? scheduler.lastTickAt
          ? `Running · last tick ${scheduler.lastTickAt.toISOString()}`
          : 'Running · no tick yet'
        : 'Not running',
    });

    return checks;
  }
}
