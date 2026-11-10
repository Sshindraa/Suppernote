import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';

const AUTH = { authorization: 'Bearer test' };
let clientCount = 0;
function nextClientAddress(): string {
  clientCount += 1;
  return `10.2.0.${clientCount}`;
}

const OPENED = new Date('2026-12-31T19:15:00.000Z');

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    externalId: `T-${id}`,
    openedAt: OPENED,
    closedAt: null,
    tableReference: '12',
    total: { toFixed: () => '13.50' },
    currency: 'EUR',
    matches: [
      {
        status: 'MATCHED',
        confidence: { toNumber: () => 0.85 },
        reservation: {
          id: 'res-1',
          reservedAt: OPENED,
          startsAt: null,
          partySize: 2,
          table: { name: '12' },
        },
      },
    ],
    ...overrides,
  };
}

describe('GET /pos/checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('POS_CONNECTORS_ENABLED', 'true');
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'PRO' } as never);
    vi.mocked(db.posCheck.findMany).mockResolvedValue([] as never);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeApp();
  });

  it('reste coupé sans le drapeau d’exécution', async () => {
    vi.stubEnv('POS_CONNECTORS_ENABLED', 'false');
    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/pos/checks',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'POS_CONNECTORS_DISABLED' });
  });

  it('renvoie le ticket, son rapprochement et la réservation liée, sans nom de client', async () => {
    vi.mocked(db.posCheck.findMany).mockResolvedValue([row('c1')] as never);
    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/pos/checks',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.nextCursor).toBeNull();
    expect(body.data.items[0]).toEqual({
      id: 'c1',
      externalId: 'T-c1',
      openedAt: OPENED.toISOString(),
      closedAt: null,
      tableReference: '12',
      total: '13.50',
      currency: 'EUR',
      match: {
        status: 'MATCHED',
        confidence: 0.85,
        reservation: {
          id: 'res-1',
          at: OPENED.toISOString(),
          partySize: 2,
          table: '12',
        },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/customerName|customer_name/);
  });

  it('pagine avec un curseur, plus récents d’abord', async () => {
    vi.mocked(db.posCheck.findMany).mockResolvedValue([row('c1'), row('c2')] as never);
    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/pos/checks?limit=1',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
    });

    expect(response.json().data).toMatchObject({
      items: [expect.objectContaining({ id: 'c1' })],
      nextCursor: 'c1',
    });
    expect(vi.mocked(db.posCheck.findMany).mock.calls[0]?.[0]).toMatchObject({
      take: 2,
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      where: { restaurantId: 'test-rest-1' },
    });
  });

  it('refuse une limite hors bornes', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/pos/checks?limit=500',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('INVALID_POS_CHECK_QUERY');
  });
});
