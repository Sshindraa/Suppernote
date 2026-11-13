import { randomUUID } from 'node:crypto';
import type {
  SuppernoteAgentClientConfig,
  ToolName,
  ToolListFormat,
  SearchRestaurantsInput,
  GetRestaurantDetailsInput,
  CheckAvailabilityInput,
  CreateReservationInput,
  CancelReservationInput,
  GetReservationStatusInput,
} from './types.js';

export class SuppernoteAgentClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly toolFormat: ToolListFormat;
  private readonly timeoutMs: number;

  constructor(config: SuppernoteAgentClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.toolFormat = config.toolFormat ?? 'openai';
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  /**
   * Récupère la liste des tools avec leurs schémas JSON.
   * Le format dépend de `toolFormat` (mcp, openai, mistral, gemini).
   */
  async getTools(): Promise<unknown[]> {
    const url = `${this.baseUrl}/v1/agents/tools?format=${this.toolFormat}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`SuppernoteAgentClient.getTools failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { tools: unknown[] };
    return body.tools;
  }

  /**
   * Exécute un tool sur l'API Suppernote.
   */
  async executeTool(tool: ToolName, args: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/v1/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ tool, arguments: args }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = (await res.json()) as { result?: unknown; error?: string; code?: string };
    if (!res.ok) {
      throw new Error(
        `SuppernoteAgentClient.executeTool('${tool}') failed: ${res.status} ${body.error ?? body.code ?? 'unknown'}`,
      );
    }
    return body.result;
  }

  // ─── Wrappers typés pour chaque tool ───────────────────────────────

  async searchRestaurants(input: SearchRestaurantsInput) {
    return this.executeTool('search_restaurants', input as Record<string, unknown>);
  }

  async getRestaurantDetails(input: GetRestaurantDetailsInput) {
    return this.executeTool('get_restaurant_details', input as Record<string, unknown>);
  }

  async checkAvailability(input: CheckAvailabilityInput) {
    return this.executeTool('check_availability', input as Record<string, unknown>);
  }

  async createReservation(input: CreateReservationInput) {
    const payload = {
      ...input,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    };
    return this.executeTool('create_reservation', payload as Record<string, unknown>);
  }

  async cancelReservation(input: CancelReservationInput) {
    return this.executeTool('cancel_reservation', input as Record<string, unknown>);
  }

  async getReservationStatus(input: GetReservationStatusInput) {
    return this.executeTool('get_reservation_status', input as Record<string, unknown>);
  }
}
