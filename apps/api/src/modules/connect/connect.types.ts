/**
 * Suppernote Connect — Types publics et schémas Zod.
 *
 * Pas d'auth Clerk sur ces endpoints. Les données sont publiées
 * volontairement par le restaurateur (connectPublished=true).
 *
 * Source de vérité du gating : RestaurantExposureSettings
 *   - connectPublished autorise la page publique + réservation web
 *   - connectAgentic autorise l'exposition agentic avancée
 *     (JSON-LD ReserveAction, OAI-SearchBot allow, deep-link source=)
 */

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { CONNECT_DEMO_SLUGS } from '@suppernote/shared';
import { BookingMarketingConsentSchema } from '../marketing/marketing-consent.schema';

// ─── Slug (param URL) ─────────────────────────────────────────

export const SlugParamSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with dashes'),
});
export type SlugParam = z.infer<typeof SlugParamSchema>;

// ─── Availability ─────────────────────────────────────────────

export const AvailabilityQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  partySize: z.coerce.number().int().min(1).max(50),
  preferredSectionId: z.string().guid().optional(),
});
export type AvailabilityQuery = z.infer<typeof AvailabilityQuerySchema>;

export const AvailabilitySlotSchema = z.object({
  time: z.string().regex(/^\d{2}:\d{2}$/),
  available: z.boolean(),
});
export type AvailabilitySlot = z.infer<typeof AvailabilitySlotSchema>;

export type AvailabilityDto = {
  restaurantId: string;
  date: string;
  partySize: number;
  slots: AvailabilitySlot[];
};

// ─── Hold ─────────────────────────────────────────────────────

export const SourceEnum = z.enum([
  'google',
  'chatgpt',
  'perplexity',
  'bing',
  'restaurant_website',
  'instagram',
  'qr_code',
  'direct',
  'unknown',
  'web',
]);
export type Source = z.infer<typeof SourceEnum>;

/** Sources "agentic" (nécessitent connectAgentic=true) */
export const AGENTIC_SOURCES: ReadonlySet<Source> = new Set([
  'chatgpt',
  'perplexity',
  'bing',
  'google', // google organic search = trafic SEO, pas agentic — MAIS traité comme agentic dans notre taxonomie pour le tracking IA-crawlers
]);

/**
 * Sources "agentic neutres" : neutralisées en 'web' si connectAgentic=false.
 * Google est EXCLU car c'est du trafic SEO organic (pas agentic).
 * Cf. spec v1.1 §5.9.
 */
export const AGENTIC_NEUTRAL_SOURCES: ReadonlySet<Source> = new Set([
  'chatgpt',
  'perplexity',
  'bing',
]);

/**
 * Normalise la source d'une réservation Connect.
 * - Si connectAgentic=false et la source est agentic-neutre → 'web'
 * - Sinon → source inchangée (google, instagram, qr_code, etc. préservés)
 * Cf. spec v1.1 §5.9.
 */
export function normalizeConnectSource(requestedSource: Source, connectAgentic: boolean): Source {
  return !connectAgentic && AGENTIC_NEUTRAL_SOURCES.has(requestedSource) ? 'web' : requestedSource;
}

// ─── Invariant de publication ─────────────────────────────────
/**
 * Source de vérité unique de « ce restaurant a une page Suppernote Connect publique ».
 *
 *   canPublicPageRender = connectPublished && slug && publishedAt
 *   (cf. docs/obsidian/Suppernote Connect P0.md §Gating)
 *
 * `agenticOptIn` en fait partie : la page Connect est une surface de
 * réservation, et non une simple fiche vitrine. Un restaurant qui n'accepte pas
 * les réservations en ligne n'a pas de page (comportement couvert par
 * `connect.routes.test.ts` › « retourne 404 si agenticOptIn=false »).
 *
 * Historiquement seule cette page appliquait les quatre conditions : le sitemap
 * et les listes de villes n'en vérifiaient que deux ou trois, donc une fiche
 * publiée avec MCP désactivé restait annoncée aux crawlers tout en répondant
 * 404 — le sitemap promettait une URL morte. Les surfaces DOIVENT désormais
 * réutiliser ces deux représentations — le `where` Prisma pour les requêtes, le
 * prédicat pour les vérifications en mémoire — plutôt que de redéclarer la règle.
 */
export const PUBLIC_CONNECT_WHERE = {
  exposureSettings: { connectPublished: true },
  publishedAt: { not: null },
  slug: { not: null },
  agenticOptIn: true,
} as const;

/** Discovery excludes explicit fixtures; direct pages and test reservations remain available. */
export const DISCOVERABLE_CONNECT_WHERE = {
  ...PUBLIC_CONNECT_WHERE,
  slug: { not: null, notIn: [...CONNECT_DEMO_SLUGS] },
} satisfies Prisma.RestaurantWhereInput;

