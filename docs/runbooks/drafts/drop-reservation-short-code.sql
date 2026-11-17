-- BROUILLON, NON APPLIQUÉ. Ne pas exécuter sans accord explicite de Hamza.
-- Retire le lien court SMS (PR #744, revert #749) : index unique et deux colonnes nullables.
-- Hors du dossier migrations/ : le déploiement lance `migrate deploy` et appliquerait ce fichier.
--
-- Avant d'exécuter (en production) :
--   1. Sauvegarde : pg_dump --format=custom "$DATABASE_URL" > backup-avant-drop-short-code.dump
--   2. Relecture de ce SQL, puis exécution dans une transaction (le script se termine par COMMIT).
--   3. Vérifier ensuite : \d reservations ne montre plus les colonnes ; _prisma_migrations ne contient plus la ligne.
--
-- Garde-fou : le script échoue si une réservation porte encore un code (aucune au 17/11/2026).

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reservations
    WHERE management_short_code IS NOT NULL OR management_short_code_phone IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Des réservations portent encore un lien court : arrêt, relire avant de supprimer';
  END IF;
END
$$;

DROP INDEX IF EXISTS reservations_management_short_code_key;

ALTER TABLE reservations
  DROP COLUMN IF EXISTS management_short_code,
  DROP COLUMN IF EXISTS management_short_code_phone;

-- Résidu de la migration retirée du dépôt (appliquée le 16/11, fichier absent depuis le revert #749)
DELETE FROM _prisma_migrations
WHERE migration_name = '20261115120000_reservation_management_short_code';

COMMIT;

-- Retour arrière (si besoin, après restauration de la sauvegarde) : ré-exécuter la migration
-- 20261115120000_reservation_management_short_code, puis réinsérer la ligne dans _prisma_migrations.
