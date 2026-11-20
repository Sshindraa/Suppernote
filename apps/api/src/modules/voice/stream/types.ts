import type { InterruptedReply, SpokenAlignment } from './interrupted-reply';
import type { CallerVoiceActivity } from './caller-voice-activity';
import type { FastBargeInState } from './fast-barge-in';
import type { StructuredTurnState } from './structured-turn/fact-guards';
import type { OpeningHours } from '../prompts';
import type { WebSocket } from 'ws';
import type { VoiceLanguageCode } from './voice-language';

/** États possibles de la conversation */
export type CallState = 'IDLE' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'CLOSING';

/** Acte de parole détecté avant l'orchestration LLM. */
export type VoiceSpeechAct = 'liveness' | 'backchannel' | 'closing' | 'correction' | 'content';

/**
 * `explicit` : extracteur sur une formulation explicite ; `contextual` : nombre
 * nu lu grâce à la question en attente ; `confirmation` : validé par l'appelant ;
 * `model` : complété par un TurnPlan accepté.
 */
export type SlotProvenanceSource = 'explicit' | 'contextual' | 'confirmation' | 'model';

export type NameCollectionState = 'idle' | 'collecting' | 'clarifying' | 'confirming' | 'confirmed';

/** Moment de la journée exprimé par l'appelant. */
export type DayPeriod = 'lunch' | 'dinner';

/** Réponse métier attendue après la dernière question de l'agent. */
export type PendingQuestion =
  | 'date'
  | 'time'
  | 'timeChoice'
  | 'partySize'
  | 'partySizeConfirmation'
  | 'customerName'
  | 'customerPhone'
  | 'confirmation'
  /** Repli humain proposé après un blocage de dialogue (message ou transfert). */
  | 'humanFallback'
  | null;

/** Action proposée et encore en attente de choix explicite. */
export type HumanFallbackMode = 'choice' | 'transfer' | 'message' | null;

export type PendingInteractionKind = Exclude<PendingQuestion, null> | 'open';
export type PendingInteractionStatus = 'active' | 'suspended' | 'resolved' | 'cancelled';
export type PendingInteractionResumePolicy = 'resume_after_child' | 'discard_on_detour' | null;

/** Question/action en attente, avec un cycle de vie distinct de la transcription. */
export interface PendingInteraction {
  id: number;
  kind: PendingInteractionKind;
  prompt: string;
  status: PendingInteractionStatus;
  resumePolicy: PendingInteractionResumePolicy;
  /** Intention métier active au moment où cette question a été posée. */
  intentContext?: ConversationState['intent'];
  fallbackMode?: Exclude<HumanFallbackMode, null>;
  candidatePartySize?: number;
}

/**
 * Niveau du garde-fou anti-boucle pour une relance déterministe :
 * `ask` = première relance, `reformulate` = même question reformulée,
 * `escalate` = repli humain proposé pour ne pas boucler.
 */
export type DialogueStallLevel = 'ask' | 'reformulate' | 'escalate';

export type SpellingTokenKind = 'letter' | 'separator' | 'ambiguous';

/** Token conservé pendant une épellation, y compris quand le STT n'est pas sûr. */
export interface SpellingToken {
  /** Position logique dans le nom (les séparateurs ne consomment pas d'ordinal). */
  position: number;
  raw: string;
  value: string | null;
  kind: SpellingTokenKind;
}

/** État dédié à la collecte du nom, indépendant de la dernière question LLM. */
export interface NameCollection {
  state: NameCollectionState;
  /** Candidat avec `?` aux positions ambiguës, séparateurs explicites conservés. */
  partialCandidate: string;
  tokens: SpellingToken[];
  ambiguousPositions: number[];
  /** Nombre de réponses infructueuses aux demandes de clarification. */
  clarificationCount: number;
  /** Une correction a été détectée mais sa position/lettre reste à préciser. */
  awaitingCorrection: boolean;
  /** Valeur effectivement présentée à l'appelant pour confirmation. */
  presentedCandidate: string | null;
  confirmedName: string | null;
  /** Une prise de message humaine a terminé la collecte sans confirmer le nom. */
  fallbackRecorded: boolean;
}

/** Mot reconnu et ses métadonnées STT. */
export interface SttWord {
  word: string;
  punctuatedWord?: string;
  confidence?: number;
  start?: number;
  end?: number;
}