export function isPublicConnectPage(restaurant: {
  slug: string | null;
  publishedAt: Date | null;
  agenticOptIn: boolean;
  exposureSettings: { connectPublished: boolean } | null;
}): boolean {
  return Boolean(
    restaurant.slug &&
    restaurant.publishedAt &&
    restaurant.agenticOptIn &&
    restaurant.exposureSettings?.connectPublished,
  );
}

export const HoldInputSchema = z.object({
  date: z.string().date(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  partySize: z.number().int().min(1).max(50),
  preferredSectionId: z.string().guid().optional(),
  source: SourceEnum.optional().default('web'),
  // Réservation test : jeton signé du tableau de bord. Format et signature sont
  // vérifiés par la route, pour qu'un jeton mal formé reçoive le même 403 clair.
  testBookingToken: z.string().max(100).optional(),
  // Honeypot anti-bot : doit être vide. Si rempli → bot.
  website: z.string().optional(),
});
export type HoldInput = z.infer<typeof HoldInputSchema>;

export type HoldDto = {
  holdId: string;
  holdToken: string;
  expiresAt: string; // ISO 8601
  status: 'pending';
};

// ─── Confirm ──────────────────────────────────────────────────

export const ConfirmInputSchema = z.object({
  holdToken: z.string().min(10),
  customer: z.object({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100).optional(),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164 (e.g. +33612345678)'),
    email: z.string().email().optional().or(z.literal('')),
  }),
  specialRequests: z.string().max(500).optional(),
  idempotencyKey: z.string().guid().optional(),
  marketingAttributionToken: z.string().trim().min(20).max(4096).optional(),
  source: SourceEnum.optional().default('web'),
  giftCardCode: z.string().optional(),
  whatsappReminderConsent: z
    .object({
      accepted: z.boolean(),
      version: z.literal('whatsapp-reminder-2026-10-17'),
    })
    .optional(),
  // Réservation test : même contrat que pour le hold.
  testBookingToken: z.string().max(100).optional(),
  // Cases de consentement marketing (jamais cochées par défaut, jamais obligatoires).
  marketingConsent: BookingMarketingConsentSchema.optional(),
  // Empreinte bancaire : acceptation des conditions affichées, avec le montant vu par le client.
  cardGuarantee: z
    .object({
      accepted: z.literal(true),
      totalAmount: z.string().regex(/^\d{1,6}\.\d{2}$/),
    })
    .optional(),
  // Honeypot anti-bot : doit être vide. Si rempli → bot.
  website: z.string().optional(),
});
export type ConfirmInput = z.infer<typeof ConfirmInputSchema>;

export type ConfirmDto = {
  whatsappWithdrawalToken?: string;
  managementUrl?: string;
  reservationId: string;
  status: 'confirmed';
  restaurantName: string;
  date: string;
  time: string;
  partySize: number;
};

// ─── Public DTO ──────────────────────────────────────────────

/** Format priceRange int (1..4) → string "€" / "€€" / "€€€" / "€€€€" */
export function priceRangeToSymbol(priceRange: number | null | undefined): string | undefined {
  if (priceRange == null) return undefined;
  if (priceRange < 1 || priceRange > 4) return undefined;
  return '€'.repeat(priceRange);
}

/** Sérialise un openingHours JSON brut en {day, open, close}[] normalisé */
export type OpeningHoursDay = {
  day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  open: string;
  close: string;
};
export type OpeningHoursSpec = OpeningHoursDay[];

export type PublicRestaurantDto = {
  whatsappReminderOptInEnabled?: boolean;
  id: string;
  slug: string;
  name: string;
  description?: string;
  address: {
    line1: string;
    postalCode?: string;
    city: string;
    country: string;
  };
  phone: string;
  cuisineTypes: string[];
  priceRange?: string;
  openingHours: OpeningHoursSpec;
  reservationUrl: string;
  images: {
    cover?: string;
    gallery: string[];
  };
  ambiance?: string[];
  dietary?: string[];
  noiseLevel?: string;
  acceptsReservations: boolean;
  publishedAt: string; // ISO 8601
  // Fuseau du restaurant (IANA) : « aujourd'hui » se calcule dans ce fuseau, pas dans celui du serveur.
  timezone?: string;
  // Métadonnées internes (utiles pour le front, pas pour le SEO)
  connectAgentic: boolean;
  // Géolocalisation (exposée dans JSON-LD GeoCoordinates)
  lat?: number;
  lng?: number;
  // Note agrégée (importée Google Places, Phase 3). Absent si pas de Place ID.
  aggregateRating?: {
    ratingValue: number;
    reviewCount: number;
    provider: 'google';
  };
};

export const CardGuaranteeTokenParamSchema = SlugParamSchema.extend({
  token: z.string().min(40).max(120),
});

export const CardGuaranteeCheckoutSchema = z.object({ accepted: z.literal(true) });
