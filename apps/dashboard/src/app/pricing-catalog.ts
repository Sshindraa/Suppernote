/** Formules publiques, dans l'ordre d'affichage. */
export type PlanLabel = 'Essential' | 'Pro' | 'Multi-restaurant';
export const PLAN_ORDER: readonly PlanLabel[] = ['Essential', 'Pro', 'Multi-restaurant'];

/**
 * « disponible » seulement si la fonctionnalité est livrée et activable pour les comptes de la formule.
 * « prévu » pour tout le reste : affiché comme tel, jamais présenté comme acquis.
 */
export type FeatureStatus = 'disponible' | 'prévu';

export interface CatalogFeature {
  id: string;
  label: string;
  status: FeatureStatus;
  /** Formule à partir de laquelle la fonctionnalité est incluse ; les formules supérieures l'incluent aussi. */
  introducedIn: PlanLabel;
}

/**
 * Source unique des cartes et du tableau de comparaison. L'ordre compte : les fonctionnalités d'une formule
 * sont regroupées derrière celles de la formule inférieure. Les libellés reprennent la rédaction publique de
 * la page Tarifs ; une fonctionnalité non livrée reste « prévu », jamais « disponible ».
 */
export const CATALOG_FEATURES: readonly CatalogFeature[] = [
  {
    id: 'phone-assistant',
    label: 'Suppernote répond au téléphone et prend les réservations',
    status: 'disponible',
    introducedIn: 'Essential',
  },
  {
    id: 'shared-planning',
    label: 'Un seul planning : téléphone, web et salle',
    status: 'disponible',
    introducedIn: 'Essential',
  },
  {
    id: 'connect-widget',
    label: 'Page de réservation et widget pour votre site',
    status: 'disponible',
    introducedIn: 'Essential',
  },
  {
    id: 'floor-waitlist',
    label: 'Plan de salle et liste d’attente',
    status: 'disponible',
    introducedIn: 'Essential',
  },
  {
    id: 'client-file',
    label: 'Fichier client et suivi des absences',
    status: 'disponible',
    introducedIn: 'Essential',
  },
  {
    // Profil client de l'agent actif pour tous les restaurants depuis le 22/10/2026.
    id: 'returning-callers',
    label: 'Vos habitués reconnus dès qu’ils appellent',
    status: 'disponible',
    introducedIn: 'Essential',
  },
  {
    id: 'number',
    label: 'Numéro dédié inclus',
    status: 'disponible',
    introducedIn: 'Essential',
  },
  {
    id: 'daily-report',
    label: 'Rapport quotidien des appels',
    status: 'disponible',
    introducedIn: 'Essential',
  },
  {
    id: 'tone',
    label: 'Ton adapté à votre établissement',
    status: 'prévu',
    introducedIn: 'Essential',
  },
  {
    id: 'copilot-suggestions',
    label: 'Gestion des retards en plein service',
    status: 'disponible',
    introducedIn: 'Pro',
  },
  {
    id: 'copilot-estimates',
    label: 'Prévision des tables qui se libèrent',
    status: 'disponible',
    introducedIn: 'Pro',
  },
  {
    id: 'copilot-matching',
    label: 'Placement des clients en attente',
    status: 'disponible',
    introducedIn: 'Pro',
  },
  {
    id: 'copilot-reorganisation',
    label: 'Réorganisation de salle validée par l’équipe',
    status: 'disponible',
    introducedIn: 'Pro',
  },
  {
    id: 'copilot-history',
    label: 'Historique des plans et retour arrière',
    status: 'disponible',
    introducedIn: 'Pro',
  },
  {
    id: 'ai-booking',
    label: 'Réservation depuis ChatGPT et Claude',
    status: 'prévu',
    introducedIn: 'Pro',
  },
  {
    id: 'pos-sync',
    label: 'Synchronisation ZenChef, TheFork, Lightspeed',
    status: 'disponible',
    introducedIn: 'Pro',
  },
  {
    id: 'multi-navigation',
    label: 'Toutes vos adresses dans un seul espace',
    status: 'disponible',
    introducedIn: 'Multi-restaurant',
  },
  {
    id: 'per-site-planning',
    label: 'Planning et fichier client par restaurant',
    status: 'disponible',
    introducedIn: 'Multi-restaurant',
  },
  {
    id: 'per-site-hours',
    label: 'Horaires et règles par adresse',
    status: 'disponible',
    introducedIn: 'Multi-restaurant',
  },
  {
    id: 'per-site-number',
    label: 'Un numéro dédié par établissement',
    status: 'disponible',
    introducedIn: 'Multi-restaurant',
  },
  {
    id: 'group-invoice',
    label: 'Facturation groupée',
    status: 'disponible',
    introducedIn: 'Multi-restaurant',
  },
];

const RANK: Record<PlanLabel, number> = { Essential: 0, Pro: 1, 'Multi-restaurant': 2 };

export function planIncludes(plan: PlanLabel, feature: CatalogFeature): boolean {
  return RANK[feature.introducedIn] <= RANK[plan];
}

export function featuresIntroducedIn(plan: PlanLabel): CatalogFeature[] {
  return CATALOG_FEATURES.filter((feature) => feature.introducedIn === plan);
}

export function featuresIncludedIn(plan: PlanLabel): CatalogFeature[] {
  return CATALOG_FEATURES.filter((feature) => planIncludes(plan, feature));
}
