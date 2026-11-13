/**
 * Banc de questions du Companion : chaque question part 3 fois dans answerCompanion, avec la vraie
 * clé OpenRouter, directement (ni HTTP ni plafond), sur la base locale de DEMO_RESTAURANT_ID.
 *
 * Usage (depuis apps/api) : npx tsx scripts/companion-bench/run.ts
 * Les chiffres attendus se recalculent au moment du test. Ceux des questions 12, 22 à 27 viennent de
 * requêtes Prisma écrites ici, indépendantes de query-data.ts.
 * Questions notées : 1 à 12, 17 à 20, 22 à 27 et 29 à 41 (41 : restaurant sans la formule Avis). Deux critères, notés à part : au moins un outil
 * appelé, puis valeur attendue dans la réponse (pour la question 26, le premier canal nommé doit être
 * le plus haut dans un résultat d'outil enregistré). Questions à relire : 13 à 16, 21 et 28 ; réponses
 * brutes et appels d'outils dans results/.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ReservationState } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../../src/env';
import { db } from '../../src/shared/db/client';
import {
  COMPANION_REASONING_EFFORT,
  answerCompanion,
} from '../../src/modules/companion/companion.service';
import { computeRoi } from '../../src/modules/analytics/roi.service';
import { computeCallStats } from '../../src/modules/calls/call-stats';
import type { CampaignDraft } from '../../src/modules/companion/companion.tools';
import { evaluateCapability } from '../../src/modules/entitlements/entitlement.service';
import {
  computeDashboardStats,
  computeEmptySlots,
  computeNoShowStats,
} from '../../src/modules/dashboard/dashboard.routes';
import { WEEKDAYS, anchoredIn, numbersIn } from '../../src/modules/companion/grounding';
import { COMPANION_REFERENCE_NOW } from '../../src/modules/companion/reference-clock';

// Même liste que packages/database/prisma/seed-demo-guard.ts.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const RESULTS_DIR = path.join(__dirname, 'results');
const DAY_NAMES: Record<string, string> = {
  dim: 'dimanche',
  lun: 'lundi',
  mar: 'mardi',
  mer: 'mercredi',
  jeu: 'jeudi',
  ven: 'vendredi',
  sam: 'samedi',
};
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// alt : second nombre accepté. rates : seuls pourcentages permis, ceux que renvoie un outil.
type Expected =
  | {
      kind: 'count' | 'amount' | 'rate';
      value: number;
      unit?: string;
      alt?: number;
      rates?: number[];
    }
  | { kind: 'day'; value: string[] }
  | { kind: 'all'; value: number[] }
  | { kind: 'any'; value: number[] }
  | { kind: 'first'; value: string[]; others: string[] }
  | { kind: 'unavailable' }
  // Brouillon de relance : critères figés avant l'essai. Présent (outil draft_campaign, valide), chaque
  // chiffre dans un résultat d'outil de la réponse, aucun nom du restaurant dans le texte.
  | { kind: 'draft'; names: string[] }
  | {
      kind: 'readings';
      readings: Reading[];
      tolerance: number;
      explain: boolean;
      /** Un outil quelconque suffit (query_data ou explain_change) : la lecture sans comparaison compte. */
      anyTool?: boolean;
    };

// Une lecture possible de la question : ce que la réponse doit dire pour la montrer (mesure, date,
// référence), et les valeurs qui la chiffrent. Une réponse est juste si elle nomme une lecture et
// donne toutes ses valeurs. explain : enquête, qui doit passer par explain_change.
interface Reading {
  says: RegExp[];
  values: number[];
}

interface Question {
  n: number;
  text: string;
  expected?: (restaurantId: string) => Promise<Expected>;
  /** withoutPlan : un restaurant sans la formule Avis, au lieu de DEMO_RESTAURANT_ID. */
  restaurant?: 'withoutPlan';
}

const count = (value: number, unit?: string): Expected => ({ kind: 'count', value, unit });

// Calculs de référence, écrits ici : aucun ne passe par query-data.ts.
const COUNTED_STATES: ReservationState[] = ['CONFIRMED', 'SEATED', 'HONORED'];
const benchClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Paris',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});
const benchWeekday = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Paris',
  weekday: 'long',
});
const benchHour = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Paris',
  hourCycle: 'h23',
  hour: 'numeric',
});
const FRENCH_WEEKDAYS: Record<string, string> = {
  Sunday: 'dimanche',
  Monday: 'lundi',
  Tuesday: 'mardi',
  Wednesday: 'mercredi',
  Thursday: 'jeudi',
  Friday: 'vendredi',
  Saturday: 'samedi',
};
const CHANNEL_LABELS: Record<string, string[]> = {
  phone: ['telephone'],
  website: ['site'],
  google: ['google'],
  ai: ['assistant', 'chatgpt', 'ia'],
  team: ['equipe', 'saisie'],
};

const today = () => dayFormat.format(COMPANION_REFERENCE_NOW);
function shiftDay(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
// Décalage de Paris à cet instant (en ms), puis minuit de Paris en instant UTC.
function parisOffset(instant: number): number {
  const parts = Object.fromEntries(
    benchClock.formatToParts(new Date(instant)).map(({ type, value }) => [type, Number(value)]),
  );
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    instant
  );
}
function parisStart(dayKey: string): Date {
  const wall = Date.parse(`${dayKey}T00:00:00Z`);
  return new Date(wall - parisOffset(wall - parisOffset(wall)));
}
// Premier et dernier jour d'un mois AAAA-MM.
function monthBounds(yearMonth: string): [string, string] {
  const [year, month] = yearMonth.split('-').map(Number);
  const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  return [`${yearMonth}-01`, shiftDay(nextMonth, -1)];
}
// Dernier jour de cette semaine ouvrée donnée (0 = dimanche), avant le jour indiqué.
function lastWeekdayBefore(dayKey: string, weekday: number): string {
  let day = shiftDay(dayKey, -1);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== weekday) day = shiftDay(day, -1);
  return day;
}
// Réservations de la plage, par date de service (reservedAt) ou de prise (createdAt), à Paris.
function reservationsBetween(
  restaurantId: string,
  dateField: 'reservedAt' | 'createdAt',
  from: string,
  to: string,
  states: ReservationState[] = COUNTED_STATES,
) {
  const range = { gte: parisStart(from), lt: parisStart(shiftDay(to, 1)) };
  return db.reservation.findMany({
    where: {
      restaurantId,
      state: { in: states },
      ...(dateField === 'reservedAt' ? { reservedAt: range } : { createdAt: range }),
    },
    select: {
      reservedAt: true,
      createdAt: true,
      state: true,
      channel: true,
      source: true,
      partySize: true,
    },
  });
}
// Canal d'arrivée (phone, website, google, ai, team), réécrit ici.
function benchChannel(row: { channel: string; source: string | null }): string {
  if (row.channel === 'PHONE') return 'phone';
  if (row.channel === 'ADMIN') return 'team';
  if (['MCP', 'OPENAI_RESERVE', 'API'].includes(row.channel)) return 'ai';
  if (row.channel === 'WEB') {
    const source = (row.source ?? '').toLowerCase();
    if (source === 'google') return 'google';
    if (['chatgpt', 'perplexity', 'bing'].includes(source)) return 'ai';
  }
  return 'website';
}
function benchWeekdayName(date: Date): string {
  return FRENCH_WEEKDAYS[benchWeekday.format(date)];
}
// Clés dont la valeur est la plus haute (égalités comprises).
function topKeys<K>(totals: Map<K, number>): K[] {
  const max = Math.max(...totals.values());
  return [...totals].filter(([, value]) => value === max).map(([key]) => key);
}
// Appels ayant abouti à une réservation, créés entre deux jours de Paris (bornes incluses).
function callsReservedBetween(restaurantId: string, from: string, to: string): Promise<number> {
  return db.call.count({
    where: {
      restaurantId,
      outcome: 'RESERVED',
      createdAt: { gte: parisStart(from), lt: parisStart(shiftDay(to, 1)) },
    },
  });
}

