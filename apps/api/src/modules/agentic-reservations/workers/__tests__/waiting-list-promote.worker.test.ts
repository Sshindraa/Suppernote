import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';

vi.mock('../../../../shared/redis/client', () => ({
  redisQueue: {
    url: 'redis://localhost:6379',
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock('../../../../shared/telnyx/client', () => ({
  sendSms: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../shared/email', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../shared/queue/workers/helper', () => ({
  setupWorkerListeners: vi.fn(),
  jobLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { sendSms } from '../../../../shared/telnyx/client';
import { sendEmail } from '../../../../shared/email';
import {
  processWaitingListPromoteJob,
  type WaitingListPromoteJobData,
} from '../waiting-list-promote.worker';
import type { NotificationClaimStore } from '../../../../shared/queue/notification-idempotency';

const slotStart = new Date('2026-01-14T19:30:00.000Z');

const baseEntry = {
  id: 'wl-1',
  status: 'PROMOTED',
  promotedReservationId: 'res-1',
  customerPhone: '+33612345678',
  customerEmail: 'alice@example.com',
  partySize: 4,
  slotStart,
  restaurant: {
    id: 'rest-1',
    name: 'Chez Suppernote',
    phoneNumber: '+33123456789',
    phoneE164: '+33123456789',
  },
  promotedReservation: { id: 'res-1', status: 'CONFIRMED', state: 'CONFIRMED' },
};

function makeEntry(overrides: Record<string, unknown> = {}) {
  return { ...baseEntry, ...overrides };
}

function makeDb(entry: unknown) {
  return {
    waitingListEntry: {
      findUnique: vi.fn().mockResolvedValue(entry),
    },
  } as unknown as PrismaClient;
}

const fakeFormatDate = vi.fn(
  (
    _date: string | Date | null | undefined,
    _locale?: string,
    options?: Intl.DateTimeFormatOptions,
  ) => {
    if (options && 'hour' in options) return '19:30';
    return 'mercredi 14 janvier 2026';
  },
);

function makeJob(channel: 'sms' | 'email'): Job<WaitingListPromoteJobData> {
  return {
    id: 'job-1',
    name: 'notify',
    data: { entryId: 'wl-1', reservationId: 'res-1', channel },
  } as unknown as Job<WaitingListPromoteJobData>;
}

function makeClaimStore() {
  const claims = new Map<string, string>();
  const set = vi.fn(
    async (
      key: string,
      value = 'claimed',
      _expirationMode?: 'EX',
      _expirationSeconds?: number,
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
  const store: NotificationClaimStore = { set, get, del, eval: evalScript };
  return { claims, store, set, get, del, evalScript };
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

describe('waiting-list-promote.worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESEND_API_KEY', 're_test');
  });

  it('envoie un SMS avec les bonnes informations', async () => {
    const entry = makeEntry();
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('sms'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendSms).toHaveBeenCalledTimes(1);
    const [to, text] = vi.mocked(sendSms).mock.calls[0] as [string, string];
    expect(to).toBe('+33612345678');
    expect(text).toContain('Bonne nouvelle !');
    expect(text).toContain('Chez Suppernote');
    expect(text).toContain('mercredi 14 janvier 2026');
    expect(text).toContain('19:30');
    expect(text).toContain('4 personnes');
    expect(text).toContain('+33123456789');
  });

  it('envoie un email avec le bon sujet et le bon contenu', async () => {
    const entry = makeEntry();
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('email'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [opts] = vi.mocked(sendEmail).mock.calls[0] as [
      { to: string; subject: string; html: string },
    ];
    expect(opts.to).toBe('alice@example.com');
    expect(opts.subject).toBe('Votre table chez Chez Suppernote est confirmée');
    expect(opts.html).toContain('Bonne nouvelle !');
    expect(opts.html).toContain('Chez Suppernote');
    expect(opts.html).toContain('mercredi 14 janvier 2026');
    expect(opts.html).toContain('19:30');
    expect(opts.html).toContain('4 personnes');
    expect(opts.html).toContain('+33123456789');
    expect(opts.html).toContain(
      'Pour modifier ou annuler votre réservation, appelez le restaurant au',
    );
  });

  it('ignore le SMS si le numéro client est absent', async () => {
    const entry = makeEntry({ customerPhone: '' });
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('sms'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendSms).not.toHaveBeenCalled();
  });

  it("ignore l'email si l'email client est absent", async () => {
    const entry = makeEntry({ customerEmail: null });
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('email'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("ignore le job si le statut de l'entrée n'est pas PROMOTED", async () => {
    const entry = makeEntry({ status: 'PENDING' });
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('sms'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendSms).not.toHaveBeenCalled();
  });

  it('ignore le job si promotedReservationId ne correspond pas', async () => {
    const entry = makeEntry({ promotedReservationId: 'res-other' });
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('sms'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendSms).not.toHaveBeenCalled();
  });

  it('propage un refus certain de sendSms pour le retry BullMQ', async () => {
    vi.mocked(sendSms).mockRejectedValueOnce(
      Object.assign(new Error('Telnyx API error'), { statusCode: 400 }),
    );
    const entry = makeEntry();
    const db = makeDb(entry);

    await expect(
      processWaitingListPromoteJob(makeJob('sms'), {
        db,
        sendSms,
        sendEmail,
        formatDate: fakeFormatDate,
      }),
    ).rejects.toThrow('Telnyx API error');
  });

  it("utilise formatDate pour formater la date et l'heure", async () => {
    const entry = makeEntry();
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('sms'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(fakeFormatDate).toHaveBeenCalledWith(
      slotStart,
      'fr-FR',
      expect.objectContaining({ weekday: 'long', day: 'numeric', month: 'long' }),
    );
    expect(fakeFormatDate).toHaveBeenCalledWith(
      slotStart,
      'fr-FR',
      expect.objectContaining({ hour: '2-digit', minute: '2-digit' }),
    );
  });

  it('ne notifie pas si le restaurant est manquant', async () => {
    const entry = makeEntry({ restaurant: null });
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('sms'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendSms).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('ne notifie pas si la réservation promue est manquante', async () => {
    const entry = makeEntry({ promotedReservation: null, promotedReservationId: 'res-1' });
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('sms'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendSms).not.toHaveBeenCalled();
  });

  it('ignore une notification si la réservation promue est devenue terminale', async () => {
    const entry = makeEntry({
      promotedReservation: { id: 'res-1', status: 'CANCELLED', state: 'CANCELLED' },
    });
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('sms'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendSms).not.toHaveBeenCalled();
  });

  it.each(['sms', 'email'] as const)(
    'ne prend pas de claim et ne notifie pas une promotion PENDING (%s)',
    async (channel) => {
      const entry = makeEntry({
        promotedReservation: { id: 'res-1', status: 'CONFIRMED', state: 'PENDING' },
      });
      const db = makeDb(entry);
      const { store, set } = makeClaimStore();

      await processWaitingListPromoteJob(makeJob(channel), {
        db,
        sendSms,
        sendEmail,
        formatDate: fakeFormatDate,
        claimStore: store,
      });

      expect(sendSms).not.toHaveBeenCalled();
      expect(sendEmail).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    },
  );

  it('déduplique deux jobs SMS pour la même entrée de waiting list', async () => {
    const entry = makeEntry();
    const db = makeDb(entry);
    const { store } = makeClaimStore();
    const deps = { db, sendSms, sendEmail, formatDate: fakeFormatDate, claimStore: store };

    await Promise.all([
      processWaitingListPromoteJob(makeJob('sms'), deps),
      processWaitingListPromoteJob(makeJob('sms'), deps),
    ]);

    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('conserve la claim et ne renvoie pas après un timeout SMS', async () => {
    const entry = makeEntry();
    const db = makeDb(entry);
    const { store, claims } = makeClaimStore();
    const { queue, jobIds } = makeReconciliationQueue();
    vi.mocked(sendSms).mockRejectedValue(new Error('Telnyx timeout'));
    const deps = {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
      claimStore: store,
      reconciliationQueue: queue,
    };

    await processWaitingListPromoteJob(makeJob('sms'), deps);
    await processWaitingListPromoteJob(makeJob('sms'), deps);

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(claims.size).toBe(1);
    expect(jobIds.size).toBe(1);
  });

  it("ignore l'email si RESEND_API_KEY n'est pas configuré", async () => {
    vi.stubEnv('RESEND_API_KEY', '');

    const entry = makeEntry();
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('email'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('ne notifie pas si le téléphone du restaurant est manquant', async () => {
    const entry = makeEntry({
      restaurant: { ...baseEntry.restaurant, phoneNumber: '', phoneE164: '' },
    });
    const db = makeDb(entry);

    await processWaitingListPromoteJob(makeJob('sms'), {
      db,
      sendSms,
      sendEmail,
      formatDate: fakeFormatDate,
    });

    expect(sendSms).not.toHaveBeenCalled();
  });
});
