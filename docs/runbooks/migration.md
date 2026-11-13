# Runbook — Migrations de base de données

> **Statut : ACTIF — créé le 21 septembre 2026 (R1-5), exercice rejoué le 22.**
> Deux garde-fous automatiques remplacent la consigne de revue :
> `scripts/quality/check-db-push-target.mjs` (cible de `db push`) et
> `scripts/quality/check-migration-safety.mjs` (migrations destructives).
> L'exercice de restauration daté a été rejoué le 22 septembre 2026 : 91 tables,
> 343 contraintes, 345 index, 4,90 s.

## Règle de base

Le dépôt utilise **deux régimes de schéma**, et les mélanger casse la base :

| Cible                                           | Outil                   | Trace dans `_prisma_migrations` |
| ----------------------------------------------- | ----------------------- | ------------------------------- |
| Base locale de dev (`sokar`) et `sokar_preview` | `pnpm db:push`          | **Non** — c'est attendu         |
| Staging et production (`sokar`)                 | `prisma migrate deploy` | Oui                             |

`prisma migrate status` liste donc les 79 migrations comme « non appliquées » en
local alors que le schéma est en place. C'est normal : ne pas chercher à corriger
ce chiffre, et ne jamais lancer `migrate deploy` sur la base locale — il
tenterait de recréer des tables par-dessus l'existant.

`db push` n'écrit aucun fichier relisible. Il peut supprimer une colonne ou
recréer une contrainte sans laisser de trace en revue, donc il est réservé à une
base jetable.

## Garde-fou `db:push`