function sumCovers(rows: Array<{ partySize: number }>): number {
  return rows.reduce((sum, row) => sum + row.partySize, 0);
}

// Mois précédent à Paris, au format AAAA-MM (Date.UTC accepte le mois -1 : janvier → décembre).
function previousMonth(): string {
  const [year, month] = dayFormat.format(COMPANION_REFERENCE_NOW).split('-').map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

// Noms des clients du restaurant : aucun ne doit apparaître dans un brouillon.
async function reservationNames(restaurantId: string): Promise<string[]> {
  const rows = await db.reservation.findMany({
    where: { restaurantId },
    select: { customerName: true },
  });
  return [...new Set(rows.map((row) => row.customerName).filter((name) => name.length >= 3))];
}

// Liste d'attente et avis : requêtes Prisma écrites ici, indépendantes du catalogue.
function waitlistBetween(
  restaurantId: string,
  dateField: 'slotStart' | 'createdAt',
  from: string,
  to: string,
  status?: 'PENDING' | 'PROMOTED' | 'CANCELLED' | 'EXPIRED',
) {
  const range = { gte: parisStart(from), lt: parisStart(shiftDay(to, 1)) };
  return db.waitingListEntry.findMany({
    where: {
      restaurantId,
      ...(status ? { status } : {}),
      ...(dateField === 'slotStart' ? { slotStart: range } : { createdAt: range }),
    },
    select: { slotStart: true, createdAt: true, status: true, partySize: true },
  });
}
function feedbacksBetween(restaurantId: string, from: string, to: string) {
  return db.reputationFeedback.findMany({
    where: {
      restaurantId,
      submittedAt: { gte: parisStart(from), lt: parisStart(shiftDay(to, 1)) },
    },
    select: { score: true, submittedAt: true, recoveryTask: { select: { status: true } } },
  });
}
// Mois suivant à Paris, au format AAAA-MM.
function nextMonth(): string {
  const [year, month] = dayFormat.format(COMPANION_REFERENCE_NOW).split('-').map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}
// Restaurant sans la formule Avis (reputation.feedback), pour la question hors formule.
async function findWithoutPlanRestaurant(): Promise<string> {
  const candidates = await db.restaurant.findMany({
    where: { plan: 'STARTER' },
    select: { id: true },
    take: 20,
  });
  for (const { id } of candidates) {
    if (!(await evaluateCapability(id, 'reputation.feedback')).allowed) return id;
  }
  throw new Error('aucun restaurant sans la formule Avis dans cette base.');
}
const roundOne = (value: number) => Math.round(value * 10) / 10;

// Enquête : couverts d'une plage (repas prévus, réservations valables), par canal si demandé.
async function coversBetween(
  restaurantId: string,
  from: string,
  to: string,
  channel?: string,
): Promise<number> {
  const rows = await reservationsBetween(restaurantId, 'reservedAt', from, to);
  return sumCovers(channel ? rows.filter((row) => benchChannel(row) === channel) : rows);
}
// Enquête : appels sans issue (sans résultat), créés sur la plage.
function unfinishedCallsBetween(restaurantId: string, from: string, to: string): Promise<number> {
  return db.call.count({
    where: {
      restaurantId,
      outcome: null,
      createdAt: { gte: parisStart(from), lt: parisStart(shiftDay(to, 1)) },
    },
  });
}
// Enquête : nombre de réservations d'une plage, par date de service (reservedAt) ou de prise.
async function reservationCountBetween(
  restaurantId: string,
  from: string,
  to: string,
  dateField: 'reservedAt' | 'createdAt' = 'reservedAt',
) {
  return (await reservationsBetween(restaurantId, dateField, from, to)).length;
}
// Enquête : couverts, réservations et part des couverts du site web d'une plage, par date donnée.
async function siteFiguresBetween(
  restaurantId: string,
  dateField: 'reservedAt' | 'createdAt',
  from: string,
  to: string,
) {
  const rows = await reservationsBetween(restaurantId, dateField, from, to);
  const site = rows.filter((row) => benchChannel(row) === 'website');
  const covers = sumCovers(site);
  const total = sumCovers(rows);
  return {
    covers,
    reservations: site.length,
    share: total === 0 ? 0 : roundOne((100 * covers) / total),
  };
}
// Enquête : nombre de demandes de liste d'attente d'une plage, par date de demande.
async function waitlistCountBetween(
  restaurantId: string,
  from: string,
  to: string,
  status?: 'PROMOTED',
): Promise<number> {
  return (await waitlistBetween(restaurantId, 'createdAt', from, to, status)).length;
}
// Enquête : moyenne d'un même jour de semaine, sur les 4 semaines précédentes.
async function usualOf(dayKey: string, totalOf: (day: string) => Promise<number>): Promise<number> {
  const totals = await Promise.all(
    [7, 14, 21, 28].map((weeks) => totalOf(shiftDay(dayKey, -weeks))),
  );
  return totals.reduce((sum, total) => sum + total, 0) / 4;
}
// Enquête : note moyenne des avis sur la plage, à 0,1 près.
async function averageScoreBetween(
  restaurantId: string,
  from: string,
  to: string,
): Promise<number> {
  const rows = await feedbacksBetween(restaurantId, from, to);
  return roundOne(rows.reduce((sum, row) => sum + row.score, 0) / rows.length);
}
// Jour de l'anomalie planté par le seed : mardi 20 octobre 2026.
const ANOMALY_DAY = '2026-10-20';
// Mois en cours, du 1er jour à aujourd'hui (Paris).
const thisMonth = (): [string, string] => [`${today().slice(0, 7)}-01`, today()];

// Repères d'une lecture : ce que la réponse doit dire pour la montrer. Chacun doit figurer dans la
// réponse. Une question sans repère (ni mesure, ni date) n'a pas de lecture à désigner.
const COVERS = /couvert/i;
const RESERVATIONS = /réservation|réservé/i;
const SERVICE = /service|prévu|réservés? pour|réservations? pour|date de réservation/i;
const CREATION = /créée?s?|saisies?|enregistrées?|prises?|reçues?/i;
// Date du repas : une réponse qui dit « date du repas » donne la date de service.
const SERVICE_OR_MEAL = /service|repas|prévu/i;
const USUAL_DAY = /habituel|d['’]habitude|d['’]ordinaire|moyenne|en général|mardis précédents/i;
const PREVIOUS_WEEK = /mardi dernier|semaine dernière|semaine précédente|13 octobre/i;
const ATTENTE = /attente/i;
const LAST_30 = /30 (derniers )?jours|30 jours/i;
const FRENCH_MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
];
const CURRENT_MONTH = /ce mois|depuis le 1er|début du mois/i;
const APPELS = /appel/i;
const LAST_7 = /7 (derniers )?jours|sept (derniers )?jours|cette semaine/i;
// Q19 : sept jours glissants, ou semaine civile (du lundi au jour de référence).
const ROLLING_7 = /7 (derniers )?jours|sept (derniers )?jours/i;
const WEEK_CIVIL = /cette semaine|semaine|lundi/i;
const SITE = /site|internet|en ligne|web/i;
const LAST_YEAR = /an dernier|année dernière|2025/i;
const SHARE = /part|pourcentage|%|pour cent|proportion/i;
const AVIS = /avis|note/i;

