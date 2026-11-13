/**
 * Generic Agent REST adapter — API HTTP simple pour les LLMs qui ne supportent pas MCP.
 *
 * Cible : Mistral, Gemini, OpenAI API (function calling), ou tout agent custom.
 * Réutilise les mêmes tools que le MCP server, mais avec un transport REST classique
 * au lieu du protocole MCP JSON-RPC.
 *
 * Endpoint : POST /v1/agents
 * Body     : { "tool": "search_restaurants", "arguments": { ... } }
 * Auth     : Bearer sk_suppernote_agent_xxx (même clés que MCP)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticateMcpRequest, McpAuthError } from '../mcp/auth';
import { McpRateLimiter } from '../mcp/rate-limit';
import { executeTool, McpToolRegistry } from '../mcp/tools/registry';
import { TOOL_LIST } from '../mcp/tools/tool-definitions';
import { db } from '../../../shared/db/client';
import { redisCache } from '../../../shared/redis/client';
import type { ReservationChannel } from '../core/state-machine';

const GenericAgentRequestSchema = z.object({
  tool: z.enum([
    'search_restaurants',
    'get_restaurant_details',
    'check_availability',
    'create_reservation',
    'cancel_reservation',
    'get_reservation_status',
  ]),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

function mapToolErrorToStatus(code: string): number {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'POLICY_VIOLATION':
    case 'SLOT_NOT_AVAILABLE':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'INVALID_INPUT':
    case 'INVALID_STATE':
    case 'IDEMPOTENCY_CONFLICT':
      return 400;
    default:
      return 500;
  }
}

const ToolListFormatSchema = z.enum(['mcp', 'openai', 'mistral', 'gemini']).default('mcp');

function formatToolList(format: string) {
  switch (format) {
    case 'openai':
    case 'mistral':
      return {
        tools: TOOL_LIST.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      };
    case 'gemini':
      return {
        tools: [
          {
            function_declarations: TOOL_LIST.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
          },
        ],
      };
    default:
      return { tools: TOOL_LIST };
  }
}

export async function genericAgentRoutes(app: FastifyInstance): Promise<void> {
  const rateLimiter = new McpRateLimiter(redisCache);
  const registry = new McpToolRegistry(db, rateLimiter);

  app.get(
    '/v1/agents/tools',
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = ToolListFormatSchema.safeParse((req.query as { format?: string }).format);
      const format = parsed.success ? parsed.data : 'mcp';
      return reply.send(formatToolList(format));
    },
  );

  app.post(
    '/v1/agents',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute',
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = GenericAgentRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid input',
          details: parsed.error.format(),
        });
      }

      const { tool, arguments: args } = parsed.data;

      let authCtx;
      try {
        const auth = await authenticateMcpRequest(req, db);
        authCtx = {
          clientId: auth.clientId,
          clientName: auth.clientName,
          restaurantId: auth.restaurantId,
          scopes: auth.scopes,
          actor: `generic-agent:${auth.clientId}`,
          credentialType: auth.credentialType,
          transport: 'generic_agent' as const,
          channel: 'API' as ReservationChannel,
          clientIp: req.ip,
        };
      } catch (err) {
        if (err instanceof McpAuthError) {
          return reply.status(err.statusCode).send({ error: err.message, code: err.code });
        }
        throw err;
      }

      const result = await executeTool(registry, tool, args, authCtx);

      if (result.ok) {
        return reply.send({ result: result.data });
      }

      return reply.status(mapToolErrorToStatus(result.code)).send({
        error: result.error,
        code: result.code,
      });
    },
  );
}
