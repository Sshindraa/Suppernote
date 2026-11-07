/**
 * Accueil adapté au style de la maison (réglages « Style » et « Ton de voix » de l'onboarding).
 *
 * L'accueil est la première chose que l'appelant entend : il doit déjà sonner comme la maison. Il n'est pas écrit à
 * la main : un modèle compose trois variantes d'après les consignes de registre du prompt de dialogue, puis désigne
 * celle qui sonne le mieux. Le résultat est gardé dans Redis par restaurant et par réglage (30 jours). Réglage par
 * défaut ou défaillance : l'accueil fixe d'avant. Le code ne juge que la structure (nom présent, longueur, pas de chiffre).
 */
import crypto from 'node:crypto';
import { voiceConfig } from '../../../env';
import { redisCache } from '../../../shared/redis/client';
import { logger } from '../../../shared/logger/pino';
import { personalityStyleLines } from '../prompts';
import { AGENT_NAME, AGENT_TITLE } from '../agent-identity';

export interface GreetingStyle {
  profileType?: string;
  fillerStyle?: string;
}

/** Trois variantes, et le numéro (1 à 3) de celle que le modèle juge la plus naturelle pour cette maison. */
export interface GreetingDraft {
  variants: string[];
  best: number;
}

export type GreetingLlm = (
  restaurantName: string,
  style: GreetingStyle,
  timeoutMs: number,
) => Promise<GreetingDraft | null>;

export interface GreetingStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

export interface ResolveOptions {
  store?: GreetingStore;
  llm?: GreetingLlm;
  /** Essais du modèle : 2 à l'enregistrement des réglages, 1 pendant un appel. */
  attempts?: number;
  /** Délai d'un essai : court pendant un appel (l'appelant attend), plus long à l'enregistrement. */
  timeoutMs?: number;
}

const GREETING_TTL_SECONDS = 30 * 24 * 3600;
const CALL_TIME_TIMEOUT_MS = 1_200;

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Vrai quand le réglage n'est pas le défaut : seul cas où un accueil est composé. */
export function hasStyledGreeting(style: GreetingStyle | null | undefined): boolean {
  return personalityStyleLines(style).length > 0;
}

/** Clé de cache : elle change avec le nom, le réglage et le texte des consignes de registre. */
export function greetingCacheKey(restaurantName: string, style: GreetingStyle): string {
  const material = [
    restaurantName,
    style.profileType ?? '',
    style.fillerStyle ?? '',
    personalityStyleLines(style).join('\n'),
  ].join('|');
  const digest = crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
  return `greeting:v4:${digest}`;
}

/**
 * Contrôles de structure : le nom y est, l'accueil présente l'assistante et dit qu'elle est une IA
 * (règlement européen sur l'IA, article 50 : l'appelant doit savoir qu'il parle à une IA), la phrase
 * reste courte, sans chiffre ni point d'exclamation. Sans l'annonce, l'accueil fixe est utilisé.
 */
export function isValidGreeting(text: string, restaurantName: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12 || trimmed.length > 150) return false;
  if (/[\d!\n]/.test(trimmed)) return false;
  if ((trimmed.match(/[.?]/g) ?? []).length > 3) return false;
  const folded = fold(trimmed);
  if (!/\bassistante? (?:ia|virtuel(?:le)?)\b/.test(folded)) return false;
  if (!folded.includes(fold(AGENT_NAME))) return false;
  return fold(trimmed).includes(fold(restaurantName));
}

/** La variante désignée d'abord, puis les autres : la première qui passe les contrôles de structure. */
export function pickVariant(draft: GreetingDraft, restaurantName: string): string | null {
  const index = draft.best - 1;
  const preferred = draft.variants[index];
  const ordered =
    preferred === undefined
      ? draft.variants
      : [preferred, ...draft.variants.filter((_, position) => position !== index)];
  return ordered.find((text) => isValidGreeting(text, restaurantName)) ?? null;
}

