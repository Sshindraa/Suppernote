/**
 * Test de cohérence : vérifie que TOOL_LIST (server.ts) et les
 * schémas Zod (schemas.ts) restent synchronisés.
 *
 * Sans ce test, quelqu'un peut ajouter un champ au schema Zod mais
 * oublier de mettre à jour le JSON schema dans TOOL_LIST (ou inversement).
 * C'est le risque de drift #15 de l'audit.
 */

import { describe, expect, it } from 'vitest';
import type { ZodTypeAny } from 'zod';
import { TOOL_LIST } from '../../server';
import {
  SearchRestaurantsInputSchema,
  AnswerAvailabilityOutputSchema,
  GetRestaurantDetailsInputSchema,
  CheckAvailabilityInputSchema,
  CreateQuoteInputSchema,
  CreateHoldInputSchema,
  CreateReservationInputSchema,
  JoinWaitingListInputSchema,
  CancelWaitingListInputSchema,
  ModifyReservationInputSchema,
  CancelReservationInputSchema,
  GetReservationStatusInputSchema,
} from '../schemas';

describe('TOOL_LIST ↔ Zod schema consistency', () => {
  const schemas: Record<string, ZodTypeAny> = {
    answer_availability: SearchRestaurantsInputSchema,
    search_restaurants: SearchRestaurantsInputSchema,
    get_restaurant_details: GetRestaurantDetailsInputSchema,
    check_availability: CheckAvailabilityInputSchema,
    create_quote: CreateQuoteInputSchema,
    create_hold: CreateHoldInputSchema,
    create_reservation: CreateReservationInputSchema,
    join_waiting_list: JoinWaitingListInputSchema,
    cancel_waiting_list: CancelWaitingListInputSchema,
    modify_reservation: ModifyReservationInputSchema,
    cancel_reservation: CancelReservationInputSchema,
    get_reservation_status: GetReservationStatusInputSchema,
  };

  it('TOOL_LIST has exactly 12 tools', () => {
    expect(TOOL_LIST).toHaveLength(12);
  });

  it('every tool has a title', () => {
    for (const tool of TOOL_LIST) {
      expect(tool.title, `${tool.name} missing title`).toBeDefined();
      expect(typeof tool.title).toBe('string');
      expect(tool.title!.length).toBeGreaterThan(0);
    }
  });

  it('every tool exposes an object output schema', () => {
    for (const tool of TOOL_LIST) {
      expect(tool.outputSchema, `${tool.name} missing outputSchema`).toBeDefined();
      expect((tool.outputSchema as { type?: string }).type).toBe('object');
      expect((tool.outputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(
        false,
      );
    }
  });

  it('every object in input and output schemas rejects extra properties', () => {
    const openObjects: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((child, i) => walk(child, `${path}[${i}]`));
      if (!node || typeof node !== 'object') return;
      const schema = node as Record<string, unknown>;
      if (schema.type === 'object' && schema.additionalProperties === undefined) {
        openObjects.push(path);
      }
      for (const [key, child] of Object.entries(schema)) walk(child, `${path}/${key}`);
    };
    for (const tool of TOOL_LIST) {
      walk(tool.inputSchema, `${tool.name}.input`);
      walk(tool.outputSchema, `${tool.name}.output`);
    }
    expect(openObjects).toEqual([]);
  });

  it('every tool declares the OAuth scope required by its operation', () => {
    const expectedScopes: Record<string, string> = {
      answer_availability: 'mcp:read',
      search_restaurants: 'mcp:read',
      get_restaurant_details: 'mcp:read',
      check_availability: 'mcp:read',
      create_quote: 'mcp:reserve',
      create_hold: 'mcp:reserve',
      create_reservation: 'mcp:reserve',
      join_waiting_list: 'mcp:reserve',
      cancel_waiting_list: 'mcp:cancel',
      modify_reservation: 'mcp:reserve',
      cancel_reservation: 'mcp:cancel',
      get_reservation_status: 'mcp:read',
    };

    for (const tool of TOOL_LIST) {
      expect(tool.securitySchemes, `${tool.name} missing securitySchemes`).toEqual([
        { type: 'oauth2', scopes: [expectedScopes[tool.name]] },
      ]);
    }
  });

  it('every tool declares readOnly or destructive behavior', () => {
    for (const tool of TOOL_LIST) {
      const ann = tool.annotations || {};
      const hasReadOnly = typeof ann.readOnlyHint === 'boolean';
      const hasDestructive = typeof ann.destructiveHint === 'boolean';
      expect(
        hasReadOnly || hasDestructive,
        `${tool.name} must have readOnlyHint or destructiveHint`,
      ).toBe(true);
    }
  });

  it('marks reservation cancellation as safe to retry', () => {
    const cancelTool = TOOL_LIST.find((tool) => tool.name === 'cancel_reservation');
    expect(cancelTool?.annotations).toMatchObject({ idempotentHint: true });
  });

  it('every tool name matches a Zod schema', () => {
    for (const tool of TOOL_LIST) {
      expect(schemas[tool.name], `${tool.name} has no matching Zod schema`).toBeDefined();
    }
  });

  it('every required field in TOOL_LIST JSON schema is required in Zod', () => {
    for (const tool of TOOL_LIST) {
      const schema = schemas[tool.name];
      if (!schema) continue;

      const jsonRequired = (tool.inputSchema as { required?: string[] }).required;
      if (!jsonRequired) continue;

      const base =
        (schema as unknown as { sourceType?: () => ZodTypeAny }).sourceType?.() ?? schema;
      const zodShape = (base as unknown as { shape: Record<string, unknown> }).shape;
      for (const field of jsonRequired) {
        expect(
          zodShape[field],
          `${tool.name}: field "${field}" is required in TOOL_LIST but missing from Zod schema`,
        ).toBeDefined();
      }
    }
  });

  it('search_restaurants has cursor field in TOOL_LIST', () => {
    const searchTool = TOOL_LIST.find((t) => t.name === 'search_restaurants');
    expect(searchTool).toBeDefined();
    const props = (searchTool!.inputSchema as Record<string, unknown>).properties as
      | Record<string, unknown>
      | undefined;
    expect(props?.cursor).toBeDefined();
    expect(props?.restaurantName).toBeDefined();
  });

  it('read-tool descriptions keep natural requests on the exact requested time', () => {
    const answerTool = TOOL_LIST.find((tool) => tool.name === 'answer_availability');
    const searchTool = TOOL_LIST.find((tool) => tool.name === 'search_restaurants');
    const availabilityTool = TOOL_LIST.find((tool) => tool.name === 'check_availability');

    expect(answerTool?.description).toContain('question simple en langage courant');
    expect(answerTool?.description).toContain('aucun horaire de fin');
    expect(answerTool?.description).toContain(
      'sans ajouter de commentaire sur l’absence de réservation',
    );
    expect((answerTool?.outputSchema as { required?: string[] }).required).toEqual(['message']);
    expect(
      AnswerAvailabilityOutputSchema.safeParse({
        message: 'Oui, une table est disponible au restaurant Chez Suppernote à 19 h.',
      }).success,
    ).toBe(true);
    expect(searchTool?.description).toContain('recherche unique qui commence à 19 h');
    expect(searchTool?.description).toContain('utilisez answer_availability');
    expect(searchTool?.description).toContain('mentionnez uniquement celle-ci');
    expect(availabilityTool?.description).toContain('ne multipliez pas les appels');
    expect(availabilityTool?.description).toContain('alternatives réellement retournées');
    expect(searchTool?.description).toContain('Réutilisez exactement le texte lisible du résultat');
    expect(availabilityTool?.description).toContain(
      'Réutilisez exactement le texte lisible du résultat',
    );
    expect(searchTool?.description).not.toContain('120 minutes');
    expect(availabilityTool?.description).not.toContain('120 minutes');

    const searchSchema = searchTool?.inputSchema as {
      properties?: { slotEnd?: { description?: string } };
    };
    const endBoundaryDescription = (
      searchTool?.outputSchema as {
        properties?: {
          restaurants?: {
            items?: {
              properties?: {
                availableSlots?: {
                  items?: { properties?: { endsAt?: { description?: string } } };
                };
              };
            };
          };
        };
      }
    )?.properties?.restaurants?.items?.properties?.availableSlots?.items?.properties?.endsAt
      ?.description;

    expect(searchSchema.properties?.slotEnd?.description).toContain(
      'Do not mention any implicit end time',
    );
    expect(endBoundaryDescription).toContain('Technical end boundary');
    expect(endBoundaryDescription).toContain('do not show this value');
  });

  it('uses the two-hour default for read checks but keeps holds and quotes explicit', () => {
    const naturalReadRequest = {
      restaurantId: '550e8400-e29b-41d4-a716-446655440000',
      partySize: 2,
      slotStart: '2026-10-01T19:00:00',
    };

    expect(CheckAvailabilityInputSchema.safeParse(naturalReadRequest).success).toBe(true);
    expect(CreateQuoteInputSchema.safeParse(naturalReadRequest).success).toBe(false);
    expect(CreateHoldInputSchema.safeParse(naturalReadRequest).success).toBe(false);
  });

  it('join_waiting_list requires explicit processing consent', () => {
    const result = JoinWaitingListInputSchema.safeParse({
      restaurantId: '550e8400-e29b-41d4-a716-446655440000',
      partySize: 2,
      slotStart: '2026-12-01T19:00:00Z',
      slotEnd: '2026-12-01T21:00:00Z',
      customerFirstName: 'Alice',
      customerPhone: '+33612345678',
    });
    expect(result.success).toBe(false);
  });
});
