import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { getApp, closeApp } from '../../../../test/helpers';

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  loadContextById: vi.fn(),
}));

vi.mock('../live-demo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../live-demo')>()),
  consumeLiveDemoTicket: mocks.consume,
  acquireLiveDemoSlot: mocks.acquire,
  releaseLiveDemoSlot: mocks.release,
}));
vi.mock('../../../restaurants/restaurant.service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../restaurants/restaurant.service')>();
  return {
    ...original,
    RestaurantService: { ...original.RestaurantService, loadContextById: mocks.loadContextById },
  };
});

const TICKET = 'ticket-ticket-ticket-1';

type Recorded = { messages: Array<Record<string, unknown>>; closeCode?: number };

/**
 * Vraie socket sur un vrai port : `injectWS` ne rend pas la main avec le harnais de test. Les
 * écouteurs sont posés avant l'ouverture, car le serveur parle dès la connexion.
 */
async function connect(): Promise<{ ws: WebSocket; recorded: Recorded }> {
  const app = await getApp();
  if (!app.server.listening) await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const recorded: Recorded = { messages: [] };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/demo-stream/${TICKET}`);
  ws.on('message', (data) => recorded.messages.push(JSON.parse(data.toString())));
  ws.on('close', (code) => {
    recorded.closeCode = code;
  });
  openSockets.push(ws);
  return { ws, recorded };
}

const openSockets: WebSocket[] = [];

describe('WebSocket /voice/demo-stream/:ticket (câblage Fastify)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquire.mockResolvedValue(true);
    mocks.release.mockResolvedValue(undefined);
    mocks.loadContextById.mockResolvedValue({
      id: 'rest-1',
      name: 'Chez Suppernote',
      phoneNumber: '',
      managerPhone: '',
      onlineReservationsActive: false,
      smsConfirmEnabled: false,
      timezone: 'Europe/Paris',
      openingHours: null,
      maxPartySize: 8,
      giftCardMinimumAmount: 10,
      personality: null,
    });
  });

  afterEach(() => {
    openSockets.splice(0).forEach((socket) => socket.terminate());
  });

  afterAll(async () => {
    await closeApp();
  });

  it('refuse un ticket invalide avec le code applicatif 4401, sans créer de session', async () => {
    mocks.consume.mockResolvedValue(null);
    const { recorded } = await connect();

    await vi.waitFor(() => expect(recorded.closeCode).toBe(4401));
    expect(recorded.messages).toContainEqual({ event: 'error', code: 'invalid_ticket' });
    expect(mocks.loadContextById).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
  });

  it('refuse avec 4409 quand une démonstration est déjà en cours', async () => {
    mocks.consume.mockResolvedValue('rest-1');
    mocks.acquire.mockResolvedValue(false);
    const { recorded } = await connect();

    await vi.waitFor(() => expect(recorded.closeCode).toBe(4409));
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('accepte un ticket valide : annonce ready, puis libère le créneau à la fermeture', async () => {
    mocks.consume.mockResolvedValue('rest-1');
    const { ws, recorded } = await connect();

    await vi.waitFor(() =>
      expect(recorded.messages[0]).toMatchObject({
        event: 'ready',
        codec: 'PCMA',
        sampleRate: 8000,
      }),
    );
    expect(mocks.loadContextById).toHaveBeenCalledWith('rest-1');

    ws.close();
    await vi.waitFor(() =>
      expect(mocks.release).toHaveBeenCalledWith(
        expect.anything(),
        'rest-1',
        expect.stringMatching(/^demo-/),
      ),
    );
  });
});
