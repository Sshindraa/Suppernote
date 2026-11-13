import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('../../../db/client', () => ({
  db: {},
}));
vi.mock('../../../messaging/sender', () => ({
  sendReminder: vi.fn(),
}));
vi.mock('../helper', () => ({
  setupWorkerListeners: vi.fn(),
  jobLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { sendReminder, type SendResult } from '../../../messaging/sender';
import {
  processConfirmationSmsJob,
  isReminderDue,
  type ConfirmationSmsDependencies,
  type ConfirmationSmsJobData,
} from '../confirmation-sms.worker';

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

const reservation = {
  id: 'res-reminder-1',
  restaurantId: 'rest-1',
  customerId: null,
  customerPhone: '+33612345678',
  reservedAt: new Date('2026-07-02T17:00:00.000Z'),
  partySize: 2,
  status: 'CONFIRMED',
  state: 'CONFIRMED',
  confirmationStatus: 'NOT_REQUIRED',
  confirmationSentAt: null as Date | null,
  restaurant: { id: 'rest-1', name: 'Chez Suppernote', timezone: 'Europe/Paris' },
  consents: { transactionalWhatsapp: true } as Record<string, unknown>,
  channel: 'WEB',
};

function makeJob(): Job<ConfirmationSmsJobData> {
  return {
    id: 'job-reminder-1',
    name: 'send-reminder',
    data: { kind: 'send', reservationId: reservation.id },
  } as unknown as Job<ConfirmationSmsJobData>;
}

function makeDependencies(current = reservation) {
  const { claims, store, set } = makeClaimStore();
  const db = {
    reservation: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue(current),
      update: vi.fn().mockResolvedValue(current),
    },
  };
  const deps: ConfirmationSmsDependencies = {
    db: db as unknown as PrismaClient,
    sendReminder,
    formatDate: vi.fn().mockReturnValue('jeudi 2 juillet 2026'),
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

describe('confirmation-sms.worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T12:00:00Z'));
    vi.mocked(sendReminder).mockResolvedValue({ channel: 'sms', success: true });
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['2026-03-28T23:30:00Z', '2026-03-29T17:00:00Z', 'Europe/Paris', false],
    ['2026-03-28T12:00:00Z', '2026-03-29T17:00:00Z', 'Europe/Paris', true],
    ['2026-10-24T12:00:00Z', '2026-10-25T18:00:00Z', 'Europe/Paris', true],
    ['2026-07-01T00:30:00Z', '2026-07-01T18:00:00Z', 'America/New_York', true],
  ])('calcule demain dans le fuseau du restaurant (%s, %s)', (now, slot, timezone, due) => {
    expect(isReminderDue(new Date(slot), timezone, new Date(now))).toBe(due);
  });

  it('relit toutes les donnees et affiche l heure locale apres modification pendant le scan', async () => {
    const { deps, db } = makeDependencies();
    db.reservation.findMany.mockResolvedValue([reservation]);
    db.reservation.findUnique.mockResolvedValue({
      ...reservation,
      customerPhone: '+33600000002',
      reservedAt: new Date('2026-07-02T18:30:00Z'),
      partySize: 4,
    } as never);
    await processConfirmationSmsJob(
      { data: { kind: 'scan' } } as Job<ConfirmationSmsJobData>,
      deps,
    );
    expect(sendReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '+33600000002',
        time: '20:30',
        partySize: 4,
      }),
    );
    expect(deps.formatDate).toHaveBeenCalledWith(
      expect.any(Date),
      'fr-FR',
      expect.objectContaining({ timeZone: 'Europe/Paris' }),
    );
  });

  it('isole un refus et continue les rappels suivants', async () => {
    const { deps, db } = makeDependencies();
    const other = { ...reservation, id: 'res-other' };
    db.reservation.findMany.mockResolvedValue([reservation, other]);
    db.reservation.findUnique.mockResolvedValueOnce(reservation).mockResolvedValueOnce(other);
    const add = vi.fn().mockResolvedValue(undefined);
    deps.reminderQueue = { add } as never;
    vi.mocked(sendReminder)
      .mockResolvedValueOnce({ channel: 'whatsapp', success: false, outcome: 'failure_certain' })
      .mockResolvedValueOnce({ channel: 'whatsapp', success: true });
    await processConfirmationSmsJob(
      { data: { kind: 'scan' } } as Job<ConfirmationSmsJobData>,
      deps,
    );
    expect(sendReminder).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      'send-reminder',
      { kind: 'send', reservationId: reservation.id },
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    expect(db.reservation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: other.id } }),
    );
  });

  it.each([
    { channel: 'PHONE' },
    { customerPhone: null },
    { reservedAt: new Date('2026-07-04T18:30:00Z') },
    { consents: { transactionalWhatsapp: false } },
  ])('ne rappelle pas une reservation devenue ineligible pendant le scan (%j)', async (changes) => {
    const { deps, db } = makeDependencies();
    db.reservation.findMany.mockResolvedValue([reservation]);
    db.reservation.findUnique.mockResolvedValue({ ...reservation, ...changes } as never);
    await processConfirmationSmsJob(
      { data: { kind: 'scan' } } as Job<ConfirmationSmsJobData>,
      deps,
    );
    expect(sendReminder).not.toHaveBeenCalled();
    expect(db.reservation.update).not.toHaveBeenCalled();
  });

  it('déduplique deux exécutions pour la même réservation', async () => {
    const { deps } = makeDependencies();

    await Promise.all([
      processConfirmationSmsJob(makeJob(), deps),
      processConfirmationSmsJob(makeJob(), deps),
    ]);

    expect(sendReminder).toHaveBeenCalledTimes(1);
    expect(deps.db.reservation.update).toHaveBeenCalledTimes(1);
  });

  it('vérifie l’état avant d’envoyer un rappel', async () => {
    const { deps } = makeDependencies({ ...reservation, status: 'CANCELLED', state: 'CANCELLED' });

    await processConfirmationSmsJob(makeJob(), deps);

    expect(sendReminder).not.toHaveBeenCalled();
    expect(deps.db.reservation.update).not.toHaveBeenCalled();
  });

  it('ne prend pas de claim et n’envoie pas pour PENDING projeté CONFIRMED', async () => {
    const { deps, set } = makeDependencies({ ...reservation, state: 'PENDING' });

    await processConfirmationSmsJob(makeJob(), deps);

    expect(sendReminder).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(deps.db.reservation.update).not.toHaveBeenCalled();
  });

  it('ignore aussi PENDING découvert par le scan sans claim ni provider', async () => {
    const pendingReservation = { ...reservation, state: 'PENDING' };
    const { db, deps, set } = makeDependencies(pendingReservation);
    vi.mocked(db.reservation.findMany).mockResolvedValue([pendingReservation] as never);
    vi.mocked(db.reservation.findUnique).mockResolvedValue(pendingReservation as never);

    await processConfirmationSmsJob(
      {
        id: 'job-reminder-scan-1',
        name: 'scan-reminders',
        data: { kind: 'scan' },
      } as unknown as Job<ConfirmationSmsJobData>,
      deps,
    );

    expect(sendReminder).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(db.reservation.update).not.toHaveBeenCalled();
  });

  it('propage un refus certain à BullMQ et réouvre la notification au retry', async () => {
    const { deps, claims } = makeDependencies();
    const failure: SendResult = { channel: 'sms', success: false, error: 'provider unavailable' };
    vi.mocked(sendReminder)
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ channel: 'sms', success: true });

    await expect(processConfirmationSmsJob(makeJob(), deps)).rejects.toThrow(
      'provider refused the notification',
    );
    expect(claims.size).toBe(0);

    await processConfirmationSmsJob(makeJob(), deps);

    expect(sendReminder).toHaveBeenCalledTimes(2);
    expect(deps.db.reservation.update).toHaveBeenCalledTimes(1);
  });

  it('respecte le marqueur d’envoi déjà présent', async () => {
    const { deps } = makeDependencies({
      ...reservation,
      confirmationSentAt: new Date('2026-07-01T17:00:00.000Z'),
    });

    await processConfirmationSmsJob(makeJob(), deps);

    expect(sendReminder).not.toHaveBeenCalled();
  });

  it('conserve la claim et bloque le retry après un résultat unknown', async () => {
    const { deps, claims } = makeDependencies();
    const { queue, jobIds } = makeReconciliationQueue();
    deps.reconciliationQueue = queue;
    vi.mocked(sendReminder).mockResolvedValue({
      channel: 'sms',
      success: false,
      outcome: 'unknown',
      provider: 'telnyx',
    });

    await processConfirmationSmsJob(makeJob(), deps);
    await processConfirmationSmsJob(makeJob(), deps);

    expect(sendReminder).toHaveBeenCalledTimes(1);
    expect(deps.db.reservation.update).not.toHaveBeenCalled();
    expect(claims.size).toBe(1);
    expect(jobIds.size).toBe(1);
  });

  it('délègue les claims de canal au sender dans le mode de production', async () => {
    const { deps, claims } = makeDependencies();
    deps.manageReminderClaims = true;

    await processConfirmationSmsJob(makeJob(), deps);

    expect(sendReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: reservation.id,
        whatsappOptIn: true,
        reservationChannel: 'WEB',
      }),
      expect.objectContaining({ claimStore: deps.claimStore }),
    );
    expect(claims.size).toBe(0);
  });

  it.each([true, false, 'true', null])(
    'lit strictement le consentement de la réservation (%s)',
    async (value) => {
      const { deps } = makeDependencies({
        ...reservation,
        consents: { transactionalWhatsapp: value },
      });
      deps.manageReminderClaims = true;
      await processConfirmationSmsJob(makeJob(), deps);
      if (value === true) {
        expect(sendReminder).toHaveBeenCalledWith(
          expect.objectContaining({ whatsappOptIn: true }),
          expect.any(Object),
        );
      } else {
        expect(sendReminder).not.toHaveBeenCalled();
        expect(deps.db.reservation.update).not.toHaveBeenCalled();
      }
    },
  );

  it('n’envoie aucun rappel téléphonique même si un accord est présent', async () => {
    const { deps } = makeDependencies({ ...reservation, channel: 'PHONE' });
    await processConfirmationSmsJob(makeJob(), deps);
    expect(sendReminder).not.toHaveBeenCalled();
    expect(deps.db.reservation.update).not.toHaveBeenCalled();
  });

  it('ne marque pas comme envoyé un rappel ignoré', async () => {
    const { deps } = makeDependencies();
    deps.manageReminderClaims = true;
    vi.mocked(sendReminder).mockResolvedValue({
      channel: 'whatsapp',
      success: false,
      skipped: 'whatsapp_unavailable',
    });
    await processConfirmationSmsJob(makeJob(), deps);
    expect(deps.db.reservation.update).not.toHaveBeenCalled();
  });
});