/** Lit la réponse du modèle ; tout ce qui n'a pas la forme attendue donne null. */
export function toDraft(value: unknown): GreetingDraft | null {
  if (!value || typeof value !== 'object') return null;
  const { variants, best } = value as { variants?: unknown; best?: unknown };
  if (!Array.isArray(variants)) return null;
  const texts = variants
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim());
  const number = typeof best === 'number' ? best : Number(best);
  return { variants: texts, best: Number.isInteger(number) ? number : 0 };
}

const GREETING_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'greeting_variants',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        variants: { type: 'array', items: { type: 'string' } },
        best: { type: 'integer', enum: [1, 2, 3] },
      },
      required: ['variants', 'best'],
      additionalProperties: false,
    },
  },
} as const;

export function greetingInstructions(style: GreetingStyle): string {
  return [
    `Tu écris l'accueil téléphonique d'un restaurant : la phrase que ${AGENT_NAME}, ${AGENT_TITLE} de la maison, prononce au décroché, avant que l'appelant ne parle.`,
    `Elle nomme le restaurant exactement tel qu'il s'appelle, sans rien y ajouter, et ${AGENT_NAME} s'y présente comme ${AGENT_TITLE}, avec les mots « assistante IA » : l'appelant doit savoir qu'il parle à une IA. Elle est naturelle, courte et dans le registre de la maison décrit ci-dessous. Elle ne donne aucune information (horaire, prix) et n'indique aucune procédure à l'appelant. Une ou deux phrases courtes, toujours au vouvoiement.`,
    'Le registre de la maison :',
    ...personalityStyleLines(style).map((line) => `- ${line}`),
    "Produis trois variantes réellement différentes entre elles, puis donne le numéro (1, 2 ou 3) de celle qui sonnerait le mieux au téléphone pour cette maison. Réponds uniquement par l'objet demandé.",
  ].join('\n');
}

const cerebrasGreeting: GreetingLlm = async (restaurantName, style, timeoutMs) => {
  const apiKey = voiceConfig.CEREBRAS_API_KEY?.trim();
  if (!apiKey) return null;
  const response = await fetch(
    `${voiceConfig.CEREBRAS_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: voiceConfig.VOICE_LLM_MODEL,
        temperature: 0.7,
        max_tokens: 220,
        reasoning_effort: 'none',
        response_format: GREETING_FORMAT,
        messages: [
          { role: 'system', content: greetingInstructions(style) },
          { role: 'user', content: `Nom du restaurant : ${restaurantName}` },
        ],
      }),
    },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return toDraft(JSON.parse(body.choices?.[0]?.message?.content ?? 'null'));
};

/** Accueil composé pour ce restaurant et ce style, ou null (défaut, échec, aucune variante valide). */
export async function resolveStyledGreeting(
  restaurantName: string,
  style: GreetingStyle | null | undefined,
  options: ResolveOptions = {},
): Promise<string | null> {
  if (!style || !hasStyledGreeting(style) || !restaurantName.trim()) return null;
  const store = options.store ?? (redisCache as unknown as GreetingStore);
  const llm = options.llm ?? cerebrasGreeting;
  const key = greetingCacheKey(restaurantName, style);
  try {
    const cached = await store.get(key);
    if (cached && isValidGreeting(cached, restaurantName)) {
      // Glissant : un texte utilisé reste stable, donc son audio aussi (un nouveau texte = un audio à refaire).
      await store.set(key, cached, 'EX', GREETING_TTL_SECONDS).catch(() => undefined);
      return cached;
    }
    const attempts = Math.max(1, options.attempts ?? 1);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const draft = await llm(restaurantName, style, options.timeoutMs ?? CALL_TIME_TIMEOUT_MS);
        const chosen = draft ? pickVariant(draft, restaurantName) : null;
        if (chosen) {
          await store.set(key, chosen, 'EX', GREETING_TTL_SECONDS);
          return chosen;
        }
      } catch (err) {
        // Jamais le nom ni le texte dans les journaux : seulement la cause.
        logger.warn(
          { reason: err instanceof Error ? err.name : 'unknown', attempt },
          '[greeting] styled greeting attempt failed',
        );
      }
    }
    return null;
  } catch (err) {
    logger.warn(
      { reason: err instanceof Error ? err.name : 'unknown' },
      '[greeting] styled greeting unavailable, fixed greeting used',
    );
    return null;
  }
}
