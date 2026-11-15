import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CALLS_GRACE_MINUTES,
  CALLS_WINDOW_HOURS,
  CONFIRMATION_SMS_EXPECTED,
  CONFIRMATION_SMS_SENT_EVENT,
  SMS_GRACE_MINUTES,
  SMS_WINDOW_HOURS,
} from './system-checks';
import { logger } from '../logger/pino';

/**
 * Mesures métier des SLO (R0-5).
 *
 * Chaque mesure retourne un ratio dans [0, 1] ou `null` quand il n'y a rien à
 * mesurer : une fenêtre sans trafic n'est ni une réussite ni un échec. Les
 * prédicats reprennent exactement ceux des checks `system-health`, pour que
 * l'alerte et le SLO racontent la même histoire.
 */

export async function measureVoiceTranscriptCoverage(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<number | null> {
  const windowStart = new Date(now.getTime() - CALLS_WINDOW_HOURS * 3_600_000);
  const graceEnd = new Date(now.getTime() - CALLS_GRACE_MINUTES * 60_000);
  if (windowStart >= graceEnd) return null;

  const base: Prisma.CallWhereInput = {
    carrier: 'telnyx',
    createdAt: { gte: windowStart, lte: graceEnd },
  };

  const [total, failing] = await Promise.all([
    // tenant-scoping: global — SLO agrégé multi-établissements, pas une lecture tenant.
    db.call.count({ where: base }),
    db.call.count({ where: { ...base, OR: [{ transcript: null }, { outcome: null }] } }),
  ]);

  if (total === 0) return null;
  return (total - failing) / total;
}

export async function measureReservationConfirmationCoverage(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<number | null> {
  const windowStart = new Date(now.getTime() - SMS_WINDOW_HOURS * 3_600_000);
  const graceEnd = new Date(now.getTime() - SMS_GRACE_MINUTES * 60_000);
  if (windowStart >= graceEnd) return null;

  const base: Prisma.ReservationWhereInput = {
    createdAt: { gte: windowStart, lte: graceEnd },
    customerPhone: { not: null },
    ...CONFIRMATION_SMS_EXPECTED,
    state: 'CONFIRMED',
  };

  const [total, failing] = await Promise.all([
    // tenant-scoping: global — SLO agrégé multi-établissements, pas une lecture tenant.
    db.reservation.count({ where: base }),
    db.reservation.count({
      where: { ...base, auditLog: { none: { event: CONFIRMATION_SMS_SENT_EVENT } } },
    }),
  ]);

  if (total === 0) return null;
  return (total - failing) / total;
}

export interface SloBusinessInputs {
  readonly voiceTranscriptCoverage: number | null;
  readonly reservationConfirmationCoverage: number | null;
}

/**
 * Mesure les deux SLO métier. Une base indisponible ne doit pas casser le tick
 * d'évaluation : la mesure devient `null` (unknown) et l'erreur est loggée.
 */
export async function measureBusinessSloInputs(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<SloBusinessInputs> {
  const [voiceTranscriptCoverage, reservationConfirmationCoverage] = await Promise.all([
    measureVoiceTranscriptCoverage(db, now).catch((err) => {
      logger.warn({ err }, '[slo] voice transcript coverage measurement failed');
      return null;
    }),
    measureReservationConfirmationCoverage(db, now).catch((err) => {
      logger.warn({ err }, '[slo] reservation confirmation coverage measurement failed');
      return null;
    }),
  ]);

  return { voiceTranscriptCoverage, reservationConfirmationCoverage };
}
