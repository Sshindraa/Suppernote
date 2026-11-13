import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { __resetMetrics, renderMetrics } from '../metrics';
import { refreshVoiceReservationQualityMetrics } from '../voice-reservation-quality';

describe('voice reservation quality snapshot', () => {
  beforeEach(() => {
    __resetMetrics();
  });

  it('publie les comptes par champ depuis une seule requête SQL en lecture seule', async () => {
    const query = vi.fn().mockResolvedValue([
      {
        created_count: 6n,
        changed_date_count: 1n,
        changed_time_count: 2n,
        changed_party_size_count: 3n,
        cancelled_count: 1n,
      },
    ]);
    const client = { $queryRaw: query } as unknown as Pick<PrismaClient, '$queryRaw'>;
    const now = new Date('2026-09-24T12:00:00.000Z');

    await expect(refreshVoiceReservationQualityMetrics(client, now)).resolves.toEqual({
      created7d: 6,
      changedAfterCall7d: { date: 1, time: 2, party_size: 3 },
      cancelledAfterCall7d: 1,
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sqlArgument] = query.mock.calls[0] as unknown as [
      { sql?: string; strings?: readonly string[]; values?: unknown[] },
    ];
    const sql = sqlArgument.sql ?? sqlArgument.strings?.join(' ') ?? '';
    expect(sql).toContain("r.channel = 'PHONE'");
    expect(sql).toContain('r.call_id IS NOT NULL');
    expect(sql).toContain("INTERVAL '48 hours'");
    expect(sql).toContain("a.metadata -> 'changedFields' ? 'party_size'");
    expect(sql).toContain("'reservation_cancelled', 'reservation_deleted'");
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/i);
    expect(sqlArgument.values).toEqual([new Date('2026-09-17T12:00:00.000Z'), now, now]);

    const payload = await renderMetrics();
    expect(payload).toMatch(/suppernote_voice_reservations_created_7d 6/);
    expect(payload).toMatch(
      /suppernote_voice_reservations_changed_after_call_7d\{field="date"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_reservations_changed_after_call_7d\{field="time"\} 2/,
    );
    expect(payload).toMatch(
      /suppernote_voice_reservations_changed_after_call_7d\{field="party_size"\} 3/,
    );
    expect(payload).toMatch(/suppernote_voice_reservations_cancelled_after_call_7d 1/);
  });

  it('publie des zéros si aucune réservation vocale n’est dans la fenêtre', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const client = { $queryRaw: query } as unknown as Pick<PrismaClient, '$queryRaw'>;

    await refreshVoiceReservationQualityMetrics(client);

    const payload = await renderMetrics();
    expect(payload).toMatch(/suppernote_voice_reservations_created_7d 0/);
    expect(payload).toMatch(/suppernote_voice_reservations_cancelled_after_call_7d 0/);
  });
});
