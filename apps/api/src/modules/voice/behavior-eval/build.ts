import {
  buildStructuredTurnJsonSchema,
  STRUCTURED_TURN_SCHEMA_NAME,
} from '../stream/structured-turn/schema';
import { buildStructuredTurnMessages } from '../stream/structured-turn/prompt';
import { buildSystemPrompt } from '../prompts';
import { createStructuredTurnState } from '../stream/structured-turn/fact-guards';
import type { BehaviorCase, BehaviorCasesFile, BehaviorProfile } from './types';

/** Après une action exécutée, le modèle ne peut plus que parler ou terminer l'appel. */
const AFTER_ACTION_ACTIONS = ['none', 'end_call'] as const;

export interface BehaviorRequest {
  id: string;
  samples: number;
  messages: ReturnType<typeof buildStructuredTurnMessages>;
  format: {
    type: 'json_schema';
    json_schema: { name: string; strict: true; schema: unknown };
  };
}

function historyOf(testCase: BehaviorCase, file: BehaviorCasesFile) {
  if (typeof testCase.history !== 'string') return testCase.history;
  const named = file.histories?.[testCase.history];
  if (!named) throw new Error(`Historique inconnu « ${testCase.history} » (cas ${testCase.id})`);
  return named;
}

/** Réglages « Style » et « Ton de voix » de l'onboarding, appliqués au prompt (drapeau de style allumé). */
export interface BehaviorPersona {
  profileType?: string;
  fillerStyle?: string;
}

export interface BuildOptions {
  /** Persona du restaurant : absent = prompt d'avant (drapeau de style éteint). */
  persona?: BehaviorPersona;
  /** Vérification de compréhension (reading + understanding), comme le drapeau de production. */
  understanding?: boolean;
}

/**
 * Profil du restaurant du cas : le sien, sinon le profil par défaut du fichier (Chez Suppernote, tel qu'en base).
 * Il n'existe aucune consigne « minimale » : un cas sans vraie base ne se construit pas.
 */
export function profileOf(testCase: BehaviorCase, file: BehaviorCasesFile): BehaviorProfile {
  const id = testCase.profile ?? file.defaultProfile;
  const profile = id ? file.profiles?.[id] : undefined;
  if (!profile) {
    throw new Error(
      `Profil restaurant introuvable « ${id ?? '(aucun profil par défaut)'} » (cas ${testCase.id}) : ` +
        "tous les cas passent par buildSystemPrompt avec la fiche d'un restaurant.",
    );
  }
  if (!profile.name || !profile.openingHours) {
    throw new Error(
      `Profil « ${id} » incomplet : nom et horaires sont requis (cas ${testCase.id})`,
    );
  }
  return profile;
}

export function buildRequest(
  testCase: BehaviorCase,
  file: BehaviorCasesFile,
  options: BuildOptions = {},
): BehaviorRequest {
  const state = createStructuredTurnState();
  state.draft = { date: '', time: '', partySize: 0, customerName: '', ...testCase.draft };
  state.lastAwaiting = (testCase.awaiting ?? 'open') as typeof state.lastAwaiting;
  state.reservationCreated = testCase.reservationCreated === true;
  if (testCase.dayAvailability && state.draft.date) {
    const { slots, upToSize, maxSize, noTableSizes } = testCase.dayAvailability;
    state.dayAvailability = {
      date: state.draft.date,
      closed: false,
      slotsBySize: Object.fromEntries(
        Array.from({ length: maxSize }, (_, index) => [
          index + 1,
          index + 1 <= upToSize ? slots : [],
        ]),
      ),
      ...(noTableSizes ? { noTableSizes } : {}),
    };
  }
  const profile = profileOf(testCase, file);
  const messages = buildStructuredTurnMessages({
    // Toujours la vraie base : le même constructeur qu'en appel (telnyx.pipeline.ts), mode structuré, avec la
    // fiche du restaurant (nom, horaires, fuseau, taille de groupe) et sa consigne propre (`systemPromptExtra`).
    systemPrompt: buildSystemPrompt(
      {
        name: profile.name,
        openingHours: profile.openingHours as never,
        timezone: profile.timezone ?? 'Europe/Paris',
        ...(profile.maxPartySize ? { maxPartySize: profile.maxPartySize } : {}),
        ...(profile.voiceGender ? { voiceGender: profile.voiceGender } : {}),
        ...(profile.systemPromptExtra || options.persona
          ? {
              personality: {
                ...(profile.systemPromptExtra
                  ? { systemPromptExtra: profile.systemPromptExtra }
                  : {}),
                ...options.persona,
              },
            }
          : {}),
        ...(options.persona ? { personalityStyleEnabled: true } : {}),
      },
      new Date(`${file.today}T12:00:00Z`),
    ),
    history: historyOf(testCase, file) as never,
    transcript: testCase.transcript,
    state,
    openingHours: profile.openingHours,
    today: file.today,
    ...(testCase.dayPart ? { dayPart: testCase.dayPart } : {}),
    ...(testCase.callerFinished ? { callerFinished: true } : {}),
    ...(testCase.recovery ? { recovery: testCase.recovery } : {}),
    ...(testCase.actionResult ? { actionResult: testCase.actionResult } : {}),
    ...(options.understanding ? { understanding: true } : {}),
  });
  return {
    id: testCase.id,
    samples: testCase.samples ?? 12,
    messages,
    format: {
      type: 'json_schema',
      json_schema: {
        name: STRUCTURED_TURN_SCHEMA_NAME,
        strict: true,
        schema: buildStructuredTurnJsonSchema(
          testCase.actions
            ? (testCase.actions as never)
            : testCase.actionResult
              ? (AFTER_ACTION_ACTIONS as never)
              : undefined,
          // Comme en appel : la relance après un silence impose turnComplete=true.
          {
            turnCompleteOnly: testCase.callerFinished === true || testCase.recovery !== undefined,
            ...(options.understanding ? { understanding: true } : {}),
          },
        ),
      },
    },
  };
}

export function buildRequests(
  file: BehaviorCasesFile,
  options: BuildOptions = {},
): BehaviorRequest[] {
  return file.cases.map((testCase) => buildRequest(testCase, file, options));
}
