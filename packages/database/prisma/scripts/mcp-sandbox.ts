import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const DEMO_SLUG = 'chez-suppernote-demo';
const LEGACY_DEMO_SLUG = 'chez-sokar-demo';
const SANDBOX_PHONE = '+33612345600';
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const MAX_RUN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Command = 'start' | 'status' | 'reset';

type Options = {
  command: Command;
  runId?: string;
  startedAt?: Date;
  customerPhone: string;
  apply: boolean;
};

type SandboxCounts = {
  reservations: number;
  anonymizedReservations: number;
  holds: number;
  waitingListEntries: number;
  customers: number;
  customersReferencedOutsideRun: number;
  idempotencyRecords: number;
  auditLogs: number;
  consentRecords: number;
};

const ANONYMIZED_CUSTOMER_NAME = 'Réservation de test anonymisée';

function fail(message: string): never {
  throw new Error(message);
}

function readOption(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function parseRunId(value: string | undefined, required: boolean): string | undefined {
  if (!value) {
    if (required) fail('Missing --run-id');
    return undefined;
  }
  if (!RUN_ID_PATTERN.test(value)) {
    fail('Invalid --run-id. Use 3-64 lowercase letters, digits, or hyphens.');
  }
  return value;
}

function parseStartedAt(value: string | undefined, required: boolean): Date | undefined {
  if (!value) {
    if (required) fail('Missing --started-at=ISO_DATE_TIME');
    return undefined;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail('Invalid --started-at');
  if (parsed.getTime() > Date.now()) fail('--started-at cannot be in the future');
  if (Date.now() - parsed.getTime() > MAX_RUN_AGE_MS) {
    fail('--started-at is older than 7 days; start a fresh sandbox run');
  }
  return parsed;
}

function parsePhone(value: string | undefined): string {
  const phone = value ?? SANDBOX_PHONE;
  if (!/^\+[1-9]\d{9,14}$/.test(phone)) fail('Invalid --customer-phone');
  return phone;
}

function parseOptions(argv: string[]): Options {
  const command = argv[0] as Command | undefined;
  if (command !== 'start' && command !== 'status' && command !== 'reset') {
    fail('Usage: mcp:sandbox <start|status|reset> [--run-id=...] [--started-at=...] [--apply]');
  }
  const isReset = command === 'reset';
  return {
    command,
    runId: parseRunId(readOption(argv, 'run-id'), command !== 'start'),
    startedAt: parseStartedAt(readOption(argv, 'started-at'), command !== 'start'),
    customerPhone: parsePhone(readOption(argv, 'customer-phone')),
    apply: isReset && argv.includes('--apply'),
  };
}

export function markerFor(runId: string): string {
  return `MCP-SANDBOX:${runId}`;
}

function purgedMarkerFor(runId: string): string {
  return `${markerFor(runId)}:PURGED`;
}

function assertSandboxDatabase(): void {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) fail('DATABASE_URL is required');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    fail('DATABASE_URL is invalid');
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const localHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  const sandboxDatabase = /(staging|test|dev|local)/i.test(database);
  if (process.env.NODE_ENV === 'production' && !sandboxDatabase) {
    fail('Refusing to run against a production database name.');
  }
  if (!localHost && !sandboxDatabase) {
    fail('Refusing a remote database without staging/test/dev/local in its name.');
  }
}

async function loadDemoRestaurant(prisma: PrismaClient) {
  const select = {
    id: true,
    name: true,
    slug: true,
    agenticOptIn: true,
    exposureSettings: {
      select: {
        mcpEnabled: true,
        maxPartySize: true,
        minLeadTimeMinutes: true,
      },
    },
  } as const;
  const restaurant =
    (await prisma.restaurant.findUnique({ where: { slug: DEMO_SLUG }, select })) ??
    (await prisma.restaurant.findUnique({ where: { slug: LEGACY_DEMO_SLUG }, select }));
  if (!restaurant) {
    fail(`Demo restaurant ${DEMO_SLUG} is missing. Run the database seed first.`);
  }
  if (!restaurant.agenticOptIn || !restaurant.exposureSettings?.mcpEnabled) {
    fail(`Demo restaurant ${DEMO_SLUG} is not enabled for MCP.`);
  }
  return restaurant;
}

export async function readCounts(
  prisma: PrismaClient,
  restaurantId: string,
  runId: string,
  startedAt: Date,
  customerPhone: string,
): Promise<SandboxCounts> {
  const marker = markerFor(runId);
  const reservations = await prisma.reservation.findMany({
    where: {
      restaurantId,
      channel: 'MCP',
      specialRequests: { contains: marker },
      createdAt: { gte: startedAt },
    },
    select: { id: true, specialRequests: true },
  });
  const reservationIds = reservations.map((reservation) => reservation.id);

  const [
    holds,
    waitingListEntries,
    customers,
    customersReferencedOutsideRun,
    idempotencyRecords,
    auditLogs,
    consentRecords,
  ] = await Promise.all([
    prisma.agenticHold.count({
      where: {
        restaurantId,
        channel: 'MCP',
        createdAt: { gte: startedAt },
      },
    }),
    prisma.waitingListEntry.count({
      where: {
        restaurantId,
        customerPhone,
        source: { startsWith: 'mcp:' },
        createdAt: { gte: startedAt },
      },
    }),
    prisma.customer.count({
      where: {
        restaurantId,
        phone: customerPhone,
        createdAt: { gte: startedAt },
      },
    }),
    prisma.customer.count({
      where: {
        restaurantId,
        phone: customerPhone,
        createdAt: { gte: startedAt },
        reservations: {
          some: {
            NOT: {
              id: { in: reservationIds.length > 0 ? reservationIds : ['__no_run_reservations__'] },
            },
          },
        },
      },
    }),
    reservationIds.length
      ? prisma.idempotencyRecord.count({
          where: { reservationId: { in: reservationIds } },
        })
      : Promise.resolve(0),
    reservationIds.length
      ? prisma.reservationAuditLog.count({
          where: { reservationId: { in: reservationIds } },
        })
      : Promise.resolve(0),
    reservationIds.length
      ? prisma.customerConsent.count({
          where: { reservationId: { in: reservationIds } },
        })
      : Promise.resolve(0),
  ]);

  return {
    reservations: reservations.length,
    anonymizedReservations: reservations.filter((reservation) =>
      reservation.specialRequests?.includes(purgedMarkerFor(runId)),
    ).length,
    holds,
    waitingListEntries,
    customers,
    customersReferencedOutsideRun,
    idempotencyRecords,
    auditLogs,
    consentRecords,
  };
}

export async function resetRun(
  prisma: PrismaClient,
  restaurantId: string,
  runId: string,
  startedAt: Date,
  customerPhone: string,
): Promise<void> {
  const marker = markerFor(runId);
  await prisma.$transaction(async (tx) => {
    const reservations = await tx.reservation.findMany({
      where: {
        restaurantId,
        channel: 'MCP',
        specialRequests: { contains: marker },
        createdAt: { gte: startedAt },
      },
      select: {
        id: true,
        state: true,
        specialRequests: true,
      },
    });
    const reservationIds = reservations.map((reservation) => reservation.id);
    const reservationIdSet = new Set(reservationIds);
    const existingAuditRows = reservationIds.length
      ? await tx.reservationAuditLog.findMany({
          where: { reservationId: { in: reservationIds } },
          select: { reservationId: true },
        })
      : [];
    const auditedReservationIds = new Set(
      existingAuditRows.flatMap((row) => (row.reservationId ? [row.reservationId] : [])),
    );

    await tx.waitingListEntry.deleteMany({
      where: {
        restaurantId,
        customerPhone,
        source: { startsWith: 'mcp:' },
        createdAt: { gte: startedAt },
      },
    });
    if (reservationIds.length > 0) {
      await tx.idempotencyRecord.deleteMany({
        where: { reservationId: { in: reservationIds } },
      });
    }

    for (const reservation of reservations) {
      if (!auditedReservationIds.has(reservation.id)) {
        await tx.reservation.delete({ where: { id: reservation.id } });
        continue;
      }

      const wasPurged = reservation.specialRequests?.includes(purgedMarkerFor(runId)) ?? false;
      const isCapacityBlocking = ['PENDING', 'CONFIRMED', 'SEATED'].includes(reservation.state);
      if (isCapacityBlocking) {
        await tx.reservationAuditLog.create({
          data: {
            event: 'reservation_cancelled',
            reservationId: reservation.id,
            actor: 'system:mcp-sandbox',
            fromState: reservation.state,
            toState: 'CANCELLED',
            correlationId: runId,
            metadata: { reason: 'sandbox_reset', runId },
          },
        });
      }

      if (!wasPurged) {
        await tx.reservationAuditLog.create({
          data: {
            event: 'reservation_anonymized',
            reservationId: reservation.id,
            actor: 'system:mcp-sandbox',
            fromState: isCapacityBlocking ? 'CANCELLED' : reservation.state,
            toState: isCapacityBlocking ? 'CANCELLED' : reservation.state,
            correlationId: runId,
            metadata: { reason: 'sandbox_reset', runId },
          },
        });
      }

      await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          ...(isCapacityBlocking ? { status: 'CANCELLED', state: 'CANCELLED' } : {}),
          customerName: ANONYMIZED_CUSTOMER_NAME,
          customerPhone: null,
          customerEmail: null,
          customerId: null,
          specialRequests: purgedMarkerFor(runId),
          idempotencyScope: null,
          idempotencyKey: null,
          idempotencyPayloadHash: null,
        },
      });
    }

    await tx.agenticHold.deleteMany({
      where: {
        restaurantId,
        channel: 'MCP',
        createdAt: { gte: startedAt },
      },
    });
    const runCustomers = await tx.customer.findMany({
      where: {
        restaurantId,
        phone: customerPhone,
        createdAt: { gte: startedAt },
      },
      select: { id: true },
    });
    const runCustomerIds = runCustomers.map((customer) => customer.id);
    const externalReservationCount =
      runCustomerIds.length > 0
        ? await tx.reservation.count({
            where: {
              customerId: { in: runCustomerIds },
              ...(reservationIdSet.size > 0 ? { id: { notIn: [...reservationIdSet] } } : {}),
            },
          })
        : 0;
    if (externalReservationCount === 0) {
      await tx.customer.deleteMany({
        where: { id: { in: runCustomerIds } },
      });
    }
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  assertSandboxDatabase();
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  });

  try {
    const restaurant = await loadDemoRestaurant(prisma);

    if (options.command === 'start') {
      const runId = options.runId ?? `mcp-${randomUUID().slice(0, 8)}`;
      const startedAt = new Date();
      process.stdout.write(
        `${JSON.stringify(
          {
            runId,
            startedAt: startedAt.toISOString(),
            restaurantId: restaurant.id,
            restaurantSlug: restaurant.slug,
            customerPhone: options.customerPhone,
            specialRequestsMarker: markerFor(runId),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const runId = options.runId!;
    const startedAt = options.startedAt!;
    const counts = await readCounts(prisma, restaurant.id, runId, startedAt, options.customerPhone);

    if (options.command === 'status') {
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: 'status',
            runId,
            startedAt: startedAt.toISOString(),
            restaurantId: restaurant.id,
            customerPhone: options.customerPhone,
            counts,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    if (!options.apply) {
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: 'dry-run',
            runId,
            startedAt: startedAt.toISOString(),
            restaurantId: restaurant.id,
            customerPhone: options.customerPhone,
            counts,
            nextStep:
              'Add --apply to remove operational artifacts; audited reservations and consent proofs are retained.',
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    await resetRun(prisma, restaurant.id, runId, startedAt, options.customerPhone);
    const remaining = await readCounts(
      prisma,
      restaurant.id,
      runId,
      startedAt,
      options.customerPhone,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: 'reset',
          runId,
          startedAt: startedAt.toISOString(),
          restaurantId: restaurant.id,
          customerPhone: options.customerPhone,
          beforeReset: counts,
          remaining,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `[mcp-sandbox] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
