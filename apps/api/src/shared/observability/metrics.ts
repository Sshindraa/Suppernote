/**
 * Métriques Prometheus custom pour Suppernote.
 *
 * Métriques exposées (Phase 6) :
 *   - sokar_agentic_hold_created_total{type,channel}
 *   - sokar_agentic_reservation_state_transitions_total{from,to,channel}
 *   - sokar_agentic_check_availability_duration_ms (histogram)
 *   - sokar_agentic_idempotency_hits_total{result}
 *   - sokar_agentic_pii_leaks_total{kind}
 *   - sokar_agentic_double_booking_attempts_total
 *
 * Endpoint : GET /metrics (texte Prometheus, scraped par Grafana).
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

let registry: Registry | null = null;

function getRegistry(): Registry {
  if (registry) return registry;
  registry = new Registry();
  // Collecte les métriques par défaut (process_cpu, nodejs_*, etc.)
  collectDefaultMetrics({ register: registry });
  return registry;
}

// ─── Hold created ─────────────────────────────────────────────

export const holdCreatedTotal = new Counter({
  name: 'sokar_agentic_hold_created_total',
  help: 'Total AgenticHold created',
  labelNames: ['type', 'channel'] as const,
  registers: [getRegistry()],
});

// ─── Reservation state transitions ────────────────────────────

export const reservationStateTransitionsTotal = new Counter({
  name: 'sokar_agentic_reservation_state_transitions_total',
  help: 'Total reservation state transitions',
  labelNames: ['from', 'to', 'channel'] as const,
  registers: [getRegistry()],
});

// ─── Reservation contract visibility (Phase 3A) ─────────────────────

/**
 * Mutations de réservation observées par chemin d'implémentation.
 * Labels volontairement bornés : aucun identifiant métier ou PII.
 */
export const reservationMutationsTotal = new Counter({
  name: 'sokar_reservation_mutations_total',
  help: 'Total reservation mutations observed by source and operation',
  labelNames: ['source', 'operation'] as const,
  registers: [getRegistry()],
});

/**
 * Observations de contrat pour comparer status/state, idempotence, audit,
 * notifications et capacité sans modifier le chemin métier.
 * `mismatch_type` contient aussi les observations nominales afin de rendre
 * visibles les différences entre chemins sans multiplier les labels.
 */
export const reservationContractObservationsTotal = new Counter({
  name: 'sokar_reservation_contract_observations_total',
  help: 'Reservation contract observations by source, operation and bounded observation type',
  labelNames: ['source', 'operation', 'mismatch_type'] as const,
  registers: [getRegistry()],
});

/**
 * Sous-ensemble dédié aux incohérences status/state. Les valeurs d'état ne
 * sont pas des labels : seul le type borné de divergence l'est.
 */
export const reservationStatusStateMismatchesTotal = new Counter({
  name: 'sokar_reservation_status_state_mismatches_total',
  help: 'Total observed reservation status/state mismatches',
  labelNames: ['source', 'operation', 'mismatch_type'] as const,
  registers: [getRegistry()],
});

/**
 * Résultats des appels de notification et de leur réconciliation.
 * Les labels sont strictement bornés : aucun identifiant métier, contact ou
 * contenu de message ne doit être ajouté ici.
 */
export const notificationProviderResultsTotal = new Counter({
  name: 'sokar_notification_provider_results_total',
  help: 'Notification provider results and reconciliation outcomes',
  labelNames: ['provider', 'channel', 'result'] as const,
  registers: [getRegistry()],
});

export type NotificationProviderMetricResult =
  | 'success'
  | 'failure_certain'
  | 'unknown'
  | 'reconciled_success'
  | 'reconciled_failure'
  | 'reconciled_unknown';

export function recordNotificationProviderResult(
  provider: 'telnyx' | 'resend' | 'meta',
  channel: 'sms' | 'whatsapp' | 'email',
  result: NotificationProviderMetricResult,
): void {
  notificationProviderResultsTotal.inc({ provider, channel, result });
}

/**
 * Lifecycle events for the operational claim sweep. Values are deliberately
 * fixed and contain no claim key, reservation id or provider identifier.
 */
export const notificationClaimEventsTotal = new Counter({
  name: 'sokar_notification_claim_events_total',
  help: 'Notification claim recovery and coordination events',
  labelNames: ['event'] as const,
  registers: [getRegistry()],
});

export type NotificationClaimEvent =
  | 'active'
  | 'orphan_recovered'
  | 'manual_review'
  | 'raced'
  | 'unknown_requeued'
  | 'queue_unavailable'
  | 'scan_unavailable'
  | 'scan_failed';

export function recordNotificationClaimEvent(event: NotificationClaimEvent): void {
  notificationClaimEventsTotal.inc({ event });
}

// ─── check_availability duration ──────────────────────────────

export const checkAvailabilityDuration = new Histogram({
  name: 'sokar_agentic_check_availability_duration_ms',
  help: 'Duration of check_availability tool calls in milliseconds',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [getRegistry()],
});

// ─── Idempotency hits ─────────────────────────────────────────

export const idempotencyHitsTotal = new Counter({
  name: 'sokar_agentic_idempotency_hits_total',
  help: 'Total idempotency lookups by outcome',
  labelNames: ['result'] as const, // 'hit', 'miss', 'conflict'
  registers: [getRegistry()],
});

// ─── PII leaks (détection par regex sur tool responses) ───────

export const piiLeaksTotal = new Counter({
  name: 'sokar_agentic_pii_leaks_total',
  help: 'Total PII leaks detected in tool responses (should be 0)',
  labelNames: ['kind'] as const, // 'phone', 'email', 'hex'
  registers: [getRegistry()],
});

// ─── Double booking attempts ──────────────────────────────────

export const doubleBookingAttemptsTotal = new Counter({
  name: 'sokar_agentic_double_booking_attempts_total',
  help: 'Total double booking attempts blocked (should be 0 with partial unique index)',
  registers: [getRegistry()],
});

// ─── Global HTTP requests (for alertErrorRateHigh) ───────────────────

/**
 * Compteur global des requêtes HTTP traitées par l'API (toutes routes).
 * Permet de calculer le taux de 5xx global pour alertErrorRateHigh.
 * Labels : status_class (2xx, 4xx, 5xx) — cardinalité bornée à 3.
 */
export const httpRequestsTotal = new Counter({
  name: 'sokar_http_requests_total',
  help: 'Total HTTP requests processed by the API (all routes)',
  labelNames: ['status_class'] as const,
  registers: [getRegistry()],
});

