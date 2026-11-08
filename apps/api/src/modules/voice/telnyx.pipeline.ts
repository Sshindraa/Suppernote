import { FastifyInstance } from 'fastify';
import { telnyxWebhookGuard, webhookEventLabel } from './telnyx.guard';
import { RATE_LIMIT_PROVIDER_WEBHOOK } from '../../plugins/rate-limit.policy';
import { telnyxWebhookEventsTotal } from '../../shared/observability/metrics';
import { RestaurantService } from '../restaurants/restaurant.service';
import { CustomerService } from '../customers/customer.service';
import {
  CRM_VOICE_SUGGESTIONS_JOB_NAME,
  enqueueCrmVoiceSuggestions,
} from '../customers/customer-voice-suggestions';
import { buildPracticalFacts } from '../restaurants/practical-info';
import { buildSystemPrompt, type OpeningHours, agentVoiceGender } from './prompts';
import { CallSessionManager } from './stream/manager';
import {
  handleOnboardingTestCallEvent,
  isOnboardingTestCall,
  parseClientState,
} from './onboarding-test-call';
import { buildDeepgramCallKeyterms } from './stream/stt-deepgram-keyterms';
import { acknowledgeCallEnding } from './stream/call-ending';
import { buildTelnyxStreamConfig, getTelnyxCodec } from './stream/telnyx-codec';
import { finalizeVoiceCall } from './call-finalization.service';
import { observedTtsProvider } from './stream/turn-telemetry';
import { callFinalizationDependencies } from './call-finalization.dependencies';

import { buildSmsJobId, buildTelnyxWebhookJobId } from '../../shared/queue/job-options';
import { isVoicePipelineEnabled } from '../../shared/configcat';
import { isBillingSuspended } from '../billing/billing.service';
import { recordWebhookOutcome } from '../../shared/observability/webhook-health';
import { answerSuspendedCall, handleSuspendedCallEvent, isSuspendedCall } from './suspended-call';
import { telnyxFetch } from '../../shared/telnyx/http-agent';

/**
 * Telnyx retries callbacks, but answering a call event with 429 delays the live
 * pipeline. Provider webhooks therefore use their own tier instead of the
 * global 100 req/min budget (see `plugins/rate-limit.policy.ts`).
 */
const webhookRouteOptions = {
  preHandler: telnyxWebhookGuard,
  config: { rateLimit: RATE_LIMIT_PROVIDER_WEBHOOK },
};
import { MS_TO_SECONDS } from '../../shared/constants/time.js';
import { DEFAULT_MAX_PARTY_SIZE } from '@suppernote/config';
import { recordPricedUsageEvent } from '../usage/usage-tariff.service';

interface TelnyxCallPayload {
  data: {
    event_type: string;
    payload: {
      call_control_id: string;
      call_leg_id: string;
      from: string;
      to: string;
      direction: string;
      client_state?: string;
      duration_sec?: number;
      start_time?: string;
      end_time?: string;
      recording_id?: string;
      recording_urls?: { mp3?: string; wav?: string };
      started_at?: string;
      ended_at?: string;
      recording_started_at?: string;
      recording_ended_at?: string;
    };
  };
}

interface TelnyxCallEndPayload {
  call_leg_id: string;
  transcript?: string;
  ended_reason?: string;
  started_at?: string;
  ended_at?: string;
  stt_provider?: string;
  llm_provider?: string;
  tts_provider?: string;
  from?: string;
  to?: string;
}

