import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import {
  CEREBRAS_BASE_URL,
  RESPAN_BASE_URL,
  VOICE_LLM_MODEL_DEFAULT,
  VOICE_LLM_PROVIDERS,
} from '@suppernote/config';
import { sttChunkMsSchema } from './shared/stt-chunking';
import { telnyxCodecSchema } from './modules/voice/stream/telnyx-codec';

function isValidCorsOrigins(val: string): boolean {
  const origins = val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    origins.length > 0 &&
    origins.every((origin) => {
      try {
        const url = new URL(origin);
        return (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.origin === origin &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    })
  );
}

// En production (PM2 --env-file=.env), le fichier app-local est la source de
// vérité. En dev, on fallback sur le .env du repo root puis .env.local.
// L'ancien code chargeait toujours ../../../.env (repo root), ce qui divergeait
// silencieusement du fichier chargé par PM2 (apps/api/.env).
const appEnv = path.resolve(__dirname, '../.env');
const rootEnv = path.resolve(__dirname, '../../../.env');
const localEnv = path.resolve(__dirname, '../../../.env.local');

const envFile = fs.existsSync(appEnv) ? appEnv : fs.existsSync(rootEnv) ? rootEnv : localEnv;

// En test, on ne lit jamais le .env du développeur : les tests tournent comme en CI, sans fichier local.
if (process.env.NODE_ENV !== 'test') dotenv.config({ path: envFile });

// ─── Defaults dev (ergonomie out-of-the-box) ─────────────────────────────
// En dev/test, si les 4 vars URL ne sont pas positionnées (pas de apps/api/.env
// ni .env.local complet), on injecte des valeurs localhost avant le parse Zod.
// Cela restaure le confort "pnpm dev marche sans .env dédié" qui existait avant
// la validation centralisée, sans réintroduire le risque en prod (où le refine
// sur l'allowlist s'applique et où ces defaults ne sont jamais injectés).
const nodeEnv = process.env.NODE_ENV ?? 'development';
if (nodeEnv !== 'production') {
  process.env.PUBLIC_URL ??= 'http://localhost:4000';
  process.env.SITE_URL ??= 'http://localhost:4002';
  process.env.DASHBOARD_URL ??= 'http://localhost:3000';
  process.env.API_URL ??= 'http://localhost:4000';
}

// ─── Validation centralisée (fail-fast au démarrage) ─────────────────────
// Remplace les fallbacks dispersés `process.env.X ?? 'https://...'` qui ont
// causé plusieurs bugs de domaine en prod (commits d8849c3, c6d4ebe, 5bf1137,
// fb89267, ed16dfe). En production, un host hors allowlist fait échouer le
// démarrage plutôt que d'utiliser silencieusement une mauvaise valeur.

const PROD_HOST_ALLOWLIST = [
  'suppernote.com',
  'api.suppernote.com',
  'app.suppernote.com',
  'widget.suppernote.com',
  // Staging — mêmes contraintes que la prod (NODE_ENV=production).
  'staging.suppernote.com',
  'api-staging.suppernote.com',
  // Ancien domaine : il redirige encore. Une valeur oubliée ne doit pas bloquer le démarrage.
  'sokar.tech',
  'api.sokar.tech',
  'staging.sokar.tech',
  'api-staging.sokar.tech',
];

const DEFAULT_VOICE_LLM_TIMEOUT_MS = 8000;
/** Délai maximal avant le premier fragment du modèle principal (tour structuré), puis repli. */
const DEFAULT_VOICE_LLM_FIRST_CHUNK_TIMEOUT_MS = 2500;

/**
 * Stripe live secret keys must never be used by a local/test process.
 * Production mode is deliberately the only environment where they are
 * accepted; staging runs with NODE_ENV=production but uses sk_test_* keys.
 */
/**
 * La clé du fournisseur de reconnaissance vocale choisi est définie (≥20 caractères). Seule la clé du fournisseur
 * en service est exigée : avec Deepgram, aucune clé ElevenLabs.
 */
export function hasSttProviderKey(data: { DEEPGRAM_API_KEY?: string }): boolean {
  const key = data.DEEPGRAM_API_KEY;
  return !!key && key.length >= 20;
}

/**
 * Synthèse ElevenLabs du téléphone : exigée seulement quand `VOICE_TTS_PROVIDER=elevenlabs`.
 * Cartesia reste requis en production par ailleurs (démo et chemin de secours).
 */
export function hasElevenLabsTtsConfig(data: {
  VOICE_TTS_PROVIDER: 'cartesia' | 'elevenlabs';
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_TTS_VOICE_ID?: string;
}): boolean {
  if (data.VOICE_TTS_PROVIDER !== 'elevenlabs') return true;
  return (
    !!data.ELEVENLABS_API_KEY &&
    data.ELEVENLABS_API_KEY.length >= 20 &&
    !!data.ELEVENLABS_TTS_VOICE_ID
  );
}

export function isLiveStripeSecretKey(value: string | undefined): boolean {
  return value?.trim().startsWith('sk_live_') ?? false;
}

// Même compatibilité que manager.ts avant centralisation : une valeur absente,
// invalide, non positive ou non finie retombe sur 8 secondes.
/**
 * URL OpenRouter du seul secours vocal. Une ligne vide du .env vaut « absente » : elle ne doit pas faire échouer
 * le démarrage, et le secours retombe alors sur OPENROUTER_BASE_URL.
 */
export const openRouterFallbackBaseUrlSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);

