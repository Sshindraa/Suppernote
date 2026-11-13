import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { countSmsSegments } from '../../../../modules/usage/messaging-usage.service';
import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';

vi.mock('../../../redis/client', () => ({
  redisQueue: {
    url: 'redis://localhost:6379',
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock('../../../telnyx/client', () => ({
  sendSms: vi.fn(),
}));
vi.mock('../../../db/client', () => ({
  db: {},
}));
vi.mock('../helper', () => ({
  setupWorkerListeners: vi.fn(),
  jobLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../../../observability/system-checks', () => ({
  CONFIRMATION_SMS_SENT_EVENT: 'confirmation_sms_sent',
}));

import { sendSms } from '../../../telnyx/client';
import {
  processOutboundConfirmJob,
  type OutboundConfirmDependencies,
  type OutboundConfirmJobData,
} from '../outbound-confirm.worker';

function makeClaimStore() {
  const claims = new Map<string, string>();
  const set = vi.fn(
    async (
      key: string,
      value: string,
      _expirationMode: 'EX',
      _expirationSeconds: number,
      existenceMode?: 'NX',
    ) => {
      if (existenceMode === 'NX' && claims.has(key)) return null;
      claims.set(key, value);
      return 'OK';
    },
  );
  const get = vi.fn(async (key: string) => claims.get(key) ?? null);
  const del = vi.fn(async (key: string) => {
    claims.delete(key);
    return 1;
  });
  const evalScript = vi.fn(
    async (
      _script: string,
      _numberOfKeys: number,
      key: string,
      token: string,
      nextValue: string,
    ) => {
      const current = claims.get(key);
      if (!current || !current.includes(`\"token\":\"${token}\"`)) return 0;
      if (nextValue === '__DELETE__') claims.delete(key);
      else claims.set(key, nextValue);
      return 1;
    },
  );
  return { claims, store: { set, get, del, eval: evalScript }, set, get, del, evalScript };
}

function makeJob(): Job<OutboundConfirmJobData> {
  return {
    id: 'job-confirm-1',
    name: 'client-confirm',
    data: {
      reservationId: 'res-1',
      customerPhone: '+33612345678',
      customerName: 'Alice',
      restaurantName: 'Chez Suppernote',
      date: '5 juin 2099',
      time: '19:00',
      partySize: 2,
    },
  } as unknown as Job<OutboundConfirmJobData>;
}

function makeDependencies(
  reservation: { id: string; status: string; state: string } | null = {
    id: 'res-1',
    status: 'CONFIRMED',
    state: 'CONFIRMED',
  },
) {
  const db = {
    reservation: {
      findUnique: vi.fn().mockResolvedValue(
        reservation
          ? {
              restaurantId: 'restaurant-1',
              customerPhone: '+33600000001',
              reservedAt: new Date('2099-06-05T17:00:00.000Z'),
              startsAt: null,
              partySize: 2,
              restaurant: {
                name: 'Chez Suppernote',
                timezone: 'Europe/Paris',
                smsConfirmEnabled: true,
              },
              ...reservation,
            }
          : null,
      ),
    },
    reservationAuditLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };
  const { claims, store, set } = makeClaimStore();
  const deps: OutboundConfirmDependencies = {
    db: db as unknown as PrismaClient,
    sendSms,
    claimStore: store,
  };
  return { db, deps, claims, set };
}

function makeReconciliationQueue() {
  const jobIds = new Set<string>();
  const queue = {
    add: vi.fn(async (_name: string, _data: unknown, options: { jobId: string }) => {
      jobIds.add(options.jobId);
    }),
  };
  return { queue, jobIds };
}

describe('outbound-confirm.worker', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendSms).mockResolvedValue(undefined);
  });

  it('includes personal access in the existing single-segment SMS, without another send', async () => {
    vi.stubEnv('RESERVATION_MANAGEMENT_ENABLED', 'true');
    vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('DASHBOARD_URL', 'https://staging.suppernote.com');
    const { deps, db } = makeDependencies();
    const current = await db.reservation.findUnique();
    db.reservation.findUnique.mockResolvedValue({
      ...current,
      id: randomUUID(),
      createdAt: new Date(),
      reservedAt: new Date(Date.now() + 2 * 86_400_000),
    });

    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).toHaveBeenCalledTimes(1);
    const message = vi.mocked(sendSms).mock.calls[0][1];
    expect(message).toContain('https://staging.suppernote.com/r#');
    expect(countSmsSegments(message)).toBe(1);
  });

  it('ne peut envoyer qu’une seule fois sous concurrence', async () => {
    const { deps } = makeDependencies();

    await Promise.all([
      processOutboundConfirmJob(makeJob(), deps),
      processOutboundConfirmJob(makeJob(), deps),
    ]);

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(deps.db.reservationAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('utilise les coordonnees et le creneau actuels plutot que le vieux job', async () => {
    const { deps, db } = makeDependencies();
    const current = await db.reservation.findUnique();
    db.reservation.findUnique.mockResolvedValue({
      ...current,
      customerPhone: '+33600000002',
      partySize: 4,
      startsAt: new Date('2099-07-06T22:30:00.000Z'),
      restaurant: { name: 'Le Nouveau', timezone: 'Europe/Paris', smsConfirmEnabled: true },
    });

    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).toHaveBeenCalledWith(
      '+33600000002',
      'Reservation confirmee - Le Nouveau 07/07/2099 00:30 4pers. Annulation: appelez le restaurant.',
      expect.objectContaining({ restaurantId: 'restaurant-1' }),
    );
  });

  it.each([
    { customerPhone: null },
    { reservedAt: new Date('2000-01-01T00:00:00.000Z') },
    { restaurant: { name: 'Chez Suppernote', timezone: 'Europe/Paris', smsConfirmEnabled: false } },
  ])('ignore une confirmation devenue ineligible sans prendre de claim (%j)', async (changes) => {
    const { deps, db, set } = makeDependencies();
    const current = await db.reservation.findUnique();
    db.reservation.findUnique.mockResolvedValue({ ...current, ...changes });

    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(db.reservationAuditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    ['2099-01-05T18:00:00.000Z', '05/01/2099 19:00'],
    ['2099-07-05T17:00:00.000Z', '05/07/2099 19:00'],
  ])('respecte le fuseau du restaurant en hiver et en ete (%s)', async (instant, expected) => {
    const { deps, db } = makeDependencies();
    const current = await db.reservation.findUnique();
    db.reservation.findUnique.mockResolvedValue({ ...current, reservedAt: new Date(instant) });

    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).toHaveBeenCalledWith(
      '+33600000001',
      expect.stringContaining(expected),
      expect.any(Object),
    );
  });

  it('ne renvoie pas un SMS pour une réservation annulée', async () => {
    const { deps } = makeDependencies({ id: 'res-1', status: 'CANCELLED', state: 'CANCELLED' });

    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).not.toHaveBeenCalled();
    expect(deps.db.reservationAuditLog.findFirst).not.toHaveBeenCalled();
  });

  it('ne prend pas de claim et n’envoie pas pour PENDING projeté CONFIRMED', async () => {
    const { deps, set } = makeDependencies({ id: 'res-1', status: 'CONFIRMED', state: 'PENDING' });

    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(deps.db.reservationAuditLog.findFirst).not.toHaveBeenCalled();
  });

  it('libère la claim après un refus certain et autorise le retry', async () => {
    const { deps, claims } = makeDependencies();
    vi.mocked(sendSms)
      .mockRejectedValueOnce(Object.assign(new Error('Telnyx refused'), { statusCode: 400 }))
      .mockResolvedValueOnce(undefined);

    await expect(processOutboundConfirmJob(makeJob(), deps)).rejects.toThrow('Telnyx refused');
    expect(claims.size).toBe(0);

    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(deps.db.reservationAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('propage un résultat failure_certain explicite et réutilise le même job au retry', async () => {
    const { deps, claims } = makeDependencies();
    vi.mocked(sendSms)
      .mockResolvedValueOnce({
        outcome: 'failure_certain',
        provider: 'telnyx',
        channel: 'sms',
      })
      .mockResolvedValueOnce(undefined);

    await expect(processOutboundConfirmJob(makeJob(), deps)).rejects.toThrow(
      'provider refused the notification',
    );
    expect(claims.size).toBe(0);

    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).toHaveBeenCalledTimes(2);
    expect(deps.db.reservationAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('respecte un audit d’envoi déjà présent', async () => {
    const { db, deps } = makeDependencies();
    vi.mocked(db.reservationAuditLog.findFirst).mockResolvedValue({
      id: 'audit-existing',
    } as never);

    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).not.toHaveBeenCalled();
  });

  it('conserve la claim et réconcilie un timeout sans second appel provider', async () => {
    const { deps, claims } = makeDependencies();
    const { queue, jobIds } = makeReconciliationQueue();
    deps.reconciliationQueue = queue;
    vi.mocked(sendSms).mockRejectedValue(new Error('Telnyx timeout'));

    await processOutboundConfirmJob(makeJob(), deps);
    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(claims.size).toBe(1);
    expect(queue.add).toHaveBeenCalled();
    expect(jobIds.size).toBe(1);
  });

  it('conserve un identifiant provider connu dans la claim après une réponse unknown', async () => {
    const { deps, claims } = makeDependencies();
    const { queue } = makeReconciliationQueue();
    deps.reconciliationQueue = queue;
    vi.mocked(sendSms).mockResolvedValue({
      outcome: 'unknown',
      provider: 'telnyx',
      channel: 'sms',
      providerMessageId: 'msg-outbound-unknown',
    });

    await processOutboundConfirmJob(makeJob(), deps);

    const claim = [...claims.values()][0];
    expect(claim).toContain('"status":"unknown"');
    expect(claim).toContain('"providerMessageId":"msg-outbound-unknown"');
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('does not audit a missing provider receipt as a successful confirmation', async () => {
    const { deps, db, claims } = makeDependencies();
    const { queue } = makeReconciliationQueue();
    deps.reconciliationQueue = queue;
    vi.mocked(sendSms).mockResolvedValue({
      outcome: 'unknown',
      provider: 'telnyx',
      channel: 'sms',
    });
    await processOutboundConfirmJob(makeJob(), deps);
    await processOutboundConfirmJob(makeJob(), deps);
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(db.reservationAuditLog.create).not.toHaveBeenCalled();
    expect([...claims.values()][0]).toContain('"status":"unknown"');
    expect(queue.add).toHaveBeenCalled();
  });

  it('ne renvoie pas si la queue de réconciliation est indisponible', async () => {
    const { deps, claims } = makeDependencies();
    deps.reconciliationQueue = {
      add: vi.fn().mockRejectedValue(new Error('Redis queue unavailable')),
    };
    vi.mocked(sendSms).mockResolvedValue({
      outcome: 'unknown',
      provider: 'telnyx',
      channel: 'sms',
      providerMessageId: 'msg-queue-down',
    });

    await processOutboundConfirmJob(makeJob(), deps);
    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(claims.size).toBe(1);
    expect([...claims.values()][0]).toContain('"status":"unknown"');
  });

  it('conserve le succès avant un audit local défaillant et ne renvoie pas', async () => {
    const { deps, db, claims } = makeDependencies();
    db.reservationAuditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));

    await processOutboundConfirmJob(makeJob(), deps);
    await processOutboundConfirmJob(makeJob(), deps);

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(db.reservationAuditLog.create).toHaveBeenCalledTimes(1);
    expect(claims.size).toBe(1);
    expect([...claims.values()][0]).toContain('"status":"success"');
  });
});
