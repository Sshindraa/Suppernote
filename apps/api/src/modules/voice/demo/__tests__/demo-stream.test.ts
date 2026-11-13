import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      set: vi.fn(async (key: string, value: string, ...args: Array<string | number>) => {
        if (args.includes('NX') && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
      getdel: vi.fn(async (key: string) => {
        const value = store.get(key) ?? null;
        store.delete(key);
        return value;
      }),
      eval: vi.fn(async (_s: string, _n: number, key: string, owner: string) => {
        if (store.get(key) === owner) store.delete(key);
        return 1;
      }),
    },
    create: vi.fn(),
    del: vi.fn(),
    handleTelnyxMessage: vi.fn(),
    closeStt: vi.fn(),
    loadContextById: vi.fn(),
  };
});

vi.mock('../../../../shared/redis/client', () => ({ redisCache: mocks.redis }));
vi.mock('../../stream/manager', () => ({
  CallSessionManager: { getInstance: () => ({ create: mocks.create, delete: mocks.del }) },
}));
vi.mock('../../stream/handler', () => ({ handleTelnyxMessage: mocks.handleTelnyxMessage }));
vi.mock('../../stream/stt-bridge', () => ({ closeStt: mocks.closeStt }));
vi.mock('../../../restaurants/restaurant.service', () => ({
  RestaurantService: { loadContextById: mocks.loadContextById },
}));
vi.mock('../../prompts', () => ({
  buildSystemPrompt: vi.fn(() => 'prompt'),
  agentVoiceGender: vi.fn(() => 'female'),
}));
vi.mock('../../../../shared/logger/pino', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return { logger: log };
});
vi.mock('../../../../shared/sentry/client', () => ({ captureException: vi.fn() }));

import { handleLiveDemoConnection, LIVE_DEMO_CLOSE } from '../demo-stream';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Array<Record<string, unknown>> = [];
  send = vi.fn((data: string) => {
    this.sent.push(JSON.parse(data));
  });
  close = vi.fn((code?: number) => {
    this.readyState = WebSocket.CLOSED;
    this.closeCode = code;
    this.emit('close');
  });
  closeCode: number | undefined;

  receive(message: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
}

const TICKET = 'ticket-ticket-ticket-1';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function connect(ticketRestaurant: string | null = 'rest-1') {
  if (ticketRestaurant) mocks.store.set(`live-demo:ticket:${TICKET}`, ticketRestaurant);
  const socket = new FakeSocket();
  handleLiveDemoConnection(socket as unknown as WebSocket, TICKET);
  return socket;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.clear();
  mocks.create.mockImplementation((opts: { callControlId: string }) => ({
    callControlId: opts.callControlId,
    from: 'demo-navigateur',
    to: '',
    createdAt: Date.now(),
    state: 'IDLE',
    ended: false,
    isSpeaking: false,
  }));
  mocks.loadContextById.mockResolvedValue({
    id: 'rest-1',
    name: 'Chez Suppernote',
    phoneNumber: '',
    managerPhone: '+33612345678',
    onlineReservationsActive: false,
    smsConfirmEnabled: true,
    timezone: 'Europe/Paris',
    openingHours: null,
    maxPartySize: 8,
    giftCardMinimumAmount: 10,
    personality: {
      fillerStyle: 'WARM',
      systemPromptExtra: null,
      speakingRate: '1.1',
      volume: '1',
      emotion: null,
      voiceIdCa: null,
      pronunciationDictId: null,
    },
  });
});