// ─── Fail-open (Redis/cache down) ────────────────────────────────────

/**
 * Compteur des fail-open Redis/cache. Permet de detecter un Redis down
 * prolonge sans attendre qu'un humain le remarque par hasard.
 * Labels : source (mcp_rate_limit, connect_rate_limit, openai_reserve_cache,
 *           idempotency, ...). Cardinalite bornee par le nombre de sources.
 */
export const failOpenTotal = new Counter({
  name: 'sokar_fail_open_total',
  help: 'Total fail-open events (Redis/cache down, request allowed through)',
  labelNames: ['source'] as const,
  registers: [getRegistry()],
});

// ─── OpenAI Reserve feed (visibilite, pas de blocage) ───────────────

/**
 * Compteur des requetes sur GET /v1/businesses (business feed public).
 * Permet de detecter un volume anormal (scraping massif, DoS applicatif)
 * sans bloquer personne a priori. La decision de bloquer viendra plus tard
 * si les metriques montrent un abus reel.
 * Labels : status (200, 400, 429, 500, cache_hit, cache_miss).
 */
export const openaiReserveFeedRequestsTotal = new Counter({
  name: 'sokar_openai_reserve_feed_requests_total',
  help: 'Total requests on GET /v1/businesses (OpenAI Reserve business feed)',
  labelNames: ['status'] as const,
  registers: [getRegistry()],
});

// ─── Voice pipeline (observation only, no alerting yet) ─────────────

/**
 * Durée complète d'un tour de parole voice (du start du tour au premier
 * audio TTS entendu par l'appelant). Buckets adaptés à la latence voice
 * (cible p95 < 2s, p99 < 5s).
 */
export const voiceTurnDurationMs = new Histogram({
  name: 'sokar_voice_turn_duration_ms',
  help: "Durée complète d'un tour de parole voice (ms)",
  buckets: [100, 200, 500, 1000, 2000, 5000, 10000, 30000],
  registers: [getRegistry()],
});

/**
 * Temps jusqu'au premier token LLM (TTFT). Cible < 500ms pour une
 * conversation naturelle.
 */
export const voiceLlmFirstTokenMs = new Histogram({
  name: 'sokar_voice_llm_first_token_ms',
  help: "Temps jusqu'au premier token LLM (TTFT, ms)",
  buckets: [50, 100, 200, 500, 1000, 2000, 5000],
  registers: [getRegistry()],
});

/** Temps jusqu'à la première phrase complète livrée au pipeline TTS. */
export const voiceLlmFirstPhraseMs = new Histogram({
  name: 'sokar_voice_llm_first_phrase_ms',
  help: "Temps jusqu'à la première phrase LLM complète (ms)",
  buckets: [100, 200, 500, 1000, 2000, 5000, 10000],
  registers: [getRegistry()],
});

/**
 * Temps jusqu'au premier audio TTS (Cartesia). Cible < 500ms.
 */
export const voiceTtsFirstAudioMs = new Histogram({
  name: 'sokar_voice_tts_first_audio_ms',
  help: "Temps jusqu'au premier audio TTS (ms)",
  buckets: [50, 100, 200, 500, 1000, 2000, 5000],
  registers: [getRegistry()],
});

/**
 * Erreurs par provider voice (Deepgram, Cartesia, Cerebras).
 * Permet de mesurer la fiabilité de chaque provider indépendamment.
 * Labels : provider (deepgram_stt | cartesia_stt | cartesia | cerebras | openrouter) × type borné.
 */
export const voiceLlmFallbackTotal = new Counter({
  name: 'sokar_voice_llm_fallback_total',
  help: 'Voice LLM fallback attempts: path (structured|legacy), outcome (used|failed|no_key), reason',
  labelNames: ['path', 'outcome', 'reason'] as const,
  registers: [getRegistry()],
});
export const voiceLlmHedgeTotal = new Counter({
  name: 'sokar_voice_llm_hedge_total',
  help: 'Hedged structured-turn requests: outcome (primary_won|hedge_won|both_failed)',
  labelNames: ['outcome'] as const,
  registers: [getRegistry()],
});
export const voiceNoiseSuppressionTotal = new Counter({
  name: 'sokar_voice_noise_suppression_total',
  help: 'Telnyx noise suppression starts: engine, outcome (started|rejected|error)',
  labelNames: ['engine', 'outcome'] as const,
  registers: [getRegistry()],
});
/**
 * Échecs d'un tour TTS en contexte (WebSocket). `outcome` : `http_fallback` (aucun son encore envoyé,
 * la réponse repart par le chemin HTTP), `audio_cut` (la réponse s'arrête en cours de route, sans repli),
 * `skipped` (l'appel n'attendait plus de voix). Le repli HTTP ne se supprime qu'au vu de ce compteur.
 */
export const voiceTtsContextFailureTotal = new Counter({
  name: 'sokar_voice_tts_context_failure_total',
  help: 'Échecs du TTS en contexte (WebSocket) par fournisseur et issue',
  labelNames: ['provider', 'outcome'] as const,
  registers: [getRegistry()],
});

export const voiceTtsCacheTotal = new Counter({
  name: 'sokar_voice_tts_cache_total',
  help: 'Lectures du cache TTS par type (accueil ou réplique) et résultat',
  labelNames: ['kind', 'result'] as const,
  registers: [getRegistry()],
});

export const voiceProviderErrorsTotal = new Counter({
  // Préfixe `sokar_` comme toutes les métriques maison : sans lui, impossible
  // de distinguer nos séries des métriques système dans un dashboard.
  name: 'sokar_voice_provider_errors_total',
  help: 'Erreurs par provider voice',
  labelNames: ['provider', 'type'] as const,
  registers: [getRegistry()],
});

/** Fins de tour forcées retardées faute de silence réel chez l'appelant. */
export const voiceSilenceGuardTotal = new Counter({
  name: 'sokar_voice_silence_guard_total',
  help: 'Forced end-of-turn requests held by the caller silence guard, by outcome',
  labelNames: ['outcome'] as const,
  registers: [getRegistry()],
});

/** Coupure rapide de l'agent par le détecteur de voix : pause, puis coupure ou reprise. */
export const voiceFastBargeInTotal = new Counter({
  name: 'sokar_voice_fast_barge_in_total',
  help: 'Fast barge-in by caller voice detection: paused, escalated (cut) or resumed (false alarm)',
  labelNames: ['outcome'] as const,
  registers: [getRegistry()],
});

