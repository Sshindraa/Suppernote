/**
 * Sortie structurée d'un tour vocal : le modèle comprend le tour, tient le
 * brouillon de réservation, choisit une action et formule sa réponse, en un seul
 * appel. Le code ne classe rien lui-même : il valide ces champs et exécute les
 * actions autorisées.
 *
 * L'ordre des clés est celui du schéma (Cerebras, mode strict) : `say` vient en
 * dernier pour être lu en streaming pendant sa génération ; `turnComplete` en
 * premier pour savoir au plus tôt si l'appelant a fini de parler. `amorce` suit la lecture de compréhension : ces
 * quelques mots partent vers la voix avant que le brouillon et l'action ne soient écrits (voir engine.ts).
 */

export const STRUCTURED_TURN_INTERPRETATIONS = [
  'answer',
  'question',
  'correction',
  'affirmation',
  'decline',
  'new_request',
  'end_call',
  'unclear',
] as const;

export const STRUCTURED_TURN_AWAITING = [
  'none',
  'date',
  'time',
  'partySize',
  'customerName',
  'customerNameConfirmation',
  'confirmation',
  'confirmationResume',
  'humanFallback',
  'open',
] as const;

/**
 * `clear` : pour chaque valeur ajoutée ou changée dans le brouillon, les mots de l'appelant suffisent à
 * savoir de quelle information il s'agit. `doubtful` : le modèle a dû deviner (voir COMPRÉHENSION VÉRIFIÉE
 * dans prompt.ts). Le code applique cette déclaration : aucun changement de brouillon, aucune action.
 */
export const STRUCTURED_TURN_UNDERSTANDING = ['clear', 'doubtful'] as const;

/**
 * Ton de la phrase pour la voix (balise d'expression ElevenLabs v4). `none` par défaut. Liste courte et sobre :
 * `warm` a perdu les deux paires où il figurait à l'écoute à l'aveugle du 16/10/2026.
 */
export const STRUCTURED_TURN_TONES = [
  'none',
  'cheerful',
  'apologetic',
  'amused',
  'reassuring',
] as const;

export const STRUCTURED_TURN_ACTIONS = [
  'none',
  'check_availability',
  'create_reservation',
  'take_message',
  'transfer',
  'end_call',
] as const;

export type StructuredTurnInterpretation = (typeof STRUCTURED_TURN_INTERPRETATIONS)[number];
export type StructuredTurnAwaiting = (typeof STRUCTURED_TURN_AWAITING)[number];
export type StructuredTurnAction = (typeof STRUCTURED_TURN_ACTIONS)[number];
export type StructuredTurnUnderstanding = (typeof STRUCTURED_TURN_UNDERSTANDING)[number];
export type StructuredTurnTone = (typeof STRUCTURED_TURN_TONES)[number];

/** Brouillon tenu par le modèle ; chaîne vide ou 0 = inconnu. */
export interface StructuredTurnDraft {
  date: string;
  time: string;
  partySize: number;
  customerName: string;
}

export interface StructuredTurnOutput {
  /** Faux quand l'appelant n'a visiblement pas fini sa phrase : l'agent se tait. */
  turnComplete: boolean;
  /** Lecture littérale de ce que l'appelant a dit, avant le brouillon (seulement avec la vérification de compréhension). */
  reading?: string;
  understanding?: StructuredTurnUnderstanding;
  /** Premiers mots dits avant le reste, repris de ce que l'appelant vient de dire ; vide le plus souvent. */
  amorce?: string;
  interpretation: StructuredTurnInterpretation;
  draft: StructuredTurnDraft;
  awaiting: StructuredTurnAwaiting;
  action: StructuredTurnAction;
  message: string;
  confidence: 'high' | 'medium' | 'low';
  /** Ton de la voix pour `say` (seulement avec le ton d'expression activé). */
  tone?: StructuredTurnTone;
  say: string;
}

export const STRUCTURED_TURN_SCHEMA_NAME = 'voice_turn';

/**
 * Schéma JSON strict. `actions` restreint les actions possibles : après une
 * action exécutée, le second passage ne peut que parler ou terminer l'appel.
 */
