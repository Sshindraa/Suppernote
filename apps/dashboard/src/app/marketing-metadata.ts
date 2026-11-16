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
  'Logiciel de réservation pour restaurants | Suppernote',
  'Centralisez les réservations en ligne, par téléphone et en salle. Gérez votre plan de salle et consultez l’historique de vos clients. Demandez une démo.',
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
