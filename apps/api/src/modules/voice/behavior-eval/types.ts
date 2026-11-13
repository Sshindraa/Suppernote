/**
 * Jeu de test de comportements du tour structuré.
 *
 * Chaque cas rejoue un moment réel d'un appel (historique, phrase de l'appelant,
 * état du brouillon) devant le modèle et mesure, sur plusieurs tirages, la part des
 * réponses qui respectent un comportement. Les contrôles sont structurels (champs du
 * JSON de sortie) ; un motif dans la phrase dite ne sert qu'à *interdire* une dérive
 * connue, jamais à imposer une formulation. Rien de tout cela n'est utilisé à
 * l'exécution : le modèle décide, le jeu mesure.
 */
export interface BehaviorMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Contrôle évalué sur UN tirage : vrai ou faux. Tous sont structurels (champs du JSON de
 * sortie, brouillon) ; `say` ne sert qu'à interdire une dérive connue, jamais à imposer une
 * formulation, et aucun nouveau motif de phrase n'est ajouté.
 */
export type SamplePredicate =
  /** Un champ de premier niveau du JSON vaut (ou ne vaut pas) une valeur. */
  | { kind: 'field'; path: string; equals?: unknown; notEquals?: unknown }
  /** Un champ du brouillon vaut une valeur (casse ignorée pour le texte). */
  | { kind: 'draft'; field: string; equals: string | number }
  /** Les champs listés du brouillon sortant sont ceux du brouillon entrant : rien n'a été retenu. */
  | { kind: 'draftUnchanged'; fields: string[] }
  /** Un champ de premier niveau appartient à une liste de valeurs. */
  | { kind: 'fieldIn'; path: string; values: unknown[] }
  /** La phrase dite contient (expect=true) ou évite (expect=false) un motif. */
  | { kind: 'say'; pattern: string; expect: boolean }
  /** La dernière phrase dite ne recopie pas la question donnée. */
  | { kind: 'noRepeatOf'; text: string }
  /**
   * L'appel raccroche-t-il ? Mesuré À TRAVERS le moteur : la réponse du modèle passe par la décision
   * d'autorisation (`authorizeStructuredAction`, avec l'état du cas) ; `end_call` seul ne suffit pas, le
   * moteur peut le refuser (doute, énoncé long, question en attente).
   */
  | { kind: 'hangsUp'; expect: boolean }
  /**
   * La phrase lit les lettres du nom du brouillon, isolées et dans l'ordre (contrôle structurel : jetons d'une seule
   * lettre). Mesure si le modèle relit le nom comme le moteur l'exige ; sinon le moteur se tait et redemande avec les
   * lettres en données (un second appel au modèle, donc du délai).
   */
  | { kind: 'readsBack'; expect: boolean };

export type BehaviorCheck =
  /** Part des tirages où le contrôle est tenu, au moins `minRate`. */
  | (SamplePredicate & { minRate: number })
  /** Part des tirages où AU MOINS UN des contrôles est tenu (mesuré tirage par tirage, pas en moyenne). */
  | { kind: 'anyOf'; of: SamplePredicate[]; minRate: number }
  /** Nombre moyen de mots de la phrase dite, au plus. */
  | { kind: 'sayWords'; maxMean: number };

/** Valeurs du brouillon qu'une phrase peut porter et qu'on sait annoter. */
export type SpanField = 'time' | 'partySize' | 'customerName';

/**
 * Sous-chaîne EXACTE de la phrase qui porte une valeur, et la valeur qu'elle porte. C'est une
 * annotation (donnée) : le code ne devine jamais quelle partie d'une phrase est une heure, un nombre
 * ou un nom.
 */
export interface ValueSpan {
  text: string;
  value: string | number;
}

export type BehaviorSplit = 'calibration' | 'holdout';

/**
 * Famille de comportements : l'unité à laquelle le banc doit voir une baisse. Les identifiants sont une
 * liste fermée (pas du texte libre), pour que le dimensionnement par famille ne dérive pas.
 */
export const BEHAVIOR_FAMILIES = [
  'attente',
  'epellation',
  'extraction',
  'conge',
  'relance',
  'repetition',
  'horaires',
] as const;
export type BehaviorFamily = (typeof BEHAVIOR_FAMILIES)[number];

