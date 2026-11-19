/**
 * WebSocket de la démonstration en direct (onboarding) : le navigateur joue le rôle de Telnyx.
 *
 * Le navigateur parle le même protocole que le Media Stream Telnyx (`start`, `media`, `mark` en
 * entrée ; `media`, `clear`, `mark` en sortie), en G.711 A-law 8 kHz comme un vrai appel. Le
 * pipeline (STT, dialogue, TTS, barge-in) est donc exactement celui de la production : seul le
 * transport change, et la session est marquée `demo` pour neutraliser tout effet de bord réel.
 *
 * Messages ajoutés par ce transport (absents du protocole Telnyx) :
 *  - serveur → navigateur : `ready` (session prête), `ended` (fin d'appel), `error` ;
 *  - navigateur → serveur : rien de plus que `start` / `media` / `mark`.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import '@fastify/websocket';
import { WebSocket } from 'ws';
import type { CallSession, TelnyxStreamMessage } from '../stream/types';
import { CallSessionManager } from '../stream/manager';
import { handleTelnyxMessage } from '../stream/handler';
import { closeStt } from '../stream/stt-bridge';
import { buildSystemPrompt, agentVoiceGender, type OpeningHours } from '../prompts';
import { RestaurantService } from '../../restaurants/restaurant.service';
import { redisCache } from '../../../shared/redis/client';
import { logger } from '../../../shared/logger/pino';
import { captureException } from '../../../shared/sentry/client';
import { DEFAULT_MAX_PARTY_SIZE } from '@suppernote/config';
import { DemoCallRecorder, liveDemoRecordingDir } from './demo-recorder';
import {
  LIVE_DEMO_MAX_DURATION_SEC,
  acquireLiveDemoSlot,
  consumeLiveDemoTicket,
  releaseLiveDemoSlot,
} from './live-demo';

/** Une trame A-law de 20 ms fait 160 octets (≈ 216 caractères en base64) : marge large, rien de plus. */
const MAX_MESSAGE_BYTES = 8 * 1024;
/** Le navigateur doit envoyer `start` dès que le micro et la lecture sont prêts. */
const START_TIMEOUT_MS = 20_000;

/** Codes de fermeture applicatifs (plage 4000-4999). */
export const LIVE_DEMO_CLOSE = {
  invalidTicket: 4401,
  busy: 4409,
  unavailable: 4503,
} as const;

