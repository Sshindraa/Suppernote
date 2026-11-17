-- Réglages reproductibles des cinq fiches de démo Paris de staging (Suppernote Connect + MCP).
-- Lancement : scripts/ops/apply-staging-demo-fixtures.sh (ne jamais viser une autre base).
--
-- Idempotent : un second passage ne change rien, chaque UPDATE ne touche que les lignes qui diffèrent.
-- Un plan et ses tables ne sont créés que si la fiche n'a encore aucun plan (NOT EXISTS).
-- Ne supprime rien : pas de DROP, TRUNCATE ni DELETE. Ne change ni nom, ni slug, ni site_status,
-- ni connect_published : les fiches restent masquées des recherches générales (isHiddenDemoRestaurant).
-- Une seule transaction : une erreur annule tout.

BEGIN;

-- Gardes : base sokar_staging uniquement, fiche de référence présente, cinq fiches présentes.
DO $$
DECLARE
  missing text;
BEGIN
  IF current_database() <> 'sokar_staging' THEN
    RAISE EXCEPTION 'Refus : base "%" (attendu sokar_staging)', current_database();
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM restaurants r
    JOIN restaurant_exposure_settings e ON e.restaurant_id = r.id
    WHERE r.slug = 'chez-suppernote-demo'
  ) THEN
    RAISE EXCEPTION 'Fiche de référence chez-suppernote-demo absente (ou sans réglages) : rien appliqué';
  END IF;
  SELECT string_agg(s.slug, ', ') INTO missing
  FROM unnest(ARRAY[
    'chez-sokar-bistrot-paris', 'chez-sokar-neo-paris', 'chez-sokar-ramen-paris',
    'chez-sokar-tapas-paris', 'chez-sokar-veggie-paris'
  ]) AS s(slug)
  WHERE NOT EXISTS (SELECT 1 FROM restaurants r WHERE r.slug = s.slug);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Fiches démo absentes : %. Rien appliqué.', missing;
  END IF;
END $$;

-- 1. Plan « Salle principale » (1400 x 900, par défaut, actif) et ses 3 tables,
--    uniquement pour les fiches qui n'ont encore aucun plan.
WITH new_plans AS (
  INSERT INTO floor_plans (id, restaurant_id, name, width, height, is_default, is_active, created_at, updated_at)
  SELECT gen_random_uuid()::text, r.id, 'Salle principale', 1400, 900, true, true, now(), now()
  FROM restaurants r
  WHERE r.slug IN (
    'chez-sokar-bistrot-paris', 'chez-sokar-neo-paris', 'chez-sokar-ramen-paris',
    'chez-sokar-tapas-paris', 'chez-sokar-veggie-paris'
  )
    AND NOT EXISTS (SELECT 1 FROM floor_plans fp WHERE fp.restaurant_id = r.id)
  RETURNING id
)
INSERT INTO floor_plan_tables (id, floor_plan_id, name, capacity, min_capacity, position_x, position_y, shape, is_active, rotation, created_at, updated_at)
SELECT gen_random_uuid()::text, np.id, t.name, t.capacity, 1, t.x, t.y, 'rect', true, 0, now(), now()
FROM new_plans np
CROSS JOIN (VALUES ('T1', 2, 80, 64), ('T2', 4, 384, 64), ('T3', 6, 192, 288)) AS t(name, capacity, x, y);

-- 2. Ligne de réglages d'exposition manquante (les autres colonnes ont leur valeur par défaut).
INSERT INTO restaurant_exposure_settings (restaurant_id, updated_at)
SELECT r.id, now()
FROM restaurants r
WHERE r.slug IN (
  'chez-sokar-bistrot-paris', 'chez-sokar-neo-paris', 'chez-sokar-ramen-paris',
  'chez-sokar-tapas-paris', 'chez-sokar-veggie-paris'
)
  AND NOT EXISTS (SELECT 1 FROM restaurant_exposure_settings e WHERE e.restaurant_id = r.id);

