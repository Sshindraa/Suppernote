import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetMetrics,
  renderMetrics,
  recordNotificationClaimEvent,
  recordMcpToolCall,
  piiLeaksTotal,
  openaiReserveFeedRequestsTotal,
} from '../metrics';
import { observeReservationMutation } from '../reservation-contract';

describe('Prometheus metrics', () => {
  beforeEach(() => {
    // Reset les valeurs sans recréer le registry (les compteurs sont
    // attachés au registry au top-level).
    __resetMetrics();
  });

  it('incrémente un counter et expose le label', async () => {
    piiLeaksTotal.inc({ kind: 'email' });
    piiLeaksTotal.inc({ kind: 'email' });
    piiLeaksTotal.inc({ kind: 'phone' });
    const payload = await renderMetrics();
    expect(payload).toContain('suppernote_agentic_pii_leaks_total');
    expect(payload).toMatch(/suppernote_agentic_pii_leaks_total\{[^}]*kind="email"[^}]*\} 2/);
    expect(payload).toMatch(/suppernote_agentic_pii_leaks_total\{[^}]*kind="phone"[^}]*\} 1/);
  });

  it('expose les métriques par défaut nodejs', async () => {
    const payload = await renderMetrics();
    // Métriques par défaut prom-client (collectDefaultMetrics)
    expect(payload).toContain('process_cpu_user_seconds_total');
  });

  it('expose suppernote_openai_reserve_feed_requests_total avec labels status', async () => {
    openaiReserveFeedRequestsTotal.inc({ status: '200' });
    openaiReserveFeedRequestsTotal.inc({ status: '200' });
    openaiReserveFeedRequestsTotal.inc({ status: '429' });
    const payload = await renderMetrics();
    expect(payload).toContain('suppernote_openai_reserve_feed_requests_total');
    expect(payload).toMatch(
      /suppernote_openai_reserve_feed_requests_total\{[^}]*status="200"[^}]*\} 2/,
    );
    expect(payload).toMatch(
      /suppernote_openai_reserve_feed_requests_total\{[^}]*status="429"[^}]*\} 1/,
    );
  });

  it('observe les contrats réservation avec des labels bornés et détecte PENDING/CONFIRMED', async () => {
    observeReservationMutation({
      source: 'connect',
      operation: 'create',
      status: 'CONFIRMED',
      state: 'PENDING',
      idempotency: 'keyed',
      audit: 'written',
      notification: 'not_sent',
      capacity: 'reserved',
    });

    const payload = await renderMetrics();
    expect(payload).toMatch(
      /suppernote_reservation_mutations_total\{[^}]*source="connect"[^}]*operation="create"[^}]*\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_reservation_status_state_mismatches_total\{[^}]*source="connect"[^}]*operation="create"[^}]*mismatch_type="status_state_pending_projection"[^}]*\} 1/,
    );
    expect(payload).toContain('mismatch_type="idempotency_keyed"');
    expect(payload).toContain('mismatch_type="audit_written"');
    expect(payload).toContain('mismatch_type="capacity_reserved"');
  });

  it('n’expose aucun identifiant métier dans les labels du contrat', async () => {
    observeReservationMutation({
      source: 'voice',
      operation: 'create_replay',
      status: 'CONFIRMED',
      state: 'CONFIRMED',
      idempotency: 'reused',
      audit: 'not_applicable',
      notification: 'not_applicable',
      capacity: 'unchanged',
      mutated: false,
    });

    const payload = await renderMetrics();
    expect(payload).toContain('source="voice"');
    expect(payload).toContain('operation="create_replay"');
    expect(payload).not.toContain('reservation-should-not-be-a-label');
    expect(payload).not.toContain('restaurant-should-not-be-a-label');
  });

  it('expose les événements de claim avec une cardinalité fixe', async () => {
    recordNotificationClaimEvent('orphan_recovered');
    recordNotificationClaimEvent('queue_unavailable');

    const payload = await renderMetrics();
    expect(payload).toMatch(
      /suppernote_notification_claim_events_total\{event="orphan_recovered"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_notification_claim_events_total\{event="queue_unavailable"\} 1/,
    );
    expect(payload).not.toContain('reservation-should-not-be-a-label');
  });

  it('ventile les appels MCP par auth et code avec des labels bornés', async () => {
    recordMcpToolCall('search_restaurants', 'success', 'oauth', undefined, 'mcp');
    recordMcpToolCall('create_reservation', 'error', 'api_key', 'FORBIDDEN', 'generic_agent');
    recordMcpToolCall('check_availability', 'error', 'oauth', 'INVALID_DATETIME', 'mcp');
    recordMcpToolCall('untrusted-client-tool-name', 'error', undefined, 'private-id-value');

    const payload = await renderMetrics();
    expect(payload).toMatch(
      /suppernote_mcp_tool_calls_by_auth_type_total\{[^}]*tool="search_restaurants"[^}]*status="success"[^}]*auth_type="oauth"[^}]*transport="mcp"[^}]*\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_mcp_tool_errors_by_code_total\{[^}]*tool="create_reservation"[^}]*auth_type="api_key"[^}]*error_code="FORBIDDEN"[^}]*transport="generic_agent"[^}]*\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_mcp_tool_errors_by_code_total\{[^}]*tool="check_availability"[^}]*error_code="INVALID_DATETIME"[^}]*\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_mcp_tool_errors_by_code_total\{[^}]*tool="unknown"[^}]*auth_type="unknown"[^}]*error_code="OTHER"[^}]*transport="unknown"[^}]*\} 1/,
    );
    expect(payload).not.toContain('untrusted-client-tool-name');
    expect(payload).not.toContain('private-id-value');
  });
});