// Question sans période : la question ne dit pas laquelle. Chaque fenêtre naturelle est une lecture
// (7 jours, 30 jours, mois en cours), comparée à la fenêtre précédente de même longueur.
interface OpenWindow {
  says: RegExp;
  current: () => [string, string];
  previous: () => [string, string];
}
const OPEN_WINDOWS: OpenWindow[] = [
  {
    says: LAST_7,
    current: () => [shiftDay(today(), -6), today()],
    previous: () => [shiftDay(today(), -13), shiftDay(today(), -7)],
  },
  {
    says: LAST_30,
    current: () => [shiftDay(today(), -29), today()],
    previous: () => [shiftDay(today(), -59), shiftDay(today(), -30)],
  },
  {
    says: CURRENT_MONTH,
    current: thisMonth,
    previous: () => monthBounds(previousMonth()),
  },
];
// Date de référence d'une réservation : service (reservedAt) ou prise (createdAt).
const BASES = [
  { field: 'reservedAt', says: SERVICE },
  { field: 'createdAt', says: CREATION },
] as const;
// Même date un an plus tôt (AAAA-MM-JJ).
const shiftYear = (dayKey: string) => `${Number(dayKey.slice(0, 4)) - 1}${dayKey.slice(4)}`;
// Une fenêtre est nommée par son libellé, ou par une de ses dates : « du 2 au 31 octobre » suffit.
const dayMonth = (dayKey: string) =>
  `\\b${Number(dayKey.slice(8))}(?:er)?\\s+${FRENCH_MONTHS[Number(dayKey.slice(5, 7)) - 1]}\\b`;
// Une date ou un mois qui suit « au » ou « et le » fait partie d'un intervalle : il ne nomme pas seul la fenêtre.
const NOT_END_OF_INTERVAL = `(?<!\\b(?:au|et le)\\s+(?:(?:${WEEKDAYS})\\s+)?(?:\\d{1,2}(?:er)?\\s+)?)`;
// « du 25 au 31 octobre » et « entre le 1er et le 31 octobre » nomment la fenêtre entière.
const intervalOf = (from: string, to: string) =>
  `\\b(?:du|entre le)\\s+(?:(?:${WEEKDAYS})\\s+)?${Number(from.slice(8))}(?:er)?\\s+` +
  `(?:${FRENCH_MONTHS[Number(from.slice(5, 7)) - 1]}\\s+)?(?:au|et le)\\s+` +
  `(?:(?:${WEEKDAYS})\\s+)?${Number(to.slice(8))}(?:er)?\\s+${FRENCH_MONTHS[Number(to.slice(5, 7)) - 1]}\\b`;
// Un mois entier (depuis le 1er, dans le même mois) se nomme aussi par son libellé : « octobre 2026 ».
const monthLabelOf = (from: string, to: string) =>
  from.endsWith('-01') && to.slice(0, 7) === from.slice(0, 7)
    ? `${NOT_END_OF_INTERVAL}\\b${FRENCH_MONTHS[Number(from.slice(5, 7)) - 1]}\\s+${from.slice(0, 4)}\\b`
    : '';
function windowSays(window: OpenWindow): RegExp {
  const [from, to] = window.current();
  const dates = [
    intervalOf(from, to),
    dayMonth(from),
    `${NOT_END_OF_INTERVAL}${dayMonth(to)}`,
    monthLabelOf(from, to),
  ];
  return new RegExp([window.says.source, ...dates.filter(Boolean)].join('|'), 'i');
}

