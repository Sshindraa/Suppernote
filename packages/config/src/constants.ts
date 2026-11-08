import { PRICING_CATALOG } from '@suppernote/shared';

export const PLANS = {
  ESSENTIAL: { label: 'Essential', price: PRICING_CATALOG.essential.monthlyCents / 100 },
  PRO: { label: 'Pro', price: PRICING_CATALOG.pro.monthlyCents / 100 },
  MULTI_SITE: {
    label: 'Multi-restaurant',
    price: PRICING_CATALOG['multi-site'].monthlyCents / 100,
  },
} as const;

// Legacy mapping — DB still uses STARTER / PREMIUM until migration
export const PLAN_LABEL_MAP: Record<string, string> = {
  STARTER: 'Essential',
  PRO: 'Pro',
  PREMIUM: 'Multi-restaurant',
};

export const PLAN_PRICE_MAP: Record<string, number> = {
  ESSENTIAL: PRICING_CATALOG.essential.monthlyCents / 100,
  STARTER: PRICING_CATALOG.essential.monthlyCents / 100,
  PRO: PRICING_CATALOG.pro.monthlyCents / 100,
  PREMIUM: PRICING_CATALOG['multi-site'].monthlyCents / 100,
};

export const INTERNAL_CALL_ALERT_THRESHOLD = 3000;
export const REDIS_CTX_TTL_SECONDS = 300;
export const SMS_RATE_LIMIT_SECONDS = 900;
/** Default maximum group size shared by online and phone reservations. */
export const DEFAULT_MAX_PARTY_SIZE = 7;

// Follow Cartesia's latest stable Sonic 3.6 snapshot automatically.
// Change this deliberately if reproducible voice behavior becomes a release gate.
export const CARTESIA_MODEL = 'sonic-3.6';
export const DEFAULT_CARTESIA_VOICE_ID = '90358bc7-3328-4b93-a942-d0447d7d4b5c';

// ─── Phase 2 — TTS Cache ─────────────────────────────────────────────────
export const TTS_CACHE_TTL_SECONDS = 86_400 * 7; // 7 jours
export const TTS_CACHE_MIN_LENGTH = 8;

// ─── Filler Cache (persistant en Redis) ────────────────────────────────────
// Les fillers audio sont pré-générés au boot et cachés 30 jours pour éviter
// de payer Cartesia à chaque restart pm2. 13 fillers × ~200 bytes = ~5 KB total.
export const FILLER_CACHE_TTL_SECONDS = 86_400 * 30; // 30 jours

// ─── Phase 2 — ROI / TheFork ──────────────────────────────────────────────
export const THEFORK_COMMISSION_PER_PAX = 3;
export const DEFAULT_AVERAGE_TICKET = 35; // € par personne — fallback si pas de estimatedRevenue en DB

// ─── Phase 2 — VIP / LLM ──────────────────────────────────────────────────
export const VIP_PARTY_SIZE_THRESHOLD = 6;
export const SPECULATIVE_MISS_THRESHOLD = 0.6;
export const LLM_VIP_TURN_THRESHOLD = 5;

// Modèle LLM utilisé dans le pipeline vocal (pas le modèle Hermes).
//
// Fournisseur LLM vocal unique : Cerebras (API OpenAI-compatible), modèle
// qwen-3.8-27b en mode instruct, raisonnement désactivé, streaming.
//
// Le modèle reste configurable par environnement (`VOICE_LLM_MODEL`). Une
// panne dégrade l'appel vers le secours OpenRouter du tour structuré, puis vers
// une réponse parlée déterministe.
export const VOICE_LLM_MODEL_DEFAULT = 'qwen-3.8-27b';
export const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
export const RESPAN_BASE_URL = 'https://api.respan.ai/api/v1';
/** Fournisseur LLM vocal (API OpenAI-compatible). */
export const VOICE_LLM_PROVIDERS = ['cerebras'] as const;
export type VoiceLlmProviderName = (typeof VOICE_LLM_PROVIDERS)[number];

export const TTS_PROVIDERS = ['cartesia'] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

// ─── Phase 2 — Carrier ────────────────────────────────────────────────────
export const CARRIER_PROVIDERS = ['telnyx'] as const;
export type CarrierProvider = (typeof CARRIER_PROVIDERS)[number];

export * from './entitlements';

// Horloge de référence du banc du Companion et du seed companion : 31 octobre 2026, 12 h à Paris.
// Jamais lue en production, où l'heure courante est passée à la place.
export const COMPANION_REFERENCE_NOW = new Date('2026-10-31T11:00:00Z');