/**
 * Ce que le cas mesure. `model` : la sortie brute du modèle (ce qu'un changement de consigne fait bouger).
 * `engine` : la décision finale après les garde-fous du code (ce que l'appelant vit) ; le seuil et l'écart se
 * lisent alors sur le chiffre après garde-fous, jamais sur la sortie brute.
 */
export type BehaviorMeasures = 'model' | 'engine';

/**
 * D'où vient le cas. `real` : défaut observé sur un appel (ou une issue documentée). `variant` : variante
 * d'un défaut réel documenté (`variantOf`), sans donnée personnelle. `control` : témoin inventé pour une
 * hypothèse précise (il ne compte pas dans les quatre défauts exigés par famille).
 */
export type BehaviorOrigin = 'real' | 'variant' | 'control';

export type PerturbationKind = 'ablation' | 'substitution' | 'noise';

/** Restaurant du jeu : nom et horaires réels d'une fiche, pour ne pas tout mesurer sur un seul profil. */
export interface BehaviorProfile {
  name: string;
  /** Fuseau de la fiche (défaut : Europe/Paris, comme `buildSystemPrompt`). */
  timezone?: string;
  /** Taille de groupe réservable automatiquement (fiche d'exposition) ; absent : celle par défaut. */
  maxPartySize?: number;
  /** Consigne propre au restaurant (`AgentPersonality.systemPromptExtra`), telle qu'en base. */
  systemPromptExtra?: string;
  /** Genre de la voix de production, quand le profil le fixe (voir `agentVoiceGender`). */
  voiceGender?: 'masculine' | 'feminine';
  openingHours: Record<
    string,
    {
      open: string;
      close: string;
      slots?: Array<{ open: string; close: string }>;
      services?: Array<{ open: string; close: string }>;
    } | null
  >;
}

export interface BehaviorCase {
  id: string;
  /** Comportement visé, pour regrouper le rapport. */
  behavior: string;
  /** Famille de comportements : sur laquelle on dimensionne les tirages et on juge une baisse. */
  family: BehaviorFamily;
  /** Mesure-t-il le modèle ou le moteur ? Déclaré, jamais déduit. */
  measures: BehaviorMeasures;
  origin: BehaviorOrigin;
  /** Pour une variante : l'identifiant du cas réel dont elle dérive. */
  variantOf?: string;
  /**
   * Difficulté constatée à l'ajout du cas (part de tirages tenus, ou « inconnue »). Une information : elle ne
   * sert JAMAIS à choisir ni à écarter un cas (ce serait un biais de sélection).
   */
  difficulty?: { rate: number; draws: number; on: string };
  /** D'où vient le cas (appel, tour). */
  source: string;
  /** Dialogue précédent, en ligne ou par nom dans `histories` du fichier. */
  history: BehaviorMessage[] | string;
  transcript: string;
  draft?: Partial<{ date: string; time: string; partySize: number; customerName: string }>;
  awaiting?: string;
  reservationCreated?: boolean;
  /**
   * Créneaux du jour du brouillon déjà lus (comme le préchargement d'un appel réel) : les tailles de 1 à `upToSize`
   * ont ces `slots`, les suivantes (jusqu'à `maxSize`) aucun ; `noTableSizes` marque celles qu'aucune table n'accueille.
   */
  dayAvailability?: { slots: string[]; upToSize: number; maxSize: number; noTableSizes?: number[] };
  /** Résultat d'action déjà exécutée : la réponse ne peut plus qu'être dite ou terminer l'appel. */
  actionResult?: string;
  /** Actions que le schéma autorise (par défaut : toutes, ou « none » et « end_call » après un résultat d'action). */
  actions?: string[];
  dayPart?: string;
  /** Le tour vient d'être relancé après un silence de l'appelant sur un fragment inachevé. */
  callerFinished?: boolean;
  /** Relance sans énoncé de l'appelant (parole non comprise, silence, silence après l'accueil). */
  recovery?: 'unheard' | 'silence' | 'opening';
  /** Profil restaurant de `profiles` ; absent : `defaultProfile` du fichier. */
  profile?: string;
  samples?: number;
  /** Sous-chaînes annotées de `transcript` : d'où partent les variantes dégradées. */
  valueSpans?: Partial<Record<SpanField, ValueSpan>>;
  /** Ce que l'appelant a réellement dit n'est pas établi (écoute humaine à faire) : résultat informatif. */
  truthStatus?: 'unverified';
  /** Explicite ; sinon dérivé d'un hachage de l'identifiant (jamais choisi à la main). */
  split?: BehaviorSplit;
  /** Présent sur les variantes générées par `perturb.ts`, jamais dans le fichier de cas. */
  perturbation?: { kind: PerturbationKind; base: string; field: SpanField };
  checks: BehaviorCheck[];
}