const QUESTIONS: Question[] = [
  {
    n: 1,
    text: "Combien de réservations ont été prises aujourd'hui ?",
    expected: async (id) =>
      count((await computeDashboardStats(id, 'today', COMPANION_REFERENCE_NOW)).total_reservations),
  },
  {
    n: 2,
    text: 'Combien de couverts ont été réservés ces 7 derniers jours ?',
    expected: async (id) =>
      count((await computeDashboardStats(id, '7d', COMPANION_REFERENCE_NOW)).covers),
  },
  {
    n: 3,
    text: "Combien d'appels sur les 30 derniers jours ?",
    expected: async (id) =>
      count((await computeDashboardStats(id, '30d', COMPANION_REFERENCE_NOW)).total_calls),
  },
  {
    n: 4,
    text: 'Quel est le taux de conversion des appels sur 7 jours ?',
    expected: async (id) => {
      const rate = (await computeDashboardStats(id, '7d', COMPANION_REFERENCE_NOW)).conversion_rate;
      return { kind: 'rate', value: rate, rates: [rate] };
    },
  },
  {
    n: 5,
    text: 'Combien de couverts sont prévus demain ?',
    expected: async (id) =>
      count((await computeEmptySlots(id, COMPANION_REFERENCE_NOW)).days[1].covers),
  },
  {
    n: 6,
    text: 'Quel est le jour le plus faible des 7 prochains jours ?',
    expected: async (id) => {
      const open = (await computeEmptySlots(id, COMPANION_REFERENCE_NOW)).days.filter(
        (day) => day.isOpen,
      );
      const lowest = Math.min(...open.map((day) => day.reservationCount));
      return {
        kind: 'day',
        value: open
          .filter((day) => day.reservationCount === lowest)
          .map((day) => DAY_NAMES[day.dayName]),
      };
    },
  },
  {
    n: 7,
    text: 'Combien de jours sous-réservés dans les 7 prochains jours ?',
    expected: async (id) =>
      count(
        (await computeEmptySlots(id, COMPANION_REFERENCE_NOW)).summary.underbookedDays,
        'jours?',
      ),
  },
  {
    n: 8,
    text: 'Quel est mon taux de no-show ?',
    expected: async (id) => ({
      kind: 'rate',
      value: (await computeNoShowStats(id, COMPANION_REFERENCE_NOW)).noShowRate,
    }),
  },
  {
    n: 9,
    text: 'Combien de no-shows sur les 90 derniers jours ?',
    expected: async (id) => count((await computeNoShowStats(id, COMPANION_REFERENCE_NOW)).noShows),
  },
  {
    n: 10,
    text: 'Combien de couverts le mois dernier ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      return {
        kind: 'readings',
        readings: [
          { says: [COVERS, SERVICE], values: [await coversBetween(id, from, to)] },
          {
            says: [COVERS, CREATION],
            values: [(await computeRoi(id, previousMonth())).totalCouverts],
          },
        ],
        tolerance: 0,
        explain: false,
      };
    },
  },
  {
    n: 11,
    text: "Combien Suppernote m'a fait économiser en commissions TheFork le mois dernier ?",
    expected: async (id) => ({
      kind: 'amount',
      value: (await computeRoi(id, previousMonth())).theforkSavings,
    }),
  },
  {
    n: 12,
    text: 'Combien de couverts avons-nous servis mardi dernier ?',
    expected: async (id) => {
      const day = lastWeekdayBefore(today(), 2);
      return count(sumCovers(await reservationsBetween(id, 'reservedAt', day, day)));
    },
  },
  { n: 13, text: "Quel est le nom du client qui n'est pas venu hier ?" },
  { n: 14, text: "Quel est mon chiffre d'affaires net après charges ?" },
  { n: 15, text: "Rédigez un SMS pour relancer la liste d'attente samedi." },
  { n: 16, text: 'Rédigez un message pour annoncer une soirée spéciale vendredi.' },
  {
    n: 17,
    text: "Combien d'appels avons-nous reçus ces 7 derniers jours ?",
    expected: async (id) =>
      count((await computeCallStats(id, '7d', COMPANION_REFERENCE_NOW)).total),
  },
  {
    n: 18,
    text: "Combien d'appels hors horaires sur 30 jours ?",
    expected: async (id) => {
      const { afterHours } = await computeCallStats(id, '30d', COMPANION_REFERENCE_NOW);
      if (afterHours === null)
        throw new Error('horaires absents : appels hors horaires non notables');
      return count(afterHours);
    },
  },
  {
    n: 19,
    text: "Combien d'appels ont abouti à une réservation cette semaine ?",
    expected: async (id) => {
      const calls = await computeCallStats(id, '7d', COMPANION_REFERENCE_NOW);
      const dashboard = await computeDashboardStats(id, '7d', COMPANION_REFERENCE_NOW);
      // Semaine civile : du lundi au jour de référence.
      const weekday = new Date(`${today()}T12:00:00Z`).getUTCDay();
      const monday = shiftDay(today(), -((weekday + 6) % 7));
      const civil = await callsReservedBetween(id, monday, today());
      return {
        kind: 'readings',
        readings: [
          { says: [ROLLING_7], values: [calls.byOutcome.RESERVED] },
          { says: [ROLLING_7], values: [dashboard.call_reservations] },
          { says: [WEEK_CIVIL], values: [civil] },
        ],
        tolerance: 0.5,
        explain: false,
      };
    },
  },
  {
    n: 20,
    text: 'Par quel moyen les clients réservent-ils, sur 30 jours ?',
    expected: async (id) => {
      const channels = (await computeDashboardStats(id, '30d', COMPANION_REFERENCE_NOW)).by_channel;
      const reservations = (channel: string) =>
        channels.find((stat) => stat.channel === channel)?.reservations ?? 0;
      return { kind: 'all', value: [reservations('phone'), reservations('website')] };
    },
  },
  { n: 21, text: 'Par quel moyen les gens appellent ?' },
  {
    n: 22,
    text: 'Quel jour de la semaine fait le plus de couverts sur les 8 dernières semaines ?',
    expected: async (id) => {
      const covers = new Map<string, number>();
      for (const row of await reservationsBetween(
        id,
        'reservedAt',
        shiftDay(today(), -55),
        today(),
      )) {
        const name = benchWeekdayName(row.reservedAt);
        covers.set(name, (covers.get(name) ?? 0) + row.partySize);
      }
      return { kind: 'day', value: topKeys(covers) };
    },
  },
  {
    n: 23,
    text: 'Combien de réservations annulées en septembre ?',
    expected: async (id) => {
      const [from, to] = monthBounds(`${today().slice(0, 4)}-09`);
      const byService = await reservationsBetween(id, 'reservedAt', from, to, ['CANCELLED']);
      const byCreated = await reservationsBetween(id, 'createdAt', from, to, ['CANCELLED']);
      return { kind: 'any', value: [byService.length, byCreated.length] };
    },
  },
  {
    n: 24,
    text: 'Combien de couverts via le site web le mois dernier ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      // Date de service ou date de prise : les deux lectures sont acceptées si la réponse dit laquelle.
      const website = (
        rows: Array<{ channel: string; source: string | null; partySize: number }>,
      ) => sumCovers(rows.filter((row) => benchChannel(row) === 'website'));
      const byService = await reservationsBetween(id, 'reservedAt', from, to);
      const byCreation = await reservationsBetween(id, 'createdAt', from, to);
      return {
        kind: 'readings',
        readings: [
          { says: [SITE, SERVICE_OR_MEAL], values: [website(byService)] },
          { says: [SITE, CREATION], values: [website(byCreation)] },
        ],
        tolerance: 0.5,
        explain: false,
      };
    },
  },
  {
    n: 25,
    text: "Combien d'appels pour des annulations sur 30 jours ?",
    expected: async (id) =>
      count(
        await db.call.count({
          where: {
            restaurantId: id,
            intent: 'CANCEL',
            createdAt: {
              gte: parisStart(shiftDay(today(), -29)),
              lt: parisStart(shiftDay(today(), 1)),
            },
          },
        }),
      ),
  },
  {
    n: 26,
    text: 'Quel canal apporte le plus de couverts sur 90 jours ?',
    expected: async (id) => {
      const covers = new Map<string, number>();
      for (const row of await reservationsBetween(
        id,
        'createdAt',
        shiftDay(today(), -89),
        today(),
      )) {
        const channel = benchChannel(row);
        covers.set(channel, (covers.get(channel) ?? 0) + row.partySize);
      }
      // Le canal attendu doit être le premier nommé : les autres canaux ne doivent pas venir avant.
      const winners = topKeys(covers);
      const others = Object.keys(CHANNEL_LABELS).filter((channel) => !winners.includes(channel));
      return {
        kind: 'first',
        value: winners.flatMap((channel) => CHANNEL_LABELS[channel]),
        others: others.flatMap((channel) => CHANNEL_LABELS[channel]),
      };
    },
  },
  {
    n: 27,
    text: 'À quelle heure arrivent la plupart des clients le samedi, sur 8 semaines ?',
    expected: async (id) => {
      const perHour = new Map<number, number>();
      for (const row of await reservationsBetween(
        id,
        'reservedAt',
        shiftDay(today(), -55),
        today(),
      )) {
        if (benchWeekdayName(row.reservedAt) !== 'samedi') continue;
        const hour = Number(benchHour.format(row.reservedAt));
        perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
      }
      return { kind: 'any', value: topKeys(perHour) };
    },
  },
  { n: 28, text: "Combien de personnes sont sur la liste d'attente ?" },
  {
    n: 29,
    text: 'Combien de couverts sont en liste d’attente pour le mois prochain ?',
    expected: async (id) => {
      const [from, to] = monthBounds(nextMonth());
      const rows = await waitlistBetween(id, 'slotStart', from, to, 'PENDING');
      return count(sumCovers(rows));
    },
  },
  {
    n: 30,
    text: 'Combien de demandes en liste d’attente ont été obtenues sur les créneaux du mois dernier ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      return count((await waitlistBetween(id, 'slotStart', from, to, 'PROMOTED')).length);
    },
  },
  {
    n: 31,
    text: 'Combien de couverts ont été demandés en liste d’attente le mois dernier ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      return count(sumCovers(await waitlistBetween(id, 'createdAt', from, to)));
    },
  },
  {
    n: 32,
    text: 'Quel jour de la semaine reçoit le plus de demandes en liste d’attente le mois dernier, selon la date de la demande ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      const perDay = new Map<string, number>();
      for (const row of await waitlistBetween(id, 'createdAt', from, to)) {
        const name = benchWeekdayName(row.createdAt);
        perDay.set(name, (perDay.get(name) ?? 0) + 1);
      }
      return { kind: 'day', value: topKeys(perDay) };
    },
  },
  {
    n: 33,
    text: 'Combien de demandes faites le mois dernier ont été annulées ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      return count((await waitlistBetween(id, 'createdAt', from, to, 'CANCELLED')).length);
    },
  },
  {
    n: 34,
    text: 'Combien de demandes en liste d’attente ont expiré le mois dernier, selon le créneau demandé ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      return count((await waitlistBetween(id, 'slotStart', from, to, 'EXPIRED')).length);
    },
  },
  {
    n: 35,
    text: 'Quelle est la note moyenne des avis clients le mois dernier ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      const rows = await feedbacksBetween(id, from, to);
      const average = rows.reduce((sum, row) => sum + row.score, 0) / rows.length;
      return count(roundOne(average));
    },
  },
  {
    n: 36,
    text: 'Combien d’avis clients ai-je reçus ce mois-ci ?',
    expected: async (id) => {
      const [from] = monthBounds(today().slice(0, 7));
      return count((await feedbacksBetween(id, from, today())).length);
    },
  },
  {
    n: 37,
    text: 'Combien d’avis ont une note de 2 ou moins le mois dernier ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      const rows = await feedbacksBetween(id, from, to);
      return count(rows.filter((row) => row.score <= 2).length);
    },
  },
  {
    n: 38,
    text: 'Combien d’avis du mois dernier ont une tâche de récupération au statut ouvert ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      const rows = await feedbacksBetween(id, from, to);
      return count(rows.filter((row) => row.recoveryTask?.status === 'OPEN').length);
    },
  },
  {
    n: 39,
    text: 'Quelle note revient le plus souvent le mois dernier ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      const perScore = new Map<number, number>();
      for (const row of await feedbacksBetween(id, from, to)) {
        perScore.set(row.score, (perScore.get(row.score) ?? 0) + 1);
      }
      return { kind: 'any', value: topKeys(perScore) };
    },
  },
  {
    n: 40,
    text: 'Combien d’avis du mois dernier ont une tâche de récupération résolue ?',
    expected: async (id) => {
      const [from, to] = monthBounds(previousMonth());
      const rows = await feedbacksBetween(id, from, to);
      return count(rows.filter((row) => row.recoveryTask?.status === 'RESOLVED').length);
    },
  },
  {
    n: 41,
    text: 'Combien d’avis clients ai-je reçus le mois dernier ?',
    restaurant: 'withoutPlan',
    expected: async () => ({ kind: 'unavailable' }),
  },
  {
    n: 42,
    text: 'Pourquoi le mardi 20 octobre était-il si calme ?',
    expected: async (id) => {
      const covers = await coversBetween(id, ANOMALY_DAY, ANOMALY_DAY);
      const reservations = await reservationCountBetween(id, ANOMALY_DAY, ANOMALY_DAY);
      const facts = [
        await unfinishedCallsBetween(id, ANOMALY_DAY, ANOMALY_DAY),
        (await waitlistBetween(id, 'slotStart', ANOMALY_DAY, ANOMALY_DAY)).length,
      ];
      const previousTuesday = shiftDay(ANOMALY_DAY, -7);
      const usualCovers = await usualOf(ANOMALY_DAY, (day) => coversBetween(id, day, day));
      const usualReservations = await usualOf(ANOMALY_DAY, (day) =>
        reservationCountBetween(id, day, day),
      );
      return {
        kind: 'readings',
        readings: [
          { says: [COVERS, USUAL_DAY], values: [covers, usualCovers, ...facts] },
          {
            says: [COVERS, PREVIOUS_WEEK],
            values: [covers, await coversBetween(id, previousTuesday, previousTuesday), ...facts],
          },
          { says: [RESERVATIONS, USUAL_DAY], values: [reservations, usualReservations, ...facts] },
          {
            says: [RESERVATIONS, PREVIOUS_WEEK],
            values: [
              reservations,
              await reservationCountBetween(id, previousTuesday, previousTuesday),
              ...facts,
            ],
          },
        ],
        tolerance: 0.5,
        explain: true,
      };
    },
  },
  {
    n: 43,
    text: 'Ce mois-ci, ça marche mieux que le mois dernier ?',
    expected: async (id) => {
      const [from, to] = thisMonth();
      const [previousFrom, previousTo] = monthBounds(previousMonth());
      return {
        kind: 'readings',
        readings: [
          {
            says: [COVERS, SERVICE],
            values: [
              await coversBetween(id, from, to),
              await coversBetween(id, previousFrom, previousTo),
            ],
          },
          {
            says: [COVERS, CREATION],
            values: [
              (await computeRoi(id, today().slice(0, 7))).totalCouverts,
              (await computeRoi(id, previousMonth())).totalCouverts,
            ],
          },
          {
            says: [RESERVATIONS, SERVICE],
            values: [
              await reservationCountBetween(id, from, to),
              await reservationCountBetween(id, previousFrom, previousTo),
            ],
          },
          {
            says: [RESERVATIONS, CREATION],
            values: [
              await reservationCountBetween(id, from, to, 'createdAt'),
              await reservationCountBetween(id, previousFrom, previousTo, 'createdAt'),
            ],
          },
        ],
        tolerance: 0.5,
        explain: true,
      };
    },
  },
  {
    n: 44,
    text: "La liste d'attente, ça sert à quelque chose ?",
    expected: async (id) => {
      const readings: Reading[] = [];
      for (const window of OPEN_WINDOWS) {
        const [from, to] = window.current();
        const [previousFrom, previousTo] = window.previous();
        readings.push({
          says: [ATTENTE, windowSays(window)],
          values: [
            await waitlistCountBetween(id, from, to),
            await waitlistCountBetween(id, previousFrom, previousTo),
            await waitlistCountBetween(id, from, to, 'PROMOTED'),
          ],
        });
        // Lecture sans comparaison : les chiffres de la période seule suffisent à répondre.
        readings.push({
          says: [ATTENTE, windowSays(window)],
          values: [
            await waitlistCountBetween(id, from, to),
            await waitlistCountBetween(id, from, to, 'PROMOTED'),
          ],
        });
      }
      return { kind: 'readings', readings, tolerance: 0.5, explain: true, anyTool: true };
    },
  },
  {
    n: 45,
    text: "Qu'est-ce qui cloche avec les appels ?",
    expected: async (id) => {
      const readings: Reading[] = [];
      for (const window of OPEN_WINDOWS) {
        const [from, to] = window.current();
        readings.push({
          says: [APPELS, windowSays(window)],
          values: [await unfinishedCallsBetween(id, from, to)],
        });
      }
      return { kind: 'readings', readings, tolerance: 0.5, explain: true };
    },
  },
  {
    n: 46,
    text: "Mes clients viennent-ils plus par le site que l'an dernier ?",
    expected: async (id) => {
      const readings: Reading[] = [];
      for (const window of OPEN_WINDOWS) {
        const [from, to] = window.current();
        for (const basis of BASES) {
          const current = await siteFiguresBetween(id, basis.field, from, to);
          const lastYear = await siteFiguresBetween(
            id,
            basis.field,
            shiftYear(from),
            shiftYear(to),
          );
          const says = [SITE, LAST_YEAR, windowSays(window), basis.says];
          readings.push(
            { says: [COVERS, ...says], values: [current.covers, lastYear.covers] },
            {
              says: [RESERVATIONS, ...says],
              values: [current.reservations, lastYear.reservations],
            },
            { says: [SHARE, ...says], values: [current.share, lastYear.share] },
          );
        }
      }
      return { kind: 'readings', readings, tolerance: 0.5, explain: true };
    },
  },
  {
    n: 47,
    text: "Les avis clients s'améliorent-ils ?",
    expected: async (id) => {
      const readings: Reading[] = [];
      for (const window of OPEN_WINDOWS) {
        const [from, to] = window.current();
        const [previousFrom, previousTo] = window.previous();
        readings.push({
          says: [AVIS, windowSays(window)],
          values: [
            await averageScoreBetween(id, from, to),
            await averageScoreBetween(id, previousFrom, previousTo),
          ],
        });
      }
      return { kind: 'readings', readings, tolerance: 0.05, explain: true };
    },
  },
  {
    n: 48,
    text: 'Rédige une relance SMS pour les clients qui ont réservé demain sans avoir confirmé.',
    expected: async (id) => ({ kind: 'draft', names: await reservationNames(id) }),
  },
  {
    n: 49,
    text: 'Prépare un e-mail pour relancer les clients absents la semaine dernière.',
    expected: async (id) => ({ kind: 'draft', names: await reservationNames(id) }),
  },
  {
    n: 50,
    text: 'Écris un message pour remplir le service de ce soir.',
    expected: async (id) => ({ kind: 'draft', names: await reservationNames(id) }),
  },
];