export type SttFinalTrigger =
  | 'speech_final'
  | 'utterance_end'
  /** UtteranceEnd reçu avant tout segment final : `Finalize` a forcé le segment. */
  | 'utterance_end_finalize'
  /** Partielle Deepgram figée sans fin de phrase : `Finalize` a forcé le segment. */
  | 'stalled_finalize'
  /** Partielle Deepgram en attente et appelant silencieux (détection locale) : `Finalize` a forcé le segment. */
  | 'silence_finalize'
  | 'safety_flush'
  /** Relève au silence : texte rendu par un `Finalize` envoyé au silence réel, tour clos par la règle habituelle. */
  | 'silence_flush'
  | 'spelling_hold'
  | 'semantic_hold';

/**
 * Mémoire métier minimale d'un appel. Le LLM conserve la compréhension fine ;
 * cet état empêche les tours courts de réinitialiser artificiellement le dialogue.
 */
export interface ConversationState {
  intent: 'reservation' | 'availability' | 'cancel' | 'delay' | 'message' | 'gift_card' | null;
  slots: {
    date?: string;
    time?: string;
    partySize?: number;
    customerName?: string;
    customerPhone?: string;
  };
  /**
   * Origine des faits de réservation, liée à la valeur décrite : une origine
   * dont la valeur ne correspond plus au slot est ignorée.
   */
  slotProvenance?: Partial<
    Record<'date' | 'time' | 'partySize', { source: SlotProvenanceSource; value: string | number }>
  >;
  /** Demande d'horaires conservée pendant la collecte date/couverts. */
  wantsAvailabilityOptions?: boolean;
  /** Créneau de journée demandé (« le soir », « à midi »), utilisé pour filtrer les propositions. */
  dayPeriod?: DayPeriod;
  /** Échecs LLM consécutifs, remis à zéro par une réponse LLM réussie. */
  llmFailureStreak?: number;
  /**
   * Deux valeurs phonétiquement proches pour la question en cours (« six ou
   * dix ? »). Posé par `recordUserTurn`, consommé par la réponse du tour.
   */
  answerChoice?: { kind: 'partySize' | 'weekday' | 'time'; values: [string, string] } | null;
  /** Valeurs retenues au dernier tour, relues naturellement dans la question suivante. */
  justFilled?: { partySize?: boolean; date?: boolean; time?: boolean } | null;
  /** Confiance des valeurs du dernier tour, pour la télémétrie (sans texte ni valeur). */
  lastSlotConfidence?: Array<{
    kind: 'partySize' | 'weekday' | 'time';
    confidence: number | null;
    unstable: boolean;
    /** `wouldBe…` : flag de confiance coupé, décision calculée mais non appliquée. */
    decision:
      | 'readBack'
      | 'choice'
      | 'reprompt'
      | 'wouldBeReadBack'
      | 'wouldBeChoice'
      | 'wouldBeReprompt';
  }> | null;
  /**
   * Groupe au-delà du seuil du restaurant : `confirmed` passe à vrai quand
   * l'appelant confirme le nombre (ou le choisit dans « X ou Y ? ») ; le tour
   * est alors confié au gérant (transfert) ou à la prise de message.
   */
  groupRequest?: { partySize: number; confirmed: boolean } | null;
  /** Heure hors des horaires d'ouverture, sans voisin ouvert : redemandée en citant les horaires. */
  closedTimeReprompt?: boolean;
  /** Valeur jugée trop incertaine au dernier tour : la question est reposée autrement. */
  confidenceReprompt?: {
    kind: 'partySize' | 'weekday' | 'time';
    outsideOpeningHours: boolean;
  } | null;
  /** Champ rempli au dernier tour par rapprochement phonétique (jamais en silence). */
  phoneticAccepted?: 'partySize' | 'date' | 'time' | null;
  /** Issue du rapprochement au dernier tour, pour la télémétrie (sans texte). */
  lastExpectedAnswer?: {
    kind: 'partySize' | 'weekday' | 'time';
    status: 'accepted' | 'choice' | 'unresolved';
    bestScore: number | null;
    margin: number | null;
  } | null;
  offeredAvailability?: { date: string; partySize: number; slots: string[] };
  toolInFlight: 'checkAvailability' | null;
  lastAvailabilityCheck: string | null;
  /** Dernier résultat réellement renvoyé par le moteur de disponibilité. */
  lastAvailabilityResult: {
    key: string;
    date: string;
    time: string;
    partySize: number;
    slots: string[];
  } | null;
  /** Contexte explicite utilisé pour interpréter les réponses courtes. */
  pendingQuestion: PendingQuestion;
  lastAssistantQuestion: string | null;
  /** Historique borné des interactions ouvertes, suspendues ou terminées. */
  pendingInteractions: PendingInteraction[];
  nextPendingInteractionId: number;
  /** Clé du dernier récapitulatif de réservation qui attend un accord explicite. */
  pendingReservationConfirmationKey: string | null;
  /** Clé du brouillon accepté explicitement, consommée à la création. */
  confirmedReservationKey: string | null;
  /** Nom épelé détecté, en attente de confirmation explicite par l'appelant. */
  spellingCandidate: string | null;
  nameCollection: NameCollection;
  misunderstandingCount: number;
  /** Relances déterministes consécutives sur la même question sans progrès. */
  stalledTurns: number;
  /** Question actuellement relancée, pour détecter la répétition. */
  stallSignature: string | null;
  /** Vrai tant qu'une proposition de message/transfert attend une réponse. */
  humanFallbackOffered: boolean;
  /** Permet de ne jamais convertir un « oui » en choix entre deux actions. */
  humanFallbackMode: HumanFallbackMode;
  /** Dernière décision du garde-fou anti-boucle, consommée par la télémétrie. */
  lastDialogueGuard: { key: string; level: DialogueStallLevel; count: number } | null;
  closing: boolean;
}