export function buildStructuredTurnJsonSchema(
  actions: readonly StructuredTurnAction[] = STRUCTURED_TURN_ACTIONS,
  options: {
    turnCompleteOnly?: boolean;
    understanding?: boolean;
    tone?: boolean;
    amorce?: boolean;
  } = {},
) {
  // Premier passage seulement : après une action ou un fait du code, le moteur ne dit pas d'amorce.
  const amorce = options.amorce ? { amorce: { type: 'string' } } : {};
  // `tone` juste avant `say` : il est connu quand la phrase commence.
  const tone = options.tone ? { tone: { type: 'string', enum: [...STRUCTURED_TURN_TONES] } } : {};
  // `reading` puis `understanding` avant le brouillon : le modèle lit avant de décider.
  const understanding = options.understanding
    ? {
        reading: { type: 'string' },
        understanding: { type: 'string', enum: [...STRUCTURED_TURN_UNDERSTANDING] },
      }
    : {};
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Relance après un silence : le tour est terminé, le modèle doit parler.
      turnComplete: options.turnCompleteOnly
        ? { type: 'boolean', enum: [true] }
        : { type: 'boolean' },
      ...understanding,
      ...amorce,
      interpretation: { type: 'string', enum: [...STRUCTURED_TURN_INTERPRETATIONS] },
      draft: {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string' },
          time: { type: 'string' },
          partySize: { type: 'integer' },
          customerName: { type: 'string' },
        },
        required: ['date', 'time', 'partySize', 'customerName'],
      },
      awaiting: { type: 'string', enum: [...STRUCTURED_TURN_AWAITING] },
      action: { type: 'string', enum: [...actions] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      ...tone,
      say: { type: 'string' },
      // Après say : seul take_message le remplit, et say y est vide ; avant, il retardait chaque premier son.
      message: { type: 'string' },
    },
    required: [
      'turnComplete',
      ...(options.understanding ? ['reading', 'understanding'] : []),
      ...(options.amorce ? ['amorce'] : []),
      'interpretation',
      'draft',
      'awaiting',
      'action',
      'confidence',
      ...(options.tone ? ['tone'] : []),
      'say',
      'message',
    ],
  } as const;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** Valide la forme ; les valeurs métier sont vérifiées par les garde-fous. */
export function parseStructuredTurnOutput(raw: string): StructuredTurnOutput | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const draft = record.draft as Record<string, unknown> | undefined;
  if (
    typeof record.turnComplete !== 'boolean' ||
    !isOneOf(STRUCTURED_TURN_INTERPRETATIONS, record.interpretation) ||
    !isOneOf(STRUCTURED_TURN_AWAITING, record.awaiting) ||
    !isOneOf(STRUCTURED_TURN_ACTIONS, record.action) ||
    !isOneOf(['high', 'medium', 'low'] as const, record.confidence) ||
    typeof record.say !== 'string' ||
    typeof record.message !== 'string' ||
    typeof draft !== 'object' ||
    draft === null ||
    typeof draft.date !== 'string' ||
    typeof draft.time !== 'string' ||
    typeof draft.partySize !== 'number' ||
    typeof draft.customerName !== 'string'
  ) {
    return null;
  }
  return {
    turnComplete: record.turnComplete,
    // Présents seulement avec la vérification de compréhension ; absents = lecture non demandée.
    ...(typeof record.reading === 'string' ? { reading: record.reading } : {}),
    ...(isOneOf(STRUCTURED_TURN_UNDERSTANDING, record.understanding)
      ? { understanding: record.understanding }
      : {}),
    ...(typeof record.amorce === 'string' ? { amorce: record.amorce } : {}),
    interpretation: record.interpretation,
    draft: {
      date: draft.date,
      time: draft.time,
      partySize: draft.partySize,
      customerName: draft.customerName,
    },
    awaiting: record.awaiting,
    action: record.action,
    message: record.message,
    confidence: record.confidence,
    ...(isOneOf(STRUCTURED_TURN_TONES, record.tone) ? { tone: record.tone } : {}),
    say: record.say,
  };
}

/** Résultat déjà obtenu : aucune donnée de réservation ni nouvelle action à générer. */
export const AFTER_ACTION_SCHEMA_NAME = 'voice_action_reply';
export const AFTER_ACTION_ACTIONS = ['none', 'end_call'] as const;

export function buildAfterActionJsonSchema(options: { tone?: boolean } = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      awaiting: { type: 'string', enum: [...STRUCTURED_TURN_AWAITING] },
      action: { type: 'string', enum: [...AFTER_ACTION_ACTIONS] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      ...(options.tone ? { tone: { type: 'string', enum: [...STRUCTURED_TURN_TONES] } } : {}),
      say: { type: 'string' },
    },
    required: ['awaiting', 'action', 'confidence', ...(options.tone ? ['tone'] : []), 'say'],
  } as const;
}

/** Adapte la formulation au moteur existant, sans laisser le modèle réécrire le brouillon vérifié. */
export function parseAfterActionOutput(
  raw: string,
  draft: StructuredTurnDraft,
  interpretation: StructuredTurnInterpretation = 'answer',
): StructuredTurnOutput | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['awaiting', 'action', 'confidence', 'tone', 'say'].includes(key),
    ) ||
    !isOneOf(STRUCTURED_TURN_AWAITING, record.awaiting) ||
    !isOneOf(AFTER_ACTION_ACTIONS, record.action) ||
    !isOneOf(['high', 'medium', 'low'] as const, record.confidence) ||
    (record.tone !== undefined && !isOneOf(STRUCTURED_TURN_TONES, record.tone)) ||
    typeof record.say !== 'string'
  )
    return null;
  return {
    turnComplete: true,
    understanding: 'clear',
    interpretation: record.action === 'end_call' ? 'end_call' : interpretation,
    draft: { ...draft },
    awaiting: record.awaiting,
    action: record.action,
    message: '',
    confidence: record.confidence,
    ...(isOneOf(STRUCTURED_TURN_TONES, record.tone) ? { tone: record.tone } : {}),
    say: record.say,
  };
}
