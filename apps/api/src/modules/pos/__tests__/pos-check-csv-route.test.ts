import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';

const AUTH = { authorization: 'Bearer test' };
const HEADER = 'Numéro de ticket;Ouverture;Clôture;Table;Sous-total;TVA;Remise;Total;Couverts';
const ROW = 'T-1;31/12/2026 20:15;;12;12,50;2,08;0;13,50;2';

// The rate limit (5 per minute per client address) is shared by the whole app: one address per call.
let clientCount = 0;
function nextClientAddress(): string {
  clientCount += 1;
  return `10.1.0.${clientCount}`;
}

function csvPayload(csv: string, extra: Record<string, unknown> = {}) {
  return { csv, dryRun: true, ...extra };
}

describe('POST /pos/checks/csv-import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('POS_CONNECTORS_ENABLED', 'true');
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'PRO' } as never);
    vi.mocked(db.posConnection.findUnique).mockResolvedValue(null);
    vi.mocked(db.posConnection.create).mockResolvedValue({
      id: 'connection-file',
      provider: 'csv-file',
      externalLocationId: 'fichier',
      credentialReference: 'file:csv-import',
      status: 'PENDING',
      cursor: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastErrorCode: null,
    } as never);
    vi.mocked(db.posConnection.findFirst).mockResolvedValue({
      id: 'connection-file',
      status: 'PENDING',
    } as never);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeApp();
  });

  it('reste coupé sans le drapeau d’exécution', async () => {
    vi.stubEnv('POS_CONNECTORS_ENABLED', 'false');
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/pos/checks/csv-import',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
      payload: csvPayload(`${HEADER}\n${ROW}`),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'POS_CONNECTORS_DISABLED' });
  });

  it('applique le droit pos.connect avant d’importer', async () => {
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'STARTER' } as never);
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/pos/checks/csv-import',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
      payload: csvPayload(`${HEADER}\n${ROW}`),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('CAPABILITY_NOT_INCLUDED');
    expect(db.posConnection.create).not.toHaveBeenCalled();
  });

  it('vérifie sans rien écrire en dryRun et compte les lignes ignorées', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/pos/checks/csv-import',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
      payload: csvPayload(`${HEADER}\n${ROW}\nT-2;pas une date;;12;12,50;2,08;0;13,50;2`),
    });

    expect(response.statusCode).toBe(200);
    const { data } = response.json();
    expect(data.dryRun).toBe(true);
    expect(data.counts).toMatchObject({ imported: 1, skipped: 1, withReservation: 0, matched: 0 });
    expect(data.reasons).toEqual([
      { line: 3, reason: 'date d’ouverture invalide (attendu JJ/MM/AAAA HH:MM)' },
    ]);
    expect(data.preview[0]).toMatchObject({
      externalId: 'T-1',
      tableReference: '12',
      total: '13.50',
    });
    expect(db.posConnection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'csv-file',
          credentialReference: 'file:csv-import',
        }),
      }),
    );
    expect(db.reservationCheckMatch.upsert).not.toHaveBeenCalled();
  });

  it('signale une colonne obligatoire absente en aperçu, mais refuse l’import', async () => {
    const app = await getApp();
    const csv = 'Numéro de ticket;Ouverture;Total\nT-1;31/12/2026 20:15;13,50';
    const preview = await app.inject({
      method: 'POST',
      url: '/pos/checks/csv-import',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
      payload: csvPayload(csv),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.missing).toEqual(['subtotal', 'tax']);

    const imported = await app.inject({
      method: 'POST',
      url: '/pos/checks/csv-import',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
      payload: csvPayload(csv, { dryRun: false }),
    });
    expect(imported.statusCode).toBe(400);
    expect(imported.json()).toMatchObject({ error: 'INVALID_POS_CHECK_MAPPING' });
    // Only the preview created the file connection; the refused import wrote no ticket.
    expect(db.posConnection.create).toHaveBeenCalledTimes(1);
    expect(db.reservationCheckMatch.upsert).not.toHaveBeenCalled();
  });

  it('refuse plus de 2 000 tickets sans rien importer', async () => {
    const rows = Array.from(
      { length: 2001 },
      (_, index) => `T-${index};31/12/2026 20:15;;1;1,00;0,17;0;1,00;1`,
    );
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/pos/checks/csv-import',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
      payload: csvPayload([`Numéro de ticket;Ouverture;Sous-total;TVA;Total`, ...rows].join('\n')),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('POS_CHECK_IMPORT_TOO_LARGE');
    expect(db.posConnection.create).not.toHaveBeenCalled();
  });

  it('refuse un corps au-delà de 1 Mio (limite nginx)', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/pos/checks/csv-import',
      headers: AUTH,
      remoteAddress: nextClientAddress(),
      payload: csvPayload(`${HEADER}\n${'x'.repeat(1_100_000)}`),
    });

    expect(response.statusCode).toBe(413);
    expect(db.posConnection.create).not.toHaveBeenCalled();
  });
});
