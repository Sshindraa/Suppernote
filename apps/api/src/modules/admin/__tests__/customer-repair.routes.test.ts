import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  operator: true,
  preview: vi.fn(),
  repair: vi.fn(),
}));

vi.mock('../../../plugins/clerk', () => ({
  requirePlatformOperator:
    () =>
    async (
      req: { userId?: string },
      reply: { status: (code: number) => { send: (body: unknown) => unknown } },
    ) => {
      if (!mocks.operator)
        return reply.status(403).send({ error: 'Suppernote operator access required' });
      req.userId = 'user-operator';
    },
}));
vi.mock('../../customers/customer-crm.service', () => ({
  previewCustomerMetricSnapshotRepair: mocks.preview,
  repairCustomerMetricSnapshot: mocks.repair,
}));
vi.mock('../../customers/customer-crm.routes', () => ({
  projectionRepairErrorResponse: () => null,
}));

import { adminCustomerRepairRoutes } from '../customer-repair.routes';

async function buildApp() {
  const app = Fastify();
  await app.register(adminCustomerRepairRoutes);
  return app;
}

const base = '/admin/restaurants/rest-1/customers/cust-1';

describe('admin customer projection repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operator = true;
  });

  it('refuse un utilisateur qui n’est pas opérateur Suppernote', async () => {
    mocks.operator = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${base}/projection-repair-preview` });
    expect(res.statusCode).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it('prévisualise sur le restaurant et le client de l’URL', async () => {
    mocks.preview.mockResolvedValue({ changed: true, reservationCount: 2 });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${base}/projection-repair-preview` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { changed: true, reservationCount: 2 } });
    expect(mocks.preview).toHaveBeenCalledWith({ restaurantId: 'rest-1', customerId: 'cust-1' });
  });

  it('recalcule avec la clé d’idempotence et trace l’opérateur', async () => {
    mocks.repair.mockResolvedValue({ changed: false, replayed: false });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${base}/projection-repair`,
      headers: { 'idempotency-key': 'key-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(mocks.repair).toHaveBeenCalledWith({
      restaurantId: 'rest-1',
      customerId: 'cust-1',
      idempotencyKey: 'key-1',
      actor: 'operator:user-operator',
    });
  });
});
