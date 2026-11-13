import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// Mock les dépendances externes avant d'importer le worker.
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
  sendSms: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../helper', () => ({
  setupWorkerListeners: vi.fn(),
  jobLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../../queues', () => ({
  queues: {
    analytics: { add: vi.fn().mockResolvedValue(undefined) },
  },
}));

import { sendSms } from '../../../telnyx/client';
import { queues } from '../../queues';
import { processCallRecoveryJob } from '../call-recovery.worker';
import type { CallRecoveryJobData } from '../call-recovery.worker';
import type { NotificationClaimStore } from '../../notification-idempotency';

function makeJob(data: Partial<CallRecoveryJobData>) {
  return {
    data: {
      callId: 'call-1',
      restaurantId: 'rest-1',
      customerPhone: '+33612345678',
      customerName: null,
      restaurantName: 'Chez Suppernote',
      restaurantSlug: 'chez-sokar-demo',
      restaurantPhone: '+33123456789',
      reason: 'no_action_with_intent' as const,
      ...data,
    },
    id: 'job-1',
    name: 'send-recovery-sms',
  } as unknown as Job<CallRecoveryJobData>;
}

function makeClaimStore() {
  const claims = new Map<string, string>();
  const store: NotificationClaimStore = {
    async set(key, value, _expirationMode, _expirationSeconds, existenceMode) {
      if (existenceMode === 'NX' && claims.has(key)) return null;
      claims.set(key, value);
      return 'OK';
    },
    async get(key) {
      return claims.get(key) ?? null;
    },
    async del(key) {
      claims.delete(key);
      return 1;
    },
    async eval(_script, _numberOfKeys, key, token, nextValue) {
      const current = claims.get(key);
      if (!current || !current.includes(`\"token\":\"${token}\"`)) return 0;
      if (nextValue === '__DELETE__') claims.delete(key);
      else claims.set(key, nextValue);
      return 1;
    },
  };
  return { claims, store };
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

describe('call-recovery.worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SITE_URL = 'https://suppernote.com';
  });

  it('envoie un SMS avec le prénom du client quand customerName est fourni', async () => {
    await processCallRecoveryJob(makeJob({ customerName: 'Jean Dupont' }));

    expect(sendSms).toHaveBeenCalledTimes(1);
    const [to, text] = vi.mocked(sendSms).mock.calls[0] as [string, string];
    expect(to).toBe('+33612345678');
    expect(text).toContain('Bonjour Jean');
    expect(text).toContain('Chez Suppernote');
  });

  it('envoie un SMS générique quand customerName est null', async () => {
    await processCallRecoveryJob(makeJob({ customerName: null }));

    const [, text] = vi.mocked(sendSms).mock.calls[0] as [string, string];
    expect(text).toContain('Bonjour,');
    expect(text).not.toContain('Bonjour Jean');
  });

  it('inclut le lien de réservation Connect quand restaurantSlug est fourni', async () => {
    await processCallRecoveryJob(makeJob({ restaurantSlug: 'chez-sokar-demo' }));

    const [, text] = vi.mocked(sendSms).mock.calls[0] as [string, string];
    expect(text).toContain('https://suppernote.com/restaurant/chez-sokar-demo/book');
    expect(text).toContain('Réservez en ligne');
  });

  it('fallback sur numéro de téléphone quand restaurantSlug est null', async () => {
    await processCallRecoveryJob(
      makeJob({ restaurantSlug: null, restaurantPhone: '+33123456789' }),
    );

    const [, text] = vi.mocked(sendSms).mock.calls[0] as [string, string];
    expect(text).not.toContain('/restaurant/');
    expect(text).toContain('Appelez le +33123456789');
  });

  it('fallback générique quand ni slug ni téléphone ne sont disponibles', async () => {
    await processCallRecoveryJob(makeJob({ restaurantSlug: null, restaurantPhone: null }));

    const [, text] = vi.mocked(sendSms).mock.calls[0] as [string, string];
    expect(text).toContain('Rappelez-nous quand vous voulez');
    expect(text).not.toContain('Appelez le');
    expect(text).not.toContain('/restaurant/');
  });

  it('utilise SITE_URL personnalisé pour le lien booking', async () => {
    process.env.SITE_URL = 'https://staging.suppernote.com';
    await processCallRecoveryJob(makeJob({ restaurantSlug: 'chez-sokar-demo' }));

    const [, text] = vi.mocked(sendSms).mock.calls[0] as [string, string];
    expect(text).toContain('https://staging.suppernote.com/restaurant/chez-sokar-demo/book');
  });

  it('enregistre un event analytics call-recovery-sent', async () => {
    await processCallRecoveryJob(makeJob({}));

    expect(queues.analytics.add).toHaveBeenCalledWith(
      'call-recovery-sent',
      expect.objectContaining({
        restaurantId: 'rest-1',
        callId: 'call-1',
        reason: 'no_action_with_intent',
      }),
    );
  });

  it('ne plante pas si analytics échoue (best-effort)', async () => {
    vi.mocked(queues.analytics.add).mockRejectedValueOnce(new Error('Redis down'));
    await expect(processCallRecoveryJob(makeJob({}))).resolves.not.toThrow();
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('propage un refus certain si sendSms échoue (pour retry BullMQ)', async () => {
    vi.mocked(sendSms).mockRejectedValueOnce(
      Object.assign(new Error('Telnyx API error'), { statusCode: 400 }),
    );
    await expect(processCallRecoveryJob(makeJob({}))).rejects.toThrow('Telnyx API error');
  });

  it('déduplique deux jobs de récupération pour le même callId', async () => {
    const { store } = makeClaimStore();

    await Promise.all([
      processCallRecoveryJob(makeJob({}), store),
      processCallRecoveryJob(makeJob({}), store),
    ]);

    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('libère la claim après refus certain du provider', async () => {
    const { claims, store } = makeClaimStore();
    vi.mocked(sendSms).mockRejectedValueOnce(
      Object.assign(new Error('Telnyx API error'), { statusCode: 400 }),
    );

    await expect(processCallRecoveryJob(makeJob({}), store)).rejects.toThrow('Telnyx API error');
    expect(claims.size).toBe(0);
  });

  it('conserve la claim et ne renvoie pas après une erreur réseau ambiguë', async () => {
    const { claims, store } = makeClaimStore();
    const { queue, jobIds } = makeReconciliationQueue();
    vi.mocked(sendSms).mockRejectedValue(new Error('provider timeout'));
    const deps = { claimStore: store, sendSms, reconciliationQueue: queue };

    await processCallRecoveryJob(makeJob({}), deps);
    await processCallRecoveryJob(makeJob({}), deps);

    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(claims.size).toBe(1);
    expect(jobIds.size).toBe(1);
  });

  it('n’envoie rien quand une réservation a finalement été créée', async () => {
    const { claims, store } = makeClaimStore();
    const deps = {
      claimStore: store,
      sendSms,
      reservationLookup: vi.fn().mockResolvedValue(true),
    };

    await processCallRecoveryJob(makeJob({}), deps);

    expect(sendSms).not.toHaveBeenCalled();
    expect(claims.size).toBe(0);
  });

  it('continue la récupération quand la vérification de réservation échoue', async () => {
    const { claims, store } = makeClaimStore();
    const deps = {
      claimStore: store,
      sendSms,
      reservationLookup: vi.fn().mockRejectedValue(new Error('db down')),
    };

    await processCallRecoveryJob(makeJob({}), deps);

    // Un doute sur la réservation ne doit pas bloquer un rappel légitime :
    // le claim garantit toujours un seul envoi.
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(claims.size).toBe(1);
  });
});
