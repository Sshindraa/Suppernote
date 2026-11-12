import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExperienceReservationStatus,
  ExperienceSessionStatus,
  ExperienceStatus,
} from '@prisma/client';
import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';

const AUTH = { authorization: 'Bearer test' };
const NOW = new Date('2026-09-14T10:00:00.000Z');

function experienceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'experience-1',
    restaurantId: 'test-rest-1',
    key: 'wine-tasting',
    name: 'Dégustation de vins',
    description: 'Une séance guidée.',
    durationMinutes: 90,
    priceCents: 4500,
    currency: 'EUR',
    capacity: 12,
    status: ExperienceStatus.ACTIVE,
    createdAt: NOW,
    updatedAt: NOW,
    _count: { sessions: 1, reservations: 0 },
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    restaurantId: 'test-rest-1',
    experienceId: 'experience-1',
    startsAt: new Date('2026-09-20T18:00:00.000Z'),
    endsAt: new Date('2026-09-20T19:30:00.000Z'),
    capacityOverride: null,
    status: ExperienceSessionStatus.OPEN,
    createdAt: NOW,
    updatedAt: NOW,
    experience: {
      key: 'wine-tasting',
      name: 'Dégustation de vins',
      priceCents: 4500,
      currency: 'EUR',
      capacity: 12,
      status: ExperienceStatus.ACTIVE,
    },
    _count: { reservations: 0 },
    ...overrides,
  };
}

function reservationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'experience-reservation-1',
    restaurantId: 'test-rest-1',
    experienceId: 'experience-1',
    sessionId: 'session-1',
    customerId: null,
    reservationId: null,
    idempotencyKey: 'a'.repeat(64),
    quantity: 2,
    unitPriceCents: 4500,
    totalPriceCents: 9000,
    currency: 'EUR',
    status: ExperienceReservationStatus.CONFIRMED,
    createdByHash: 'a'.repeat(64),
    cancelledByHash: null,
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    experience: {
      key: 'wine-tasting',
      name: 'Dégustation de vins',
      priceCents: 4500,
      currency: 'EUR',
    },
    session: {
      startsAt: new Date('2026-09-20T18:00:00.000Z'),
      endsAt: new Date('2026-09-20T19:30:00.000Z'),
    },
    customer: null,
    ...overrides,
  };
}