// Nombres en lettres pour la question 7 : « Un seul jour est sous-réservé ».
const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
};

// Pourcentages cités : nombre suivi de « % » ou de « pour cent ».
function percentagesIn(reply: string): number[] {
  return [...reply.matchAll(/(\d+(?:[,.]\d+)?)\s*(?:%|pour cent)/gi)].map(([, value]) =>
    Number(value.replace(',', '.')),
  );
}

// Compte exact ; montant à l'euro près ; taux à 0,1 près ; jour : nom complet, sans accent ni casse.
// Zéro s'écrit aussi « aucune » ou « zéro » : une réponse sans chiffre peut être juste.
const ZERO_WORDS = /\b(aucune?|zéro)\b/i;

// Une lecture est juste si la réponse la nomme (repères) et donne chacune de ses valeurs, à la tolérance près.
function readingFound(reply: string, reading: Reading, tolerance: number): boolean {
  if (!reading.says.every((marker) => marker.test(reply))) return false;
  const figures = numbersIn(reply);
  return reading.values.every(
    (value) =>
      (value === 0 && ZERO_WORDS.test(reply)) ||
      figures.some((figure) => Math.abs(figure - value) <= tolerance + 1e-9),
  );
}

function valueFound(reply: string, expected: Expected): boolean {
  if (
    expected.kind === 'count' &&
    expected.value === 0 &&
    !expected.unit &&
    ZERO_WORDS.test(reply)
  ) {
    return true;
  }
  if (expected.kind === 'readings') {
    return expected.readings.some((reading) => readingFound(reply, reading, expected.tolerance));
  }
  if (expected.kind === 'unavailable') {
    // Source hors formule : la réponse le dit, sans annoncer zéro.
    return /formule/i.test(reply) && !/\b0\b|zéro|aucun/i.test(reply);
  }
  if (expected.kind === 'all') {
    return expected.value.every((value) => numbersIn(reply).includes(value));
  }
  if (expected.kind === 'any') {
    return numbersIn(reply).some((n) => expected.value.includes(n));
  }
  if (expected.kind === 'first') {
    const text = reply
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
    return firstMention(text, expected.value) < firstMention(text, expected.others);
  }
  if (expected.kind === 'day') {
    const text = reply
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
    return expected.value.some((name) => new RegExp(`\\b${name}\\b`).test(text));
  }
  // Le nombre doit être suivi de son unité : un « 1 » quelconque ne compte pas.
  if (expected.unit) {
    const number = `\\d+|${Object.keys(NUMBER_WORDS).join('|')}`;
    const pattern = new RegExp(`\\b(${number})\\s+(?:seul(?:e?s)?\\s+)?${expected.unit}\\b`, 'gi');
    return [...reply.matchAll(pattern)].some(([, token]) => {
      const key = token.toLowerCase();
      return (NUMBER_WORDS[key] ?? Number(key)) === expected.value;
    });
  }
  // Un pourcentage qu'aucun outil n'a renvoyé est un taux calculé par le modèle : KO.
  const rates = expected.rates;
  if (
    rates &&
    percentagesIn(reply).some((p) => !rates.some((rate) => Math.abs(p - rate) <= 0.05))
  ) {
    return false;
  }
  const wanted = [expected.value, expected.alt].filter(
    (value): value is number => value !== undefined,
  );
  const tolerance = { count: 0, amount: 0.5, rate: 0.05 }[expected.kind];
  return numbersIn(reply).some((n) =>
    wanted.some((value) => Math.abs(n - value) <= tolerance + 1e-9),
  );
}

