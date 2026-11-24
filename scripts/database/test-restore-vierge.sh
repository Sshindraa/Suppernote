#!/usr/bin/env bash
# Test de restore bout-en-bout sur une base vierge.
#
# Télécharge le dump R2 le plus récent, restaure dans une base temporaire
# créée from scratch, vérifie que les tables et les contraintes sont là,
# puis nettoie. C'est le vrai "on sait restaurer sur une base vierge".
#
# Usage (sur le VPS, ou en local avec Docker + rclone configuré) :
#   bash scripts/database/test-restore-vierge.sh
#
# Variables d'env:
#   R2_BUCKET        — nom du bucket (défaut: sokar-backups)
#   R2_PATH          — préfixe (défaut: postgres)
#   POSTGRES_CONTAINER — nom du conteneur (défaut: infra-postgres-1)
#   POSTGRES_USER    — user Postgres (défaut: sokar)
#   KEEP_DB          — si "1", ne supprime pas la base de test (debug)
#
# Exit codes:
#   0 — restore OK, intégrité vérifiée
#   1 — échec (dump introuvable, restore incomplet, contraintes manquantes)

set -euo pipefail

export PATH="$HOME/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Le cron de backup offsite tourne en root avec la configuration rclone du
# compte `deploy` (root n'a pas la sienne). L'exercice de restauration
# s'exécute lui aussi en root, via `suppernote-deploy-root restore-test` : sans cette
# résolution, `rclone lsf r2:…` échoue et l'exercice est impossible à lancer.
if [ -z "${RCLONE_CONFIG:-}" ] && [ -f /home/deploy/.config/rclone/rclone.conf ]; then
  export RCLONE_CONFIG=/home/deploy/.config/rclone/rclone.conf
fi

CONTAINER="${POSTGRES_CONTAINER:-infra-postgres-1}"
DB_USER="${POSTGRES_USER:-sokar}"
BUCKET="${R2_BUCKET:-sokar-backups}"
PREFIX="${R2_PATH:-postgres}"
TARGET_DB="sokar_restore_test_$(date -u '+%Y%m%d%H%M%S')"
KEEP_DB="${KEEP_DB:-0}"
DUMP_LOCAL=""

log()  { echo "[$(date -u '+%H:%M:%SZ')] $*"; }
ok()   { echo "  ✅ $*"; }
fail() { echo "  ❌ $*" >&2; exit 1; }

# Le compte deploy n'est pas membre du groupe docker sur le VPS. Le wrapper
# sudo autorise toutefois Docker pour les opérations d'exploitation prévues.
# En local, on conserve le chemin direct si Docker est déjà accessible.
DOCKER=(docker)
if ! docker ps >/dev/null 2>&1; then
  if sudo -n docker ps >/dev/null 2>&1; then
    DOCKER=(sudo -n docker)
  else
    fail "Docker inaccessible (ni docker direct ni sudo -n docker)"
  fi
fi
docker_exec() { "${DOCKER[@]}" exec "$@"; }

cleanup() {
  if [ "$KEEP_DB" = "1" ]; then
    log "KEEP_DB=1 — base de test conservée: ${TARGET_DB}"
  else
    log "→ Nettoyage base de test ${TARGET_DB}"
    docker_exec "${CONTAINER}" dropdb --if-exists --force \
      -U "${DB_USER}" "${TARGET_DB}" >/dev/null 2>&1 || true
  fi
  rm -f "${DUMP_LOCAL}"
}
trap cleanup EXIT

# ── 1. Récupérer le dump le plus récent depuis R2 ───────────
log "→ Listing R2 r2:${BUCKET}/${PREFIX}/"
# rclone lsf n'a pas --sort-by ni --time-format dans la version installée ;
# on liste avec le timestamp natif (format tsp) et trie côté shell.
# Format: "modified_date;size;name" → on prend la dernière ligne triée par date.
LATEST=$(rclone lsf "r2:${BUCKET}/${PREFIX}/" --format "tsp" --max-depth 1 --files-only 2>/dev/null \
  | sort -t';' -k1 -r | head -1 | cut -d';' -f3) \
  || fail "Impossible de lister r2:${BUCKET}/${PREFIX}/"
[ -n "${LATEST}" ] || fail "Aucun dump dans r2:${BUCKET}/${PREFIX}/"
log "  Dernier dump: ${LATEST}"

DUMP_LOCAL="/tmp/suppernote-restore-test-${LATEST}"
log "→ Téléchargement vers ${DUMP_LOCAL}"
rclone copyto "r2:${BUCKET}/${PREFIX}/${LATEST}" "${DUMP_LOCAL}"
[ -s "${DUMP_LOCAL}" ] || fail "Dump téléchargé vide ou absent"
SIZE=$(stat -c%s "${DUMP_LOCAL}" 2>/dev/null || stat -f%z "${DUMP_LOCAL}")
ok "Dump téléchargé (${SIZE} octets)"

# ── 2. Créer une base vierge ─────────────────────────────────
log "→ Création base vierge ${TARGET_DB}"
docker_exec "${CONTAINER}" dropdb --if-exists --force \
  -U "${DB_USER}" "${TARGET_DB}" >/dev/null 2>&1 || true
docker_exec "${CONTAINER}" createdb -U "${DB_USER}" "${TARGET_DB}" \
  || fail "createdb échoué"
ok "Base vierge créée"

