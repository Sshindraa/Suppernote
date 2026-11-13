#!/usr/bin/env node
/**
 * Bridge MCP stdio pour Claude Desktop.
 *
 * Il expose les mêmes tools que POST /mcp et délègue toute la logique métier,
 * auth, gating et audit au serveur HTTP Suppernote.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = process.env.SOKAR_API_BASE ?? 'http://localhost:4000';
const MCP_KEY = process.env.SOKAR_MCP_KEY;

if (!MCP_KEY) {
  throw new Error(
    'SOKAR_MCP_KEY est obligatoire ; utilisez une clé MCP locale générée par le dashboard.',
  );
}

type ToolCallResponse = {
  jsonrpc: '2.0';
  id: string | number;
  result?: {
    content?: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string; data?: unknown };
};

const server = new McpServer({
  name: 'sokar-restaurants',
  version: '0.1.0',
});
const dateTime = z.string().min(16);
const slotInput = {
  restaurantId: z.string().uuid(),
  partySize: z.number().int().min(1).max(50),
  slotStart: dateTime,
  slotEnd: dateTime,
  timezone: z.string().optional(),
};

async function callHttpTool(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MCP_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      content: [{ type: 'text' as const, text: `HTTP ${res.status}: ${text}` }],
      isError: true,
    };
  }

  const body = (await res.json()) as ToolCallResponse;
  if (body.error) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(body.error) }],
      isError: true,
    };
  }

  return {
    content: body.result?.content ?? [{ type: 'text' as const, text: '{}' }],
    isError: body.result?.isError ?? false,
  };
}

server.registerTool(
  'search_restaurants',
  {
    description: 'Search restaurants available for a given party size, time, and city.',
    inputSchema: {
      city: z.string().min(1).max(100),
      partySize: z.number().int().min(1).max(50),
      slotStart: dateTime,
      slotEnd: dateTime,
      timezone: z.string().optional(),
      cuisineType: z.array(z.string()).max(10).optional(),
      maxResults: z.number().int().min(1).max(20).optional(),
      cursor: z.string().optional(),
    },
  },
  async (args) => callHttpTool('search_restaurants', args),
);

server.registerTool(
  'get_restaurant_details',
  {
    description: 'Get public details of a specific restaurant by ID.',
    inputSchema: {
      restaurantId: z.string().uuid(),
    },
  },
  async (args) => callHttpTool('get_restaurant_details', args),
);

server.registerTool(
  'check_availability',
  {
    description: 'Check if a restaurant has availability for a party size and time slot.',
    inputSchema: slotInput,
  },
  async (args) => callHttpTool('check_availability', args),
);

server.registerTool(
  'create_quote',
  {
    description: 'Check a slot and create a short-lived quote without holding capacity.',
    inputSchema: slotInput,
  },
  async (args) => callHttpTool('create_quote', args),
);

server.registerTool(
  'create_hold',
  {
    description: 'Temporarily hold a slot. Pass the returned holdToken to create_reservation.',
    inputSchema: slotInput,
  },
  async (args) => callHttpTool('create_hold', args),
);

server.registerTool(
  'create_reservation',
  {
    description: 'Create a reservation. Requires explicit user consent.',
    inputSchema: {
      restaurantId: z.string().uuid(),
      partySize: z.number().int().min(1).max(50),
      startsAt: dateTime,
      endsAt: dateTime,
      timezone: z.string().optional(),
      customerName: z.string().min(1).max(100),
      customerPhone: z.string(),
      specialRequests: z.string().max(500).optional(),
      holdToken: z.string().optional(),
      idempotencyKey: z.string().min(1).max(100),
      consents: z.object({
        reservationProcessing: z.literal(true),
        transactionalSms: z.boolean().optional(),
        transactionalEmail: z.boolean().optional(),
        marketingOptIn: z.boolean().optional(),
      }),
    },
  },
  async (args) => callHttpTool('create_reservation', args),
);

server.registerTool(
  'join_waiting_list',
  {
    description: 'Join the waiting list when the restaurant has enabled it.',
    inputSchema: {
      ...slotInput,
      customerFirstName: z.string().min(1).max(100),
      customerLastName: z.string().max(100).optional(),
      customerPhone: z.string(),
      customerEmail: z.string().email().optional(),
    },
  },
  async (args) => callHttpTool('join_waiting_list', args),
);

server.registerTool(
  'cancel_waiting_list',
  {
    description: 'Leave the waiting list using the action token returned on joining.',
    inputSchema: {
      restaurantId: z.string().uuid(),
      entryId: z.string().uuid(),
      actionToken: z.string().min(20),
    },
  },
  async (args) => callHttpTool('cancel_waiting_list', args),
);

server.registerTool(
  'modify_reservation',
  {
    description: 'Change a reservation time, party size, or customer name.',
    inputSchema: {
      reservationId: z.string().uuid(),
      customerPhone: z.string().optional(),
      partySize: z.number().int().min(1).max(50).optional(),
      startsAt: dateTime.optional(),
      endsAt: dateTime.optional(),
      timezone: z.string().optional(),
      customerName: z.string().min(1).max(100).optional(),
    },
  },
  async (args) => callHttpTool('modify_reservation', args),
);

server.registerTool(
  'cancel_reservation',
  {
    description: 'Cancel an existing reservation.',
    inputSchema: {
      reservationId: z.string().uuid(),
      customerPhone: z.string().optional(),
      reason: z.string().max(500).optional(),
    },
  },
  async (args) => callHttpTool('cancel_reservation', args),
);

server.registerTool(
  'get_reservation_status',
  {
    description: 'Get the status of an existing reservation by ID.',
    inputSchema: {
      reservationId: z.string().uuid(),
      customerPhone: z.string().optional(),
    },
  },
  async (args) => callHttpTool('get_reservation_status', args),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Suppernote MCP stdio bridge running; proxy=${API_BASE}/mcp`);
}

main().catch((err) => {
  console.error('Suppernote MCP stdio bridge failed:', err);
  process.exit(1);
});