/** Attente avant le premier son d'une réponse, par issue. */
export const voiceFirstAudioHoldTotal = new Counter({
  name: 'sokar_voice_first_audio_hold_total',
  help: 'Replies whose first audio waited for caller silence, by outcome',
  labelNames: ['outcome'] as const,
  registers: [getRegistry()],
});

export const voiceFirstAudioHoldMs = new Histogram({
  name: 'sokar_voice_first_audio_hold_ms',
  help: 'Milliseconds a prepared reply was held before its first audio (held replies only)',
  buckets: [50, 100, 200, 300, 450, 600, 900, 1200],
  registers: [getRegistry()],
});

/** STT audio messages by selected provider. */
export const voiceSttProviderAudioMessagesTotal = new Counter({
  name: 'sokar_voice_stt_provider_audio_messages_total',
  help: 'Audio messages sent to the active STT provider by configured chunk size',
  labelNames: ['provider', 'chunk_ms'] as const,
  registers: [getRegistry()],
});

export const voiceSttProviderChunkBytes = new Histogram({
  name: 'sokar_voice_stt_provider_chunk_bytes',
  help: 'Audio message sizes sent to the active STT provider in bytes',
  labelNames: ['provider'] as const,
  buckets: [160, 320, 640, 1600, 3200, 6400, 16000],
  registers: [getRegistry()],
});

/**
 * Bande large détectée : part des appels où l'audio entrant porte réellement du
 * contenu au-dessus de 4 kHz (codec L16). Mesure UNIQUEMENT l'audio, jamais un
 * identifiant d'appel : c'est ce qui dira si le 16 kHz sert à quelque chose.
 */
export const voiceWidebandDetectedTotal = new Counter({
  name: 'sokar_voice_wideband_detected_total',
  help: 'Appels évalués par la sonde de bande large, selon le verdict',
  labelNames: ['detected', 'codec'] as const,
  registers: [getRegistry()],
});

export type VoiceQualityKind = 'party_size' | 'date' | 'time';
export type VoiceQualityCohort = 'flag_on' | 'flag_off';
export type VoiceExpectedAnswerStatus = 'accepted' | 'choice' | 'unresolved';
export type VoiceSlotConfidenceDecision =
  | 'readBack'
  | 'choice'
  | 'reprompt'
  | 'wouldBeReadBack'
  | 'wouldBeChoice'
  | 'wouldBeReprompt';
export type VoiceChoiceOutcome = 'first' | 'second' | 'neither' | 'other';

/** Résultat du rapprochement d'une réponse attendue, sans score ni valeur en label. */
export const voiceExpectedAnswerTotal = new Counter({
  name: 'sokar_voice_expected_answer_total',
  help: 'Voice expected-answer decisions by bounded field and status',
  labelNames: ['kind', 'status'] as const,
  registers: [getRegistry()],
});

/** Décisions de confiance de slot, y compris les décisions shadow `wouldBe…`. */
export const voiceSlotConfidenceTotal = new Counter({
  name: 'sokar_voice_slot_confidence_total',
  help: 'Voice slot-confidence decisions by bounded field and decision',
  labelNames: ['kind', 'decision'] as const,
  registers: [getRegistry()],
});

/** Champs dont l'agent a relu la valeur à l'appelant. */
export const voiceReadbackTotal = new Counter({
  name: 'sokar_voice_readback_total',
  help: 'Voice reservation fields read back by the assistant',
  labelNames: ['kind'] as const,
  registers: [getRegistry()],
});

/** Relectures corrigées par l'appelant au tour suivant. */
export const voiceReadbackCorrectedTotal = new Counter({
  name: 'sokar_voice_readback_corrected_total',
  help: 'Voice readbacks corrected by the caller on the immediately following turn',
  labelNames: ['kind'] as const,
  registers: [getRegistry()],
});

/** Issue de la réponse au choix vocal entre deux valeurs. */
export const voiceChoiceAnswerTotal = new Counter({
  name: 'sokar_voice_choice_answer_total',
  help: 'Voice caller outcomes for two-option reservation questions',
  labelNames: ['kind', 'outcome'] as const,
  registers: [getRegistry()],
});

/** Nombre de relectures de questions, par champ et cohort de feature flag. */
export const voiceRepromptTotal = new Counter({
  name: 'sokar_voice_reprompt_total',
  help: 'Voice reservation questions repeated by bounded field and expected-answer flag cohort',
  labelNames: ['kind', 'cohort'] as const,
  registers: [getRegistry()],
});

/** Dénominateur des taux de relance, compté au moment où la question est émise. */
export const voiceQuestionTotal = new Counter({
  name: 'sokar_voice_question_total',
  help: 'Voice reservation slot questions emitted by bounded field and flag cohort',
  labelNames: ['kind', 'cohort'] as const,
  registers: [getRegistry()],
});

const VOICE_QUALITY_KINDS: Readonly<Record<string, VoiceQualityKind>> = {
  partySize: 'party_size',
  party_size: 'party_size',
  weekday: 'date',
  date: 'date',
  time: 'time',
};

function normalizeVoiceQualityKind(kind: unknown): VoiceQualityKind | null {
  return typeof kind === 'string' ? (VOICE_QUALITY_KINDS[kind] ?? null) : null;
}

/**
 * Convertit les événements internes en compteurs bornés. Seuls les quatre
 * champs utiles aux réservations et les issues prévues entrent dans Prometheus;
 * texte, valeurs, identifiants et champs supplémentaires sont ignorés.
 */
export function recordVoiceQualityTurnEvent(
  event: 'expected_answer' | 'slot_confidence',
  fields: Record<string, unknown>,
): void {
  const kind = normalizeVoiceQualityKind(fields.kind);
  if (!kind) return;

  if (event === 'expected_answer') {
    const status = fields.status;
    if (status === 'accepted' || status === 'choice' || status === 'unresolved') {
      voiceExpectedAnswerTotal.inc({ kind, status });
    }
    return;
  }

  const decision = fields.decision;
  if (
    decision === 'readBack' ||
    decision === 'choice' ||
    decision === 'reprompt' ||
    decision === 'wouldBeReadBack' ||
    decision === 'wouldBeChoice' ||
    decision === 'wouldBeReprompt'
  ) {
    voiceSlotConfidenceTotal.inc({ kind, decision });
  }
}