function send(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function reject(socket: WebSocket, code: number, reason: string): void {
  send(socket, { event: 'error', code: reason });
  socket.close(code, reason);
}

async function createDemoSession(
  restaurantId: string,
  callControlId: string,
  socket: WebSocket,
): Promise<CallSession> {
  const ctx = await RestaurantService.loadContextById(restaurantId);

  const systemPrompt = buildSystemPrompt({
    ...ctx,
    openingHours: ctx.openingHours as OpeningHours,
    customerExtra: '',
    returningCustomerFirstName: '',
    giftCardMinimumAmount: ctx.giftCardMinimumAmount,
    voiceGender: agentVoiceGender(ctx.personality),
    personalityStyleEnabled: true,
  });

  const session = CallSessionManager.getInstance().create({
    callControlId,
    callSessionId: callControlId,
    callLegId: callControlId,
    from: 'demo-navigateur',
    to: ctx.phoneNumber,
    restaurantId: ctx.id,
    restaurantName: ctx.name,
    managerPhone: ctx.managerPhone,
    onlineReservationsActive: ctx.onlineReservationsActive === true,
    smsConfirmEnabled: ctx.smsConfirmEnabled,
    timezone: ctx.timezone,
    openingHours: (ctx.openingHours as OpeningHours | null) ?? null,
    maxPartySize: ctx.maxPartySize ?? DEFAULT_MAX_PARTY_SIZE,
    giftCardMinimumAmount: ctx.giftCardMinimumAmount ?? undefined,
    systemPrompt,
    isVip: false,
    telnyxWs: socket,
    // Même codec que la production par défaut : la démonstration restitue ce qu'entendra un client.
    codec: 'PCMA',
    demo: true,
    personality: ctx.personality
      ? {
          fillerStyle: (['CASUAL', 'FORMAL', 'WARM'] as const).includes(
            ctx.personality.fillerStyle as 'CASUAL' | 'FORMAL' | 'WARM',
          )
            ? (ctx.personality.fillerStyle as 'CASUAL' | 'FORMAL' | 'WARM')
            : 'CASUAL',
          systemPromptExtra: ctx.personality.systemPromptExtra,
          speakingRate: Number(ctx.personality.speakingRate ?? 1),
          volume: Number(ctx.personality.volume ?? 1),
          emotion: ctx.personality.emotion,
          voiceIdCa: ctx.personality.voiceIdCa,
          pronunciationDictId: ctx.personality.pronunciationDictId,
        }
      : null,
  });

  return session;
}

/**
 * Pilote une connexion de démonstration, de la validation du ticket au nettoyage. Exportée pour les
 * tests ; la route Fastify n'est qu'un branchement.
 */
export function handleLiveDemoConnection(socket: WebSocket, ticket: string): void {
  const mgr = CallSessionManager.getInstance();
  const log = logger.child({ component: 'live-demo' });

  // Développement seulement (LIVE_DEMO_RECORDING_DIR) : copie l'audio dans un MP3 stéréo à écouter.
  const recordingDir = liveDemoRecordingDir();
  const recorder = recordingDir ? new DemoCallRecorder() : null;
  if (recorder) {
    const originalSend = socket.send.bind(socket) as (...args: unknown[]) => void;
    socket.send = ((data: unknown, ...rest: unknown[]) => {
      recorder.addOutbound(data);
      return originalSend(data, ...rest);
    }) as typeof socket.send;
  }

  let session: CallSession | undefined;
  let callControlId: string | undefined;
  let restaurantId: string | undefined;
  let slotHeld = false;
  let started = false;
  let closed = false;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let durationTimer: ReturnType<typeof setTimeout> | null = null;
  // Les messages arrivent avant la fin de l'initialisation asynchrone : on les met en file.
  const pending: TelnyxStreamMessage[] = [];

  // Idempotent par ressource : la fermeture peut survenir pendant l'initialisation asynchrone, et
  // `teardown` est rappelé ensuite pour libérer ce qui vient d'être créé.
  let sessionCleaned = false;
  let slotReleased = false;
  const teardown = (reason: string): void => {
    closed = true;
    if (startTimer) clearTimeout(startTimer);
    if (durationTimer) clearTimeout(durationTimer);
    if (session && !sessionCleaned) {
      sessionCleaned = true;
      session.ended = true;
      session.state = 'IDLE';
      session.isSpeaking = false;
      closeStt(session);
      mgr.delete(session.callControlId);
      log.info(
        { restaurantId, durationSec: Math.round((Date.now() - session.createdAt) / 1000), reason },
        '[live-demo] ended',
      );
      if (recorder && recordingDir) {
        recorder
          .save(recordingDir, session.callControlId)
          .then((file) => file && log.info({ file }, '[live-demo] recording saved'))
          .catch((err) =>
            log.warn(
              { reason: err instanceof Error ? err.message : 'unknown' },
              '[live-demo] recording failed',
            ),
          );
      }
    }
    if (slotHeld && !slotReleased && restaurantId && callControlId) {
      slotReleased = true;
      releaseLiveDemoSlot(redisCache, restaurantId, callControlId).catch((err) =>
        log.error({ err, restaurantId }, '[live-demo] slot release failed'),
      );
    }
  };

  const dispatch = (msg: TelnyxStreamMessage): void => {
    if (!session || !callControlId) return;
    switch (msg.event) {
      case 'start': {
        if (started) return;
        started = true;
        if (startTimer) clearTimeout(startTimer);
        durationTimer = setTimeout(() => {
          send(socket, { event: 'ended', reason: 'timeout' });
          socket.close(1000, 'timeout');
        }, LIVE_DEMO_MAX_DURATION_SEC * 1000);
        // Le contenu envoyé par le navigateur n'est pas fiable : on reconstruit le `start`.
        handleTelnyxMessage(
          {
            event: 'start',
            start: {
              call_control_id: callControlId,
              call_session_id: callControlId,
              from: session.from,
              to: session.to,
              media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
            },
          },
          callControlId,
          socket,
          mgr,
        );
        return;
      }
      case 'media': {
        if (!started) return;
        const payload = msg.media?.payload;
        if (typeof payload !== 'string' || payload.length === 0) return;
        recorder?.addInbound(payload);
        handleTelnyxMessage(
          { event: 'media', media: { track: 'inbound', chunk: '', timestamp: '', payload } },
          callControlId,
          socket,
          mgr,
        );
        return;
      }
      case 'mark': {
        const name = msg.mark?.name;
        if (typeof name !== 'string') return;
        handleTelnyxMessage({ event: 'mark', mark: { name } }, callControlId, socket, mgr);
        return;
      }
      default:
        // `stop`, `dtmf`, `error`… : la fermeture de la socket suffit.
        return;
    }
  };

  socket.on('message', (raw: Buffer) => {
    if (closed || raw.length > MAX_MESSAGE_BYTES) return;
    let msg: TelnyxStreamMessage;
    try {
      msg = JSON.parse(raw.toString()) as TelnyxStreamMessage;
    } catch {
      return;
    }
    if (session) dispatch(msg);
    else pending.push(msg);
  });
  socket.on('close', () => teardown('socket-closed'));
  socket.on('error', (err: Error) => {
    log.error({ err: err.message, restaurantId }, '[live-demo] socket error');
    teardown('socket-error');
  });

  const setup = async (): Promise<void> => {
    try {
      const claimedRestaurantId = await consumeLiveDemoTicket(redisCache, ticket);
      if (!claimedRestaurantId)
        return reject(socket, LIVE_DEMO_CLOSE.invalidTicket, 'invalid_ticket');
      restaurantId = claimedRestaurantId;

      const id = `demo-${randomUUID()}`;
      if (!(await acquireLiveDemoSlot(redisCache, restaurantId, id))) {
        return reject(socket, LIVE_DEMO_CLOSE.busy, 'busy');
      }
      // Le créneau est tenu : toute sortie, même en cours d'initialisation, doit le libérer.
      slotHeld = true;
      callControlId = id;

      if (closed) return teardown('closed-during-setup');

      session = await createDemoSession(restaurantId, id, socket);

      if (closed) return teardown('closed-during-setup');

      startTimer = setTimeout(() => {
        send(socket, { event: 'ended', reason: 'start_timeout' });
        socket.close(1000, 'start_timeout');
      }, START_TIMEOUT_MS);

      send(socket, {
        event: 'ready',
        maxDurationSec: LIVE_DEMO_MAX_DURATION_SEC,
        codec: 'PCMA',
        sampleRate: 8000,
      });
      for (const msg of pending.splice(0)) dispatch(msg);
    } catch (err) {
      log.error({ err, restaurantId }, '[live-demo] setup failed');
      captureException(err as Error, {
        tags: { service: 'live-demo', action: 'setup' },
        extra: { restaurantId },
      });
      reject(socket, LIVE_DEMO_CLOSE.unavailable, 'unavailable');
    }
  };
  setup().catch(() => undefined); // les erreurs sont déjà traitées dans `setup`
}

/** Route publique : l'accès est contrôlé par le ticket à usage unique émis après authentification. */
export function registerLiveDemoStreamRoute(app: FastifyInstance): void {
  app.get(
    '/voice/demo-stream/:ticket',
    {
      websocket: true,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    (socket, req) => {
      const { ticket } = req.params as { ticket: string };
      handleLiveDemoConnection(socket, ticket);
    },
  );
}