describe('handleLiveDemoConnection', () => {
  it('rejette un ticket inconnu ou déjà consommé', async () => {
    const socket = connect(null);
    await flush();

    expect(socket.closeCode).toBe(LIVE_DEMO_CLOSE.invalidTicket);
    expect(socket.sent).toContainEqual({ event: 'error', code: 'invalid_ticket' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('crée une session demo en PCMA, avec la personnalité du restaurant, et annonce ready', async () => {
    const socket = connect();
    await flush();

    expect(mocks.loadContextById).toHaveBeenCalledWith('rest-1');
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        restaurantId: 'rest-1',
        demo: true,
        codec: 'PCMA',
        telnyxWs: socket,
        personality: expect.objectContaining({ fillerStyle: 'WARM', speakingRate: 1.1 }),
      }),
    );
    expect(socket.sent[0]).toMatchObject({ event: 'ready', codec: 'PCMA', sampleRate: 8000 });
  });

  it('refuse une deuxième démonstration simultanée pour le même restaurant', async () => {
    connect();
    await flush();
    mocks.store.set(`live-demo:ticket:${TICKET}`, 'rest-1');
    const second = new FakeSocket();
    handleLiveDemoConnection(second as unknown as WebSocket, TICKET);
    await flush();

    expect(second.closeCode).toBe(LIVE_DEMO_CLOSE.busy);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('reconstruit le `start` côté serveur et ignore le contenu du navigateur', async () => {
    const socket = connect();
    await flush();

    socket.receive({
      event: 'start',
      start: { call_control_id: 'pirate', media_format: { encoding: 'L16' } },
    });

    const [msg, callId] = mocks.handleTelnyxMessage.mock.calls[0];
    expect(callId).toMatch(/^demo-/);
    expect(msg.start.call_control_id).toBe(callId);
    expect(msg.start.media_format.encoding).toBe('PCMA');
  });

  it('n’accepte l’audio qu’après le start, et seulement les trames raisonnables', async () => {
    const socket = connect();
    await flush();

    socket.receive({ event: 'media', media: { payload: 'AAAA' } });
    expect(mocks.handleTelnyxMessage).not.toHaveBeenCalled();

    socket.receive({ event: 'start' });
    socket.receive({ event: 'media', media: { payload: 'AAAA' } });
    socket.receive({ event: 'media', media: { payload: 'A'.repeat(20_000) } });
    socket.receive({ event: 'media' });

    const media = mocks.handleTelnyxMessage.mock.calls.filter(([m]) => m.event === 'media');
    expect(media).toHaveLength(1);
    expect(media[0][0].media.payload).toBe('AAAA');
  });

  it('relaie l’acquittement des marks au pipeline', async () => {
    const socket = connect();
    await flush();
    socket.receive({ event: 'start' });
    socket.receive({ event: 'mark', mark: { name: 'goodbye-1' } });

    expect(mocks.handleTelnyxMessage).toHaveBeenLastCalledWith(
      { event: 'mark', mark: { name: 'goodbye-1' } },
      expect.stringMatching(/^demo-/),
      socket,
      expect.anything(),
    );
  });

  it('prend en compte les messages reçus pendant l’initialisation', async () => {
    mocks.store.set(`live-demo:ticket:${TICKET}`, 'rest-1');
    const socket = new FakeSocket();
    handleLiveDemoConnection(socket as unknown as WebSocket, TICKET);
    socket.receive({ event: 'start' }); // avant la fin de la création de session
    await flush();

    expect(mocks.handleTelnyxMessage).toHaveBeenCalledTimes(1);
  });

  it('à la fermeture : coupe le STT, supprime la session et libère le créneau', async () => {
    const socket = connect();
    await flush();
    const session = mocks.create.mock.results[0].value;

    socket.emit('close');
    await flush();

    expect(session.ended).toBe(true);
    expect(mocks.closeStt).toHaveBeenCalledWith(session);
    expect(mocks.del).toHaveBeenCalledWith(session.callControlId);
    expect(mocks.store.has('live-demo:slot:rest-1')).toBe(false);

    // Idempotent : une erreur socket après la fermeture ne double pas le nettoyage.
    socket.emit('error', new Error('late'));
    expect(mocks.closeStt).toHaveBeenCalledTimes(1);
  });

  it('libère le créneau si la socket se ferme pendant la création de la session', async () => {
    let resolveContext: (value: unknown) => void = () => undefined;
    mocks.loadContextById.mockReturnValue(new Promise((resolve) => (resolveContext = resolve)));
    const socket = connect();
    await flush();

    socket.emit('close'); // fermeture avant la fin du chargement du contexte
    resolveContext({
      id: 'rest-1',
      name: 'Chez Suppernote',
      phoneNumber: '',
      managerPhone: '',
      timezone: 'Europe/Paris',
      openingHours: null,
      personality: null,
    });
    await flush();

    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.store.has('live-demo:slot:rest-1')).toBe(false);
  });

  it('ferme proprement si le contexte du restaurant est introuvable', async () => {
    mocks.loadContextById.mockRejectedValue(new Error('not found'));
    const socket = connect();
    await flush();

    expect(socket.closeCode).toBe(LIVE_DEMO_CLOSE.unavailable);
    expect(mocks.store.has('live-demo:slot:rest-1')).toBe(false);
  });
});