function formatExpected(expected: Expected | undefined): string {
  if (!expected) return '';
  if (expected.kind === 'unavailable') return 'non incluse dans la formule';
  if (expected.kind === 'draft') return 'brouillon (draft_campaign)';
  if (expected.kind === 'readings') {
    const lectures = expected.readings.map((reading) => reading.values.join(' et ')).join(' | ');
    return expected.explain ? `${lectures} (enquête)` : lectures;
  }
  if (expected.kind === 'day') return expected.value.join(' / ');
  if (expected.kind === 'all') return expected.value.join(' et ');
  if (expected.kind === 'any') return expected.value.join(' ou ');
  if (expected.kind === 'first') return expected.value.join(' / ');
  return expected.alt === undefined
    ? String(expected.value)
    : `${expected.value} ou ${expected.alt}`;
}

// Appel d'outil tel que le modèle l'a émis, avec le contenu renvoyé (agrégats uniquement).
interface ToolCall {
  name: string;
  arguments: string;
  result: unknown;
}

// Position du premier libellé trouvé dans le texte (Infinity si aucun).
function firstMention(text: string, labels: string[]): number {
  const positions = labels
    .map((label) => text.search(new RegExp(`\\b${label}\\b`)))
    .filter((position) => position >= 0);
  return Math.min(...positions, Infinity);
}

// Canal nommé le premier dans la réponse, d'après les libellés de CHANNEL_LABELS.
function firstNamedChannel(reply: string): string | undefined {
  const text = reply
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  let first: { channel: string; position: number } | undefined;
  for (const [channel, labels] of Object.entries(CHANNEL_LABELS)) {
    const position = firstMention(text, labels);
    if (position !== Infinity && (!first || position < first.position)) {
      first = { channel, position };
    }
  }
  return first?.channel;
}

