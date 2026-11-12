/**
 * Créneaux passés sur Connect (page et widget embarqué) : `GET /public/r/:slug/availability` renvoie
 * le DTO du moteur tel quel, donc ne propose plus les horaires déjà commencés. Le moteur est le vrai,
 * seule la base est en doublure. Jeudi 2 juillet 2026, 15:00 à Paris.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { redisCache } from '../../../shared/redis/client';

const SLUG = 'chez-suppernote-demo';
const RESTAURANT_ID = 'ba5be41b-eb72-4e05-bb9c-b576e39e33ba';
const NOW = new Date('2026-07-02T13:00:00.000Z'); // 15:00 à Paris

const restaurant = {
  id: RESTAURANT_ID,
  slug: SLUG,
  name: 'Chez Suppernote',
  description: 'Bistrot français à Lyon',
  formattedAddress: '12 Rue de la République, 69001 Lyon',
  city: 'Lyon',
  country: 'FR',
  postalCode: '69001',
  phoneNumber: '+334****0000',
  phoneE164: '+334****0000',
  cuisineType: ['Bistrot'],
  priceRange: 2,
  openingHours: {
    thu: { open: '12:00', close: '22:30' },
    fri: { open: '12:00', close: '22:30' },
  },
  ambiance: [],
  dietary: [],
  noiseLevel: null,
  agenticOptIn: true,
  publishedAt: new Date('2026-06-24'),
  timezone: 'Europe/Paris',
  exposureSettings: { connectPublished: true, connectAgentic: false, capacitySpecials: {} },
  images: [],
  lat: null,
  lng: null,
  googleRating: null,
  googleReviewCount: null,
};

describe('Connect — GET /public/r/:slug/availability : créneaux passés', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await redisCache.flushall();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue(
      restaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>,
    );
    vi.mocked(db.reservation.findMany).mockResolvedValue([]);
    vi.mocked(db.agenticHold.findMany).mockResolvedValue([]);
    vi.mocked(db.table.findMany).mockResolvedValue([
      { id: 't-1', capacity: 4, minCapacity: 1, sectionId: null },
    ] as unknown as Awaited<ReturnType<typeof db.table.findMany>>);
    // Sans réglages, la route applique le délai par défaut (30 min) : chaque test règle le sien.
    vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(null);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await closeApp();
  });

  const call = async (date: string) => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/public/r/${SLUG}/availability?date=${date}&partySize=2`,
    });
    return res.json() as {
      restaurantId: string;
      date: string;
      partySize: number;
      slots: Array<{ time: string; available: boolean }>;
    };
  };
  const slot = (body: Awaited<ReturnType<typeof call>>, time: string) =>
    body.slots.find((candidate) => candidate.time === time);

  it('marque indisponibles les horaires déjà passés aujourd’hui, sans en retirer du tableau', async () => {
    const today = await call('2026-07-02');

    expect(Object.keys(today).sort()).toEqual(['date', 'partySize', 'restaurantId', 'slots']);
    expect(slot(today, '12:00')).toEqual({ time: '12:00', available: false });
    expect(slot(today, '15:00')?.available).toBe(false);
    expect(slot(today, '15:30')?.available).toBe(true);
    expect(slot(today, '19:00')?.available).toBe(true);
    // Ce que la page de Connect affiche (« Disponibilités aujourd'hui ») : les 4 premiers libres.
    const preview = today.slots.filter((candidate) => candidate.available).slice(0, 4);
    expect(preview.map((candidate) => candidate.time)).toEqual([
      '15:30',
      '16:00',
      '16:30',
      '17:00',
    ]);
  });

  it('ne change rien demain', async () => {
    const tomorrow = await call('2026-07-03');

    expect(slot(tomorrow, '12:00')?.available).toBe(true);
    expect(slot(tomorrow, '15:00')?.available).toBe(true);
    expect(tomorrow.slots.every((candidate) => candidate.available)).toBe(true);
  });

  describe('délai minimum du restaurant (surface en ligne)', () => {
    const withLead = (minLeadTimeMinutes: number) =>
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue({
        minLeadTimeMinutes,
      } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findUnique>>);

    it('avec 2 h à 15:00 : rien avant 17:00, et 17:00 (maintenant + 2 h pile) est proposé', async () => {
      withLead(120);

      const today = await call('2026-07-02');

      expect(slot(today, '15:30')?.available).toBe(false);
      expect(slot(today, '16:30')?.available).toBe(false);
      expect(slot(today, '17:00')?.available).toBe(true);
      const preview = today.slots.filter((candidate) => candidate.available).slice(0, 4);
      expect(preview.map((candidate) => candidate.time)).toEqual([
        '17:00',
        '17:30',
        '18:00',
        '18:30',
      ]);
    });

    it('lit le délai du restaurant : 30 min proposent 15:30, 2 h ne le proposent pas', async () => {
      withLead(30);
      expect(slot(await call('2026-07-02'), '15:30')?.available).toBe(true);

      await redisCache.flushall();
      withLead(120);
      expect(slot(await call('2026-07-02'), '15:30')?.available).toBe(false);
    });

    it('un délai de 0 réglé par le restaurant ne laisse passer que le passé', async () => {
      withLead(0);

      const today = await call('2026-07-02');

      expect(slot(today, '15:00')?.available).toBe(false);
      expect(slot(today, '15:30')?.available).toBe(true);
    });

    it('ne change rien demain (au-delà du délai)', async () => {
      withLead(120);

      const tomorrow = await call('2026-07-03');

      expect(tomorrow.slots.every((candidate) => candidate.available)).toBe(true);
    });

    it('garde la forme de la réponse', async () => {
      withLead(120);

      const today = await call('2026-07-02');

      expect(Object.keys(today).sort()).toEqual(['date', 'partySize', 'restaurantId', 'slots']);
      expect(slot(today, '12:00')).toEqual({ time: '12:00', available: false });
    });
  });
});