export function recordVoiceQuestion(kind: VoiceQualityKind, cohort: VoiceQualityCohort): void {
  voiceQuestionTotal.inc({ kind, cohort });
}

export function recordVoiceReprompt(kind: VoiceQualityKind, cohort: VoiceQualityCohort): void {
  voiceRepromptTotal.inc({ kind, cohort });
}

export function recordVoiceReadback(kind: VoiceQualityKind): void {
  voiceReadbackTotal.inc({ kind });
}

export function recordVoiceReadbackCorrected(kind: VoiceQualityKind): void {
  voiceReadbackCorrectedTotal.inc({ kind });
}

export function recordVoiceChoiceAnswer(kind: VoiceQualityKind, outcome: VoiceChoiceOutcome): void {
  voiceChoiceAnswerTotal.inc({ kind, outcome });
}

/** Crédit OpenRouter restant (repli vocal, Jev, juge), lu chaque heure. */
export const openRouterCreditUsd = new Gauge({
  name: 'sokar_openrouter_credit_usd',
  help: 'Crédit OpenRouter restant en dollars',
  registers: [getRegistry()],
});

/** État du quota ElevenLabs observé via l'endpoint subscription. */
export const elevenLabsCharacterCount = new Gauge({
  name: 'sokar_elevenlabs_character_count',
  help: 'Nombre de caractères consommés sur le compte ElevenLabs',
  registers: [getRegistry()],
});

export const elevenLabsCharacterLimit = new Gauge({
  name: 'sokar_elevenlabs_character_limit',
  help: 'Limite de caractères du compte ElevenLabs',
  registers: [getRegistry()],
});

export type VoiceTurnPlanShadowStatus =
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'speech_missing'
  | 'failed'
  | 'aborted';

/** Span-01 shadow labels are bounded enums; no call or restaurant identifiers. */
export const voiceSemanticDurationMs = new Histogram({
  name: 'sokar_voice_semantic_duration_ms',
  help: 'Span-01 scoring duration in milliseconds',
  labelNames: ['model', 'provider'] as const,
  buckets: [100, 200, 500, 1000, 2000, 5000, 10000],
  registers: [getRegistry()],
});
export const voiceSemanticStatusTotal = new Counter({
  name: 'sokar_voice_semantic_status_total',
  help: 'Span-01 scoring outcomes',
  labelNames: ['status', 'provider'] as const,
  registers: [getRegistry()],
});
export const voiceStructuredSpeculationTotal = new Counter({
  name: 'sokar_voice_structured_speculation_total',
  help: 'Structured-turn speculation outcomes: hit, hit_tolerant (harmless transcript gap), none (never started) or miss by cause',
  labelNames: ['outcome'] as const,
  registers: [getRegistry()],
});
export const voiceStructuredSpeculationLaunchTotal = new Counter({
  name: 'sokar_voice_structured_speculation_launch_total',
  help: 'Structured-turn speculative requests: started, or capped by the per-turn launch limit',
  labelNames: ['result'] as const,
  registers: [getRegistry()],
});
export const voiceTurnJudgeTotal = new Counter({
  name: 'sokar_voice_turn_judge_total',
  help: 'Turn-end judge verdicts: complete, incomplete, or unavailable (timeout, error, invalid) which falls back to turnComplete',
  labelNames: ['outcome'] as const,
  registers: [getRegistry()],
});
export const voiceTurnJudgeDurationMs = new Histogram({
  name: 'sokar_voice_turn_judge_duration_ms',
  help: 'Duration of the separate turn-end judge request (ms), judged or not',
  buckets: [50, 100, 200, 300, 500, 800, 1500],
  registers: [getRegistry()],
});
export const voiceSemanticAgreementTotal = new Counter({
  name: 'sokar_voice_semantic_agreement_total',
  help: 'Agreement between Span-01 signals and TurnPlan',
  labelNames: ['behavior', 'outcome', 'behavior_set_version'] as const,
  registers: [getRegistry()],
});
export const voiceSemanticConflictTotal = new Counter({
  name: 'sokar_voice_semantic_conflict_total',
  help: 'Contradictory Span-01 signals',
  labelNames: ['conflict'] as const,
  registers: [getRegistry()],
});
export const voiceSemanticWouldClarifyTotal = new Counter({
  name: 'sokar_voice_semantic_would_clarify_total',
  help: 'Hypothetical clarification for sensitive action',
  labelNames: ['sensitive_action'] as const,
  registers: [getRegistry()],
});
/** Phase 2 (avis) : ce que Jev aurait changé, comparé à ce que l'agent a fait. */
export const voiceSemanticAdvisoryTotal = new Counter({
  name: 'sokar_voice_semantic_advisory_total',
  help: 'Advisory comparison between Jev and the agent (jev_only = Jev would have changed the turn)',
  labelNames: ['behavior', 'outcome', 'behavior_set_version'] as const,
  registers: [getRegistry()],
});
export const voiceSemanticInputTokensTotal = new Counter({
  name: 'sokar_voice_semantic_input_tokens_total',
  help: 'Span-01 input tokens',
  registers: [getRegistry()],
});
/** Jev renvoie souvent 0 ou 1 : cet histogramme suit la surconfiance des `choice`. */
export const voiceSemanticChoiceConfidence = new Histogram({
  name: 'sokar_voice_semantic_choice_confidence',
  help: 'Max option probability of a Span-01 choice answer',
  labelNames: ['choice', 'provider'] as const,
  buckets: [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1],
  registers: [getRegistry()],
});
/** Réponses unitaires écartées : type inattendu ou forme invalide. */
export const voiceSemanticAnswerSkippedTotal = new Counter({
  name: 'sokar_voice_semantic_answer_skipped_total',
  help: 'Span-01 answers skipped during per-answer parsing',
  labelNames: ['provider', 'reason'] as const,
  registers: [getRegistry()],
});
/** Aggregated precision/recall from the weekly Jev model-judge evaluation. */
export const voiceSemanticEvalPrecision = new Gauge({
  name: 'sokar_voice_semantic_eval_precision',
  help: 'Weekly Jev evaluation precision by behavior and score threshold',
  labelNames: ['behavior', 'threshold'] as const,
  registers: [getRegistry()],
});
export const voiceSemanticEvalRecall = new Gauge({
  name: 'sokar_voice_semantic_eval_recall',
  help: 'Weekly Jev evaluation recall by behavior and score threshold',
  labelNames: ['behavior', 'threshold'] as const,
  registers: [getRegistry()],
});
export const voiceSemanticEvalExamples = new Gauge({
  name: 'sokar_voice_semantic_eval_examples',
  help: 'Observable examples used in the weekly Jev evaluation by behavior',
  labelNames: ['behavior'] as const,
  registers: [getRegistry()],
});
export const voiceSemanticEvalLastRunTimestampSeconds = new Gauge({
  name: 'sokar_voice_semantic_eval_last_run_timestamp_seconds',
  help: 'Unix timestamp of the most recent weekly Jev evaluation run',
  registers: [getRegistry()],
});
export const voiceSemanticEvalJudgeStatusTotal = new Counter({
  name: 'sokar_voice_semantic_eval_judge_status_total',
  help: 'Weekly Jev evaluation model-judge results by status',
  labelNames: ['status'] as const,
  registers: [getRegistry()],
});
export type VoiceTurnPlanShadowPolicyOutcome = 'accepted' | 'rejected' | 'not_evaluated';
export type VoiceTurnPlanShadowAgreement = 'agree' | 'disagree' | 'not_comparable';