// Valeur par canal de chaque résultat d'outil qui en porte une : groupes de query_data par canal,
// ou by_channel de reservation_stats (couverts).
function channelBreakdowns(calls: ToolCall[]): Array<Map<string, number>> {
  return calls.flatMap((call) => {
    const result = call.result as {
      query?: { group_by?: string };
      groups?: Array<{ key: string | number; value: number | null }>;
      by_channel?: Array<{ channel: string; covers: number }>;
    };
    if (result?.query?.group_by === 'channel' && Array.isArray(result.groups)) {
      return [new Map(result.groups.map((group) => [String(group.key), Number(group.value)]))];
    }
    if (Array.isArray(result?.by_channel)) {
      return [new Map(result.by_channel.map((stat) => [stat.channel, stat.covers]))];
    }
    return [];
  });
}

// Le canal nommé en premier est, dans un résultat d'outil enregistré, celui dont la valeur est la plus haute.
function firstChannelIsTop(reply: string, calls: ToolCall[]): boolean {
  const named = firstNamedChannel(reply);
  if (!named) return false;
  return channelBreakdowns(calls).some(
    (totals) => totals.get(named) === Math.max(...totals.values()),
  );
}

interface Trial {
  reply: string;
  sources: string[];
  calls: ToolCall[];
  toolOk: boolean | null;
  valueOk: boolean | null;
  /** Chaque chiffre de la réponse vient d'un résultat d'outil de la même réponse. */
  anchorOk: boolean;
  unanchored: number[];
  /** Brouillon retenu par le serveur, s'il existe. */
  draft?: CampaignDraft | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  /** Durée de la réponse complète (outils compris), en ms. */
  latency_ms: number;
  error?: string;
}

// answerCompanion ne renvoie pas les tokens : ils sont dans la ligne de journal de chaque appel.
let lastUsage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
const usageLog = {
  info: (fields: { input_tokens: number; output_tokens: number; cached_input_tokens: number }) => {
    lastUsage = {
      input_tokens: fields.input_tokens,
      output_tokens: fields.output_tokens,
      cached_input_tokens: fields.cached_input_tokens,
    };
  },
} as unknown as FastifyBaseLogger;

// Modèle du banc : celui de production par défaut, ou celui demandé par --model et --reasoning.
interface ModelChoice {
  id: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

function parseEffort(value: string | undefined): ModelChoice['reasoningEffort'] {
  if (value === undefined) return undefined;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new Error('--reasoning : low, medium ou high.');
}

// Outil : au moins un appel ; pour une enquête, un appel à explain_change.
// Brouillon : présent, chiffres dans les résultats d'outils, aucun nom du restaurant.
function draftFound(
  draft: CampaignDraft | null | undefined,
  calls: ToolCall[],
  names: string[],
): boolean {
  if (!draft) return false;
  const text = [draft.name, draft.objective, draft.subject ?? '', draft.body].join(' ');
  const dataCalls = calls.filter((call) => call.name !== 'draft_campaign');
  const invented = anchoredIn(text, dataCalls).unanchored.length > 0;
  const lowered = text.toLowerCase();
  const named = names.some((name) => lowered.includes(name.toLowerCase()));
  return !invented && !named;
}

function toolUsedFor(expected: Expected | undefined, calls: ToolCall[]): boolean {
  if (expected?.kind !== 'readings' || !expected.explain || expected.anyTool)
    return calls.length > 0;
  return calls.some((call) => call.name === 'explain_change');
}

async function runTrial(
  question: Question,
  expected: Expected | undefined,
  restaurantId: string,
  choice: ModelChoice,
): Promise<Trial> {
  lastUsage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
  const started = performance.now();
  const calls: ToolCall[] = [];
  try {
    const answer = await answerCompanion({
      now: COMPANION_REFERENCE_NOW,
      restaurantId,
      messages: [{ role: 'user', content: question.text }],
      log: usageLog,
      onToolCall: (call) => calls.push(call),
      model: choice.id,
      reasoningEffort: choice.reasoningEffort,
    });
    const sources = answer.sources.map((source) => source.tool);
    const anchor = anchoredIn(answer.reply, calls);
    const isDraft = expected?.kind === 'draft';
    return {
      reply: answer.reply,
      sources,
      calls,
      draft: answer.draft,
      toolOk: isDraft
        ? calls.some((call) => call.name === 'draft_campaign')
        : question.expected
          ? toolUsedFor(expected, calls)
          : null,
      valueOk:
        expected?.kind === 'draft'
          ? draftFound(answer.draft, calls, expected.names)
          : expected
            ? valueFound(answer.reply, expected) &&
              (expected.kind !== 'first' || firstChannelIsTop(answer.reply, calls))
            : null,
      anchorOk: anchor.ok,
      unanchored: anchor.unanchored,
      latency_ms: Math.round(performance.now() - started),
      ...lastUsage,
    };
  } catch (error) {
    return {
      reply: '',
      sources: [],
      calls,
      toolOk: question.expected ? false : null,
      valueOk: expected ? false : null,
      anchorOk: false,
      unanchored: [],
      error: error instanceof Error ? error.message : String(error),
      latency_ms: Math.round(performance.now() - started),
      ...lastUsage,
    };
  }
}

function isLocalDatabase(rawUrl: string | undefined): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(rawUrl ?? '').hostname);
  } catch {
    return false;
  }
}

// Options : --trials N (essais par question, 1 par défaut) et --only 3,7,12 (questions seules).
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

// Valeurs chiffrées d'une valeur attendue : forme enregistrée (ancienne ou lectures) ou recalculée.
function figuresOf(expected: unknown): number[] {
  const { kind, value, readings } = expected as {
    kind?: string;
    value?: unknown;
    readings?: Reading[];
  };
  if (kind === 'readings') return (readings ?? []).flatMap((reading) => reading.values);
  if (typeof value === 'number') return [value];
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : [];
}