const voiceLlmTimeoutSchema = z.preprocess((value) => {
  if (value === undefined) return DEFAULT_VOICE_LLM_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_VOICE_LLM_TIMEOUT_MS;
}, z.number().positive());

const voiceLlmFirstChunkTimeoutSchema = z.preprocess((value) => {
  if (value === undefined) return DEFAULT_VOICE_LLM_FIRST_CHUNK_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 500 && parsed <= 8000
    ? parsed
    : DEFAULT_VOICE_LLM_FIRST_CHUNK_TIMEOUT_MS;
}, z.number().positive());

/**
 * Une variable d'environnement vide n'est pas absente : `pm2` transmet à ses
 * process l'environnement du shell qui l'a lancé, donc un secret de workflow
 * non renseigné arrive en chaîne vide et fait échouer `z.string().url()` —
 * `.optional()` ne protège pas, puisque la valeur existe. Le 2026-09-22,
 * `ALERT_WEBHOOK_URL=''` a fait boucler le process de workers en crash et
 * bloqué la promotion staging → production. Une valeur vide doit se lire
 * « non configuré », pas « invalide ».
 */
export const optionalUrlSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  // Le trim évite qu'un espace invisible dans un secret GitHub produise une
  // URL « valide » en apparence mais refusée par `new URL()`.
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, z.string().url().optional());

/**
 * Adresse e-mail seule (« bonjour@… », sans nom affiché) : le nom affiché vient du restaurant. Une
 * valeur vide se lit « non configurée ».
 */
export const optionalEmailAddressSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, z.string().email().optional());

/** Budget quotidien des e-mails marketing : entier ≥ 0, 40 par défaut, 0 coupe les envois. */
export const marketingEmailDailyBudgetSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.coerce.number().int().min(0).default(40),
);

/** Hôtes Deepgram autorisés : la clé API leur est envoyée, jamais à une valeur libre. */
export const DEEPGRAM_API_HOSTS = ['api.deepgram.com', 'api.eu.deepgram.com'] as const;