/**
 * Résultats d'observation TurnPlan. Labels strictement bornés : pas de tenant,
 * de transcription, de créneau ni d'identifiant d'appel.
 */
/**
 * Chemin du tour observé : `llm` pour un tour déjà confié au modèle, `deferred`
 * pour un tour que les extracteurs n'ont pas compris et que le canary lui confie,
 * `deterministic` pour un tour répondu sans LLM et observé hors bande.
 */
export type VoiceTurnPlanShadowPath = 'llm' | 'deferred' | 'deterministic';

export const voiceTurnPlanShadowObservationsTotal = new Counter({
  name: 'sokar_voice_turn_plan_shadow_observations_total',
  help: 'Total in-band TurnPlan shadow observations by bounded outcome',
  labelNames: ['status', 'policy_outcome', 'agreement', 'path'] as const,
  registers: [getRegistry()],
});

export function recordVoiceTurnPlanShadowObservation(input: {
  status: VoiceTurnPlanShadowStatus;
  policyOutcome: VoiceTurnPlanShadowPolicyOutcome;
  agreement: VoiceTurnPlanShadowAgreement;
  path: VoiceTurnPlanShadowPath;
}): void {
  voiceTurnPlanShadowObservationsTotal.inc({
    status: input.status,
    policy_outcome: input.policyOutcome,
    agreement: input.agreement,
    path: input.path,
  });
}

export type VoiceTurnPlanShadowDimension =
  | 'intent'
  | 'slots'
  | 'interaction'
  | 'assistant_interaction';

/**
 * Accord TurnPlan par dimension, pour distinguer un désaccord d'intention
 * d'un désaccord de slots ou d'interaction. Labels bornés.
 */
export const voiceTurnPlanShadowDimensionTotal = new Counter({
  name: 'sokar_voice_turn_plan_shadow_dimension_total',
  help: 'In-band TurnPlan shadow agreement by comparison dimension',
  labelNames: ['dimension', 'agreement', 'path'] as const,
  registers: [getRegistry()],
});

export function recordVoiceTurnPlanShadowDimension(
  dimension: VoiceTurnPlanShadowDimension,
  agrees: boolean,
  path: VoiceTurnPlanShadowPath,
): void {
  voiceTurnPlanShadowDimensionTotal.inc({
    dimension,
    agreement: agrees ? 'agree' : 'disagree',
    path,
  });
}

export type VoiceTurnPlanAuthorityField =
  | 'intent'
  | 'date'
  | 'time'
  | 'partySize'
  | 'assistant_interaction';
export type VoiceTurnPlanAuthorityOutcome =
  | 'applied'
  | 'replaced'
  | 'already_set'
  | 'protected'
  | 'tentative'
  | 'unsupported'
  | 'deterministic_fallback';

/**
 * Canary d'autorité TurnPlan : faits appliqués depuis le modèle, déjà connus,
 * ou laissés au repli déterministe. Labels bornés.
 */
export const voiceTurnPlanAuthorityTotal = new Counter({
  name: 'sokar_voice_turn_plan_authority_total',
  help: 'TurnPlan canary authority decisions by field and outcome',
  labelNames: ['field', 'outcome'] as const,
  registers: [getRegistry()],
});

export function recordVoiceTurnPlanAuthority(
  field: VoiceTurnPlanAuthorityField,
  outcome: VoiceTurnPlanAuthorityOutcome,
): void {
  voiceTurnPlanAuthorityTotal.inc({ field, outcome });
}

export type VoiceTurnPlanDeferredOutcome =
  | 'fact_applied'
  | 'no_fact'
  | 'plan_rejected'
  | 'plan_unavailable'
  | 'stall_handoff';

/**
 * Tours non compris par les extracteurs et confiés au modèle par le canary :
 * fait appliqué, aucun fait, plan refusé ou absent, ou retour au déterministe
 * après deux relances. Labels bornés.
 */
export const voiceTurnPlanDeferredTotal = new Counter({
  name: 'sokar_voice_turn_plan_deferred_total',
  help: 'Turns deferred from deterministic re-asks to the model, by outcome',
  labelNames: ['outcome'] as const,
  registers: [getRegistry()],
});

export function recordVoiceTurnPlanDeferred(outcome: VoiceTurnPlanDeferredOutcome): void {
  voiceTurnPlanDeferredTotal.inc({ outcome });
}

// ─── Phase 0 : référence de naturalité voice, par restaurant ───────
// Ces séries portent `restaurant_id` : la cardinalité reste bornée par le
// nombre de restaurants actifs (quelques dizaines), jamais par l'appel.

export type VoiceFirstAudioPath = 'deterministic' | 'llm' | 'availability' | 'fallback' | 'unknown';

/**
 * Fin de parole estimée → premier frame audio envoyé à Telnyx. La fin de
 * parole est le commit STT moins le silence VAD configuré, pour que les
 * gains de détection de fin de tour soient visibles.
 */
export const voiceEndOfSpeechToFirstAudioMs = new Histogram({
  name: 'sokar_voice_end_of_speech_to_first_audio_ms',
  help: 'Fin de parole estimée → premier audio envoyé (ms), par chemin et restaurant',
  labelNames: ['path', 'restaurant_id'] as const,
  buckets: [250, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 6000, 10000],
  registers: [getRegistry()],
});

