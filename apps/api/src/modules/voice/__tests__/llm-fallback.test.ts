/**
 * Repli OpenRouter du modèle vocal (appel 1b3f85e9 / panne de quota du 29/09) : le tour structuré
 * ET le chemin à outils des autres restaurants basculent quand Cerebras échoue avant le premier
 * fragment ; un premier fragment trop lent bascule aussi.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { CallSessionManager, _resetCircuitBreakersForTesting } from '../stream/manager';
import { voiceConfig, type VoiceConfig } from '../../../env';
import type { CallSession } from '../stream/types';
import { voiceLlmFallbackTotal, voiceLlmHedgeTotal } from '../../../shared/observability/metrics';

vi.mock('../../reservations/reservation.service', () => ({
  ReservationService: { create: vi.fn(), update: vi.fn(), availability: vi.fn() },
}));
vi.mock('../../../shared/db/client', () => ({
  db: {
    call: {
      findUnique: vi.fn().mockResolvedValue({ id: 'call-record-1', restaurantId: 'rest-1' }),
    },
    restaurant: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Europe/Paris' }) },
    reservation: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    reservationAuditLog: { create: vi.fn() },
    message: { create: vi.fn() },
  },
}));
vi.mock('../../../shared/telnyx/http-agent', () => ({
  telnyxFetch: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../shared/logger/pino', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

const alerts = vi.hoisted(() => ({
  bothFailed: vi.fn().mockResolvedValue(false),
  fallbackUnavailable: vi.fn().mockResolvedValue(false),
}));
vi.mock('../stream/llm-alerts', () => ({
  recordLlmBothProvidersFailed: alerts.bothFailed,
  alertLlmFallbackUnavailable: alerts.fallbackUnavailable,
  recordLlmHedgeFired: vi.fn().mockResolvedValue(false),
  alertLlmPrimaryUnavailable: vi.fn().mockResolvedValue(false),
  alertLlmCircuitOpened: vi.fn().mockResolvedValue(false),
}));

const PRIMARY_KEY = ['test', 'cerebras', 'key'].join('-');
const FALLBACK_KEY = ['test', 'openrouter', 'key'].join('-');

const sse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`,
          ),
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
};

const neverEmits = (): Response =>
  new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });

function makeSession(): CallSession {
  return CallSessionManager.getInstance().create({
    callControlId: 'cc-fallback',
    callSessionId: 'cs-fallback',
    from: '+33****0001',
    to: '+33****0000',
    restaurantId: 'rest-1',
    restaurantName: 'Test Resto',
    systemPrompt: "Tu es l'assistant vocal de Test Resto.",
    isVip: false,
    telnyxWs: { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn(), on: vi.fn() } as never,
    callLegId: 'leg-fallback',
    codec: 'PCMA',
  });
}

const format = {
  type: 'json_schema',
  json_schema: { name: 'voice_turn', strict: true, schema: {} },
};
const messages = [
  { role: 'system' as const, content: 'Consignes' },
  { role: 'user' as const, content: 'bonjour' },
];

let saved: Partial<VoiceConfig>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saved = {
    CEREBRAS_API_KEY: voiceConfig.CEREBRAS_API_KEY,
    OPENROUTER_API_KEY: voiceConfig.OPENROUTER_API_KEY,
    VOICE_LLM_FIRST_CHUNK_TIMEOUT_MS: voiceConfig.VOICE_LLM_FIRST_CHUNK_TIMEOUT_MS,
    VOICE_LLM_TIMEOUT_MS: voiceConfig.VOICE_LLM_TIMEOUT_MS,
    VOICE_STRUCTURED_FALLBACK_PROVIDER_ORDER: voiceConfig.VOICE_STRUCTURED_FALLBACK_PROVIDER_ORDER,
    VOICE_STRUCTURED_FALLBACK_PROVIDER_IGNORE:
      voiceConfig.VOICE_STRUCTURED_FALLBACK_PROVIDER_IGNORE,
    VOICE_STRUCTURED_FALLBACK_REASONING: voiceConfig.VOICE_STRUCTURED_FALLBACK_REASONING,
    VOICE_STRUCTURED_FALLBACK_SAMPLING: voiceConfig.VOICE_STRUCTURED_FALLBACK_SAMPLING,
    VOICE_LLM_OPENROUTER_PRIMARY_HEDGE_MS: voiceConfig.VOICE_LLM_OPENROUTER_PRIMARY_HEDGE_MS,
  };
  Object.assign(voiceConfig, {
    CEREBRAS_API_KEY: PRIMARY_KEY,
    OPENROUTER_API_KEY: FALLBACK_KEY,
    VOICE_LLM_FIRST_CHUNK_TIMEOUT_MS: 60,
    VOICE_LLM_TIMEOUT_MS: 1_000,
  });
  (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
    new CallSessionManager();
  _resetCircuitBreakersForTesting();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  Object.assign(voiceConfig, saved);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const urlOf = (call: unknown[]): string => String(call[0]);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as { body: string }).body));

describe('repli du chemin à outils (restaurants hors tour structuré)', () => {
  const tools = [{ type: 'function', function: { name: 'check_availability' } }];
  const call = (mgr: CallSessionManager, session: CallSession) =>
    (
      mgr as unknown as {
        fetchLlmStreaming: (
          s: CallSession,
          m: typeof messages,
          o: { tools: unknown; maxTokens: number; temperature: number },
        ) => Promise<{ response: Response; provider: string }>;
      }
    ).fetchLlmStreaming(session, messages, { tools, maxTokens: 200, temperature: 0.7 });

  it("garde le comportement historique si le repli échoue aussi : la réponse d'erreur du principal est rendue", async () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    fetchMock
      .mockResolvedValueOnce(new Response('quota épuisé', { status: 402 }))
      .mockResolvedValueOnce(new Response('down', { status: 500 }));

    const { response, provider } = await call(mgr, session);

    expect(provider).not.toBe('openrouter');
    expect(response.status).toBe(402);
    expect(await response.text()).toBe('quota épuisé');
  });

  it('ne touche pas au repli quand le principal répond', async () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    fetchMock.mockResolvedValueOnce(sse(['Bonjour.']));

    const { provider } = await call(mgr, session);

    expect(provider).not.toBe('openrouter');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GPT-6 Luna (OpenRouter) en principal pour tous les restaurants, Cerebras en relais', () => {
  const answer = (say: string) => `{"turnComplete":true,"say":"${say}"}`;
  const run = () =>
    CallSessionManager.getInstance().streamStructuredCompletion(
      makeSession(),
      messages,
      format as never,
      { onDelta: () => undefined },
    );
  const hedgeCount = async (outcome: string) =>
    (await voiceLlmHedgeTotal.get()).values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
  const signalAt = (index: number) =>
    (fetchMock.mock.calls[index][1] as { signal: AbortSignal }).signal;

  beforeEach(() => {
    Object.assign(voiceConfig, {
      VOICE_LLM_OPENROUTER_PRIMARY_HEDGE_MS: 30,
      VOICE_STRUCTURED_FALLBACK_MODEL: 'openai/gpt-6-luna',
      VOICE_STRUCTURED_FALLBACK_PROVIDER_ORDER: 'openai/fast',
      VOICE_STRUCTURED_FALLBACK_REASONING: 'none',
      VOICE_STRUCTURED_FALLBACK_SAMPLING: 'false',
    });
    voiceLlmHedgeTotal.reset();
    alerts.fallbackUnavailable.mockClear();
  });

  it('envoie le tour à OpenRouter en deux requêtes identiques, avec les réglages du relais, et garde la première qui écrit', async () => {
    fetchMock.mockResolvedValueOnce(neverEmits()).mockResolvedValueOnce(sse([answer('Oui.')]));

    const text = await run();

    expect(text).toBe(answer('Oui.'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock.mock.calls[0])).toContain('openrouter');
    expect(urlOf(fetchMock.mock.calls[1])).toContain('openrouter');
    const body = bodyOf(fetchMock.mock.calls[0]);
    expect(body.model).toBe('openai/gpt-6-luna');
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body).not.toHaveProperty('temperature');
    expect(body.provider.order).toEqual(['openai/fast']);
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual(body);
    expect(signalAt(0).aborted).toBe(true);
    expect(signalAt(1).aborted).toBe(false);
  });

  it('garde la requête qui répond quand l’autre est refusée', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(sse([answer('Bonjour.')]));

    const text = await run();

    expect(text).toBe(answer('Bonjour.'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lance Cerebras en doublon quand OpenRouter tarde, et garde le premier qui répond', async () => {
    fetchMock
      .mockResolvedValueOnce(neverEmits())
      .mockResolvedValueOnce(neverEmits())
      .mockResolvedValueOnce(sse([answer('Oui.')]));

    const text = await run();

    expect(text).toBe(answer('Oui.'));
    expect(urlOf(fetchMock.mock.calls[2])).not.toContain('openrouter');
    expect(bodyOf(fetchMock.mock.calls[2]).reasoning_effort).toBe('none');
    expect(await hedgeCount('hedge_won')).toBe(1);
  });

  it('passe tout de suite à Cerebras quand OpenRouter refuse, et signale le relais hors service', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('quota', { status: 402 }))
      .mockResolvedValueOnce(new Response('quota', { status: 402 }))
      .mockResolvedValueOnce(sse([answer('Bonjour.')]));

    const text = await run();

    expect(text).toBe(answer('Bonjour.'));
    expect(urlOf(fetchMock.mock.calls[2])).not.toContain('openrouter');
    expect(alerts.fallbackUnavailable).toHaveBeenCalledWith(402);
    expect(await hedgeCount('hedge_won')).toBe(0);
  });

  it('échoue proprement quand OpenRouter et Cerebras refusent tous les deux', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('quota', { status: 401 }))
      .mockResolvedValueOnce(new Response('quota', { status: 401 }))
      .mockResolvedValueOnce(new Response('quota', { status: 402 }));

    await expect(run()).rejects.toThrow('OpenRouter 401');
  });

  it('attend son propre délai avant le doublon Cerebras : Luna lent mais dans le délai garde la main', async () => {
    Object.assign(voiceConfig, { VOICE_LLM_OPENROUTER_PRIMARY_HEDGE_MS: 300 });
    const encoder = new TextEncoder();
    const slowLuna = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: answer('Luna.') } }] })}\n\ndata: [DONE]\n\n`,
                ),
              );
              controller.close();
            }, 120);
          },
        }),
        { status: 200 },
      );
    fetchMock.mockResolvedValueOnce(slowLuna()).mockResolvedValueOnce(slowLuna());

    const text = await run();

    expect(text).toBe(answer('Luna.'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => urlOf(call).includes('openrouter'))).toBe(true);
  });

  it('reste sur Cerebras seul sans clé OpenRouter', async () => {
    Object.assign(voiceConfig, { OPENROUTER_API_KEY: '' });
    fetchMock.mockResolvedValueOnce(sse([answer('Ok.')]));

    await run();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchMock.mock.calls[0])).not.toContain('openrouter');
  });
});