export async function telnyxVoiceRoutes(app: FastifyInstance) {
  // Comptage des webhooks traités / en erreur (alerte « webhook Telnyx en
  // erreur » du worker system-health). Les 403 du guard sont déjà comptées
  // en result='rejected' — on les exclut ici pour ne pas double-compter.
  app.addHook('onResponse', (req, reply, done) => {
    try {
      if (reply.statusCode !== 403) {
        telnyxWebhookEventsTotal.inc({
          event: webhookEventLabel(req.url),
          result: reply.statusCode >= 500 ? 'error' : 'processed',
        });
        recordWebhookOutcome(reply.statusCode >= 500 ? 'error' : 'processed');
      }
    } catch {
      // La métrique ne doit jamais casser le webhook.
    }
    done();
  });

  app.post('/voice/telnyx', webhookRouteOptions, async (req, reply) => {
    const body = req.body as TelnyxCallPayload;
    const eventType = body.data.event_type;
    const payload = body.data.payload;

    // Appel de test sortant du provisioning : le numéro appelé est celui du gérant, pas celui d'un restaurant.
    // Ses événements sont traités ici, avant la résolution du restaurant par le numéro appelé.
    const clientState = parseClientState(payload.client_state);
    if (isOnboardingTestCall(clientState)) {
      try {
        const outcome = await handleOnboardingTestCallEvent(eventType, payload.call_control_id);
        return reply.send({ result: outcome });
      } catch (err) {
        app.log.error(
          { err: err instanceof Error ? err.message : String(err), eventType },
          'Onboarding test call action failed',
        );
        return reply.send({ result: 'failed' });
      }
    }

    // Appel d'un restaurant suspendu : message court puis raccroché (voir suspended-call.ts).
    if (isSuspendedCall(clientState)) {
      try {
        const outcome = await handleSuspendedCallEvent(
          eventType,
          payload.call_control_id,
          clientState as Record<string, unknown>,
        );
        return reply.send({ result: outcome });
      } catch (err) {
        app.log.error(
          { err: err instanceof Error ? err.message : String(err), eventType },
          'Suspended call action failed',
        );
        return reply.send({ result: 'failed' });
      }
    }

    switch (eventType) {
      case 'call.recording.saved': {
        const recordingId = payload.recording_id;
        const downloadUrl = payload.recording_urls?.mp3;
        if (
          process.env.CALL_RECORDING_ENABLED !== 'true' ||
          !recordingId ||
          !downloadUrl ||
          !payload.call_leg_id
        ) {
          app.log.warn(
            { callLegId: payload.call_leg_id, recordingId },
            'Recording webhook ignored: feature disabled or incomplete payload',
          );
          return reply.send({ result: 'ignored' });
        }

        const jobId = buildTelnyxWebhookJobId('store-recording', recordingId);
        await app.queues.telnyxWebhooks.add(
          'store-recording',
          {
            callLegId: payload.call_leg_id,
            recordingId,
            downloadUrl,
            // `call.recording.saved` exposes recording_started_at/ended_at.
            // Keep the generic names as a compatibility fallback for older
            // fixtures/provider payloads, but prefer the recording fields.
            startedAt: payload.recording_started_at ?? payload.started_at,
            endedAt: payload.recording_ended_at ?? payload.ended_at,
          },
          { jobId },
        );
        return reply.send({ result: 'ok' });
      }

      case 'call.initiated': {
        let ctx: Awaited<ReturnType<typeof RestaurantService.loadContext>>;
        try {
          ctx = await RestaurantService.loadContext(payload.to);
        } catch (err: unknown) {
          app.log.error(
            { err: err instanceof Error ? err.message : String(err), hasTo: Boolean(payload.to) },
            'Restaurant lookup failed for phone number',
          );
          if ((err as { code?: string } | null)?.code === 'P2025')
            return reply.send({ result: 'ok' });
          throw err;
        }

        // ── Parallélisation des 3 lectures indépendantes (ctx.id only) ──
        // Avant : checkMarginHealth → isVoicePipelineEnabled → lookupOrCreate
        //         (3 awaits séquentiels = ~50-150ms cumulés)
        // Après : Promise.all des 3 en parallèle = max(3) au lieu de sum(3)
        const [safe, voiceEnabled, billingSuspended, customer] = await Promise.all([
          RestaurantService.checkMarginHealth(ctx.id),
          isVoicePipelineEnabled(ctx.id),
          isBillingSuspended(ctx.id),
          payload.from
            ? CustomerService.lookupOrCreate(ctx.id, payload.from).then((caller) =>
                CustomerService.withVoiceProfile(ctx.id, caller),
              )
            : Promise.resolve(null),
        ]);

        if (!safe) {
          app.log.warn({ restaurantId: ctx.id }, 'Circuit breaker triggered');
          return reply.send({ result: 'ok' });
        }

        // Kill switch — drop the call before any expensive work (DB write,
        // session create, queue enqueue). Telnyx will fall back to voicemail
        // / configured fallback flow.
        if (!voiceEnabled) {
          app.log.warn(
            { restaurantId: ctx.id, callId: payload.call_control_id },
            'Voice pipeline killed by feature flag — dropping call',
          );
          return reply.send({ result: 'ok' });
        }

        // Ended subscription (trial without a card, cancellation, unpaid): no voice session.
        // The restaurant may still forward its line here, so the caller hears a short message in
        // the restaurant's name instead of silence, then Suppernote hangs up.
        if (billingSuspended) {
          app.log.warn(
            { restaurantId: ctx.id, callId: payload.call_control_id },
            'Billing suspended — short message then hang up',
          );
          try {
            await answerSuspendedCall(payload.call_control_id, ctx.name);
          } catch (err) {
            app.log.error(
              { err: err instanceof Error ? err.message : String(err), restaurantId: ctx.id },
              'Suspended call answer failed',
            );
          }
          return reply.send({ result: 'ok' });
        }

        if (customer?.isVip && process.env.VIP_PUSH_ENABLED === 'true') {
          await app.queues.smsManager.add(
            'vip-alert',
            {
              restaurantId: ctx.id,
              message: `⭐ VIP en ligne${customer.name ? ' : ' + customer.name : ''} — appel entrant`,
              idempotencyKey: buildSmsJobId('vip-alert', ctx.id, payload.call_leg_id),
            },
            { jobId: buildSmsJobId('vip-alert', ctx.id, payload.call_leg_id) },
          );
        }

        const customerExtra = customer
          ? CustomerService.buildVipPromptExtra(customer, { timezone: ctx.timezone })
          : '';
        const returningCustomerFirstName = customer
          ? CustomerService.returningCustomerFirstName(customer)
          : '';

        const systemPrompt = buildSystemPrompt({
          ...ctx,
          openingHours: ctx.openingHours as OpeningHours,
          customerExtra,
          returningCustomerFirstName,
          giftCardMinimumAmount: ctx.giftCardMinimumAmount,
          voiceGender: agentVoiceGender(ctx.personality),
          personalityStyleEnabled: true,
          restaurantFacts: buildPracticalFacts({
            practicalInfo: ctx.practicalInfo,
            dietary: ctx.dietary,
            ambiance: ctx.ambiance,
          }),
        });

        // Créer un enregistrement Call minimal dès l'init
        // P2002 (duplicate unique key) est attendu en cas de retransmission webhook
        // Telnyx ou race avec call.hangup — on le swallow en warn.
        // Toute autre erreur Prisma (FK violation, timeout, connexion) est
        // re-thrown pour ne pas continuer avec un état DB incohérent.
        try {
          await app.db.call.create({
            data: {
              callSid: payload.call_leg_id,
              restaurantId: ctx.id,
              carrier: 'telnyx',
              // Persisté dès l'init : c'est le seul moment où le numéro est
              // garanti. Le rattrapage des appels incomplets en a besoin pour
              // déclencher la récupération commerciale.
              callerPhone: payload.from ?? null,
            },
          });
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === 'P2002') {
            app.log.warn(
              { callSid: payload.call_leg_id, restaurantId: ctx.id },
              'Duplicate call record at init (webhook retry or race) — continuing',
            );
            // Continue: la session sera tout de même créée et l'appel répondu
            // (le webhook est un retry, le call existe déjà en DB).
            const existingCall = await app.db.call.findFirst({
              where: { callSid: payload.call_leg_id, restaurantId: ctx.id },
              select: { outcome: true, durationSec: true },
            });
            if (existingCall?.outcome || existingCall?.durationSec != null) {
              return reply.send({ result: 'ok' });
            }
          } else {
            app.log.error(
              { err: err instanceof Error ? err.message : String(err), code },
              'Failed to create call record at init — rethrowing',
            );
            throw err;
          }
        }

        // Pre-créer la session vocale pour que le WebSocket start event la trouve
        // (sinon le handler log "No session found for start event" et reste silencieux).
        // La session est en mode IDLE ici — le WebSocket start event y attachera le
        // telnyxWs et déclenchera la première salutation.
        // Codec Telnyx : PCMA par défaut, L16 seulement si le flag est activé.
        const telnyxCodec = getTelnyxCodec(ctx.id);
        const deepgramKeyterms = buildDeepgramCallKeyterms({
          restaurantName: ctx.name,
          address: ctx.formattedAddress,
          city: ctx.city,
          cuisineTypes: ctx.cuisineType,
        });
        const manager = CallSessionManager.getInstance();
        const existingSession = manager.get(payload.call_control_id);
        if (existingSession?.ended || existingSession?.ending) return reply.send({ result: 'ok' });
        const voiceSession =
          existingSession ??
          manager.create({
            callControlId: payload.call_control_id,
            callSessionId: payload.call_leg_id,
            from: payload.from,
            to: payload.to,
            restaurantId: ctx.id,
            restaurantName: ctx.name,
            deepgramKeyterms,
            managerPhone: ctx.managerPhone,
            onlineReservationsActive: ctx.onlineReservationsActive === true,
            smsConfirmEnabled: ctx.smsConfirmEnabled,
            timezone: ctx.timezone,
            openingHours: (ctx.openingHours as OpeningHours | null) ?? null,
            // Contexte en cache d'avant ce champ : `loadContext` le recalcule sous 5 min.
            maxPartySize: ctx.maxPartySize ?? DEFAULT_MAX_PARTY_SIZE,
            giftCardMinimumAmount: ctx.giftCardMinimumAmount ?? undefined,
            systemPrompt,
            isVip: customer?.isVip ?? false,
            telnyxWs: null as unknown as import('ws').WebSocket, // Sera attaché dans le WebSocket start event
            callLegId: payload.call_leg_id,
            codec: telnyxCodec,
            ...(ctx.personality
              ? {
                  greetingStyle: {
                    profileType: ctx.personality.profileType,
                    fillerStyle: ctx.personality.fillerStyle,
                  },
                }
              : {}),
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
        app.log.info(
          { callId: payload.call_control_id },
          'Voice session pre-created in call.initiated',
        );

        app.log.info({ callId: payload.call_control_id }, 'Answering call with media stream');

        // Answer with media streaming
        const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
        const wsUrl =
          publicUrl.replace(/^https?/, 'wss') +
          `/voice/stream/${payload.call_control_id}?token=${encodeURIComponent(voiceSession.streamToken!)}`;

        // Do not acknowledge the webhook until the answer or its durable retry is accepted.
        const idempotencyKey = buildTelnyxWebhookJobId('answer', payload.call_control_id);
        const apiKey = process.env.TELNYX_API_KEY;
        if (!apiKey) throw new Error('TELNYX_API_KEY not configured');
        let answered = false;
        try {
          const response = await telnyxFetch(
            `/v2/calls/${payload.call_control_id}/actions/answer`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Idempotency-Key': idempotencyKey,
              },
              body: JSON.stringify(buildTelnyxStreamConfig(wsUrl, telnyxCodec)),
            },
          );
          answered = response.ok;
          if (!answered)
            app.log.warn(
              { callId: payload.call_control_id, status: response.status },
              'Direct answer failed',
            );
        } catch (error) {
          app.log.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              callId: payload.call_control_id,
            },
            'Direct answer failed',
          );
        }
        if (!answered) {
          await app.queues.telnyxWebhooks.add(
            'answer-call',
            {
              callControlId: payload.call_control_id,
              callLegId: payload.call_leg_id,
              streamUrl: wsUrl,
              codec: telnyxCodec,
              idempotencyKey,
            },
            { jobId: idempotencyKey },
          );
        }
        return reply.send({ result: 'ok' });
      }

      case 'call.speak.ended': {
        const session = CallSessionManager.getInstance().get(payload.call_control_id);
        if (session && payload.client_state) {
          acknowledgeCallEnding(
            session,
            Buffer.from(payload.client_state, 'base64').toString(),
            'native',
          );
        }
        return reply.send({ result: 'ok' });
      }

      case 'call.hangup': {
        const pending = CallSessionManager.getInstance().get(payload.call_control_id);
        if (pending && !pending.telnyxWs)
          CallSessionManager.getInstance().delete(payload.call_control_id);
        const durationSec =
          typeof payload.duration_sec === 'number' ? Math.round(payload.duration_sec) : null;

        if (durationSec !== null) {
          try {
            await app.db.call.update({
              where: { callSid: payload.call_leg_id },
              data: { durationSec },
            });
          } catch {
            // Swallow — call record may not exist (e.g. pipeline killed early).
          }
        }

        const callRecord = await app.db.call.findUnique({
          where: { callSid: payload.call_leg_id },
          include: { reservation: true, restaurant: { select: { accountId: true } } },
        });

        if (durationSec !== null && callRecord?.id && callRecord.restaurantId) {
          try {
            await recordPricedUsageEvent({
              restaurantId: callRecord.restaurantId,
              accountId: callRecord.restaurant?.accountId,
              category: 'TELEPHONY_SECONDS',
              provider: 'telnyx',
              quantity: durationSec,
              unit: 'seconds',
              sourceType: 'call',
              sourceId: callRecord.id,
              sourceEventKey: `telnyx:call:${payload.call_leg_id}:final`,
              occurredAt: new Date(),
              metadata: { costStatus: 'UNPRICED', carrier: 'telnyx' },
            });
          } catch (error) {
            app.log.error(
              {
                err: error instanceof Error ? error.message : String(error),
                callSid: payload.call_leg_id,
              },
              'Failed to record telephony usage',
            );
          }
        }

        // Telnyx peut omettre ou retarder `call.recording.saved`. Un appel de
        // test déjà marqué PENDING est donc réconcilié depuis son API après la
        // fin d'appel, avec retry queue et sans élargir l'allowlist.
        if (
          process.env.CALL_RECORDING_ENABLED === 'true' &&
          callRecord?.recordingStatus === 'PENDING'
        ) {
          try {
            const jobId = buildTelnyxWebhookJobId('recover-recording', payload.call_leg_id);
            await app.queues.telnyxWebhooks.add(
              'recover-recording',
              { callLegId: payload.call_leg_id },
              {
                jobId,
                delay: 30_000,
                attempts: 5,
                backoff: { type: 'exponential', delay: 30_000 },
              },
            );
          } catch (err: unknown) {
            app.log.warn(
              {
                err: err instanceof Error ? err.message : String(err),
                callLegId: payload.call_leg_id,
              },
              'failed to enqueue recording recovery',
            );
          }
        }

        if (callRecord?.reservation && payload.from) {
          const ctx = await RestaurantService.loadContext(payload.to);
          await CustomerService.incrementVisit(ctx.id, payload.from, {
            reservationId: callRecord.reservation.id,
            occurredAt: new Date(),
          });
        }

        // Record call activity on every hangup (with or without reservation)
        // so we have lastCallAt + partySizeTypical for the next call's greeting.
        if (payload.from) {
          try {
            const ctx = await RestaurantService.loadContext(payload.to);
            const partySize = callRecord?.reservation?.partySize ?? null;
            await CustomerService.recordCallActivity(ctx.id, payload.from, partySize, {
              callId: callRecord?.id,
              occurredAt: new Date(),
            });
          } catch (err: unknown) {
            app.log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'failed to record call activity',
            );
          }
        }

        // Finalisation commune : `call.hangup` est le signal le plus fiable du
        // fournisseur. `/voice/telnyx/end` peut ne jamais arriver ; l'outcome ne
        // doit pas rester nul pour autant. La session en mémoire enrichit les
        // faits quand elle est encore vivante (même process).
        try {
          const session = CallSessionManager.getInstance().get(payload.call_control_id);
          await finalizeVoiceCall(
            payload.call_leg_id,
            {
              source: 'hangup',
              restaurantId: callRecord?.restaurantId,
              transcript: session?.transcript,
              durationSec,
              handoffConclusion: session?.handoffConclusion,
              conversationIntent: session?.conversation?.intent ?? null,
              ttsProvider: session ? observedTtsProvider(session) : null,
              to: payload.to,
              customerPhone: payload.from,
            },
            callFinalizationDependencies(app),
          );
          // Suggestions CRM tirées de ce que l'appelant a dit (restaurants listés) : en file, jamais
          // bloquant, après la finalisation qui a écrit la transcription.
          await enqueueCrmVoiceSuggestions(
            payload.call_leg_id,
            callRecord?.restaurantId,
            app.queues.telnyxWebhooks,
            buildTelnyxWebhookJobId(CRM_VOICE_SUGGESTIONS_JOB_NAME, payload.call_leg_id),
          );
        } catch (err: unknown) {
          app.log.error(
            { err: err instanceof Error ? err.message : String(err), callSid: payload.call_leg_id },
            'call.hangup: finalization failed',
          );
        }

        return reply.send({ result: 'ok' });
      }

      default:
        return reply.send({ result: 'ignored' });
    }
  });

  app.post('/voice/telnyx/end', webhookRouteOptions, async (req, reply) => {
    const {
      call_leg_id,
      transcript,
      ended_reason,
      started_at,
      ended_at,
      stt_provider,
      llm_provider,
      tts_provider,
      from,
      to,
    } = req.body as TelnyxCallEndPayload;

    // Résoudre le restaurantId : le guard ne peuple pas req.restaurantId.
    // On tente (1) l'attribut posé par un authMiddleware éventuel, puis
    // (2) un lookup via le numéro Telnyx `to`. Si aucun n'est disponible,
    // on refuse avec 400 plutôt que d'écrire un Call orphelin (restaurantId='').
    let restaurantId: string | undefined = (req as { restaurantId?: string }).restaurantId;
    if (!restaurantId && to) {
      try {
        const ctx = await RestaurantService.loadContext(to);
        restaurantId = ctx.id;
      } catch (err: unknown) {
        app.log.warn(
          { err: err instanceof Error ? err.message : String(err), hasTo: Boolean(to) },
          '/voice/telnyx/end: failed to resolve restaurantId from `to`',
        );
      }
    }
    if (!restaurantId) {
      app.log.error(
        { call_leg_id, hasTo: Boolean(to) },
        '/voice/telnyx/end: cannot resolve restaurantId — refusing',
      );
      return reply.status(400).send({ error: 'restaurantId is required' });
    }

    // Finalisation commune : outcome déduit des faits persistés (réservation
    // réellement créée, transfert accepté, message enregistré), écriture
    // idempotente et récupération commerciale déclenchée une seule fois.
    try {
      await finalizeVoiceCall(
        call_leg_id,
        {
          source: 'end-webhook',
          restaurantId,
          transcript,
          endedReason: ended_reason,
          durationSec: Math.round(
            ended_at && started_at
              ? (new Date(ended_at).getTime() - new Date(started_at).getTime()) / MS_TO_SECONDS
              : 0,
          ),
          sttProvider: stt_provider,
          llmProvider: llm_provider,
          ttsProvider: tts_provider,
          to,
          customerPhone: from,
        },
        callFinalizationDependencies(app),
      );
    } catch (err: unknown) {
      // Une base momentanément indisponible ne doit pas perdre l'événement :
      // Telnyx rejouera ce webhook, et le worker de rattrapage reprendra
      // l'appel resté incomplet.
      app.log.error(
        { err: err instanceof Error ? err.message : String(err), call_leg_id },
        '/voice/telnyx/end: finalization failed',
      );
      return reply.status(503).send({ error: 'finalization_unavailable' });
    }

    return reply.send({ received: true });
  });
}
