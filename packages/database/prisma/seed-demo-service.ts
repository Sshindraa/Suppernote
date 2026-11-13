/**
 * Service de démo « en cours » chez le restaurant DEMO_RESTAURANT_ID (Carmelo en local), calé sur
 * l'heure d'exécution : tables installées, partis, retard, absence, arrivées imminentes, deux
 * réservations à placer, et le service du soir si on lance la démo avant 16 h.
 *
 * Base locale uniquement (même garde-fou que seed-companion). Écriture Prisma directe : aucun SMS,
 * e-mail, file ou webhook. Rejouable : supprime d'abord ses lignes (createdByClient / source =
 * 'seed-demo-service') et les réservations seed-companion du jour, qui n'ont pas de table.
 * Usage : pnpm --filter @suppernote/database seed:demo-service (après seed:companion)
 */
import {
  PrismaClient,
  type Prisma,
  type ReservationChannel,
  type ReservationState,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { isLocalDatabaseUrl } from './seed-demo-guard';

const MARKER = 'seed-demo-service';
const DURATION_MIN = 90;

const { DATABASE_URL, DEMO_RESTAURANT_ID, NODE_ENV } = process.env;
if (NODE_ENV === 'production' || !isLocalDatabaseUrl(DATABASE_URL)) {
  console.error('seed-demo-service refusé : NODE_ENV=production ou DATABASE_URL hors localhost.');
  process.exit(1);
}
if (!DEMO_RESTAURANT_ID) {
  console.error('seed-demo-service refusé : DEMO_RESTAURANT_ID absent (apps/api/.env).');
  process.exit(1);
}
const restaurantId: string = DEMO_RESTAURANT_ID;
const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Instant UTC d'une heure murale à Paris (jour AAAA-MM-JJ, minutes depuis minuit). */
function parisInstant(dayKey: string, minutes: number): Date {
  const guess = new Date(Date.parse(`${dayKey}T00:00:00Z`) + minutes * 60_000);
  const [h, m] = clockFormat.format(guess).split(':').map(Number);
  const shownDay = dayFormat.format(guess);
  const dayShift = shownDay === dayKey ? 0 : shownDay > dayKey ? 1440 : -1440;
  return new Date(guess.getTime() - (h * 60 + m + dayShift - minutes) * 60_000);
}

type Row = {
  offset?: number; // minutes depuis l'ancre (service en cours)
  at?: number; // ou heure fixe du soir, en minutes depuis minuit
  table: string | null;
  size: number;
  state: ReservationState;
  channel: ReservationChannel;
  note?: string;
  regular?: boolean;
};

// Service en cours, autour de l'ancre (heure actuelle arrondie au quart d'heure inférieur).
const LIVE: Row[] = [
  { offset: -105, table: 'T5', size: 2, state: 'HONORED', channel: 'PHONE' },
  { offset: -90, table: 'T7', size: 4, state: 'HONORED', channel: 'WEB' },
  {
    offset: -60,
    table: 'T1',
    size: 6,
    state: 'SEATED',
    channel: 'PHONE',
    note: 'Anniversaire de Claire : bougie sur le dessert, gâteau apporté par la famille.',
  },
  { offset: -45, table: 'T2', size: 4, state: 'SEATED', channel: 'WEB' },
  {
    offset: -45,
    table: 'T4',
    size: 2,
    state: 'SEATED',
    channel: 'PHONE',
    note: 'Habitué : préfère la table près de la fenêtre.',
    regular: true,
  },
  { offset: -45, table: 'T15', size: 2, state: 'NO_SHOW', channel: 'WEB' },
  {
    offset: -30,
    table: 'T14',
    size: 4,
    state: 'SEATED',
    channel: 'MCP',
    note: 'Réservé via ChatGPT.',
  },
  {
    offset: -30,
    table: 'T3',
    size: 3,
    state: 'SEATED',
    channel: 'PHONE',
    note: 'Allergie aux fruits à coque (une personne).',
  },
  { offset: -15, table: 'T9', size: 4, state: 'SEATED', channel: 'WEB' },
  { offset: -15, table: 'T8', size: 2, state: 'SEATED', channel: 'PHONE' },
  {
    offset: -15,
    table: 'T16',
    size: 4,
    state: 'CONFIRMED',
    channel: 'PHONE',
    note: 'A prévenu d’un léger retard (parking).',
  },
  { offset: 15, table: 'T5', size: 2, state: 'CONFIRMED', channel: 'WEB' },
  { offset: 15, table: 'T6', size: 4, state: 'CONFIRMED', channel: 'PHONE', regular: true },
  { offset: 15, table: 'T7', size: 3, state: 'CONFIRMED', channel: 'MCP' },
  {
    offset: 30,
    table: 'T11',
    size: 4,
    state: 'CONFIRMED',
    channel: 'PHONE',
    note: 'Chaise haute pour un bébé.',
  },
  { offset: 30, table: 'T18', size: 4, state: 'CONFIRMED', channel: 'WEB' },
  {
    offset: 45,
    table: 'T19',
    size: 3,
    state: 'CONFIRMED',
    channel: 'WEB',
    note: 'Une personne végétarienne.',
  },
  {
    offset: 45,
    table: 'T17',
    size: 6,
    state: 'CONFIRMED',
    channel: 'PHONE',
    note: 'Repas d’affaires : addition séparée.',
  },
  { offset: 60, table: 'T15', size: 2, state: 'CONFIRMED', channel: 'WEB' },
  { offset: 60, table: null, size: 2, state: 'CONFIRMED', channel: 'PHONE' },
  {
    offset: 75,
    table: null,
    size: 5,
    state: 'CONFIRMED',
    channel: 'WEB',
    note: 'Demande une table au calme.',
  },
  { offset: 30, table: null, size: 4, state: 'CANCELLED', channel: 'PHONE' },
];

// Service du soir (heures fixes), ajouté si la démo a lieu avant 16 h.
const EVENING: Row[] = [
  { at: 19 * 60, table: 'T8', size: 2, state: 'CONFIRMED', channel: 'WEB' },
  { at: 19 * 60 + 15, table: 'T2', size: 4, state: 'CONFIRMED', channel: 'PHONE' },
  {
    at: 19 * 60 + 30,
    table: 'T1',
    size: 6,
    state: 'CONFIRMED',
    channel: 'PHONE',
    note: 'Dîner d’équipe, menu unique.',
  },
  { at: 19 * 60 + 30, table: 'T14', size: 4, state: 'CONFIRMED', channel: 'MCP' },
  {
    at: 19 * 60 + 45,
    table: 'T4',
    size: 2,
    state: 'CONFIRMED',
    channel: 'WEB',
    note: 'Demande en mariage : discrétion, champagne prévu.',
  },
  { at: 20 * 60, table: 'T3', size: 4, state: 'CONFIRMED', channel: 'PHONE', regular: true },
  { at: 20 * 60, table: 'T6', size: 4, state: 'CONFIRMED', channel: 'WEB' },
  { at: 20 * 60, table: 'T17', size: 6, state: 'CONFIRMED', channel: 'PHONE' },
  {
    at: 20 * 60 + 15,
    table: 'T9',
    size: 3,
    state: 'CONFIRMED',
    channel: 'WEB',
    note: 'Sans gluten.',
  },
  { at: 20 * 60 + 30, table: 'T5', size: 2, state: 'CONFIRMED', channel: 'PHONE' },
  { at: 20 * 60 + 30, table: 'T11', size: 4, state: 'CONFIRMED', channel: 'MCP' },
  { at: 20 * 60 + 45, table: 'T7', size: 4, state: 'CONFIRMED', channel: 'WEB' },
  { at: 21 * 60, table: 'T19', size: 2, state: 'CONFIRMED', channel: 'PHONE' },
];

const legacyStatus = (state: ReservationState) =>
  state === 'CANCELLED' || state === 'NO_SHOW' || state === 'SEATED' ? state : 'CONFIRMED';

async function main() {
  const restaurant = await prisma.restaurant.findUniqueOrThrow({
    where: { id: restaurantId },
    select: { name: true },
  });
  const now = new Date();
  const today = dayFormat.format(now);
  const [h, m] = clockFormat.format(now).split(':').map(Number);
  const anchor = h * 60 + m - ((h * 60 + m) % 15);
  const dayStart = parisInstant(today, 0);
  const dayEnd = parisInstant(today, 24 * 60 - 1);

  const tables = await prisma.table.findMany({
    where: { isActive: true, floorPlan: { restaurantId, isActive: true } },
    select: { id: true, name: true },
  });
  const tableId = new Map(tables.map((t) => [t.name, t.id]));

  // Clients fictifs du seed Companion : les habitués sont ceux qui ont le plus d'historique.
  const customers = await prisma.customer.findMany({
    where: { restaurantId, notes: 'seed-companion' },
    select: {
      id: true,
      name: true,
      phone: true,
      emailNormalized: true,
      _count: { select: { reservations: true } },
    },
    orderBy: { reservations: { _count: 'desc' } },
  });
  if (customers.length < 40) {
    throw new Error(
      'Lancez d’abord seed:companion : il fournit les clients fictifs et leur historique.',
    );
  }
  const regulars = customers.slice(0, 5);
  const others = customers.slice(5);
  let r = 0;
  let o = 0;

  const rows = [...LIVE, ...(anchor < 16 * 60 ? EVENING : [])];
  const reservations: Prisma.ReservationCreateManyInput[] = rows.map((row) => {
    const minutes = row.at ?? anchor + (row.offset ?? 0);
    const startsAt = parisInstant(today, minutes);
    const customer = row.regular ? regulars[r++ % regulars.length] : others[o++ % others.length];
    if (row.table && !tableId.has(row.table))
      throw new Error(`Table ${row.table} absente du plan.`);
    return {
      id: randomUUID(),
      restaurantId,
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      customerEmail: customer.emailNormalized,
      reservedAt: startsAt,
      startsAt,
      endsAt: new Date(startsAt.getTime() + DURATION_MIN * 60_000),
      partySize: row.size,
      estimatedRevenue: row.size * 42,
      channel: row.channel,
      state: row.state,
      status: legacyStatus(row.state),
      tableId: row.table ? tableId.get(row.table)! : null,
      specialRequests: row.note ?? null,
      createdAt: new Date(startsAt.getTime() - (2 + (o % 9)) * 86_400_000),
      createdByClient: MARKER,
    };
  });

  const evening = parisInstant(today, 20 * 60 + 30);
  const waitlist: Prisma.WaitingListEntryCreateManyInput[] =
    anchor < 16 * 60
      ? [4, 2].map((partySize, index) => {
          const c = others[o++ % others.length];
          const [first, ...last] = c.name.split(' ');
          return {
            id: randomUUID(),
            restaurantId,
            partySize,
            customerFirstName: first,
            customerLastName: last.join(' ') || null,
            customerPhone: c.phone,
            customerPhoneNormalized: c.phone,
            customerEmail: c.emailNormalized,
            slotStart: evening,
            slotEnd: new Date(evening.getTime() + DURATION_MIN * 60_000),
            status: 'PENDING' as const,
            position: index + 1,
            actionTokenHash: `${MARKER}-${randomUUID()}`,
            expiresAt: evening,
            source: MARKER,
            createdAt: new Date(now.getTime() - (index + 1) * 3_600_000),
          };
        })
      : [];

  await prisma.$transaction([
    prisma.reservation.deleteMany({ where: { restaurantId, createdByClient: MARKER } }),
    prisma.waitingListEntry.deleteMany({ where: { restaurantId, source: MARKER } }),
    prisma.reservation.deleteMany({
      where: {
        restaurantId,
        createdByClient: 'seed-companion',
        startsAt: { gte: dayStart, lte: dayEnd },
      },
    }),
    prisma.reservation.createMany({ data: reservations }),
    prisma.waitingListEntry.createMany({ data: waitlist }),
  ]);

  const count = (state: ReservationState) =>
    rows.filter((row) => row.state === state && row.offset !== undefined).length;
  // eslint-disable-next-line no-console -- bilan de la graine, lu dans le terminal
  console.log(
    `Service de démo chez ${restaurant.name}, ${today} autour de ${String(Math.floor(anchor / 60)).padStart(2, '0')}h${String(anchor % 60).padStart(2, '0')} : ` +
      `${count('SEATED')} tables installées, ${count('HONORED')} parties, 1 en retard, ${count('NO_SHOW')} absence, ` +
      `${LIVE.filter((x) => (x.offset ?? 0) > 0 && x.state === 'CONFIRMED').length} arrivées à venir (dont 2 à placer)` +
      `${anchor < 16 * 60 ? `, ${EVENING.length} réservations ce soir, ${waitlist.length} en liste d’attente` : ''}.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
