/**
 * Client MCP de test pour Suppernote.
 *
 * Usage :
 *   cd apps/api
 *   SOKAR_MCP_KEY=sk_sokar_agent_xxx pnpm --filter @suppernote/api exec tsx ../../tools/diagnostics/test-mcp-client.ts
 *
 * Variables d'environnement :
 *   SOKAR_API_BASE   (défaut http://localhost:4000)
 *   SOKAR_MCP_KEY    clé dev (doit matcher AGENT_DEV_KEY côté API)
 */

const API_BASE = process.env.SOKAR_API_BASE ?? 'http://localhost:4000';
const MCP_KEY = process.env.SOKAR_MCP_KEY;
if (!MCP_KEY) {
  throw new Error(
    'SOKAR_MCP_KEY est obligatoire ; utilisez une clé MCP locale générée par le dashboard.',
  );
}
const TEST_CITY = process.env.SOKAR_TEST_CITY ?? 'Lyon';
const TEST_CUSTOMER_NAME = process.env.SOKAR_TEST_CUSTOMER_NAME ?? 'Claude Test';
const TEST_CUSTOMER_PHONE = process.env.SOKAR_TEST_CUSTOMER_PHONE ?? '+33612345678';
const TEST_OPEN_DAYS = process.env.SOKAR_TEST_OPEN_DAYS ?? '2,3,4,5,6';
const OPEN_DAYS = new Set(TEST_OPEN_DAYS.split(',').map((d) => parseInt(d.trim(), 10))); // tue-sat, aligned with the demo seed.

async function mcpCall(
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 1,
): Promise<unknown> {
  const res = await fetch(`${API_BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MCP_KEY}`,
      Origin: 'https://claude.ai',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

type TestSlot = {
  startsAt: string;
  endsAt: string;
};

type McpResponse = {
  result?: {
    content?: Array<{ text?: string }>;
    tools?: Array<{ name: string }>;
  };
};

type InitResponse = {
  callControlId: string;
  restaurant: { id: string; name: string };
  caller: { phone: string; isVip: boolean };
  mode: string;
};

function daysAheadAt(daysAhead: number, hour: number, minute: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function buildSlotCandidates(): TestSlot[] {
  const candidates: TestSlot[] = [];
  for (let daysAhead = 1; daysAhead <= 28; daysAhead += 1) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    if (!OPEN_DAYS.has(d.getDay())) continue;

    for (const minute of [0, 15, 30, 45]) {
      candidates.push({
        startsAt: daysAheadAt(daysAhead, 19, minute),
        endsAt: daysAheadAt(daysAhead, 21, minute),
      });
    }
  }
  return candidates;
}

async function main() {
  console.log('=== MCP Suppernote — test client ===\n');

  // 1. Initialize
  console.log('1. initialize');
  const init = (await mcpCall('initialize', {}, 1)) as InitResponse;
  console.log(JSON.stringify(init, null, 2));

  // 2. tools/list
  console.log('\n2. tools/list');
  const tools = (await mcpCall('tools/list', {}, 2)) as McpResponse;
  const names = tools.result?.tools?.map((t) => t.name) ?? [];
  console.log('Tools:', names.join(', '));

  let restaurantId: string | null = null;
  let selectedSlot: TestSlot | null = null;
  const candidates = buildSlotCandidates();

  // 3. search_restaurants
  console.log('\n3. search_restaurants (Lyon, 2 pers, prochain créneau libre)');
  for (const candidate of candidates) {
    const search = (await mcpCall(
      'tools/call',
      {
        name: 'search_restaurants',
        arguments: {
          city: TEST_CITY,
          partySize: 2,
          slotStart: candidate.startsAt,
          slotEnd: candidate.endsAt,
        },
      },
      3,
    )) as McpResponse;

    const searchText = search.result?.content?.[0]?.text;
    if (searchText) {
      const data = JSON.parse(searchText) as
        | { restaurants?: Array<{ slug: string; id: string }> }
        | undefined;
      const found =
        data?.restaurants?.find((r) => r.slug === 'chez-suppernote-demo') ?? data?.restaurants?.[0];
      restaurantId = found?.id ?? null;
      selectedSlot = restaurantId ? candidate : null;
    }

    if (restaurantId && selectedSlot) {
      console.log(JSON.stringify(search, null, 2));
      console.log(`Créneau sélectionné : ${selectedSlot.startsAt} → ${selectedSlot.endsAt}`);
      break;
    }
  }

  if (!restaurantId || !selectedSlot) {
    console.error(
      'Aucun restaurant/créneau trouvé. Vérifie que le seed a tourné (pnpm db:seed) et que les prochains créneaux ne sont pas tous occupés.',
    );
    process.exit(1);
  }
  console.log(`Restaurant sélectionné : ${restaurantId}`);

  // 4. get_restaurant_details
  console.log('\n4. get_restaurant_details');
  const details = await mcpCall(
    'tools/call',
    {
      name: 'get_restaurant_details',
      arguments: { restaurantId },
    },
    4,
  );
  console.log(JSON.stringify(details, null, 2));

  // 5. check_availability
  console.log('\n5. check_availability');
  const availability = await mcpCall(
    'tools/call',
    {
      name: 'check_availability',
      arguments: {
        restaurantId,
        partySize: 2,
        slotStart: selectedSlot.startsAt,
        slotEnd: selectedSlot.endsAt,
      },
    },
    5,
  );
  console.log(JSON.stringify(availability, null, 2));

  // 6. create_reservation
  console.log('\n6. create_reservation');
  const idempotencyKey = `test-mcp-${Date.now()}`;
  const reservation = (await mcpCall(
    'tools/call',
    {
      name: 'create_reservation',
      arguments: {
        restaurantId,
        partySize: 2,
        startsAt: selectedSlot.startsAt,
        endsAt: selectedSlot.endsAt,
        customerName: TEST_CUSTOMER_NAME,
        customerPhone: TEST_CUSTOMER_PHONE,
        specialRequests: 'Table en terrasse si possible',
        idempotencyKey,
        consents: { reservationProcessing: true },
      },
    },
    6,
  )) as McpResponse;
  console.log(JSON.stringify(reservation, null, 2));

  const reservationText = reservation.result?.content?.[0]?.text;
  const reservationId = reservationText
    ? ((JSON.parse(reservationText) as { reservationId?: string } | undefined)?.reservationId ??
      null)
    : null;

  if (reservationId) {
    // 7. get_reservation_status
    console.log('\n7. get_reservation_status');
    const status = await mcpCall(
      'tools/call',
      {
        name: 'get_reservation_status',
        arguments: { reservationId },
      },
      7,
    );
    console.log(JSON.stringify(status, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
