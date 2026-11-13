-- ═════════════════════════════════════════════════════════════════════════════
-- audit-checks.sql
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Checks opérationnels à exécuter avant chaque pilote ou après incident.
--
-- Usage :
--   psql $DATABASE_URL -f infra/sql/audit-checks.sql
--

\set ON_ERROR_STOP on
\echo '>>> SUPPERNOTE AUDIT CHECKS — starting at:'
SELECT now();

-- ─── 1. Doubles réservations actives sur le même slot ────────────────────────────────────
\echo '>>> 1. Duplicate active reservations per slot (should be 0)...'
SELECT
  r.restaurant_id,
  r.starts_at,
  r.ends_at,
  count(*) AS active_count
FROM reservations r
WHERE r.state NOT IN ('CANCELLED', 'NO_SHOW')
GROUP BY r.restaurant_id, r.starts_at, r.ends_at
HAVING count(*) > 1
ORDER BY active_count DESC, r.starts_at
LIMIT 20;

-- ─── 2. Holds expirés non libérés ───────────────────────────────────────────────
\echo '>>> 2. Expired holds not yet released (worker lag indicator)...'
SELECT
  h.restaurant_id,
  count(*) AS expired_unreleased_count
FROM agentic_holds h
WHERE h.state = 'EXPIRED'
  AND h.released_at IS NULL
  AND h.expires_at < now() - interval '5 minutes'
GROUP BY h.restaurant_id
ORDER BY expired_unreleased_count DESC;

-- ─── 3. Index critiques ─────────────────────────────────────────────────────────────
\echo '>>> 3. Critical indexes existence...'
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'one_active_hold_per_slot',
    'reservations_restaurant_starts_at_idx',
    'idx_reservation_audit_log_created_at',
    'idx_identity_verification_otps_subject',
    'idx_signed_token_usages_jti'
  )
ORDER BY indexname;

-- ─── 4. Trigger append-only audit log ──────────────────────────────────────────
\echo '>>> 4. Audit log append-only trigger exists...'
SELECT tgname AS trigger_name, tgrelid::regclass AS table_name
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgname = 'reservation_audit_log_append_only';

-- ─── 5. Restaurants avec features agentic activées ─────────────────────────────
\echo '>>> 5. Restaurants with agentic features enabled...'
SELECT
  count(*) FILTER (WHERE mcp_enabled = true)            AS mcp_enabled,
  count(*) FILTER (WHERE openai_reserve_enabled = true) AS openai_reserve_enabled,
  count(*)                                              AS total
FROM restaurants;

-- ─── 6. PII leaks / outils suspects dans audit log ─────────────────────────────────────
\echo '>>> 6. Recent audit events that may indicate abuse/errors...'
SELECT
  a.event,
  count(*)
FROM reservation_audit_log a
WHERE a.created_at >= now() - interval '24 hours'
  AND a.event IN ('rgpd_erasure', 'double_booking_blocked', 'pii_leak_detected', 'hold_conflict')
GROUP BY a.event
ORDER BY count(*) DESC;

\echo '>>> SUPPERNOTE AUDIT CHECKS — done.'
SELECT now();
