/**
 * Tests unitaires pour emitConnectEvent (T9).
 *
 * Vérifie :
 * - L'event est ajouté à la queue avec les bons champs
 * - reservation_confirmed a une priorité plus élevée
 * - Si la queue throw, emitConnectEvent ne throw pas (best-effort)
 * - Les champs optionnels sont gérés (source défaut 'web')
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Queue } from 'bullmq';
import { emitConnectEvent } from '../connect-analytics';
import type { ConnectAnalyticsJobData } from '../../../shared/queue/workers/connect-analytics.worker';

// Mock Queue — capture les appels .add()
function createMockQueue() {
  const calls: Array<{ name: string; data: ConnectAnalyticsJobData; opts: unknown }> = [];
  const queue = {
    add: vi.fn(async (name: string, data: ConnectAnalyticsJobData, opts?: unknown) => {
      calls.push({ name, data, opts });
    }),
    _calls: calls,
  };
  return queue;
}

function createFailingQueue() {
  return {
    add: vi.fn(async () => {
      throw new Error('Redis connection refused');
    }),
  };
}

describe('emitConnectEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ajoute l'event à la queue avec les bons champs", async () => {
    const queue = createMockQueue();
    const result = await emitConnectEvent(queue as unknown as Queue<ConnectAnalyticsJobData>, {
      event: 'restaurant_page_view',
      restaurantId: 'rest-1',
      restaurantSlug: 'chez-suppernote-demo',
      city: 'Lyon',
      source: 'google',
    });
    expect(result).toBe(true);
    expect(queue.add).toHaveBeenCalledOnce();
    expect(queue._calls[0].name).toBe('connect-event');
    expect(queue._calls[0].data.event).toBe('restaurant_page_view');
    expect(queue._calls[0].data.restaurantId).toBe('rest-1');
    expect(queue._calls[0].data.source).toBe('google');
    expect(queue._calls[0].data.sentAt).toBeDefined();
  });

  it('source par défaut = "web" si non fournie', async () => {
    const queue = createMockQueue();
    await emitConnectEvent(queue as unknown as Queue<ConnectAnalyticsJobData>, {
      event: 'booking_page_view',
      restaurantId: 'rest-1',
    });
    expect(queue._calls[0].data.source).toBe('web');
  });

  it('reservation_confirmed a une priorité plus élevée (1 vs 5)', async () => {
    const queue = createMockQueue();
    await emitConnectEvent(queue as unknown as Queue<ConnectAnalyticsJobData>, {
      event: 'restaurant_page_view',
    });
    await emitConnectEvent(queue as unknown as Queue<ConnectAnalyticsJobData>, {
      event: 'reservation_confirmed',
    });
    expect(queue._calls[0].opts).toEqual({ priority: 5 });
    expect(queue._calls[1].opts).toEqual({ priority: 1 });
  });

  it('ne throw pas si la queue est down (best-effort)', async () => {
    const queue = createFailingQueue();
    const result = await emitConnectEvent(queue as unknown as Queue<ConnectAnalyticsJobData>, {
      event: 'reservation_confirmed',
      restaurantId: 'rest-1',
    });
    expect(result).toBe(false);
  });

  it('passe les champs spécifiques (date, time, partySize, reservationId)', async () => {
    const queue = createMockQueue();
    await emitConnectEvent(queue as unknown as Queue<ConnectAnalyticsJobData>, {
      event: 'reservation_confirmed',
      restaurantId: 'rest-1',
      restaurantSlug: 'chez-suppernote-demo',
      city: 'Lyon',
      source: 'chatgpt',
      date: '2026-07-02',
      time: '20:00',
      partySize: 4,
      reservationId: 'res-123',
    });
    const data = queue._calls[0].data;
    expect(data.date).toBe('2026-07-02');
    expect(data.time).toBe('20:00');
    expect(data.partySize).toBe(4);
    expect(data.reservationId).toBe('res-123');
  });
});
