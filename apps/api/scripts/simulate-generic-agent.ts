/**
 * Simulation end-to-end du Generic Agent REST adapter.
 *
 * Prérequis :
 *   - pnpm dev lancé sur localhost:4000
 *   - AGENT_DEV_KEY configuré dans .env.local
 *   - seed DB : pnpm db:seed
 *
 * Scénario :
 *   1. Créer un plan de salle + tables pour le demo restaurant si besoin.
 *   2. search_restaurants (Lyon, mardi 19h, 2 pers)
 *   3. check_availability sur le demo restaurant
 *   4. create_reservation
 *   5. get_reservation_status
 *   6. cancel_reservation
 */

import { randomUUID } from 'crypto';
import { env } from '../src/env';
import { db } from '../src/shared/db/client';

const API_URL = 'http://localhost:4000';
const DEMO_SLUG = 'chez-suppernote-demo';
const LEGACY_DEMO_SLUG = 'chez-sokar-demo';

const KEY = env.AGENT_DEV_KEY;
if (!KEY) {
  console.error('AGENT_DEV_KEY manquant dans .env.local');
  process.exit(1);
}

async function callAgent(tool: string, args: Record<string, unknown>) {
  const res = await fetch(`${API_URL}/v1/agents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const status = res.status;
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = { raw: await res.text() };
  }
  return { status, body };
}

async function ensureFloorPlan(restoId: string) {
  // A restaurant owns several floor plans since the editor rework, so
  // `restaurantId` is no longer unique and cannot be used in an upsert.
  const existingPlan = await db.floorPlan.findFirst({
    where: { restaurantId: restoId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  const floorPlan =
    existingPlan ??
    (await db.floorPlan.create({
      data: {
        id: randomUUID(),
        restaurantId: restoId,
        name: 'Salle principale',
      },
    }));

  const existing = await db.table.findFirst({ where: { floorPlanId: floorPlan.id } });
  if (!existing) {
    await db.table.createMany({
      data: [
        { id: randomUUID(), floorPlanId: floorPlan.id, name: 'T1', capacity: 2, minCapacity: 1 },
        { id: randomUUID(), floorPlanId: floorPlan.id, name: 'T2', capacity: 4, minCapacity: 1 },
        { id: randomUUID(), floorPlanId: floorPlan.id, name: 'T3', capacity: 6, minCapacity: 1 },
      ],
    });
    // eslint-disable-next-line no-console
    console.log('Plan de salle + tables créés pour le demo restaurant');
  }

  return floorPlan;
}

/**
 * The demo restaurant opens Tuesday to Saturday. Return the next such day at
 * 19:00 in the machine's timezone so the simulation never depends on a date
 * that silently expires.
 */
function nextOpenSlot(): { start: string; end: string } {
  const openDays = new Set([2, 3, 4, 5, 6]); // mardi → samedi
  const start = new Date();
  start.setDate(start.getDate() + 1);
  for (let i = 0; i < 8 && !openDays.has(start.getDay()); i += 1) {
    start.setDate(start.getDate() + 1);
  }
  start.setHours(19, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function main() {
  const resto =
    (await db.restaurant.findUnique({ where: { slug: DEMO_SLUG } })) ??
    (await db.restaurant.findUnique({ where: { slug: LEGACY_DEMO_SLUG } }));
  if (!resto) {
    console.error(`Restaurant ${DEMO_SLUG} non trouvé. Lance pnpm db:seed.`);
    process.exit(1);
  }

  await ensureFloorPlan(resto.id);

  const { start: slotStart, end: slotEnd } = nextOpenSlot();
  // eslint-disable-next-line no-console
  console.log(`Créneau simulé : ${slotStart} → ${slotEnd}`);

  // eslint-disable-next-line no-console
  console.log('--- search_restaurants ---');
  const search = await callAgent('search_restaurants', {
    city: 'Lyon',
    partySize: 2,
    slotStart,
    slotEnd,
    maxResults: 5,
  });
  // eslint-disable-next-line no-console
  console.log(`status: ${search.status}`, JSON.stringify(search.body, null, 2));

  // eslint-disable-next-line no-console
  console.log('--- check_availability ---');
  const check = await callAgent('check_availability', {
    restaurantId: resto.id,
    partySize: 2,
    slotStart,
    slotEnd,
  });
  // eslint-disable-next-line no-console
  console.log(`status: ${check.status}`, JSON.stringify(check.body, null, 2));

  const checkResult = check.body.result as Record<string, unknown> | undefined;
  if (!checkResult?.available) {
    console.error('Créneau non disponible, impossible de créer la réservation');
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('--- create_reservation ---');
  const create = await callAgent('create_reservation', {
    restaurantId: resto.id,
    partySize: 2,
    startsAt: slotStart,
    endsAt: slotEnd,
    customerName: 'Alice Dupont',
    customerPhone: '+33612345678',
    specialRequests: 'Terrasse si possible',
    idempotencyKey: randomUUID(),
    consents: { reservationProcessing: true },
  });
  // eslint-disable-next-line no-console
  console.log(`status: ${create.status}`, JSON.stringify(create.body, null, 2));

  const createResult = create.body.result as Record<string, unknown> | undefined;
  const reservationId = createResult?.reservationId as string | undefined;
  if (!reservationId) {
    console.error('Aucune reservationId retournée');
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log('--- get_reservation_status ---');
  const status = await callAgent('get_reservation_status', { reservationId });
  // eslint-disable-next-line no-console
  console.log(`status: ${status.status}`, JSON.stringify(status.body, null, 2));

  // eslint-disable-next-line no-console
  console.log('--- cancel_reservation ---');
  const cancel = await callAgent('cancel_reservation', {
    reservationId,
    reason: 'Simulation generic-agent',
  });
  // eslint-disable-next-line no-console
  console.log(`status: ${cancel.status}`, JSON.stringify(cancel.body, null, 2));

  // eslint-disable-next-line no-console
  console.log('Simulation terminée avec succès');
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
