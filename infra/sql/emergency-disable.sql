-- ═════════════════════════════════════════════════════════════════════════════
-- emergency-disable.sql
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Objectif : couper immédiatement les features agentic en cas d'incident P0.
--
-- Usage :
--   psql $DATABASE_URL -f infra/sql/emergency-disable.sql
--
-- Ce script est intentionnellement verbeux : chaque UPDATE affiche le nombre
-- de lignes affectées (psql \echo + count implicit).
--
-- ATTENTION : la réactivation se fait RESTAURANT PAR RESTAURANT, après
-- validation manuelle. Ne jamais réactiver globalement sans investigation.
--

\set ON_ERROR_STOP on
\echo '>>> SUPPERNOTE EMERGENCY DISABLE — starting at:'
SELECT now();

-- ─── 1. Désactiver MCP pour tous les restaurants ─────────────────────────────
\echo '>>> 1. Disabling MCP for all restaurants...'
UPDATE restaurants
SET mcp_enabled = false,
    updated_at  = now()
WHERE mcp_enabled = true;

-- ─── 2. Désactiver OpenAI Reserve pour tous les restaurants ──────────────────
\echo '>>> 2. Disabling OpenAI Reserve for all restaurants...'
UPDATE restaurants
SET openai_reserve_enabled = false,
    updated_at             = now()
WHERE openai_reserve_enabled = true;

-- ─── 3. Vérification rapide ──────────────────────────────────────────────────
\echo '>>> 3. Verification : restaurants still enabled (should be 0)...'
SELECT
  count(*) FILTER (WHERE mcp_enabled = true)            AS mcp_enabled_count,
  count(*) FILTER (WHERE openai_reserve_enabled = true) AS openai_reserve_enabled_count,
  count(*)                                              AS total_restaurants
FROM restaurants;

-- ─── 4. Snapshot des réservations actives des dernières 24h ──────────────────
\echo '>>> 4. Active reservations in the last 24h (for incident context)...'
SELECT
  r.state,
  count(*)
FROM reservations r
WHERE r.created_at >= now() - interval '24 hours'
GROUP BY r.state
ORDER BY count(*) DESC;

-- ─── 5. Derniers audit logs agentic ──────────────────────────────────────────
\echo '>>> 5. Last 20 agentic audit logs...'
SELECT
  a.created_at,
  a.event,
  a.actor,
  a.metadata
FROM reservation_audit_log a
ORDER BY a.created_at DESC
LIMIT 20;

\echo '>>> SUPPERNOTE EMERGENCY DISABLE — done.'
SELECT now();