export const voiceEndOfSpeechToSttFinalMs = new Histogram({
  name: 'sokar_voice_end_of_speech_to_stt_final_ms',
  help: 'Measured end of caller speech to final STT transcript in milliseconds, by what closed the phrase',
  labelNames: ['provider', 'final_trigger'] as const,
  buckets: [100, 200, 350, 500, 750, 1000, 1250, 1500, 2000, 3000, 5000],
  registers: [getRegistry()],
});

/** Fausse fin de tour : le client reprend la parole pendant PROCESSING. */
export const voiceFalseEndOfTurnTotal = new Counter({
  name: 'sokar_voice_false_end_of_turn_total',
  help: 'Reprises de parole du client pendant PROCESSING (fausse fin de tour)',
  labelNames: ['restaurant_id'] as const,
  registers: [getRegistry()],
});

export const voiceFillerEventsTotal = new Counter({
  name: 'sokar_voice_filler_events_total',
  help: 'Fillers vocaux par résultat (started, completed, interrupted) et usage',
  labelNames: ['outcome', 'purpose', 'restaurant_id'] as const,
  registers: [getRegistry()],
});

export const voiceLlmSpokenFallbackTotal = new Counter({
  name: 'sokar_voice_llm_spoken_fallback_total',
  help: 'Voice LLM failures recovered with a spoken deterministic response',
  registers: [getRegistry()],
});

export const voiceEchoSparedTotal = new Counter({
  name: 'sokar_voice_echo_spared_total',
  help: 'Words the echo filter would have removed but kept because the caller was clearly speaking',
  labelNames: ['stage'] as const,
  registers: [getRegistry()],
});
export const voiceEchoSuppressedTotal = new Counter({
  name: 'sokar_voice_echo_suppressed_total',
  help: 'Assistant audio echo suppressed from STT by stage',
  labelNames: ['stage'] as const,
  registers: [getRegistry()],
});
export const voiceNoCallerVoiceTranscriptTotal = new Counter({
  name: 'sokar_voice_no_caller_voice_transcript_total',
  help: 'STT transcripts ignored because the incoming audio held no caller voice, by stage',
  labelNames: ['stage'] as const,
  registers: [getRegistry()],
});

export const voiceTurnPlanShadowByRestaurantTotal = new Counter({
  name: 'sokar_voice_turn_plan_shadow_by_restaurant_total',
  help: 'Observations TurnPlan shadow par statut et restaurant',
  labelNames: ['status', 'restaurant_id'] as const,
  registers: [getRegistry()],
});

export type VoiceTransferMotive =
  | 'caller_request'
  | 'dialogue_stall'
  | 'name_spelling'
  | 'group_size';
export type VoiceTransferOutcome = 'requested' | 'rejected' | 'failed' | 'unconfigured';

/** Transferts au gérant par motif, intention en cours et résultat Telnyx. */
export const voiceTransfersTotal = new Counter({
  name: 'sokar_voice_transfers_total',
  help: 'Transferts vers le gérant par motif, intention, résultat et restaurant',
  labelNames: ['motive', 'intent', 'outcome', 'restaurant_id'] as const,
  registers: [getRegistry()],
});

/** Appels vocaux démarrés : dénominateur des taux par restaurant. */
export const voiceCallsTotal = new Counter({
  name: 'sokar_voice_calls_total',
  help: 'Appels vocaux démarrés par restaurant',
  labelNames: ['restaurant_id'] as const,
  registers: [getRegistry()],
});

// ─── Render ───────────────────────────────────────────────────

/**
 * Render le payload Prometheus pour /metrics.
 * Format texte, compatible scraper Prometheus / Grafana Agent.
 */
export async function renderMetrics(): Promise<string> {
  return getRegistry().metrics();
}

/**
 * Noms des métriques réellement enregistrées, y compris celles qui n'ont pas
 * encore de valeur (une jauge sans label défini ne produit aucune ligne dans le
 * rendu texte). Utilisé par le garde-fou des règles d'alerte (R1-6).
 */
export function registeredMetricNames(): string[] {
  return getRegistry()
    .getMetricsAsArray()
    .map((metric) => metric.name)
    .sort();
}

/**
 * Reset toutes les métriques (test only).
 */
export function __resetMetrics(): void {
  holdCreatedTotal.reset();
  reservationStateTransitionsTotal.reset();
  reservationMutationsTotal.reset();
  reservationContractObservationsTotal.reset();
  reservationStatusStateMismatchesTotal.reset();
  notificationProviderResultsTotal.reset();
  notificationClaimEventsTotal.reset();
  checkAvailabilityDuration.reset();
  idempotencyHitsTotal.reset();
  piiLeaksTotal.reset();
  doubleBookingAttemptsTotal.reset();
  connectEventsTotal.reset();
  connectReservationsConfirmedTotal.reset();
  connectRequestDuration.reset();
  mcpToolCallsTotal.reset();
  mcpToolCallsByAuthTypeTotal.reset();
  mcpToolErrorsByCodeTotal.reset();
  connectIaBotHitsTotal.reset();
  openaiReserveFeedRequestsTotal.reset();
  failOpenTotal.reset();
  httpRequestsTotal.reset();
  telnyxWebhookEventsTotal.reset();
  telnyxMessagingEventsTotal.reset();
  alertsSentTotal.reset();
  queueJobsGauge.reset();
  callsMissingTranscriptGauge.reset();
  reservationsMissingSmsGauge.reset();
  voiceExpectedAnswerTotal.reset();
  voiceSlotConfidenceTotal.reset();
  voiceReadbackTotal.reset();
  voiceReadbackCorrectedTotal.reset();
  voiceChoiceAnswerTotal.reset();
  voiceRepromptTotal.reset();
  voiceQuestionTotal.reset();
  voiceReservationsCreated7dGauge.reset();
  voiceReservationsChangedAfterCall7dGauge.reset();
  voiceReservationsCancelledAfterCall7dGauge.reset();
  voiceTurnDurationMs.reset();
  voiceLlmFirstTokenMs.reset();
  voiceLlmFirstPhraseMs.reset();
  voiceTtsFirstAudioMs.reset();
  voiceProviderErrorsTotal.reset();
  voiceTtsContextFailureTotal.reset();
  voiceSttProviderAudioMessagesTotal.reset();
  voiceSttProviderChunkBytes.reset();
  elevenLabsCharacterCount.reset();
  openRouterCreditUsd.reset();
  elevenLabsCharacterLimit.reset();
  voiceTurnPlanShadowObservationsTotal.reset();
  voiceSemanticDurationMs.reset();
  voiceSemanticStatusTotal.reset();
  voiceSemanticAgreementTotal.reset();
  voiceSemanticConflictTotal.reset();
  voiceSemanticWouldClarifyTotal.reset();
  voiceSemanticAdvisoryTotal.reset();
  voiceSemanticInputTokensTotal.reset();
  voiceSemanticChoiceConfidence.reset();
  voiceSemanticAnswerSkippedTotal.reset();
  voiceSemanticEvalPrecision.reset();
  voiceSemanticEvalRecall.reset();
  voiceSemanticEvalExamples.reset();
  voiceSemanticEvalLastRunTimestampSeconds.reset();
  voiceSemanticEvalJudgeStatusTotal.reset();
  voiceTurnPlanShadowDimensionTotal.reset();
  voiceTurnPlanAuthorityTotal.reset();
  voiceTurnPlanDeferredTotal.reset();
  voiceEndOfSpeechToFirstAudioMs.reset();
  voiceEndOfSpeechToSttFinalMs.reset();
  voiceFalseEndOfTurnTotal.reset();
  voiceFillerEventsTotal.reset();
  voiceLlmSpokenFallbackTotal.reset();
  voiceEchoSuppressedTotal.reset();
  voiceNoCallerVoiceTranscriptTotal.reset();
  voiceTurnPlanShadowByRestaurantTotal.reset();
  voiceTransfersTotal.reset();
  voiceCallsTotal.reset();
}