// Renote l'ancrage et le chiffre d'un fichier déjà joué, sans appeler le modèle : mêmes réponses,
// critères courants. Les valeurs attendues sont recalculées dans la base. Si une valeur enregistrée
// n'en fait plus partie (base ou date changées), le chiffre de la question reste tel quel : dérive
// signalée. Écrit <fichier>-rescored.json à côté du fichier d'origine, avec les valeurs recalculées
// (expectedNow) pour pouvoir relire chaque lecture.
async function rescoreFile(
  file: string,
  restaurantId: string,
  withoutPlanId: string,
): Promise<void> {
  const data = JSON.parse(readFileSync(file, 'utf-8')) as {
    questions: Array<{
      n: number;
      expected?: unknown;
      expectedNow?: unknown;
      trials: Array<Trial & { error?: string }>;
    }>;
  };
  const drifted: number[] = [];
  let ok = 0;
  let total = 0;
  let figuresOk = 0;
  let scored = 0;
  for (const question of data.questions) {
    const definition = QUESTIONS.find((item) => item.n === question.n);
    const targetId = definition?.restaurant === 'withoutPlan' ? withoutPlanId : restaurantId;
    const fresh = definition?.expected ? await definition.expected(targetId) : undefined;
    const drift =
      fresh !== undefined &&
      question.expected !== undefined &&
      question.expected !== null &&
      !figuresOf(question.expected).every((value) => figuresOf(fresh).includes(value));
    if (drift) drifted.push(question.n);
    question.expectedNow = fresh ?? null;
    for (const trial of question.trials) {
      total++;
      if (trial.error) {
        trial.anchorOk = false;
        trial.unanchored = [];
        continue;
      }
      const anchor = anchoredIn(trial.reply, trial.calls);
      trial.anchorOk = anchor.ok;
      trial.unanchored = anchor.unanchored;
      if (anchor.ok) ok++;
      if (fresh && !drift) {
        trial.valueOk =
          valueFound(trial.reply, fresh) &&
          (fresh.kind !== 'first' || firstChannelIsTop(trial.reply, trial.calls));
      }
      if (fresh) {
        scored++;
        if (trial.valueOk) figuresOk++;
      }
    }
  }
  const out = file.replace(/\.json$/, '-rescored.json');
  writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
  // eslint-disable-next-line no-console -- renotage du banc, lu dans le terminal
  console.log(`Renoté : ancrage ${ok}/${total}, chiffre ${figuresOk}/${scored}. Fichier : ${out}`);
  if (drifted.length > 0) {
    // eslint-disable-next-line no-console -- dérive du renotage, lue dans le terminal
    console.log(`Dérive : question(s) ${drifted.join(', ')}, chiffre non renoté.`);
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production' || !isLocalDatabase(process.env.DATABASE_URL)) {
    throw new Error('banc refusé : NODE_ENV=production ou DATABASE_URL hors localhost.');
  }
  const restaurantId = process.env.DEMO_RESTAURANT_ID;
  if (!restaurantId) throw new Error('DEMO_RESTAURANT_ID absent (apps/api/.env).');
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true },
  });
  if (!restaurant) throw new Error(`restaurant ${restaurantId} introuvable dans cette base.`);

  const withoutPlanId = await findWithoutPlanRestaurant();
  const rescorePath = option('--rescore');
  if (rescorePath) {
    await rescoreFile(rescorePath, restaurantId, withoutPlanId);
    return;
  }
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY absente (apps/api/.env).');

  const trialCount = Number(option('--trials') ?? 1);
  if (!Number.isInteger(trialCount) || trialCount < 1) throw new Error('--trials : entier ≥ 1.');
  const onlyNumbers = option('--only')?.split(',').map(Number);
  const unknown = (onlyNumbers ?? []).filter((n) => !QUESTIONS.some((q) => q.n === n));
  if (unknown.length > 0)
    throw new Error(`--only : question(s) inconnue(s) ${unknown.join(', ')}.`);
  const selected = QUESTIONS.filter((question) => !onlyNumbers || onlyNumbers.includes(question.n));

  const modelChoice: ModelChoice = {
    id: option('--model') ?? env.COMPANION_LLM_MODEL,
    reasoningEffort: parseEffort(option('--reasoning')) ?? COMPANION_REASONING_EFFORT,
  };
  if (!/^[a-z0-9-]+\/[a-z0-9.-]+$/.test(modelChoice.id)) {
    throw new Error('--model : identifiant OpenRouter, par exemple anthropic/claude-sonnet-5.5.');
  }
  // eslint-disable-next-line no-console -- modèle du banc, lu dans le terminal
  console.log(
    `Modèle : ${modelChoice.id}, effort : ${modelChoice.reasoningEffort ?? 'aucun (production)'}.`,
  );
  const startedAt = new Date().toISOString();
  const results = [];
  for (const question of selected) {
    const targetId = question.restaurant === 'withoutPlan' ? withoutPlanId : restaurantId;
    const expected = question.expected ? await question.expected(targetId) : undefined;
    const trials: Trial[] = [];
    for (let attempt = 0; attempt < trialCount; attempt++) {
      trials.push(await runTrial(question, expected, targetId, modelChoice));
    }
    results.push({
      n: question.n,
      text: question.text,
      expected: expected ?? null,
      trials,
    });
    // eslint-disable-next-line no-console -- progression du banc, lue dans le terminal
    console.log(`Question ${question.n} : ${trials.length} essais`);
  }

  console.table(
    results
      .filter((result) => result.expected)
      .map((result) => ({
        '#': result.n,
        Question: result.text,
        Outil: result.trials.map((trial) => (trial.toolOk ? 'OK' : 'KO')).join(' '),
        Chiffre: result.trials.map((trial) => (trial.valueOk ? 'OK' : 'KO')).join(' '),
        Ancrage: result.trials.map((trial) => (trial.anchorOk ? 'OK' : 'KO')).join(' '),
        Attendu: formatExpected(result.expected ?? undefined),
      })),
  );
  // Ancrage sur toutes les questions ; outil et chiffre sur les questions notées.
  const everyTrial = results.flatMap((result) => result.trials);
  const scoredTrials = results
    .filter((result) => result.expected)
    .flatMap((result) => result.trials);
  const countOk = (list: Trial[], key: 'toolOk' | 'valueOk' | 'anchorOk') =>
    list.filter((trial) => trial[key]).length;
  // eslint-disable-next-line no-console -- résultats du banc, lus dans le terminal
  console.log(
    `Outil ${countOk(scoredTrials, 'toolOk')}/${scoredTrials.length}, chiffre ${countOk(scoredTrials, 'valueOk')}/${scoredTrials.length}, ancrage ${countOk(everyTrial, 'anchorOk')}/${everyTrial.length}.`,
  );
  const averageTokens = (list: Trial[]) => {
    const average = (key: 'input_tokens' | 'cached_input_tokens') =>
      list.length === 0
        ? 0
        : Math.round(list.reduce((sum, trial) => sum + trial[key], 0) / list.length);
    return `${average('input_tokens')} entrée (dont ${average('cached_input_tokens')} du cache) par essai`;
  };
  const isEnquiry = (result: { expected: Expected | null }) =>
    result.expected?.kind === 'readings' && result.expected.explain;
  // eslint-disable-next-line no-console -- résultats du banc, lus dans le terminal
  console.log(
    `Tokens moyens, question simple : ${averageTokens(results.filter((r) => r.expected && !isEnquiry(r)).flatMap((r) => r.trials))} ; enquête : ${averageTokens(results.filter((r) => isEnquiry(r)).flatMap((r) => r.trials))}.`,
  );

  const trials = results.flatMap((result) => result.trials);
  const tokens = {
    input_tokens: trials.reduce((sum, trial) => sum + trial.input_tokens, 0),
    cached_input_tokens: trials.reduce((sum, trial) => sum + trial.cached_input_tokens, 0),
    output_tokens: trials.reduce((sum, trial) => sum + trial.output_tokens, 0),
  };
  const latencies = trials.map((trial) => trial.latency_ms).sort((a, b) => a - b);
  const middle = Math.floor(latencies.length / 2);
  const median =
    latencies.length % 2 === 1
      ? latencies[middle]
      : Math.round((latencies[middle - 1] + latencies[middle]) / 2);
  // eslint-disable-next-line no-console -- latence du banc, lue dans le terminal
  console.log(`Latence par réponse : médiane ${median} ms, max ${latencies.at(-1)} ms.`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        startedAt,
        model: modelChoice.id,
        reasoningEffort: modelChoice.reasoningEffort ?? null,
        tokens,
        questions: results,
      },
      null,
      2,
    ) + '\n',
  );
  // eslint-disable-next-line no-console -- résumé du banc, lu dans le terminal
  console.log(
    `Tokens : ${tokens.input_tokens} entrée (dont ${tokens.cached_input_tokens} lus du cache), ${tokens.output_tokens} sortie (${trials.length} appels).`,
  );
  // eslint-disable-next-line no-console -- chemin du fichier de résultats
  console.log(`Résultats : ${file}`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