-- 3. Horaires copiés de la fiche de référence ; agentic_opt_in forcé à vrai.
UPDATE restaurants r
SET opening_hours = ref.opening_hours, agentic_opt_in = true, updated_at = now()
FROM (SELECT opening_hours FROM restaurants WHERE slug = 'chez-suppernote-demo') AS ref
WHERE r.slug IN (
  'chez-sokar-bistrot-paris', 'chez-sokar-neo-paris', 'chez-sokar-ramen-paris',
  'chez-sokar-tapas-paris', 'chez-sokar-veggie-paris'
)
  AND (r.opening_hours IS DISTINCT FROM ref.opening_hours OR r.agentic_opt_in IS DISTINCT FROM true);

-- 4. MCP activé ; capacité et créneaux exposés copiés de la fiche de référence.
UPDATE restaurant_exposure_settings e
SET mcp_enabled = true,
    capacity_specials = ref.capacity_specials,
    exposed_creneaux = ref.exposed_creneaux,
    updated_at = now()
FROM restaurants r
CROSS JOIN (
  SELECT x.capacity_specials, x.exposed_creneaux
  FROM restaurant_exposure_settings x
  JOIN restaurants y ON y.id = x.restaurant_id
  WHERE y.slug = 'chez-suppernote-demo'
) AS ref
WHERE r.id = e.restaurant_id
  AND r.slug IN (
    'chez-sokar-bistrot-paris', 'chez-sokar-neo-paris', 'chez-sokar-ramen-paris',
    'chez-sokar-tapas-paris', 'chez-sokar-veggie-paris'
  )
  AND (
    e.mcp_enabled IS DISTINCT FROM true
    OR e.capacity_specials IS DISTINCT FROM ref.capacity_specials
    OR e.exposed_creneaux IS DISTINCT FROM ref.exposed_creneaux
  );

-- Contrôle final : 5 fiches prêtes, 5 plans par défaut, 15 tables actives. Sinon, tout est annulé.
DO $$
DECLARE
  n_fiches integer;
  n_plans integer;
  n_tables integer;
BEGIN
  SELECT count(*) INTO n_fiches
  FROM restaurants r
  JOIN restaurant_exposure_settings e ON e.restaurant_id = r.id
  WHERE r.slug IN (
    'chez-sokar-bistrot-paris', 'chez-sokar-neo-paris', 'chez-sokar-ramen-paris',
    'chez-sokar-tapas-paris', 'chez-sokar-veggie-paris'
  )
    AND e.mcp_enabled AND r.agentic_opt_in;

  SELECT count(*) INTO n_plans
  FROM floor_plans fp
  JOIN restaurants r ON r.id = fp.restaurant_id
  WHERE r.slug IN (
    'chez-sokar-bistrot-paris', 'chez-sokar-neo-paris', 'chez-sokar-ramen-paris',
    'chez-sokar-tapas-paris', 'chez-sokar-veggie-paris'
  )
    AND fp.is_default AND fp.is_active AND fp.name = 'Salle principale';

  SELECT count(*) INTO n_tables
  FROM floor_plan_tables t
  JOIN floor_plans fp ON fp.id = t.floor_plan_id
  JOIN restaurants r ON r.id = fp.restaurant_id
  WHERE r.slug IN (
    'chez-sokar-bistrot-paris', 'chez-sokar-neo-paris', 'chez-sokar-ramen-paris',
    'chez-sokar-tapas-paris', 'chez-sokar-veggie-paris'
  )
    AND fp.is_default AND t.is_active;

  IF n_fiches <> 5 OR n_plans <> 5 OR n_tables <> 15 THEN
    RAISE EXCEPTION 'Contrôle final KO : fiches=% plans=% tables=% (attendu 5/5/15)', n_fiches, n_plans, n_tables;
  END IF;
  RAISE NOTICE 'Contrôle final OK : fiches=% plans=% tables=%', n_fiches, n_plans, n_tables;
END $$;

COMMIT;