describe('experience routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(NOW);
    vi.stubEnv('EXPERIENCES_ENABLED', 'false');
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      plan: 'PRO',
      siteStatus: 'ACTIVE',
    } as never);
    vi.mocked(db.restaurant.findFirst).mockResolvedValue({ id: 'test-rest-1' } as never);
    vi.mocked(db.experienceCheckout.findMany).mockResolvedValue([] as never);
  });

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await closeApp();
  });

  it('keeps the local experiences foundation disabled during the freeze', async () => {
    const app = await getApp();
    const response = await app.inject({ method: 'GET', url: '/experiences', headers: AUTH });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'EXPERIENCES_DISABLED' });
    expect(db.experience.findMany).not.toHaveBeenCalled();
  });

  it('resolves the canonical experience URL while the stored slug is legacy', async () => {
    vi.stubEnv('EXPERIENCES_ENABLED', 'true');
    vi.stubEnv('EXPERIENCE_BOOKING_ENABLED', 'true');
    const findUnique = vi.mocked(db.restaurant.findUnique);
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'demo-rest-1',
      slug: 'chez-sokar-demo',
      publishedAt: NOW,
      exposureSettings: { connectPublished: true },
    } as never);
    vi.mocked(db.experience.findMany).mockResolvedValue([] as never);

    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/public/r/chez-suppernote-demo/experiences',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { experiences: [] } });
    expect(findUnique).toHaveBeenNthCalledWith(1, {
      where: { slug: 'chez-suppernote-demo' },
      select: expect.anything(),
    });
    expect(findUnique).toHaveBeenNthCalledWith(2, {
      where: { slug: 'chez-sokar-demo' },
      select: expect.anything(),
    });
  });

  it('enforces the Pro entitlement before the runtime flag', async () => {
    vi.stubEnv('EXPERIENCES_ENABLED', 'true');
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      plan: 'ESSENTIAL',
      siteStatus: 'ACTIVE',
    } as never);
    const app = await getApp();
    const response = await app.inject({ method: 'GET', url: '/experiences', headers: AUTH });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: 'CAPABILITY_NOT_INCLUDED',
      capability: 'experiences.manage',
    });
  });

  it('creates a catalogue entry for an enabled Pro restaurant', async () => {
    vi.stubEnv('EXPERIENCES_ENABLED', 'true');
    vi.mocked(db.experience.create).mockResolvedValue(experienceRow() as never);
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/experiences',
      headers: AUTH,
      payload: {
        key: 'wine-tasting',
        name: 'Dégustation de vins',
        durationMinutes: 90,
        priceCents: 4500,
        capacity: 12,
        status: 'ACTIVE',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      id: 'experience-1',
      status: ExperienceStatus.ACTIVE,
    });
  });

  it('lets staff reserve a future session while keeping catalogue mutations for managers', async () => {
    vi.stubEnv('EXPERIENCES_ENABLED', 'true');
    const app = await getApp();
    vi.mocked(db.experience.create).mockResolvedValue(experienceRow() as never);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/experiences',
      headers: { ...AUTH, 'x-test-site-role': 'STAFF' },
      payload: {
        key: 'wine-tasting',
        name: 'Dégustation de vins',
        durationMinutes: 90,
        priceCents: 4500,
        capacity: 12,
      },
    });
    expect(createResponse.statusCode).toBe(403);

    vi.mocked(db.experienceReservation.findUnique).mockResolvedValue(null);
    vi.mocked(db.experienceSession.findFirst).mockResolvedValue(sessionRow() as never);
    vi.mocked(db.experienceReservation.findMany).mockResolvedValue([] as never);
    vi.mocked(db.experienceReservation.create).mockResolvedValue(reservationRow() as never);
    const reserveResponse = await app.inject({
      method: 'POST',
      url: '/experiences/experience-1/sessions/session-1/reservations',
      headers: { ...AUTH, 'x-test-site-role': 'STAFF', 'idempotency-key': 'booking-0001' },
      payload: { quantity: 2 },
    });
    expect(reserveResponse.statusCode).toBe(201);
    expect(reserveResponse.json().data).toMatchObject({ totalPriceCents: 9000, replayed: false });
  });

  it('returns 200 on an idempotent reservation replay', async () => {
    vi.stubEnv('EXPERIENCES_ENABLED', 'true');
    vi.mocked(db.experienceReservation.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(reservationRow() as never);
    vi.mocked(db.experienceSession.findFirst).mockResolvedValue(sessionRow() as never);
    vi.mocked(db.experienceReservation.findMany).mockResolvedValue([] as never);
    vi.mocked(db.experienceReservation.create).mockResolvedValue(reservationRow() as never);
    const app = await getApp();
    const first = await app.inject({
      method: 'POST',
      url: '/experiences/experience-1/sessions/session-1/reservations',
      headers: { ...AUTH, 'idempotency-key': 'booking-0001' },
      payload: { quantity: 2 },
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/experiences/experience-1/sessions/session-1/reservations',
      headers: { ...AUTH, 'idempotency-key': 'booking-0001' },
      payload: { quantity: 2 },
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toMatchObject({ replayed: true });
  });

  it('rejects malformed quantities with a 400 validation response', async () => {
    vi.stubEnv('EXPERIENCES_ENABLED', 'true');
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/experiences/experience-1/sessions/session-1/reservations',
      headers: AUTH,
      payload: { quantity: 0 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Validation Error' });
  });
  it('protects deletion with the runtime flag and manager role', async () => {
    const app = await getApp();
    const disabled = await app.inject({
      method: 'DELETE',
      url: '/experiences/experience-1',
      headers: AUTH,
    });
    expect(disabled.statusCode).toBe(503);
    vi.stubEnv('EXPERIENCES_ENABLED', 'true');
    const staff = await app.inject({
      method: 'DELETE',
      url: '/experiences/experience-1',
      headers: { ...AUTH, 'x-test-site-role': 'STAFF' },
    });
    expect(staff.statusCode).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('returns an empty success response after a permitted deletion', async () => {
    vi.stubEnv('EXPERIENCES_ENABLED', 'true');
    vi.mocked(db.$transaction).mockResolvedValue(undefined as never);
    const app = await getApp();
    const response = await app.inject({
      method: 'DELETE',
      url: '/experiences/experience-1',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(db.$transaction).toHaveBeenCalled();
  });
});