// ─── Suppernote Connect (Phase 1) ────────────────────────────────────────

/**
 * Compteur global des events Suppernote Connect. Labels limités pour éviter la
 * cardinalité infinie (cf. spec v1.1 §16.1 — events standardisés).
 * Labels : event (page_view, cta_clicked, availability_requested,
 *                hold_created, hold_expired, reservation_confirmed,
 *                reservation_failed) × source (web, google, chatgpt, ...).
 */
export const connectEventsTotal = new Counter({
  name: 'sokar_connect_events_total',
  help: 'Total Suppernote Connect events received',
  labelNames: ['event', 'source'] as const,
  registers: [getRegistry()],
});

/**
 * Réservations confirmées via Suppernote Connect (par source).
 * Permet de calculer la conversion par canal SEO/agentic.
 */
export const connectReservationsConfirmedTotal = new Counter({
  name: 'sokar_connect_reservations_confirmed_total',
  help: 'Total reservations confirmed via Suppernote Connect',
  labelNames: ['source', 'city'] as const,
  registers: [getRegistry()],
});

/**
 * Latence des requêtes sur les routes publiques Suppernote Connect.
 * Permet de calculer le p95 (cible < 500ms, spec v1.1 §11.2).
 * Labels : route (slug, availability, hold, confirm) × status (2xx, 4xx, 5xx).
 */
export const connectRequestDuration = new Histogram({
  name: 'sokar_connect_request_duration_ms',
  help: 'Duration of Suppernote Connect public API requests in milliseconds',
  labelNames: ['route', 'status'] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [getRegistry()],
});

// ─── MCP Server (agentic reservations) ─────────────────────────────

/**
 * Compteur historique des appels au registre d'outils par nom et résultat.
 * Il agrège MCP et generic_agent ; les nouvelles ventilations permettent de
 * filtrer le transport.
 */
export const mcpToolCallsTotal = new Counter({
  name: 'sokar_mcp_tool_calls_total',
  help: 'Total tool registry calls by tool name and status',
  labelNames: ['tool', 'status'] as const,
  registers: [getRegistry()],
});

/**
 * Appels d'outils ventilés par transport et OAuth/API key. `tool`, `status`,
 * `auth_type` et `transport` sont normalisés vers des valeurs finies ; aucun ID client, nom fourni par un
 * client ou détail de réservation n'est exposé.
 */
export const mcpToolCallsByAuthTypeTotal = new Counter({
  name: 'sokar_mcp_tool_calls_by_auth_type_total',
  help: 'Total tool calls by tool, result, bounded authentication type and transport',
  labelNames: ['tool', 'status', 'auth_type', 'transport'] as const,
  registers: [getRegistry()],
});

/** Erreurs d'outils par code stable, transport et type d'authentification. */
export const mcpToolErrorsByCodeTotal = new Counter({
  name: 'sokar_mcp_tool_errors_by_code_total',
  help: 'Total tool errors by tool, bounded error code, authentication type and transport',
  labelNames: ['tool', 'error_code', 'auth_type', 'transport'] as const,
  registers: [getRegistry()],
});

const MCP_TOOL_LABELS = new Set([
  'search_restaurants',
  'get_restaurant_details',
  'check_availability',
  'create_reservation',
  'create_quote',
  'create_hold',
  'join_waiting_list',
  'cancel_waiting_list',
  'modify_reservation',
  'cancel_reservation',
  'get_reservation_status',
]);

const MCP_ERROR_CODE_LABELS = new Set([
  'ALREADY_EXISTS',
  'FORBIDDEN',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_DATETIME',
  'INTERNAL',
  'INVALID_HOLD',
  'INVALID_INPUT',
  'INVALID_STATE',
  'NOT_FOUND',
  'POLICY_VIOLATION',
  'RATE_LIMITED',
  'SLOT_AVAILABLE',
  'SLOT_UNAVAILABLE',
  'UNKNOWN_TOOL',
  'WAITING_LIST_DISABLED',
  'WAITING_LIST_FULL',
]);

/** Enregistre les métriques d'outils sans laisser les labels dépendre de l'entrée brute. */
export function recordMcpToolCall(
  toolName: string,
  status: 'success' | 'error',
  credentialType?: 'api_key' | 'oauth',
  errorCode?: string,
  transport?: 'mcp' | 'generic_agent',
): void {
  const tool = MCP_TOOL_LABELS.has(toolName) ? toolName : 'unknown';
  const authType =
    credentialType === 'oauth' || credentialType === 'api_key' ? credentialType : 'unknown';
  const transportLabel =
    transport === 'mcp' || transport === 'generic_agent' ? transport : 'unknown';
  const labels = { tool, status };

  mcpToolCallsTotal.inc(labels);
  mcpToolCallsByAuthTypeTotal.inc({ ...labels, auth_type: authType, transport: transportLabel });

  if (status === 'error') {
    mcpToolErrorsByCodeTotal.inc({
      tool,
      auth_type: authType,
      error_code: errorCode && MCP_ERROR_CODE_LABELS.has(errorCode) ? errorCode : 'OTHER',
      transport: transportLabel,
    });
  }
}

