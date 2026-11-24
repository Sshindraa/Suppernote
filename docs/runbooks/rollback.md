# Runbook — Rollback

> **Statut : ACTIF — audité le 12 septembre 2026.** Le rollback applicatif et l'option de
> restauration DB sont implémentés ; une restauration vierge a été exercée. Le RTO complet d'un
> rollback production avec reprise métier reste à mesurer. Voir
> [`../DOCUMENTATION_STATUS.md`](../DOCUMENTATION_STATUS.md).

## Staging

```zsh
ssh deploy@suppernote
cd /opt/suppernote-staging
bash scripts/deploy.sh --env staging rollback
```

## Production

```zsh
ssh deploy@suppernote
cd /opt/suppernote
bash scripts/deploy.sh --env prod --confirm-production rollback
```

## Rollback vers une release spécifique

```zsh
bash scripts/deploy.sh --env prod --confirm-production rollback 20260726T194319Z
```

## Rollback avec restauration DB

Par défaut, le rollback restaure uniquement les artefacts (API, dashboard, connect).
Pour restaurer aussi la base de données depuis la backup horodatée dans le dossier
de release, ajouter `--with-db-rollback` :

```zsh
bash scripts/deploy.sh --env prod --confirm-production rollback --with-db-rollback 20260726T194319Z-pre
```

> ⚠️ Le snapshot `-pre` conserve les artefacts et la base juste avant le déploiement.
> Sélectionner explicitement ce snapshot pour un rollback DB : les snapshots post-build
> ne contiennent pas de dump. Les snapshots suivent la même limite de rétention que les releases.
> Toute donnée écrite après cette backup sera perdue.

> Sans `--with-db-rollback`, un rollback applicatif ne restaure pas la base de données.
> Planifier le rollback DB séparément si des migrations ont été appliquées.

## Cache des visites CRM

La migration `20261105020000_customer_visit_cache_revision` ajoute une table, une séquence et un déclencheur sur les réservations. Un rollback des seuls artefacts laisse ce déclencheur actif ; une ancienne API fonctionne avec lui. Avant toute suppression de la table lors d’un rollback de schéma planifié, retirer d’abord le déclencheur `reservation_visit_cache_revision`, puis sa fonction : sinon les écritures de réservations échoueront. Les clés Redis expirent au plus tard après cinq minutes ; changer leur préfixe de version si le format ou les règles de calcul du cache changent.

## Mesure du restore vierge

Le test reproductible se lance depuis le VPS, via le wrapper privilégié (le
compte `deploy` n'a ni le groupe docker ni les clients PostgreSQL), et crée puis
supprime une base temporaire :

```zsh
ssh deploy@suppernote
/usr/bin/time -p sudo /usr/local/sbin/suppernote-deploy-root restore-test prod
```

La répétition du 22 septembre 2026 a restauré `20260921T020001Z.dump` dans
`sokar_restore_test_20260921224047` : 91 tables, 343 contraintes, 345 index, les
deux index critiques `agentic_holds` présents, en 4,90 s.

La répétition du 7 septembre 2026 à 22:04 UTC a restauré `20260907T020001Z.dump` (130 148 octets) dans `sokar_restore_test_20260907220422`, vérifié 32 tables, 73 contraintes, 117 index et les deux index critiques `agentic_holds`, puis supprimé la base. Le dump avait 20 h 05 d’âge ; le temps total mesuré était de 4,00 s. Ces chiffres décrivent le RPO observable et le RTO d’une restauration vierge. Le RTO production complet doit inclure arrêt/reprise API, bascule de base et smoke métier ; il n’est pas encore validé.
