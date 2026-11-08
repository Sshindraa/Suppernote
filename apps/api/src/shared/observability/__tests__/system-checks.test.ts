import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectQueueStates,
  evaluateQueueStates,
  evaluateTelnyxWebhookHealth,
  evaluateCallsWithoutTranscript,
  findCallsWithoutTranscript,
  evaluateReservationsWithoutSms,
  findReservationsWithoutConfirmationSms,
  CONFIRMATION_SMS_SENT_EVENT,
  FAILED_JOBS_THRESHOLD,
  type QueueStateCounts,
} from '../system-checks';

// Les files BullMQ sont stubées : collectQueueStates est testé sans Redis.
const queueMocks = vi.hoisted(() => ({
  smsClient: { name: 'sms-client', getJobCounts: vi.fn() },
  deadLetter: { name: 'dead-letter', getJobCounts: vi.fn() },
}));

vi.mock('../../queue/queues', () => ({
  queues: queueMocks,
}));

const okCounts: QueueStateCounts = { waiting: 0, active: 1, delayed: 0, failed: 0, paused: 0 };

describe('collectQueueStates', () => {
  beforeEach(() => {
    queueMocks.smsClient.getJobCounts.mockReset();
    queueMocks.deadLetter.getJobCounts.mockReset();
  });

  it('retourne les compteurs par file, null si une file est inaccessible', async () => {
    queueMocks.smsClient.getJobCounts.mockResolvedValue({ waiting: 2, active: 1 });
    queueMocks.deadLetter.getJobCounts.mockRejectedValue(new Error('Redis down'));

    const states = await collectQueueStates();

    expect(states['sms-client']).toEqual({
      waiting: 2,
      active: 1,
      delayed: 0,
      failed: 0,
      paused: 0,
    });
    expect(states['dead-letter']).toBeNull();
  });
});

describe('evaluateQueueStates', () => {
  it('file inaccessible → critique queue_unreachable', () => {
    const findings = evaluateQueueStates({ 'sms-client': null });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'queue_unreachable',
      severity: 'critical',
      identifier: 'sms-client',
    });
  });

  it('failed ≥ seuil → critique failed_jobs', () => {
    const findings = evaluateQueueStates({
      'sms-client': { ...okCounts, failed: FAILED_JOBS_THRESHOLD },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'failed_jobs', severity: 'critical' });
  });

  it('dead-letter non vide → critique dead_letter_backlog', () => {
    const findings = evaluateQueueStates({
      'dead-letter': { ...okCounts, waiting: 2, active: 0 },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'dead_letter_backlog', severity: 'critical' });
  });

  it('backlog ≥ 100 → warning queue_backlog', () => {
    const findings = evaluateQueueStates({
      analytics: { ...okCounts, waiting: 80, delayed: 25 },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'queue_backlog', severity: 'warning' });
  });

  it('files saines → aucun finding', () => {
    expect(evaluateQueueStates({ 'sms-client': okCounts, 'dead-letter': okCounts })).toHaveLength(
      0,
    );
  });
});

describe('evaluateTelnyxWebhookHealth', () => {
  const health = (abnormal: boolean, expected: number | null) => ({
    window: { errors: 4, total: 9 },
    baseline: { errors: 2, total: 5000 },
    abnormal,
    expected,
  });

  it('fenêtre normale → pas d’alerte', () => {
    expect(evaluateTelnyxWebhookHealth(health(false, 0.01))).toBeNull();
  });

  it('fenêtre anormale → critique, avec le taux attendu dans le détail', () => {
    const finding = evaluateTelnyxWebhookHealth(health(true, 0.02));
    expect(finding).toMatchObject({ kind: 'telnyx_webhook_errors', severity: 'critical' });
    expect(finding?.summary).toContain('4 webhooks Telnyx en erreur sur 9');
    expect(finding?.detail).toContain('0.02 attendus');
  });

  it('sans historique fiable → le détail dit que la majorité échoue', () => {
    expect(evaluateTelnyxWebhookHealth(health(true, null))?.detail).toContain('la majorité échoue');
  });
});