export interface BehaviorCasesFile {
  version: number;
  today: string;
  /** Profil des cas qui n'en nomment pas : Chez Suppernote, relevé en base de production. */
  defaultProfile: string;
  histories?: Record<string, BehaviorMessage[]>;
  profiles: Record<string, BehaviorProfile>;
  /** Spans annotés supplémentaires (valeurs simples, sans phrase), donneurs des variantes de substitution. */
  spanPool?: Partial<Record<SpanField, ValueSpan[]>>;
  cases: BehaviorCase[];
}

/** Jetons comptés par le fournisseur, par bras : de quoi chiffrer le rejeu suivant sans rien supposer. */
export interface ReplayUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface BehaviorResponses {
  model: string;
  usage?: ReplayUsage;
  /** Sorties JSON du modèle par cas ; null quand la réponse est invalide. */
  responses: Record<string, (Record<string, unknown> | null)[]>;
  /** Durée de chaque réponse valide (ms) par cas, quand le rejeu l'a mesurée. */
  latencyMs?: Record<string, number[]>;
}

export interface CheckResult {
  description: string;
  /** Sortie BRUTE du modèle : le chiffre qui compte, sans aucun garde-fou du code. */
  rate: number;
  /**
   * Même contrôle après les garde-fous de fact-guards.ts qui touchent le brouillon (l'épellation du nom).
   * Absent quand le contrôle ne lit pas le brouillon ou que les garde-fous n'y changent rien.
   */
  guardedRate?: number;
  /** Cas `engine` : le chiffre brut du modèle, à côté du chiffre après garde-fous qui est `rate`. */
  rawRate?: number;
  required: number;
  passed: boolean;
}

export interface CaseResult {
  id: string;
  behavior: string;
  family: BehaviorFamily;
  measures: BehaviorMeasures;
  split: BehaviorSplit;
  valid: number;
  samples: number;
  /** Informatif : mesuré et rapporté, sans jamais faire échouer le jeu (variantes générées, vérité non établie). */
  informational: boolean;
  passed: boolean;
  checks: CheckResult[];
  perturbation?: BehaviorCase['perturbation'];
  /** Variantes générées : part des tirages où le comportement attendu est tenu (sortie brute). */
  successRate?: number;
  /** Idem après garde-fous du code, quand ils changent quelque chose. */
  guardedSuccessRate?: number;
}

export interface SplitSummary {
  /** Comportements non informatifs tenus / total. */
  held: number;
  total: number;
  /** Variantes générées utilisées par indicateur (sans celles dont trop de réponses sont invalides). */
  variants: Record<PerturbationKind, number>;
  /** Part des tirages d'ablation où une valeur absente de la phrase entre dans le brouillon. */
  falseAcceptRate: number | null;
  /** Part des tirages de substitution où le brouillon suit la phrase plutôt que l'état précédent. */
  fidelityRate: number | null;
  /** Part des tirages avec un mot parasite où la valeur annotée reste extraite. */
  noiseRobustness: number | null;
  /** Les mêmes indicateurs après garde-fous du code (épellation du nom) : l'écart avec le brut est ce que le code rattrape. */
  guarded: {
    falseAcceptRate: number | null;
    fidelityRate: number | null;
    noiseRobustness: number | null;
  };
}

export type BehaviorSummary = Record<BehaviorSplit, SplitSummary>;

/**
 * Sortie d'un rejeu A/B : les deux bras tirés dans la MÊME session, requêtes alternées. Il n'existe pas de
 * référence stockée : la comparaison exige que les deux bras portent le même `runId`.
 */
export interface BehaviorAbResponses {
  runId: string;
  startedAt: string;
  model: string;
  provider: string;
  /** Hébergeurs qui ont servi les tirages (OpenRouter), par bras. */
  served: Record<string, Record<string, number>>;
  arms: { reference: BehaviorResponses; candidate: BehaviorResponses };
}