const deepgramApiHostSchema = z.preprocess((value) => {
  const host = typeof value === 'string' ? value.trim().replace(/^["']|["']$/g, '') : '';
  return (DEEPGRAM_API_HOSTS as readonly string[]).includes(host) ? host : 'api.deepgram.com';
}, z.enum(DEEPGRAM_API_HOSTS));

export const VoiceDeepgramConfigSchema = z.object({
  // Endpoint EU : 7 ms de latence réseau depuis le VPS contre 110 ms vers les États-Unis ; la
  // transcription revient ~165 ms plus tôt à chaque résultat, avec des textes identiques (rejeu du
  // 29/09 : 11/11). Toute autre valeur retombe sur api.deepgram.com.
  DEEPGRAM_API_HOST: deepgramApiHostSchema,
  // 200 ms : −110 ms en médiane sur le rejeu des appels réels du 27/09 (958 → 849 ms) ;
  // les phrases coupées sont rattrapées par l'attente des tours inachevés.
  VOICE_DEEPGRAM_ENDPOINTING_MS: z.coerce.number().int().min(100).max(1_000).default(200),
  VOICE_DEEPGRAM_UTTERANCE_END_MS: z.coerce.number().int().min(500).max(3_000).default(1_000),
  VOICE_DEEPGRAM_SPELLING_SILENCE_MS: z.coerce.number().int().min(400).max(2_000).default(800),
  VOICE_DEEPGRAM_MIP_OPT_OUT: z.enum(['true', 'false']).default('true'),
});

/** Configuration voice issue des variables d'environnement validées. */
export const VoiceConfigSchema = z
  .object({
    VOICE_LLM_MODEL: z.string().default(VOICE_LLM_MODEL_DEFAULT),
    VOICE_LLM_TIMEOUT_MS: voiceLlmTimeoutSchema,
    VOICE_LLM_FIRST_CHUNK_TIMEOUT_MS: voiceLlmFirstChunkTimeoutSchema,
    VOICE_LLM_PROVIDER: z.enum(VOICE_LLM_PROVIDERS).default('cerebras'),
    VOICE_SEMANTIC_SIGNALS_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
    /** `openrouter` passe par `/alpha/decisions` ; `respan` garde le client direct. */
    VOICE_SEMANTIC_SIGNALS_PROVIDER: z.enum(['openrouter', 'respan']).default('openrouter'),
    VOICE_SEMANTIC_SIGNALS_MODEL: z.string().optional(),
    VOICE_SEMANTIC_SIGNALS_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(2_000),
    VOICE_SEMANTIC_SIGNALS_HISTORY_TURNS: z.coerce.number().int().min(1).max(30).default(3),
    VOICE_SEMANTIC_AUTO_EVAL_ENABLED: z.enum(['true', 'false']).default('false'),
    VOICE_SEMANTIC_AUTO_EVAL_MAX_TURNS: z.coerce.number().int().min(1).max(5_000).default(300),
    VOICE_SEMANTIC_JUDGE_MODEL: z.string().default('xiaomi/mimo-v2.6-pro'),
    RESPAN_BASE_URL: z.string().url().default(RESPAN_BASE_URL),
    RESPAN_API_KEY: z.string().optional(),
    VOICE_LLM_FILLER_DELAY_MS: z.coerce.number().int().min(100).max(5_000).default(1_200),
    CEREBRAS_BASE_URL: z.string().url().default(CEREBRAS_BASE_URL),
    CEREBRAS_API_KEY: z.string().optional(),
    /** Secours du tour structuré (JSON Schema strict) si le provider principal échoue. */
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
    /**
     * Adresse du secours vocal seul (tour structuré et doublon de hedging) ; absente = OPENROUTER_BASE_URL. Séparée
     * parce que le routage UE (`https://eu.openrouter.ai/api/v1`) ne porte pas Jev (l'API decisions y répond 404) :
     * Jev, le juge et le suivi de crédit gardent OPENROUTER_BASE_URL.
     */
    OPENROUTER_FALLBACK_BASE_URL: openRouterFallbackBaseUrlSchema,
    VOICE_STRUCTURED_FALLBACK_MODEL: z.string().default('deepseek/deepseek-v4-flash-0731'),
    // Hébergeurs OpenRouter du repli, dans l'ordre (vide = tri par latence historique, instable).
    VOICE_STRUCTURED_FALLBACK_PROVIDER_ORDER: z.string().default('Cohere,Wafer,Baidu'),
    // Hébergeurs OpenRouter jamais utilisés par le repli, même en secours (ex. données hors des pays admis).
    VOICE_STRUCTURED_FALLBACK_PROVIDER_IGNORE: z.string().default(''),
    // Raisonnement du modèle de repli : `disabled` (défaut) ou `none` (effort nul, exigé par GPT-6 Luna).
    VOICE_STRUCTURED_FALLBACK_REASONING: z.enum(['disabled', 'none']).default('disabled'),
    // false : ni temperature ni top_p, refusés par les modèles à raisonnement d'OpenAI.
    VOICE_STRUCTURED_FALLBACK_SAMPLING: z.enum(['true', 'false']).default('true'),
    // Délai avant le doublon Cerebras quand GPT-6 Luna (OpenRouter) est en principal. GPT-6 Luna met ~0,8 s (pire mesuré 1,4 s) :
    // au délai normal (700 ms), Cerebras gagnerait la moitié des tours. 0 = Cerebras seulement en repli.
    VOICE_LLM_OPENROUTER_PRIMARY_HEDGE_MS: z.preprocess((value) => {
      if (value === undefined || value === '') return 1500;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 8000 ? parsed : 1500;
    }, z.number().min(0)),
  })
  .merge(VoiceDeepgramConfigSchema);

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PUBLIC_URL: z.string().url('PUBLIC_URL must be a valid URL'),
    SITE_URL: z.string().url('SITE_URL must be a valid URL'),
    DASHBOARD_URL: z.string().url('DASHBOARD_URL must be a valid URL'),
    API_URL: z.string().url('API_URL must be a valid URL'),
    OAUTH_ISSUER_URL: z.string().url('OAUTH_ISSUER_URL must be a valid URL').optional(),
    MCP_ALLOWED_ORIGINS: z
      .string()
      .refine(isValidCorsOrigins, { message: 'MCP_ALLOWED_ORIGINS must be http(s) origins' })
      .optional(),
    // CORS — allowlist explicite des origins navigateur (comma-separated)
    CORS_ORIGINS: z
      .string()
      .refine(isValidCorsOrigins, {
        message:
          'CORS_ORIGINS must be a comma-separated list of http(s) URLs (e.g. https://suppernote.com,https://www.suppernote.com)',
      })
      .optional(),
    // Reverse proxy IPs (Nginx) — comma-separated, accepte CIDR et IPv6.
    // Defaut loopback ; ajouter l'IP publique du VPS si Nginx n'est pas local.
    TRUSTED_PROXY_IPS: z.string().default('127.0.0.1, ::1'),
    // Routes /api/test (simulation d'appel). DOIT être explicitement true, même en dev/test.
    // En production, doit rester false (SEC-005).
    ENABLE_TEST_ROUTES: z.enum(['true', 'false']).default('false'),
    // Authentification /metrics (SEC-006). Si user+password sont définis, auth basique requise.
    // Sinon, allowlist d'IPs exactes (défaut loopback). Prometheus doit être dans la liste.
    METRICS_BASIC_AUTH_USER: z.string().optional(),
    METRICS_BASIC_AUTH_PASSWORD: z.string().min(1).optional(),
    METRICS_ALLOWLIST_IPS: z.string().default('127.0.0.1, ::1'),
    // Endpoint de métriques du process worker (R1-6). Loopback par défaut :
    // seul Prometheus, sur le même hôte, doit pouvoir le lire.
    METRICS_PORT: z.coerce.number().int().positive().default(4001),
    METRICS_BIND_HOST: z.string().default('127.0.0.1'),
    // IDs Clerk des opérateurs Suppernote autorisés à utiliser les routes globales
    // de provisioning et de santé. CSV, obligatoire dans l'environnement de
    // déploiement avant d'ouvrir l'administration multi-restaurant.
    SOKAR_OPERATOR_USER_IDS: z.string().optional(),
    // Jeton du endpoint legacy POST /reservations. Le pipeline vocal appelle
    // le service directement ; cette clé ne doit jamais être exposée au client.
    RESERVATION_SERVICE_TOKEN: z.string().min(32).optional(),
    // Auth MCP dev (SEC-007). ENABLE_DEV_AUTH doit être explicitement true pour activer AGENT_DEV_KEY.
    // En production, rester false. AGENT_DEV_KEY doit faire ≥32 caractères si défini.
    ENABLE_DEV_AUTH: z.enum(['true', 'false']).default('false'),
    AGENT_DEV_KEY: z.string().min(32).optional(),
    // HMAC partagé pour le feed OpenAI Reserve (RES-007). Si défini, /v1/businesses
    // exige un ?signature=... valide. Clé ≥ 32 chars, ne pas commiter.
    OPENAI_RESERVE_HMAC_KEY: z.string().min(32).optional(),
    // HMAC des événements de qualité Service Copilot. Le navigateur ne peut
    // pas déclarer une recommandation arbitraire : il ne renvoie qu’un token signé.
    SERVICE_COPILOT_TELEMETRY_SECRET: z.string().min(32).optional(),
    // Clés API critiques — validées au démarrage en production
    TELNYX_API_KEY: z.string().optional(),
    // Application voix Telnyx à laquelle relier les numéros attribués (sans elle, un numéro attribué
    // dans Suppernote ne reçoit aucun appel). Voir docs/runbooks/environment.md.
    TELNYX_CONNECTION_ID: z.string().optional(),
    TELNYX_PUBLIC_KEY: z.string().optional(),
    TELNYX_FROM_NUMBER: z.string().optional(),
    TELNYX_SMS_FROM: z.string().optional(),
    // Fournisseur global d'envoi des SMS (pas de réglage par restaurant). Voir email-sms-deliverability.md.
    SMS_PROVIDER: z.enum(['telnyx', 'brevo']).default('telnyx'),
    BREVO_API_KEY: z.string().optional(),
    // Expéditeur alphanumérique validé chez Brevo : 11 caractères maximum.
    BREVO_SMS_SENDER: z.string().max(11).optional(),
    // Secret de l'URL du webhook de livraison Brevo (Brevo ne signe pas ses webhooks).
    BREVO_SMS_WEBHOOK_SECRET: z.string().min(32).optional(),
    // Profil Telnyx utilisé pour les SMS transactionnels et leurs webhooks.
    // Le numéro expéditeur doit aussi être affecté à ce profil côté Telnyx.
    TELNYX_MESSAGING_PROFILE_ID: z.string().optional(),
    // Numéro WhatsApp Business affecté au profil de messagerie Telnyx.
    TELNYX_WHATSAPP_FROM: z.string().optional(),
    // Base URL Telnyx pour les appels fetch directs — défaut US.
    // Le SDK Telnyx utilise TELNYX_API_BASE (sans https://).
    // Pour Frankfurt : TELNYX_API_URL=https://api.telnyx.eu + TELNYX_API_BASE=api.telnyx.eu
    TELNYX_API_URL: z.string().default('https://api.telnyx.com'),
    // Enregistrements d'appels : opt-in explicite, stockage S3-compatible privé.
    CALL_RECORDING_ENABLED: z.enum(['true', 'false']).default('false'),
    // Topologie d'exécution : en développement l'API porte aussi les workers
    // pour que `pnpm dev` reste utilisable seul. En production, l'écosystème PM2
    // force `false` sur `suppernote-api` et les workers tournent dans `dist/worker.js`
    // (PM2 `suppernote-workers`). Cf. docs/PROJECT_MAP.md.
    RUN_WORKERS_IN_PROCESS: z.enum(['true', 'false']).default('true'),
    // Anonymisation RGPD (rétention 2 ans) : opération destructive, jamais
    // exécutée en production. Le worker et son scheduler existent, mais le job
    // sort immédiatement tant que ce flag n'est pas explicitement activé.
    RGPD_ANONYMIZATION_ENABLED: z.enum(['true', 'false']).default('false'),
    // Liste CSV des seuls restaurants de test autorisés à lancer un enregistrement.
    CALL_RECORDING_TEST_RESTAURANT_IDS: z.string().optional(),
    // Rapport automatique de chaque appel enregistré (docs/runbooks/call-reports.md).
    // Plafond du nombre de rapports générés (coût Deepgram) ; absent = illimité.
    CALL_REPORT_MAX_REPORTS: z.coerce.number().int().positive().optional(),
    // Dossier des journaux de l'API lus par le worker pour le rapport (défaut /var/log/suppernote).
    CALL_REPORT_LOG_DIR: z.string().optional(),
    CALL_RECORDINGS_BUCKET: z.string().min(1).optional(),
    CALL_RECORDINGS_REGION: z.string().default('eu-west-3'),
    CALL_RECORDINGS_ENDPOINT: optionalUrlSchema,
    CALL_RECORDINGS_ACCESS_KEY_ID: z.string().optional(),
    CALL_RECORDINGS_SECRET_ACCESS_KEY: z.string().optional(),
    CALL_RECORDINGS_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(30),
    CALL_RECORDINGS_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_000_000)
      .max(200_000_000)
      .default(50_000_000),
    ELEVENLABS_API_KEY: z.string().optional(),
    DEEPGRAM_API_KEY: z.string().optional(),
    CARTESIA_API_KEY: z.string().optional(),
    // Dictionnaire Cartesia global de secours ; une personnalité peut en
    // définir un différent pour un restaurant donné.
    CARTESIA_PRONUNCIATION_DICT_ID: z.string().optional(),
    // Fournisseur de synthèse vocale du téléphone : cartesia (défaut) ou elevenlabs.
    // Le retour arrière est une variable : repasser à cartesia.
    VOICE_TTS_PROVIDER: z.enum(['cartesia', 'elevenlabs']).default('cartesia'),
    ELEVENLABS_TTS_VOICE_ID: z.string().optional(),
    ELEVENLABS_TTS_MODEL: z.string().default('eleven_v4_turbo'),
    // Regroupement des trames audio avant envoi au fournisseur STT : 20 (défaut, envoi
    // immédiat trame par trame) ou un multiple de 20 entre 40 et 200.
    VOICE_STT_CHUNK_MS: sttChunkMsSchema,
    // Codec Telnyx Media Stream. `PCMA` (défaut) = G.711 A-law 8 kHz, chemin
    // de production historique. `L16` = PCM 16 bits 16 kHz (bande large).
    VOICE_TELNYX_CODEC: telnyxCodecSchema,
    // Allowlist optionnelle pour limiter le mode L16 aux restaurants ciblés.
    VOICE_TELNYX_CODEC_RESTAURANT_IDS: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // Stripe Billing — recurring base prices plus Multi-restaurant establishment add-ons.
    // They remain optional so the API can start before Billing is configured;
    // the checkout endpoint returns a sanitized 503 until they are present.
    STRIPE_PRICE_ESSENTIAL_MONTHLY: z.string().optional(),
    STRIPE_PRICE_ESSENTIAL_ANNUAL: z.string().optional(),
    STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
    STRIPE_PRICE_PRO_ANNUAL: z.string().optional(),
    STRIPE_PRICE_MULTI_SITE_MONTHLY: z.string().optional(),
    STRIPE_PRICE_MULTI_SITE_ANNUAL: z.string().optional(),
    STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY: z.string().optional(),
    STRIPE_PRICE_MULTI_SITE_ADDON_ANNUAL: z.string().optional(),
    // Captcha Cloudflare Turnstile pour les flux sensibles (SEC-009). Optionnel ; si défini, /api/rgpd/request-verification exige un token Turnstile.
    TURNSTILE_SECRET_KEY: z.string().optional(),
    // Resend HTTP API pour l'envoi des emails transactionnels (port 443,
    // bypass SMTP block sur Frankfurt VPS). L'ancienne config SMTP_* est
    // dépréciée — RESEND_API_KEY est la seule clé nécessaire.
    RESEND_API_KEY: z.string().optional(),
    // Secret Svix/Resend utilisé pour vérifier les callbacks de livraison.
    // Il reste optionnel tant que les envois marketing sont gelés.
    RESEND_WEBHOOK_SECRET: z.string().min(16).optional(),
    EMAIL_FROM: z.string().optional(),
    EMAIL_REPLY_TO: z.string().optional(),
    REPUTATION_EMAIL_SECRET: z.string().optional(),
    // Les rapports récurrents envoient un email aux gestionnaires. Staging les
    // désactive explicitement tant qu'il n'existe pas de canal d'envoi isolé.
    EVENING_REPORTS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    // Canaux d'alerte ops (monitoring pilote). Tous optionnels ; si aucun n'est
    // défini, les alertes ne partent que dans les logs + Sentry.
    //   ALERT_EMAIL_TO    : destinataires email des alertes, séparés par des virgules.
    //   ALERT_WEBHOOK_URL : webhook Slack/Discord ({ "text": "..." }).
    //   ALERT_SMS_TO      : numéro E.164 recevant un SMS pour les alertes critiques.
    //   ALERT_ENV_LABEL   : libellé d'environnement dans le sujet (ex. STAGING) ; absent = déduit
    //                       de API_URL / PUBLIC_API_URL, rien en production.
    ALERT_EMAIL_TO: z.string().optional(),
    ALERT_WEBHOOK_URL: optionalUrlSchema,
    ALERT_SMS_TO: z.string().optional(),
    ALERT_ENV_LABEL: z.string().optional(),
    // Jeton séparé pour le feed interne de marge (jamais exposé au dashboard client).
    SOKAR_INTERNAL_USAGE_TOKEN: z.string().optional(),
    // Rôles autorisés à lire les notes CRM sensibles. CSV ; le défaut applique
    // le moindre privilège (Owner + Manager), sans exposer la valeur au client.
    CRM_SENSITIVE_NOTE_ROLES: z.string().default('OWNER,MANAGER'),
    // Seuils de suivi opérationnel 70/90/100 %. Aucun quota client n'est
    // appliqué ; ce worker reste optionnel et désactivé par défaut.
    USAGE_ALERTS_ENABLED: z.enum(['true', 'false']).default('false'),
    // Budgets mensuels de cost-watch opérateur, jamais communiqués au client
    // et sans effet sur l'acceptation d'un appel, SMS ou réservation.
    USAGE_ALERT_VOICE_BUDGET_MINUTES: z.coerce.number().positive().optional(),
    USAGE_ALERT_SMS_BUDGET_SEGMENTS: z.coerce.number().positive().optional(),
    // Jeton séparé pour la réconciliation interne des callbacks marketing.
    SOKAR_INTERNAL_MARKETING_TOKEN: z.string().optional(),
    // Les envois marketing restent verrouillés par défaut, même si les clés
    // provider sont présentes. Ces flags sont lus aussi par les workers.
    MARKETING_SENDS_ENABLED: z.enum(['true', 'false']).default('false'),
    MARKETING_WHATSAPP_ENABLED: z.enum(['true', 'false']).default('false'),
    MARKETING_RECIPIENT_ALLOWLIST: z.string().optional(),
    // Expéditeur dédié aux e-mails marketing (jamais EMAIL_FROM) et budget quotidien global.
    MARKETING_EMAIL_FROM: optionalEmailAddressSchema,
    MARKETING_EMAIL_DAILY_BUDGET: marketingEmailDailyBudgetSchema,
    // POS connectors remain disabled until a provider sandbox and pilot are
    // qualified. The adapter and import endpoints are still available locally
    // when explicitly enabled in a non-production environment.
    POS_CONNECTORS_ENABLED: z.enum(['true', 'false']).default('false'),
    // Reservation payment protection remains disabled until the merchant model,
    // Stripe Connect account and legal policy are validated with a pilot.
    RESERVATION_PAYMENTS_ENABLED: z.enum(['true', 'false']).default('false'),
    // Shared CRM identity is limited to qualified multi-site pilots.
    CUSTOMER_GROUPS_ENABLED: z.enum(['true', 'false']).default('false'),
    // Internal experience management and public paid bookings have independent
    // gates. Public Checkout remains off until Connect/payment readiness is proven.
    EXPERIENCES_ENABLED: z.enum(['true', 'false']).default('false'),
    EXPERIENCE_BOOKING_ENABLED: z.enum(['true', 'false']).default('false'),
    // Event ticketing remains local-only until payment, refund and distribution
    // contracts are qualified with a pilot.
    EVENTS_ENABLED: z.enum(['true', 'false']).default('false'),
    // Partner channels remain local-only until signed provider contracts,
    // health checks and bidirectional sync are qualified with a pilot.
    DISTRIBUTION_ENABLED: z.enum(['true', 'false']).default('false'),
    // Companion (assistant du dashboard) : OpenRouter, avec OPENROUTER_API_KEY et OPENROUTER_BASE_URL partagées avec la voix.
    COMPANION_LLM_MODEL: z.string().default('anthropic/claude-sonnet-5.5'),
  })
  .merge(VoiceConfigSchema)
  .refine((data) => data.CALL_RECORDING_ENABLED !== 'true' || !!data.CALL_RECORDINGS_BUCKET, {
    message: 'CALL_RECORDINGS_BUCKET is required when CALL_RECORDING_ENABLED=true',
    path: ['CALL_RECORDINGS_BUCKET'],
  })
  .refine(
    (data) =>
      (!!data.CALL_RECORDINGS_ACCESS_KEY_ID && !!data.CALL_RECORDINGS_SECRET_ACCESS_KEY) ||
      (!data.CALL_RECORDINGS_ACCESS_KEY_ID && !data.CALL_RECORDINGS_SECRET_ACCESS_KEY),
    {
      message: 'CALL_RECORDINGS_ACCESS_KEY_ID and SECRET_ACCESS_KEY must be set together',
      path: ['CALL_RECORDINGS_ACCESS_KEY_ID'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      // En production, tous les hosts URL doivent être dans l'allowlist
      const urls = [data.PUBLIC_URL, data.SITE_URL, data.DASHBOARD_URL, data.API_URL];
      return urls.every((url) => {
        try {
          const host = new URL(url).hostname;
          return PROD_HOST_ALLOWLIST.includes(host);
        } catch {
          return false;
        }
      });
    },
    {
      message: `En production, les hosts URL doivent être dans l'allowlist: ${PROD_HOST_ALLOWLIST.join(', ')}`,
      path: ['PUBLIC_URL'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      return !!data.SERVICE_COPILOT_TELEMETRY_SECRET;
    },
    {
      message: 'SERVICE_COPILOT_TELEMETRY_SECRET doit être défini en production (≥32 caractères).',
      path: ['SERVICE_COPILOT_TELEMETRY_SECRET'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      // En production, CORS_ORIGINS doit être défini explicitement
      // (pas de fallback hardcoded — cf. audit sécurité Phase 1)
      return !!data.CORS_ORIGINS;
    },
    {
      message:
        'En production, CORS_ORIGINS doit être défini explicitement (ex: "https://suppernote.com,https://www.suppernote.com"). Aucun fallback hardcoded.',
      path: ['CORS_ORIGINS'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      return Boolean(
        data.SOKAR_OPERATOR_USER_IDS?.split(',')
          .map((id) => id.trim())
          .filter(Boolean).length,
      );
    },
    {
      message:
        'SOKAR_OPERATOR_USER_IDS doit contenir au moins un ID Clerk en production pour protéger les routes globales.',
      path: ['SOKAR_OPERATOR_USER_IDS'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      // En production, les clés API voice doivent être présentes
      // (sauf si la voice est explicitement désactivée — staging)
      const voiceDisabled = process.env.VOICE_DISABLED === 'true';
      if (voiceDisabled) return true;
      return !!data.TELNYX_API_KEY && data.TELNYX_API_KEY.length >= 20;
    },
    {
      message:
        'En production, TELNYX_API_KEY doit être définie (≥20 chars). Pour désactiver la voice (staging), set VOICE_DISABLED=true.',
      path: ['TELNYX_API_KEY'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      const voiceDisabled = process.env.VOICE_DISABLED === 'true';
      if (voiceDisabled) return true;
      // Deepgram est le seul fournisseur de reconnaissance : seule sa clé est exigée.
      return hasSttProviderKey(data);
    },
    {
      message:
        'En production, la clé de reconnaissance vocale doit être définie (≥20 chars) : DEEPGRAM_API_KEY. Pour désactiver la voice (staging), set VOICE_DISABLED=true.',
      path: ['DEEPGRAM_API_KEY'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      const voiceDisabled = process.env.VOICE_DISABLED === 'true';
      if (voiceDisabled) return true;
      return !!data.CARTESIA_API_KEY && data.CARTESIA_API_KEY.length >= 20;
    },
    {
      message:
        'En production, CARTESIA_API_KEY doit être définie (≥20 chars). Pour désactiver la voice (staging), set VOICE_DISABLED=true.',
      path: ['CARTESIA_API_KEY'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production' || process.env.VOICE_DISABLED === 'true') return true;
      return hasElevenLabsTtsConfig(data);
    },
    {
      message:
        'En production avec VOICE_TTS_PROVIDER=elevenlabs, ELEVENLABS_API_KEY (≥20 chars) et ELEVENLABS_TTS_VOICE_ID doivent être définies.',
      path: ['VOICE_TTS_PROVIDER'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production' || process.env.VOICE_DISABLED === 'true') return true;
      return !!data.CEREBRAS_API_KEY && data.CEREBRAS_API_KEY.length >= 20;
    },
    {
      message:
        'CEREBRAS_API_KEY doit être définie en production (≥20 caractères) : c’est la clé du LLM vocal.',
      path: ['CEREBRAS_API_KEY'],
    },
  )
  .refine(
    (data) => {
      // Si une clé Stripe est configurée, le secret de webhook est obligatoire
      // (indépendamment de l'environnement, pour éviter les webhooks non vérifiés).
      if (!data.STRIPE_SECRET_KEY) return true;
      return !!data.STRIPE_WEBHOOK_SECRET;
    },
    {
      message: 'STRIPE_WEBHOOK_SECRET doit être défini quand STRIPE_SECRET_KEY est configuré.',
      path: ['STRIPE_WEBHOOK_SECRET'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV === 'production') return true;
      return !isLiveStripeSecretKey(data.STRIPE_SECRET_KEY);
    },
    {
      message:
        'Une clé Stripe live (sk_live_*) est interdite hors production. Utilisez une clé sk_test_* en local ou en test.',
      path: ['STRIPE_SECRET_KEY'],
    },
  )
  .refine(
    (data) => {
      if (data.NODE_ENV !== 'production') return true;
      // En production, on ne valide que le préfixe Stripe (pas le webhook secret,
      // déjà contrôlé par le refine précédent).
      if (!data.STRIPE_SECRET_KEY) return true;
      return data.STRIPE_SECRET_KEY.startsWith('sk_');
    },
    {
      message:
        'En production, STRIPE_SECRET_KEY doit être une clé Stripe valide (format sk_*) et STRIPE_WEBHOOK_SECRET doit être défini.',
      path: ['STRIPE_SECRET_KEY'],
    },
  );

function parseEnv() {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error("\n❌ Validation des variables d'environnement échouée:\n");
    for (const issue of result.error.issues) {
      const field = issue.path.join('.');
      console.error(`  • ${field || '(root)'}: ${issue.message}`);
    }
    console.error('\nLe démarrage est interrompu. Corrigez les variables ci-dessus.\n');
    process.exit(1);
  }
  return result.data;
}

const parsedEnv = parseEnv();

/**
 * Le modèle Span-01 par défaut dépend du fournisseur : Respan valide ses deux
 * modèles, OpenRouter passe par `respan/span-01`. On refuse les croisements
 * plutôt que de laisser un modèle inconnu atteindre l'API.
 */
export function resolveSemanticModel(
  provider: 'openrouter' | 'respan',
  model: string | undefined,
): string {
  if (provider === 'openrouter') {
    if (model === undefined || model === '') return 'typesafe/jev-1.13-20260917';
    if (model === 'span-01-pro' || model === 'span-01-free')
      throw new Error(
        `VOICE_SEMANTIC_SIGNALS_MODEL=${model} appartient à Respan ; utilisez 'typesafe/jev-1.13-20260917' avec VOICE_SEMANTIC_SIGNALS_PROVIDER=openrouter`,
      );
    return model;
  }
  if (model === undefined || model === '') return 'span-01-pro';
  if (model === 'span-01-pro' || model === 'span-01-free') return model;
  throw new Error(
    `VOICE_SEMANTIC_SIGNALS_MODEL=${model} n'est pas un modèle Respan ; utilisez 'span-01-pro' ou 'span-01-free'`,
  );
}

export const env: typeof parsedEnv = {
  ...parsedEnv,
  VOICE_SEMANTIC_SIGNALS_MODEL: resolveSemanticModel(
    parsedEnv.VOICE_SEMANTIC_SIGNALS_PROVIDER,
    parsedEnv.VOICE_SEMANTIC_SIGNALS_MODEL,
  ),
};

// Vue typée dédiée au pipeline voice. Elle référence le même objet validé que
// `env` afin d'éviter une seconde source de vérité ou une copie de secrets.
export const voiceConfig: VoiceConfig = env;