describe('appels sans transcription', () => {
  it('evaluateCallsWithoutTranscript : 0 appel → null, 1 → warning, 3 → critical', () => {
    expect(evaluateCallsWithoutTranscript([])).toBeNull();

    const one = evaluateCallsWithoutTranscript([
      {
        callSid: 'c1',
        restaurantId: 'r1',
        createdAt: new Date(),
        hasTranscript: false,
        outcome: null,
      },
    ]);
    expect(one).toMatchObject({ kind: 'calls_without_transcript', severity: 'warning' });
    expect(one!.detail).toContain('c1');

    const three = evaluateCallsWithoutTranscript(
      Array.from({ length: 3 }, (_, i) => ({
        callSid: `c${i}`,
        restaurantId: 'r1',
        createdAt: new Date(),
        hasTranscript: true,
        outcome: null,
      })),
    );
    expect(three).toMatchObject({ severity: 'critical' });
  });

  it('findCallsWithoutTranscript interroge les appels telnyx sans transcript/outcome', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        callSid: 'c1',
        restaurantId: 'r1',
        createdAt: new Date(),
        transcript: null,
        outcome: 'INFO',
      },
    ]);
    const db = { call: { findMany } } as never;

    const result = await findCallsWithoutTranscript(db, new Date('2026-07-22T12:00:00Z'));

    const where = findMany.mock.calls[0][0].where;
    expect(where.carrier).toBe('telnyx');
    expect(where.OR).toEqual([{ transcript: null }, { outcome: null }]);
    // Fenêtre 24h et grâce de 15 min.
    expect(where.createdAt.gte.toISOString()).toBe('2026-07-21T12:00:00.000Z');
    expect(where.createdAt.lte.toISOString()).toBe('2026-07-22T11:45:00.000Z');
    expect(result).toEqual([
      {
        callSid: 'c1',
        restaurantId: 'r1',
        createdAt: expect.any(Date),
        hasTranscript: false,
        outcome: 'INFO',
      },
    ]);
  });
});

describe('réservations sans SMS de confirmation', () => {
  it('findReservationsWithoutConfirmationSms borne la fenêtre par le marqueur since', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { reservation: { findMany } } as never;
    const now = new Date('2026-07-22T12:00:00Z');
    const since = new Date('2026-07-22T08:00:00Z');

    await findReservationsWithoutConfirmationSms(db, since, now);

    const where = findMany.mock.calls[0][0].where;
    expect(where.createdAt.gte.toISOString()).toBe('2026-07-22T08:00:00.000Z');
    // Grâce de 30 min.
    expect(where.createdAt.lte.toISOString()).toBe('2026-07-22T11:30:00.000Z');
    expect(where.customerPhone).toEqual({ not: null });
    expect(where.restaurant).toEqual({ smsConfirmEnabled: true });
    expect(where.state).toBe('CONFIRMED');
    expect(where.auditLog).toEqual({ none: { event: CONFIRMATION_SMS_SENT_EVENT } });
  });

  it('marqueur since trop récent → aucune requête', async () => {
    const findMany = vi.fn();
    const db = { reservation: { findMany } } as never;
    const now = new Date('2026-07-22T12:00:00Z');

    const result = await findReservationsWithoutConfirmationSms(
      db,
      new Date('2026-07-22T11:59:00Z'),
      now,
    );

    expect(result).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('evaluateReservationsWithoutSms : vide → null, sinon warning avec échantillon', () => {
    expect(evaluateReservationsWithoutSms([])).toBeNull();

    const finding = evaluateReservationsWithoutSms([
      { id: 'resa-1', restaurantId: 'r1', customerName: 'Martin', createdAt: new Date() },
    ]);
    expect(finding).toMatchObject({ kind: 'reservations_without_sms', severity: 'warning' });
    expect(finding!.detail).toContain('resa-1');
  });
});
