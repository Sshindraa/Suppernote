// Shared constants for the Suppernote landing page
// Used by both server and client components

import {
  PLAN_PRICES_EUR,
  PRICING_CATALOG,
  ANNUAL_DISCOUNT_PERCENT,
  annualPriceCents,
  formatPriceCents,
  formatMonthlyEquivalent,
} from '@suppernote/shared';
import { featuresIntroducedIn, type FeatureStatus, type PlanLabel } from '@/app/pricing-catalog';

export const SIMULATOR_STEPS = [
  { sender: 'client', text: 'Bonjour, je voudrais réserver une table pour ce soir.' },
  {
    sender: 'assistant',
    text: 'Bienvenue au Bistrot Exemple, restaurant fictif. Pour combien de personnes ce soir ?',
  },
  { sender: 'client', text: 'Nous serons 4 personnes.' },
  {
    sender: 'assistant',
    text: "Parfait. J'ai de la disponibilité à 20h00 ou 21h30. Qu'est-ce qui vous convient ?",
  },
  { sender: 'client', text: "20h c'est super !" },
  {
    sender: 'assistant',
    text: "C'est noté. Une table pour 4 personnes ce soir à 20h00 au nom de... ?",
  },
  { sender: 'client', text: 'Au nom de Martin.' },
  {
    sender: 'assistant',
    text: 'Exemple terminé : une table pour 4 à 20h00 au nom de Martin. Réservation simulée, aucun SMS envoyé.',
  },
  { sender: 'client', text: 'Parfait, merci beaucoup. Au revoir !' },
  { sender: 'assistant', text: 'Merci à vous, au revoir et bon appétit !' },
];

export interface PlanFeatureLine {
  label: string;
  status: FeatureStatus;
}

export interface PricingPlan {
  label: PlanLabel;
  /** Prix mensuel sans engagement, en euros. */
  price: string;
  /** Prix mensuel par établissement (Multi-restaurant uniquement), en euros. */
  sitePrice?: string;
  description: string;
  promise: string;
  /** Formule précédente incluse en entier, affichée en tête de liste. */
  inherits?: string;
  note?: string;
  demoFirst?: boolean;
  /** Fonctionnalités introduites par cette formule, avec leur statut. */
  features: PlanFeatureLine[];
  featured?: boolean;
}

const toFeatureLines = (plan: PlanLabel): PlanFeatureLine[] =>
  featuresIntroducedIn(plan).map(({ label, status }) => ({ label, status }));

export const PLANS: PricingPlan[] = [
  {
    label: 'Essential',
    price: String(PLAN_PRICES_EUR.ESSENTIAL),
    promise: 'Tout l’essentiel pour faire évoluer votre restaurant',
    description: 'Plus aucune réservation perdue, même en plein service.',
    features: toFeatureLines('Essential'),
  },
  {
    label: 'Pro',
    price: String(PLAN_PRICES_EUR.PRO),
    promise: 'L’exigence évolue, votre restaurant garde le cap',
    description: 'Le copilote de service propose, votre équipe décide.',
    inherits: 'Tout Essential, plus :',
    features: toFeatureLines('Pro'),
  },
  {
    label: 'Multi-restaurant',
    price: String(PLAN_PRICES_EUR.PREMIUM),
    sitePrice: String(PRICING_CATALOG['multi-site-addon'].monthlyCents / 100),
    promise: 'Une offre groupée, un même regard',
    description: 'Plusieurs adresses, un seul espace.',
    inherits: 'Tout Pro, pour chaque établissement, plus :',
    features: toFeatureLines('Multi-restaurant'),
  },
];

export const FAQS = [
  {
    question: 'Comment Suppernote répond-il au téléphone ?',
    answer:
      'Vous gardez le numéro de votre restaurant et renvoyez les appels choisis vers votre numéro dédié Suppernote. Suppernote consulte les disponibilités de son carnet et enregistre la réservation avec le créneau et le nombre de couverts. Votre équipe la retrouve dans son tableau de bord.',
  },
  {
    question: "Avec quels outils Suppernote s'intègre-t-il ?",
    answer:
      'Les réservations prises par Suppernote sont enregistrées dans son carnet, avec les réservations en ligne et celles saisies par votre équipe. Une synchronisation avec Zenchef, TheFork et Lightspeed est disponible à partir de la formule Pro.',
  },
  {
    question: 'Quel type de restaurant peut utiliser Suppernote ?',
    answer:
      'Suppernote s’adresse aux restaurants qui prennent des réservations de tables et souhaitent réunir leurs appels, réservations web et saisies en salle dans un même carnet. Nous vérifions avec vous les horaires, services et règles nécessaires à votre établissement. Les commandes à emporter et les réponses garanties sur les allergènes ne font pas partie de ce parcours.',
  },
  {
    question: 'Combien coûte Suppernote ?',
    answer: `Essential à ${PLAN_PRICES_EUR.ESSENTIAL} €/mois, Pro à ${PLAN_PRICES_EUR.PRO} €/mois et Multi-restaurant à ${PLAN_PRICES_EUR.PREMIUM} €/mois pour le premier établissement, puis ${PRICING_CATALOG['multi-site-addon'].monthlyCents / 100} €/mois par établissement supplémentaire. Le paiement annuel engage douze mois avec ${ANNUAL_DISCOUNT_PERCENT} % de réduction. Consultez les inclusions actuelles sur la page Tarifs.`,
  },
  {
    question: 'Y a-t-il un engagement de durée ?',
    answer: `Le mensuel est sans engagement de durée. La facturation annuelle engage douze mois avec ${ANNUAL_DISCOUNT_PERCENT} % de réduction. Les équivalents mensuels affichés sont arrondis ; le montant exact à payer est indiqué avant paiement.`,
  },
  {
    question: "Comment se passe l'installation ?",
    answer:
      'Vous gardez votre numéro. Nous préparons vos horaires, services et règles, puis le renvoi vers Suppernote et le numéro de secours pour joindre votre équipe. Un appel de test vérifie la voix, la réservation dans le carnet et le secours avant activation. Vous pouvez désactiver le renvoi depuis votre ligne.',
  },
  {
    question: 'Mes données et celles de mes clients sont-elles protégées ?',
    answer:
      'Chaque restaurant dispose de son propre espace. La politique de confidentialité décrit les données traitées et les droits que vous pouvez exercer. Vous pouvez nous contacter pour toute question sur vos données.',
  },
];

/** Montants en centimes avant formatage, sans arrondir l’équivalent annuel à l’euro. */
// Compatibility helpers for existing consumers; the shared catalogue owns billing and formatting.
export const billingAmount = (price: string | number, yearly: boolean, annualTotal = false) => {
  const monthlyCents = Math.round(Number(price) * 100);
  const totalCents = yearly ? annualPriceCents(monthlyCents) : monthlyCents;
  return totalCents / (yearly && !annualTotal ? 1200 : 100);
};

export const formatPrice = (amount: number) => formatPriceCents(Math.round(amount * 100));

export const DISPLAY_PRICE = (price: string, yearly: boolean) => {
  const monthlyCents = Math.round(Number(price) * 100);
  return formatMonthlyEquivalent(yearly ? annualPriceCents(monthlyCents) : monthlyCents, yearly);
};