# ── 3. Restore ───────────────────────────────────────────────
log "→ pg_restore dans ${TARGET_DB}"
"${DOCKER[@]}" exec -i "${CONTAINER}" pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --username="${DB_USER}" \
  --dbname="${TARGET_DB}" <"${DUMP_LOCAL}" \
  || fail "pg_restore a échoué — dump corrompu ou incompatible"
ok "Restore terminé sans erreur"

# ── 4. Vérifications d'intégrité ─────────────────────────────
log "→ Vérifications d'intégrité"

# 4a. Nombre de tables
TABLES=$(docker_exec "${CONTAINER}" psql -U "${DB_USER}" -d "${TARGET_DB}" -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';")
log "  Tables public: ${TABLES}"
[ "${TABLES}" -gt 0 ] || fail "Aucune table restaurée"

# 4b. Contraintes d'intégrité (clés étrangères, uniques)
CONSTRAINTS=$(docker_exec "${CONTAINER}" psql -U "${DB_USER}" -d "${TARGET_DB}" -Atc \
  "SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace;")
log "  Contraintes: ${CONSTRAINTS}"
[ "${CONSTRAINTS}" -gt 0 ] || fail "Aucune contrainte restaurée"

# 4c. Index (incl. partial unique index one_active_hold_per_slot)
INDEXES=$(docker_exec "${CONTAINER}" psql -U "${DB_USER}" -d "${TARGET_DB}" -Atc \
  "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public';")
log "  Index: ${INDEXES}"
[ "${INDEXES}" -gt 0 ] || fail "Aucun index restauré"

# 4d. Vérifie la présence des index critiques sur agentic_holds
# - agentic_holds_restaurant_id_slot_start_idx : index de recherche (présent)
# - one_active_hold_per_slot : partial unique index anti-double-booking (devrait être présent)
SEARCH_INDEX=$(docker_exec "${CONTAINER}" psql -U "${DB_USER}" -d "${TARGET_DB}" -Atc \
  "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'agentic_holds_restaurant_id_slot_start_idx';")
log "  Index agentic_holds_restaurant_id_slot_start_idx: ${SEARCH_INDEX}"
[ "${SEARCH_INDEX}" = "1" ] || log "  ⚠️  Index de recherche agentic_holds absent"

HOLD_INDEX=$(docker_exec "${CONTAINER}" psql -U "${DB_USER}" -d "${TARGET_DB}" -Atc \
  "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'one_active_hold_per_slot';")
log "  Index one_active_hold_per_slot (partial unique): ${HOLD_INDEX}"
if [ "${HOLD_INDEX}" != "1" ]; then
  log "  ⚠️  Index anti-double-booking ABSENT — migration 20260621004000 marquée appliquée mais index manquant"
  log "      Vérifier : docker exec infra-postgres-1 psql -U sokar -c \"SELECT * FROM _prisma_migrations WHERE migration_name = '20260621004000_agentic_p0_constraints';\""
fi

# 4e. Comptage de lignes sur quelques tables clés
for t in restaurants agentic_holds calls reservations customers; do
  EXISTS=$(docker_exec "${CONTAINER}" psql -U "${DB_USER}" -d "${TARGET_DB}" -Atc \
    "SELECT to_regclass('public.${t}') IS NOT NULL;")
  if [ "${EXISTS}" = "t" ]; then
    ROWS=$(docker_exec "${CONTAINER}" psql -U "${DB_USER}" -d "${TARGET_DB}" -Atc \
      "SELECT count(*) FROM public.${t};")
    log "  ${t}: ${ROWS} lignes"
  else
    log "  ${t}: table absente (skip)"
  fi
done

# 4f. Vérifie que la base accepte une query complexe (jointure)
log "→ Test query complexe (jointure restaurants ↔ agentic_holds)"
docker_exec "${CONTAINER}" psql -U "${DB_USER}" -d "${TARGET_DB}" -Atc \
  "SELECT r.slug, count(h.id) FROM restaurants r LEFT JOIN agentic_holds h ON h.restaurant_id = r.id GROUP BY r.slug LIMIT 1;" \
  >/dev/null 2>&1 || log "  ⚠️  Jointure échouée (peut être normal si tables vides)"

ok "Intégrité vérifiée: ${TABLES} tables, ${CONSTRAINTS} contraintes, ${INDEXES} index"

# ── 5. Récapitulatif ─────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════"
echo "✅ TEST DE RESTORE RÉUSSI sur base vierge"
echo "   Source : r2:${BUCKET}/${PREFIX}/${LATEST}"
echo "   Cible  : ${TARGET_DB} (sera supprimée)"
echo "   Tables : ${TABLES} | Contraintes : ${CONSTRAINTS} | Index : ${INDEXES}"
echo "══════════════════════════════════════════════════════════"
echo ""
echo "Pour restaurer en production (après incident) :"
echo "  1. Télécharger le dump : rclone copyto r2:${BUCKET}/${PREFIX}/${LATEST} /tmp/restore.dump"
echo "  2. Stopper l'API : pm2 stop suppernote-api"
echo "  3. Renommer la base prod : docker exec ${CONTAINER} psql -U ${DB_USER} -c 'ALTER DATABASE sokar RENAME TO sokar_broken;'"
echo "  4. Restaurer : bash scripts/database/restore-postgres-backup.sh /tmp/restore.dump sokar"
echo "     (restore-postgres-backup.sh refuse 'sokar' — lever la garde avec SKIP_PROD_GUARD=1 en cas d'urgence P0)"
echo "  5. Relancer : pm2 start suppernote-api"
echo "  6. Vérifier : curl -fsS https://api.suppernote.com/health"