/** Contrat minimal du contexte TTS actif (Cartesia ou ElevenLabs), sans coupler le manager au transport. */
export interface ActiveTtsContext {
  cancel(): void;
  /** Met la lecture en pause (l'appelant a pris la parole) ; `resume` la reprend là où elle en était. */
  pause?(): void;
  resume?(): void;
  /** Texte poussé et audio joué, à lire avant `cancel` : de quoi estimer ce que l'appelant a entendu. */
  interruptionSnapshot?(): {
    text: string;
    playedMs: number;
    totalMs: number | null;
    alignment?: SpokenAlignment;
  };
}

/** Compteurs internes de consommation des providers d'un appel. */
export interface VoiceUsageLlmCounter {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

/** Sorte de requête au modèle, pour savoir où partent les jetons (mesure seulement). */
export type LlmRequestKind =
  | 'turn'
  | 'turn_after_action'
  | 'speculation'
  | 'judge'
  | 'recovery'
  | 'other';

/** Requêtes d'un appel par sorte ; les requêtes interrompues comptent leur entrée estimée (facturée). */
export interface VoiceUsageKindCounter {
  requests: number;
  interrupted: number;
  inputTokens: number;
  /** Part de l'entrée servie par le cache de prompt du fournisseur (cached_tokens), 0 s'il ne le dit pas. */
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Anticipation du tour structuré sur tout l'appel : des comptes et des tokens estimés, jamais de texte.
 * Une anticipation lancée finit reprise (`hits`), jetée au tour par cause (`misses`), remplacée par une
 * partielle plus récente (`replaced`) ou abandonnée sans tour (`cancelled`) ; le reste était en cours à la fin.
 */
export interface VoiceSpeculationCounters {
  launches: number;
  capped: number;
  replaced: number;
  cancelled: number;
  hits: number;
  /** Parmi `hits`, reprises malgré un écart sans conséquence de la phrase (harmlessTranscriptGap). */
  tolerantHits?: number;
  /** Tours sans anticipation à reprendre. */
  none: number;
  misses: Record<string, number>;
  /** Entrée estimée des anticipations jetées (remplacées, ratées, abandonnées) : facturée sans servir. */
  discardedInputTokens: number;
  /** Même entrée par cause : `replaced`, `cancelled` ou l'issue `miss_*` du tour. */
  discardedInputTokensByCause: Record<string, number>;
}

export interface VoiceUsageCounters {
  sttAudioSamples: number;
  /** Audio réellement envoyé à chaque STT, utile quand Deepgram et Cartesia tournent en parallèle. */
  sttAudioSamplesByProvider?: Partial<Record<'deepgram' | 'cartesia', number>>;
  cartesiaTtsCharacters: number;
  elevenLabsTtsCharacters: number;
  llmByProvider: Record<string, Record<string, VoiceUsageLlmCounter>>;
  llmByKind?: Partial<Record<LlmRequestKind, VoiceUsageKindCounter>>;
  speculation?: VoiceSpeculationCounters;
  finalization?: Promise<void>;
}

/** Chemin réellement emprunté par un tour, après exécution. */
export type VoiceTurnPath = 'unknown' | 'deterministic' | 'llm' | 'availability' | 'fallback';

export interface VoiceTurnLatencyTrace {
  startTime: number;
  /** Horodatages/durées ajoutés pour la chronologie de diagnostic. */
  speechStartedAt?: number;
  speechEndAt?: number;
  speechDurationMs?: number;
  sttFinalAt?: number;
  sttFinalMs?: number;
  turnDispatchedAt?: number;
  endOfSpeechToSttFinalMs?: number;
  holdMs?: number;
  endOfSpeechToFirstAudioMs?: number;
  firstAudioIsFiller?: boolean;
  /** Premier son de la vraie réponse quand un son d'attente est parti avant (voir voice-filler.ts). */
  replyAudioSentAt?: number;
  endOfSpeechToReplyAudioMs?: number;
  llmFirstTokenMs?: number;
  llmFirstPhraseMs?: number;
  llmCompletedMs?: number;
  availabilityDurationMs?: number;
  ttsSynthesisStartedAt?: number;
  ttsFirstByteMs?: number;
  audioSentAt?: number;
  ttsCompletedMs?: number;
  interruptedAt?: number;
  totalE2eMs?: number;
}

/** Identité minimisée du tour courant pour les logs d'observabilité. */
export interface VoiceTurnTelemetry {
  id: string;
  /** Position du tour dans l'appel, indépendante de turnCount métier. */
  sequence: number;
  startedAt: number;
  transcriptLength: number;
  transcriptFingerprint: string;
  path: VoiceTurnPath;
  availabilitySearches: number;
  availabilityFailures: number;
  loopDetected: boolean;
  interrupted?: boolean;
  completed: boolean;
  sttProvider?: string;
  llmProvider?: string;
  llmModel?: string;
  ttsProvider?: string;
  /** Snapshot partagé avec la trace héritée, pour ne jamais perdre un tour. */
  latencyTrace?: VoiceTurnLatencyTrace;
  /** Dernier début de recherche, utilisé pour calculer sa durée. */
  availabilityStartedAt?: number;
  endedAt?: number;
  /** Numéro monotone des événements structurés de ce tour. */
  eventSequence?: number;
  /** Dialogue du tour, rempli seulement pour les restaurants de test. */
  debugDialogue?: VoiceTurnDebugDialogue;
}

/** Paroles d'un tour (appels de test uniquement, cf. debug-dialogue.ts). */
export interface VoiceTurnDebugDialogue {
  callerText?: string;
  speechAct?: string;
  agentSpeech: DebugSpeechEntry[];
  fillers: DebugSpeechEntry[];
  tools: string[];
}

/**
 * Réplique de l'agent et sort de son audio, fixé en fin de lecture d'après les
 * trames envoyées à Telnyx pour cette seule réplique. Envoyé ne veut pas dire
 * entendu : une interruption peut encore vider l'audio en attente côté Telnyx.
 */
export interface DebugSpeechEntry {
  text: string;
  status: 'pending' | 'sent' | 'partially_sent' | 'not_sent';
}

/** Événements normalisés produits par le fournisseur STT. */
export type SttEvent =
  | { type: 'UtteranceStart' }
  | {
      type: 'UtteranceEnd';
      transcript: string;
      /** Fournisseur du texte sélectionné, distinct de celui des horodatages. */
      transcriptProvider?: string;
      words?: SttWord[];
      /** Code ISO détecté par le provider STT sur le segment final, si disponible. */
      languageCode?: string;
      speechEndAt?: number;
      sttFinalAt?: number;
      turnDispatchedAt?: number;
      finalTrigger?: SttFinalTrigger;
      providerResultEndMs?: number;
      providerLastWordEndMs?: number;
      receivedAtAudioMs?: number;
      audioClockDriftMs?: number;
      firstPartialAt?: number;
      afterBargeIn?: boolean;
    }
  | { type: 'SpeechResumed' }
  | {
      type: 'Unavailable';
      reason: 'auth' | 'quota' | 'terms' | 'connection' | 'configuration';
      message: string;
    }
  | { type: 'Error'; message: string };

/** Message entrant de Telnyx Media Stream WebSocket */
export interface TelnyxStreamMessage {
  event: 'connected' | 'start' | 'media' | 'stop' | 'dtmf' | 'error' | 'mark';
  sequence_number?: string;
  start?: {
    call_control_id: string;
    call_session_id: string;
    from: string;
    to: string;
    media_format: { encoding: string; sample_rate: number; channels: number };
  };
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // base64
  };
  stop?: {
    call_control_id: string;
  };
  mark?: { name: string };
  stream_id?: string;
}

/** Message de chat au format OpenAI-compatible (Cerebras). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** Session d'un appel avec flux audio */
export interface CallSession {
  callControlId: string;
  streamToken?: string;
  streamStartTimer?: ReturnType<typeof setTimeout> | null;
  callSessionId: string;
  /** call_leg_id Telnyx — utilisé comme callSid en DB */
  callLegId: string;
  from: string;
  to: string;
  restaurantId: string;
  /** Résolution des flags/provider figée au début du Media Stream. */
  voiceFeatureSnapshot?: import('./feature-flags').VoiceFeatureSnapshot;
  /** Horaires d'ouverture du restaurant, pour borner les heures candidates. */
  openingHours?: OpeningHours | null;
  /**
   * Taille de groupe réservable automatiquement (incluse), partagée avec le
   * canal agentique (`RestaurantExposureSettings.maxPartySize`). Absent : 7.
   */
  maxPartySize?: number;
  restaurantName: string;
  /**
   * Appel de démonstration lancé depuis le navigateur pendant l'onboarding. Aucun effet de bord
   * réel : pas d'écriture (réservation, message), pas de transfert, pas de raccrochage Telnyx, pas
   * de finalisation ni de facturation d'appel.
   */
  demo?: boolean;
  /** Numéro E.164 du gérant pour le transfert humain, si configuré. */
  managerPhone?: string | null;
  /** Keyterms métier non personnels préparés pour le chemin Deepgram ciblé. */
  deepgramKeyterms?: string[];
  /** La page Connect publique du restaurant est actuellement publiée. */
  onlineReservationsActive?: boolean;
  /** `Restaurant.smsConfirmEnabled` ; absent : inconnu (contexte en cache d'avant ce champ). */
  smsConfirmEnabled?: boolean;
  timezone: string;
  /** Montant minimum d'une carte cadeau — stocké à la création de session */
  giftCardMinimumAmount: number;
  systemPrompt: string;
  /** État du tour structuré (canary), absent sur le chemin historique. */
  structuredTurn?: StructuredTurnState;
  /** Horodatage de la dernière réservation réellement créée pendant l'appel. */
  reservationCreatedAt?: number;
  state: CallState;
  ended: boolean;
  /** Vrai après l'acceptation Telnyx d'un transfert vers le gérant. */
  handoffInProgress?: boolean;
  /** Conclusion du dernier transfert tenté, consommée par l'orchestrateur LLM. */
  handoffConclusion?: string;
  ending?: {
    markName: string;
    nativePlayback: boolean;
    playbackCompleted: boolean;
    mediaCompleted?: boolean;
    nativeCompleted?: boolean;
    complete?: () => void;
    timer?: ReturnType<typeof setTimeout>;
  };
  turnCount: number;
  isVip: boolean;
  codec: 'PCMA' | 'PCMU' | 'L16';
  history: ChatMessage[];