/**
 * Hits par bot IA sur les pages publiques Connect (crawl web).
 * Détecté côté Connect middleware (Edge), forwardé en fire-and-forget vers
 * l'endpoint analytics API qui incrémente ce compteur via la queue BullMQ.
 * Labels : bot (GPTBot, ClaudeBot, ...) × path_class (restaurant, llms.txt,
 *           sitemap, robots, well-known) — cardinalité bornée.
 */
export const connectIaBotHitsTotal = new Counter({
  name: 'sokar_connect_ia_bot_hits_total',
  help: 'Total IA bot hits on Suppernote Connect public pages',
  labelNames: ['bot', 'path_class'] as const,
  registers: [getRegistry()],
});

// ─── Monitoring ops (alerting actif) ─────────────────────────────────────

/**
 * Webhooks Telnyx reçus, par route et résultat.
 * Alimente l'alerte « webhook Telnyx en erreur » (worker system-health).
 * Labels : event (voice, voice_end) × result (processed, error, rejected).
 */
export const telnyxWebhookEventsTotal = new Counter({
  name: 'sokar_telnyx_webhook_events_total',
  help: 'Total Telnyx webhook events by route and result',
  labelNames: ['event', 'result'] as const,
  registers: [getRegistry()],
});

/**
 * Événements de messagerie Telnyx reçus, avec statut de livraison borné.
 * Aucun identifiant de message ou numéro de téléphone n'est exposé en label.
 */
export const telnyxMessagingEventsTotal = new Counter({
  name: 'sokar_telnyx_messaging_events_total',
  help: 'Total Telnyx messaging webhook events by event type and bounded status',
  labelNames: ['event', 'status'] as const,
  registers: [getRegistry()],
});

/**
 * Alertes ops dispatchées par le monitoring (worker system-health + watchdog).
 * Permet de vérifier que le canal d'alerte fonctionne (absence totale = silencieux).
 * Labels : kind × channel (email, webhook, sms, sentry) × result (ok, error).
 */
export const alertsSentTotal = new Counter({
  name: 'sokar_alerts_sent_total',
  help: 'Total ops alerts dispatched by kind, channel and result',
  labelNames: ['kind', 'channel', 'result'] as const,
  registers: [getRegistry()],
});

/**
 * Profondeur des files BullMQ par état, rafraîchie à chaque tick du worker
 * system-health (toutes les 5 min). Alimente les alertes jobs en échec /
 * dead-letter et le futur scraping Prometheus.
 */
export const queueJobsGauge = new Gauge({
  name: 'sokar_queue_jobs',
  help: 'BullMQ job counts by queue and state (refreshed every 5 min)',
  labelNames: ['queue', 'state'] as const,
  registers: [getRegistry()],
});

/** Appels Telnyx des dernières 24h sans transcription ou sans outcome. */
export const callsMissingTranscriptGauge = new Gauge({
  name: 'sokar_calls_missing_transcript_24h',
  help: 'Calls in the last 24h without transcript or outcome (refreshed every 5 min)',
  registers: [getRegistry()],
});

/** Réservations des dernières 24h confirmées sans SMS de confirmation tracé. */
export const reservationsMissingSmsGauge = new Gauge({
  name: 'sokar_reservations_missing_confirmation_sms_24h',
  help: 'Reservations in the last 24h without a confirmation SMS audit trail (refreshed every 5 min)',
  registers: [getRegistry()],
});

/** Réservations vocales créées dans les sept derniers jours. */
export const voiceReservationsCreated7dGauge = new Gauge({
  name: 'sokar_voice_reservations_created_7d',
  help: 'Phone reservations linked to calls and created in the last 7 days',
  registers: [getRegistry()],
});

/** Réservations vocales modifiées dans les 48 h, d'après les noms de champs audités. */
export const voiceReservationsChangedAfterCall7dGauge = new Gauge({
  name: 'sokar_voice_reservations_changed_after_call_7d',
  help: 'Voice reservations edited within 48 hours of creation, by field',
  labelNames: ['field'] as const,
  registers: [getRegistry()],
});

/** Réservations vocales annulées après l'appel de création, dans la cohorte 7 j. */
export const voiceReservationsCancelledAfterCall7dGauge = new Gauge({
  name: 'sokar_voice_reservations_cancelled_after_call_7d',
  help: 'Voice reservations with a cancellation audit event after creation in the last 7 days',
  registers: [getRegistry()],
});

/**
 * État de conformité des SLO (R0-5), rafraîchi à chaque tick du worker
 * alert-evaluation (toutes les 5 min).
 *
 * Valeurs : 1 = objectif tenu, 0 = objectif manqué, -1 = pas de mesure
 * (aucun trafic dans la fenêtre, ou baseline absente après un redémarrage).
 * Le runbook `docs/runbooks/slo.md` décrit les objectifs et la réaction.
 */
export const sloStatusGauge = new Gauge({
  name: 'sokar_slo_status',
  help: 'SLO compliance: 1 met, 0 breached, -1 unknown',
  labelNames: ['slo'] as const,
  registers: [getRegistry()],
});

/** Valeur mesurée du SLO, dans son unité (ratio ou millisecondes). */
export const sloValueGauge = new Gauge({
  name: 'sokar_slo_value',
  help: 'Measured SLO value in its own unit (ratio or milliseconds)',
  labelNames: ['slo', 'unit'] as const,
  registers: [getRegistry()],
});

/**
 * Sessions vocales simultanées tenues par le process (R1-3).
 *
 * Capacité locale mesurée le 21/09/2026 sur le poste de dev : ~100 sessions
 * concurrentes saturent le CPU (pic 95 %) avec des fournisseurs neutralisés,
 * pour ~2,3 Mo de RSS par session. C'est un plancher : l'acheminement STT et la
 * lecture TTS ne sont pas exercés dans ce test, donc la saturation réelle arrive
 * plus tôt. Le seuil d'alerte à 70 laisse 30 % de marge sous ce plancher et doit
 * être confirmé en staging puis sur le VPS.
 * Cf. `docs/audits/2026-09-21-voice-load-report.md`.
 */
export const voiceActiveSessionsGauge = new Gauge({
  name: 'sokar_voice_active_sessions',
  help: 'Concurrent voice sessions held by this process',
  registers: [getRegistry()],
});
