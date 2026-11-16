import type { Metadata } from 'next';
import { PLAN_PRICES_EUR, ANNUAL_DISCOUNT_PERCENT } from '@suppernote/shared';

const SITE_NAME = 'Suppernote';

// Les montants viennent du catalogue partagé (sans TVA, franchise en base, comme Stripe) : la description ne peut pas
// diverger des prix réellement facturés.
const PRICING_DESCRIPTION = `Essential ${PLAN_PRICES_EUR.ESSENTIAL} €/mois, Pro ${PLAN_PRICES_EUR.PRO} €/mois, Multi-restaurant dès ${PLAN_PRICES_EUR.PREMIUM} €/mois. Sans engagement en mensuel, -${ANNUAL_DISCOUNT_PERCENT} % en annuel.`;

function pageMetadata(path: string, title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    robots: { index: true, follow: true },
    openGraph: {
      title,
      description,
      url: path,
      siteName: SITE_NAME,
      locale: 'fr_FR',
      type: 'website',
    },
  };
}

export const HOME_METADATA = pageMetadata(
  '/',
  // Titre court pour Google (≈ 55 caractères) ; les mots-clés « réservation en ligne » et
  // « plan de salle » restent dans la description et l'accroche de la page. « Assistant
  // téléphonique » vit sur sa propre page (/solutions/assistant-telephonique-restaurant).
  'Suppernote — Chef de rang digital : réservations restaurant',
  'Le chef de rang numérique de votre restaurant : il répond aux appels, prend les réservations en ligne et organise le plan de salle. Démonstration sur demande.',
);

export const PRICING_METADATA = pageMetadata(
  '/pricing',
  'Tarifs — Suppernote',
  PRICING_DESCRIPTION,
);

export const DEMO_METADATA = pageMetadata(
  '/demo',
  'Demander une démonstration — Suppernote',
  "Demandez une démonstration de Suppernote pour votre restaurant. Nous vous recontactons par e-mail pour convenir d'un créneau.",
);

export const AI_ASSISTANTS_METADATA = pageMetadata(
  '/assistants-ia',
  'Réserver depuis Claude, ChatGPT ou Le Chat — Suppernote',
  'Connectez Suppernote à votre assistant IA pour trouver un restaurant, vérifier les places et réserver dans la conversation. Instructions, données et référence technique.',
);