`pnpm db:push` et `pnpm --filter @suppernote/database push` passent d'abord par
`scripts/quality/check-db-push-target.mjs`, qui lit la cible réelle dans
`packages/database/.env` (ou `DATABASE_URL` de l'environnement, qui prime) :

- hôte `localhost` / `127.0.0.1` / `::1` → autorisé ;
- `NODE_ENV=production` → refusé, sans dérogation possible ;
- tout autre hôte → refusé, sauf opt-in explicite :

  ```zsh
  SOKAR_ALLOW_REMOTE_DB_PUSH=I-UNDERSTAND-DB-PUSH-IS-DESTRUCTIVE pnpm db:push
  ```

L'opt-in existe pour une base de test distante jetable, pas pour un
environnement partagé. Le script n'imprime jamais l'URL complète : seule
l'adresse `hôte:port/base` apparaît, jamais le mot de passe.

Le motif est celui du garde-fou de seed (`prisma/seed-demo-guard.ts`), écrit
après l'incident du 2026-06-28 où un `db:seed` lancé sur la base de production
avec `NODE_ENV` absent avait publié neuf fiches fictives dans le sitemap. Un
contrôle basé sur la cible réelle dégrade en « rien ne se passe » au lieu de
« dégât silencieux ».

## Garde-fou des migrations destructives

`scripts/quality/check-migration-safety.mjs` lit les migrations **ajoutées par la
branche** (diff contre `origin/main`, plus les fichiers non suivis) et échoue sur
une instruction qui peut perdre des données :

- `DROP TABLE`, `DROP COLUMN`, `DROP SCHEMA`, `DROP DATABASE` ;
- `TRUNCATE`, `DELETE FROM` ;
- `ALTER COLUMN … TYPE`.

Une migration destructive reste possible, mais elle doit être assumée dans le
fichier lui-même :

```sql
-- suppernote:destructive-ok — colonne remplacée par une vue, backfill vérifié le 21/09
ALTER TABLE "reservations" DROP COLUMN "legacy_status";
```

Le contrôle tourne en pre-push et dans la CI. Il ne rescanne pas l'historique :
sur les 79 migrations existantes, une seule (`20260703135744_add_gift_card_packs_and_fields`)
est destructive, et la rescanner bloquerait tout travail sans rien protéger.
Inventaire à la demande :

```zsh
node scripts/quality/check-migration-safety.mjs --all
```

## Checklist de migration

### Avant d'écrire la migration

1. Modifier `packages/database/prisma/schema.prisma`.
2. Regarder le diff réel avant de le générer :

   ```zsh
   pnpm exec prisma migrate diff \
     --from-url "$DATABASE_URL" \
     --to-schema-datamodel packages/database/prisma/schema.prisma \
     --script
   ```

   Le résultat doit être **purement additif**. Tout `DROP`, tout
   `ALTER COLUMN … TYPE` et tout `SET NOT NULL` sur une table peuplée se
   discutent avant d'être écrits, pas après.

3. En local, préférer une migration explicite à `db push` dès que le changement
   touche une table qui existe aussi en staging ou en production.

### Avant de déployer

4. Vérifier que la CI est verte : le job `packages` exécute les deux garde-fous.
5. Prendre une sauvegarde. Le déploiement production en prend une
   automatiquement (`scripts/ops/deploy-common.sh` appelle `backup-db` avant
   `prisma migrate deploy`), **pas le staging**. Sur staging :

   ```zsh
   bash scripts/database/backup-staging-postgres.sh
   ```

6. Pour une migration destructive, relire la ligne d'acquittement et vérifier
   que la raison correspond bien au changement déployé.

### Après le déploiement

7. Confirmer que la migration est appliquée :

   ```zsh
   pnpm --filter @suppernote/database migrate:status
   ```

   (avec `DATABASE_URL` de l'environnement visé).

8. Lancer les backfills associés en lecture seule d'abord, puis avec `--apply`.
   Exemple de la cadence de facturation :

   ```zsh
   pnpm --filter @suppernote/api ops:billing-interval-backfill
   pnpm --filter @suppernote/api ops:billing-interval-backfill -- --apply
   ```

9. Vérifier `/health` et un parcours métier réel (une réservation, un
   webhook Stripe) avant de considérer la migration terminée.

## Rollback

Le rollback applicatif ne restaure **pas** la base : il ne remet en place que
les artefacts. Une migration déjà appliquée reste appliquée.

```zsh
ssh deploy@sokar
cd /opt/sokar
bash scripts/deploy.sh --env prod --confirm-production rollback
bash scripts/deploy.sh --env prod --confirm-production rollback --with-db-rollback
```

`--with-db-rollback` restaure la sauvegarde prise **avant** le build de la
release cible : toute donnée écrite après cette sauvegarde est perdue. Détails
et RTO dans [`rollback.md`](./rollback.md).

Comme Prisma ne génère pas de `down`, une migration destructive doit être
rendue réversible par conception : nouvelle colonne, double écriture, backfill,
bascule de lecture, suppression plus tard. Si la marche arrière n'est pas
possible, la migration est un point de non-retour et la sauvegarde est la seule
issue.

## Exercice de restauration

Le test reproductible crée une base temporaire, restaure le dump R2 le plus
récent, vérifie tables / contraintes / index critiques, puis supprime la base.
Il se lance depuis le VPS **via le wrapper privilégié** : le compte `deploy` n'a
ni le groupe docker ni les clients PostgreSQL (`psql`, `pg_restore`, `createdb`
sont absents de l'hôte), et le wrapper n'exposait aucune action de restauration
avant le 22 septembre 2026 — l'exercice était donc documenté mais inexécutable.

```zsh
ssh deploy@sokar
/usr/bin/time -p sudo /usr/local/sbin/sokar-deploy-root restore-test prod
```

Le script résout lui-même `RCLONE_CONFIG` vers la configuration du compte
`deploy`, comme le fait le cron de backup offsite : `root` n'a pas de
configuration rclone à lui, et sans cette résolution `rclone lsf` échoue.

Consigner chaque répétition ci-dessous : date, nom du dump, âge du dump, durée
mesurée, tables / contraintes / index, et toute anomalie. C'est la mesure du RPO
observable et du RTO d'une restauration vierge ; le RTO production complet
(arrêt/reprise API, bascule de base, smoke métier) reste à mesurer.

| Date       | Dump                    | Âge du dump | Durée  | Tables / contraintes / index | Anomalie |
| ---------- | ----------------------- | ----------- | ------ | ---------------------------- | -------- |
| 2026-09-07 | `20260907T020001Z.dump` | 20 h 05     | 4,00 s | 32 / 73 / 117                | —        |
| 2026-09-22 | `20260921T020001Z.dump` | 20 h 40     | 4,90 s | 91 / 343 / 345               | —        |

Les index critiques `agentic_holds_restaurant_id_slot_start_idx` et
`one_active_hold_per_slot` (index partiel anti-double-booking) ont été vérifiés
présents lors de la répétition du 22 septembre. Depuis la migration
`20261018120000_agentic_hold_per_table`, `one_active_hold_per_slot` est remplacé par
`one_active_hold_per_table_slot` (une table, un hold actif par heure) et
`one_active_hold_per_slot_no_table` (holds historiques sans table).

## Limites connues

- La base de dev n'a pas d'historique de migrations ; `migrate status` y est
  trompeur par construction.
- Le staging n'est pas sauvegardé automatiquement avant un déploiement.
- Le RTO complet d'un rollback production avec reprise métier n'est pas mesuré.
- Les garde-fous raisonnent sur le SQL écrit : une migration qui délègue la
  destruction à une fonction ou à un script applicatif passe entre les mailles.