  // WebSockets
  telnyxWs: WebSocket;
  sttWs: WebSocket | null;
  /** Promise résolue quand le fournisseur STT est connecté (pre-warm) */
  sttReady: Promise<void> | null;
  /** Échecs consécutifs d’ouverture/fermeture avant une connexion STT stable. */
  sttConsecutiveFailures?: number;
  /** Reconnexions du fournisseur STT déjà tentées pendant cet appel (l'ouverture initiale exclue). */
  sttReconnectAttempts?: number;
  sttRetryTimer?: ReturnType<typeof setTimeout> | null;
  sttConnectTimeout?: ReturnType<typeof setTimeout> | null;
  sttConnectionDeadlineTimer?: ReturnType<typeof setTimeout> | null;
  /** Arrêt définitif de la reconnexion après erreur terminale ou repli parlé. */
  sttTerminalFailure?: boolean;
  sttFallbackTriggered?: boolean;
  sttFallbackSpoken?: boolean;
  /** Callback mutable pour les événements STT (remplacé par le handler WS) */
  onSttEvent: ((event: SttEvent) => void) | null;
  /** Modèle STT actif. */
  sttModel?: string;
  /** Fournisseur STT réellement ouvert. */
  sttProviderUsed?: string;
  /** Adaptateur de transport STT actif, figé après le handshake initial. */
  sttAdapter?: import('./stt-provider-adapter').SttProviderAdapter;
  sttProviderOpenedOnce?: boolean;
  sttKeepAliveTimer?: ReturnType<typeof setInterval> | null;
  sttConnectionAudioStartedAt?: number;
  /** Bytes successfully sent on the current provider socket, after conversion. */
  sttConnectionAudioBytesSent?: number;
  /** Voix entendue sur l'audio de l'appelant : garde de silence des fins de tour forcées. */
  callerVoice?: CallerVoiceActivity;
  /** Coupure rapide de l'agent : voix détectée pendant qu'il parle, pause en attente de confirmation. */
  fastBargeIn?: FastBargeInState;
  sttLastNonEmptyPartialAt?: number;
  sttLastSpeechStartedAt?: number;
  /** Fin des mots du dernier tour envoyé à l'agent : la voix qui précède déjà été prise en compte. */
  sttConsumedSpeechEndAt?: number;
  sttTurnStartedAt?: number;
  sttFirstPartialAt?: number;
  sttAfterBargeIn?: boolean;
  /** Le secours Ink-2 a déjà remplacé Deepgram pendant cet appel (une seule fois). */
  sttInkFallbackUsed?: boolean;
  /** Cartesia Ink-2 en parallèle de Deepgram (voir stt-ink-parallel.ts). */
  sttInk?: import('./stt-ink-parallel').InkParallelState;
  /** L'ouverture d'Ink-2 a déjà été tentée pour cet appel. */
  sttInkAttempted?: boolean;
  /** Fins de phrase Deepgram envoyées dans l'ordre pendant l'attente d'Ink-2. */
  sttInkDispatchChain?: Promise<void>;
  /** Ink-2 et Deepgram en désaccord sur le nombre de personnes de cette phrase : à faire confirmer. */
  sttInkNote?: import('./stt-ink-parallel').InkDisagreementNote;
  /** Fins de phrase Deepgram envoyées au dialogue pendant l'appel : une note ne vaut que pour un tour. */
  sttFinalCount?: number;
  sttDeepgramFinalParts?: Array<{
    transcript: string;
    words?: SttWord[];
    languageCode?: string;
    speechEndOffsetMs?: number;
    providerResultEndMs?: number;
    providerLastWordEndMs?: number;
  }>;
  /** Deepgram : mots intermédiaires reçus, pas encore couverts par un segment final. */
  sttDeepgramPendingInterim?: boolean;
  /** Deepgram : `Finalize` envoyé en cours d'appel, le prochain segment final clôt le tour. */
  sttDeepgramFinalizeRequested?: boolean;
  /** Deepgram : dernier texte non vide reçu (partielle ou segment final), horloge serveur. */
  sttDeepgramLastTextAt?: number;
  /** Deepgram : dernière relève au silence envoyée (`Finalize` sur voix sans texte), horloge serveur. */
  sttDeepgramSilenceFlushAt?: number;
  /**
   * Deepgram : texte rendu par une relève au silence, gardé dans les segments finaux et traité comme une
   * partielle (partielle figée, fin jugée par le modèle) ; à l'échéance, le tour part sans nouveau `Finalize`.
   */
  sttDeepgramFlushHeld?: boolean;
  /**
   * Deepgram : rythme des transcriptions partielles depuis le dernier segment
   * final (jamais leur texte dans les logs). Sert à expliquer un segment final
   * tardif : partielles encore en mouvement, ou silence côté fournisseur.
   */
  /** Partielle déjà close par la fin de phrase sur silence local : une seule fois par partielle. */
  sttDeepgramLocalSilenceFinalizedText?: string;
  sttDeepgramPartials?: {
    count: number;
    changes: number;
    lastAt: number;
    lastChangeAt: number;
    lastText: string;
    lastWordCount: number;
  };
  /** Dernière langue détectée par le fournisseur STT sur un segment final. */
  sttLanguageCode?: string;
  /** Langue de dialogue active pour le LLM et le TTS. */
  voiceLanguageCode?: VoiceLanguageCode;
  /** L'appelant a demandé une langue : la détection du fournisseur STT ne la change plus. */
  voiceLanguageLocked?: boolean;
  /**
   * Candidat de changement de langue en attente d'un second segment fiable.
   * Le fournisseur STT peut attribuer une langue différente à un fragment bruité ; on
   * ne change donc pas la langue de dialogue sur une seule détection fragile.
   */
  voiceLanguageCandidate?: {
    code: VoiceLanguageCode;
    count: number;
  } | null;
  /** Indique si le premier paquet audio de la socket STT a déjà été envoyé. */
  sttFirstAudioChunkSent?: boolean;
  /** Tampon de regroupement des trames avant envoi (`VOICE_STT_CHUNK_MS` > 20). */
  sttChunkBuffer?: Buffer | null;
  /** Timer de sécurité : envoie un tampon partiel si le flux s'interrompt. */
  sttChunkTimer?: ReturnType<typeof setTimeout> | null;
  /** Sonde de bande large (premières secondes de parole), codec L16. */
  widebandProbe?: import('./wideband').WidebandProbe | null;
  widebandDetected?: boolean;
  l16EndianProbe?: import('./wideband').L16EndianProbe | null;
  l16MediaFormat?: { encoding: string; sample_rate: number; channels: number };
  l16EndianLogged?: boolean;
  /** Transcriptions partielles du tour en cours (signal d'instabilité). */
  turnPartials?: string[];
  /**
   * Preuves STT de la phrase finale, lues par `recordUserTurn` : mots avec leur
   * confiance et partielles du tour. Rattachées au texte pour ne jamais servir
   * à une autre phrase.
   */
  sttEvidence?: { transcript: string; words?: SttWord[]; partials: string[] } | null;
  /** Dernière phrase appelant envoyée au traitement (déterministe ou LLM). */
  lastProcessedTranscript?: string;
  lastProcessedAt?: number;
  lastProcessedDialogueContext?: string;
  /**
   * Phrase dont la réponse a été annulée par une reprise de parole. Elle est
   * fusionnée avec la suite, ou retraitée seule si aucune suite n'arrive.
   */
  interruptedTurn?: { transcript: string; timer: ReturnType<typeof setTimeout> } | null;
  /** Timer de grâce pour une fin de tour reçue pendant une épellation. */
  sttEndOfTurnTimer?: ReturnType<typeof setTimeout> | null;
  /** Fin de tour retenue parce que la phrase semble inachevée. */
  sttSemanticHold?: {
    transcript: string;
    words?: SttWord[];
    languageCode?: string;
    timing?: { speechEndAt?: number; sttFinalAt?: number; transcriptProvider?: string };
    holdMs: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null;
  /** Fin de tour mise en attente pendant cette courte grâce. */
  pendingSttEndOfTurn?: {
    transcript: string;
    words?: SttWord[];
    languageCode?: string;
    timing?: { speechEndAt?: number; sttFinalAt?: number; transcriptProvider?: string };
    /** Instant où ce segment a été retenu (épellation) : sert à borner l'attente. */
    createdAt?: number;
  } | null;

  // Gestion audio
  audioBuffer: Buffer[];
  isSpeaking: boolean;
  /**
   * File de lecture TTS de l'appel. Les fragments livrés par le LLM arrivent
   * parfois avant que Cartesia ait fini le précédent ; les sérialiser évite
   * deux flux audio Telnyx superposés.
   */
  ttsPlayback: Promise<void>;
  /** Invalide définitivement les fragments TTS interrompus par un barge-in. */
  ttsGeneration: number;
  /** Trames audio réellement envoyées à Telnyx pendant cet appel (voir outbound-audio.ts). */
  audioOut?: { frames: number; bytes: number; dropped: number; lastDropReason?: string };
  /** Invalide une réponse en préparation dès que l'appelant reprend la parole. */
  responseGeneration: number;
  /** Texte agent récent conservé en mémoire uniquement pour filtrer l'écho STT. */
  recentAgentSpeechText?: string;
  recentAgentSpeechTurnId?: string;
  agentAudioActive?: boolean;
  /** Attente de la réplique actuellement synthétisée, connue avant la fin de sa génération. */
  agentReplyAwaiting?: StructuredTurnState['lastAwaiting'];
  agentAudioEndedAt?: number;
  /** Intervalles récents où l'audio de l'agent est parti vers l'appelant (fenêtre anti-écho). */
  agentAudioSpans?: { startedAt: number; endedAt?: number }[];
  /** Répliques récentes de l'agent, avec l'instant où elles ont été demandées. */
  agentSpeechLog?: { text: string; at: number }[];
  /** Contexte TTS optionnel (Cartesia ou ElevenLabs) pour la réponse LLM streamée en cours. */
  ttsContext: ActiveTtsContext | null;
  /** Dernière réponse coupée par l'appelant, jusqu'au prochain tour traité. */
  interruptedReply?: InterruptedReply;
  /** Texte de l'accueil, tant qu'il peut encore être repris après une coupure sans suite. */
  greetingText?: string;
  /** L'accueil est en cours de lecture. */
  greetingPlaying?: boolean;
  /** L'accueil a été coupé et aucun tour n'a été traité depuis. */
  greetingInterrupted?: boolean;
  /** Reste de l'accueil coupé par un tour de l'appelant : dit en tête de la prochaine réplique. */
  greetingUnheard?: string;
  /** Tour utilisateur courant, créé à la finalisation STT. */
  currentTurn: VoiceTurnTelemetry | null;
  /** Tours précédents conservés jusqu'à la finalisation de l'appel. */
  voiceTurnHistory?: VoiceTurnTelemetry[];
  /** Bilan runtime, alimenté à partir des faits et persisté en fin d'appel. */
  voiceCallTelemetry?: {
    finalizedAt?: number;
    reservationConfirmed?: boolean;
    reservationIntentAbandoned?: boolean;
  };
  /** Sérialise les snapshots DB déclenchés par TTS, stop et fermeture WS. */
  voiceTelemetryPersistence?: Promise<void>;
  /** Révisions des tours déjà confirmées en base ; les échecs restent rejouables. */
  voiceTelemetryPersistedTurns?: Record<string, string>;
  /** Compteurs de coût providers, gardés en mémoire puis persistés à la fin. */
  voiceUsage?: VoiceUsageCounters;

  // Barge-in debounce
  /** Nombre de chunks inbound consécutifs reçus pendant SPEAKING */
  bargeInChunks: number;

  // Annulation LLM
  /** AbortController pour annuler la requête LLM en cours */
  abortController: AbortController | null;

  // Transcript cumulé (persistance)
  /** Transcript final cumulé de tout l'appel (concaténation des UtteranceEnd) */
  transcript: string;
  /** Buffer pour accumuler les segments d'un tour de parole */
  turnTranscript: string;
  /** Timer de fallback conservé pour une fin de tour STT tardive */
  speechFinalTimer: ReturnType<typeof setTimeout> | null;

  // Timeouts
  lastActivityAt: number;
  createdAt: number;

  // Latence
  latencyTrace?: VoiceTurnLatencyTrace;
  personality: {
    fillerStyle: 'CASUAL' | 'FORMAL' | 'WARM';
    systemPromptExtra?: string | null;
    speakingRate?: number | null;
    voiceIdCa?: string | null;
    pronunciationDictId?: string | null;
    volume?: number | null;
    emotion?: string | null;
  } | null;
  conversation: ConversationState;
}

/** Config retournée à Telnyx pour lancer le media stream */
export interface MediaStreamConfig {
  stream_url: string;
  stream_track: 'inbound_track';
  stream_bidirectional_mode: 'rtp';
  stream_bidirectional_codec: 'PCMA' | 'PCMU' | 'L16';
}
