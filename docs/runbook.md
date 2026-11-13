# Runbook opérationnel Suppernote

> Procédures d'incident transversales (agentic, MCP, OpenAI Reserve,
> Suppernote Connect, voice). Pas un document "pilote Lyon" : c'est le runbook
> de prod, applicable à tout ce qui tourne sur Suppernote.
>
> **Statut : RUNBOOK ACTIF — audité le 12 septembre 2026.** Les procédures restent applicables en
> dev, staging et production. L'état des campagnes terrain est suivi dans leurs runbooks dédiés ;
> ne pas déduire leur avancement de ce document transversal. Pour déployer, restaurer ou tester,
> préférer les procédures spécialisées dans `docs/runbooks/`. Voir
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).

## Contacts

| Rôle               | Qui                                 | Quand                                        |
| ------------------ | ----------------------------------- | -------------------------------------------- |
| On-call P1         | Hamza                               | Tout incident actif listé dans ce runbook    |
| Backup on-call     | (à définir si l'équipe grandit)     | Quand Hamza indispo                          |
| Restaurant contact | Base clients Suppernote (Dashboard) | Pour chaque resto individuellement           |
| DPO                | `dpo@suppernote.com`                | Tout incident PII (cf. §PII leak ci-dessous) |

## Canaux d'alerte

| Canal                   | Usage                             | Statut                                                       |
| ----------------------- | --------------------------------- | ------------------------------------------------------------ |
| Sentry                  | Erreurs applicatives              | Configuré                                                    |
| Prometheus `/metrics`   | Scraping interne                  | Configuré                                                    |
| Discord/Slack incidents | Alertes ops temps réel            | **Pas encore créé** (voir `pilot/_archive/channel-setup.md`) |
| Status page public      | Communication incident aux restos | **Pas encore créé**                                          |

## Health SLO summary

| KPI                                                     | Target  | Action si breach                            |
| ------------------------------------------------------- | ------- | ------------------------------------------- |
| `suppernote_agentic_double_booking_attempts_total`      | = 0     | Investigate immédiat (cf. §Double booking)  |
| `suppernote_agentic_pii_leaks_total`                    | = 0     | Investigate immédiat (cf. §PII leak)        |
| `suppernote_agentic_check_availability_duration_ms` p95 | < 800ms | Check Telnyx, ElevenLabs, Prisma, Redis     |
| 5xx rate                                                | < 1%    | Check providers externes + dernière release |

Source : `GET /metrics` (scrape Prometheus) ou endpoint interne
`/api/internal/pilot-kpis` quand l'auth VPN sera en place.

---

## Procédures d'incident

### P1 — Double booking détecté

**Symptôme** : Sentry alert `double_booking`, compteur
`suppernote_agentic_double_booking_attempts_total` > 0.

**Diagnostic** :

1. Récupérer le `restaurantId` + `slotStart` + `attemptedBy` dans Sentry
2. Lister les résas actives pour ce slot :
   ```ts
   db.reservation.findMany({
     where: {
       restaurantId,
       startsAt: { gte: slotStart - 1h, lte: slotStart + 1h },
     },
   });
   ```
3. Vérifier le partial unique index :
   ```sql
   SELECT * FROM pg_indexes WHERE indexname = 'one_active_hold_per_slot';
   ```

**Action** :

1. Contacter le resto dans les 30 min
2. Proposer un dédommagement (surclassement, dessert, prochaine résa offerte)
3. Si > 1 double booking en 24h : rollback la feature fautive pour ce resto
4. Post-mortem dans les 48h

**Escalade** : Hamza (on-call) → CTO si > 3 incidents en 7 jours.

---

### P1 — PII leak détecté

**Symptôme** : Sentry alert `pii_leak`, compteur
`suppernote_agentic_pii_leaks_total{kind="phone|email|hex"}` > 0.

**Diagnostic** :

1. Récupérer le `tool` + `kind` (phone/email/hex) + `path` dans Sentry
2. Identifier le tool response fautif
3. Vérifier que `redactResponse()` est bien appelé après l'exécution
   (cf. `apps/api/src/shared/observability/pii-leak.ts`)

**Action IMMÉDIATE** :

1. **Désactiver le tool fautif** : commenter dans `tools/registry.ts` + redéployer
2. Si le PII est sorti du système (logs tiers, telemetry) : notification CNIL
   sous 72h (RGPD Article 33) si risque élevé
3. Identifier tous les sujets affectés via `POST /api/rgpd/export`
4. Communication transparente aux restos

**Escalade** : Hamza + DPO (`dpo@suppernote.com`) → CNIL si confirmé.

---

### P2 — 5xx rate > 1%

**Symptôme** : alert `error_rate_high` OU Grafana panneau "Taux erreur"

> 1% sur 5 min glissantes.

**Diagnostic** :

1. Identifier le type d'erreur (500 vs 502 vs 504)
2. 502/504 : check load balancer, VPS, réseau
3. 500 : check Sentry pour stack trace
4. Vérifier Telnyx / ElevenLabs / Cartesia / OpenAI status pages

**Action** :

1. Si un provider externe est indisponible : appliquer le fallback documenté
   ou mettre en pause les réservations agentic
2. Si interne : rollback dernière release
3. Communication status (status page à créer — placeholder)

**Escalade** : Hamza → hébergeur VPS si > 30 min.

---

### P2 — Latence p95 > 800ms

**Symptôme** : Grafana panneau "Latence check_availability" > 800ms
sur 5 min.

**Diagnostic** :

1. Vérifier Prisma : `EXPLAIN ANALYZE` sur la query
2. Vérifier Redis (cache down ?)
3. Vérifier Telnyx (latence réseau vers provider)

**Action** :

1. Si Postgres : ajouter index manquant
2. Si Redis down : fallback DB marche (vérifier `McpRateLimiter`)
3. Si Telnyx : pas d'action, mais communication

---

### P3 — Restaurant demande aide

**Symptôme** : email direct, message Telegram, ou retour dans un canal
interne.

**Action** :

1. Réponse sous 4h ouvrées
2. Si bug : créer ticket, fix dans la semaine
3. Si question : répondre en screen-share si besoin
4. Logger dans le channel de support approprié

---

## Rollback de déploiement

Le script `scripts/deploy.sh --env prod` snapshot les artefacts buildés (dist, .next,
static) dans `/opt/sokar/releases/<timestamp>/` à chaque déploiement réussi.
Les 5 dernières releases sont conservées.

### Rollback automatique (sur échec de build)

Si le build échoue en cours de déploiement, le trap ERR restore
automatiquement les artefacts d'avant le build et redémarre les services.
**Aucune action manuelle requise** — l'app revient à l'état précédent.

### Rollback manuel (deploy réussi mais régression en prod)

```bash
# Lister les releases disponibles
ssh sokar 'bash /opt/sokar/scripts/deploy.sh --env prod --confirm-production rollback'

# Rollback vers la release précédente (recommandé)
ssh sokar 'bash /opt/sokar/scripts/deploy.sh --env prod --confirm-production rollback'

# Rollback vers une release spécifique
ssh sokar 'bash /opt/sokar/scripts/deploy.sh --env prod --confirm-production rollback 20260626T130000Z'
```

Le rollback :

1. Stoppe dashboard + Suppernote Connect (l'API reste up le temps du swap)
2. Restore les artefacts (dist, .next, public) depuis la release
3. Redémarre tous les services via PM2
4. Vérifie les endpoints health

**Durée typique** : ~15s (stop + cp 750MB + restart + health check).

### Vérifier l'état après rollback

```bash
ssh sokar 'pm2 list | grep sokar'
ssh sokar 'curl -s -o /dev/null -w "api: %{http_code}\n" http://localhost:4000/health'
ssh sokar 'curl -s -o /dev/null -w "dash: %{http_code}\n" http://localhost:3000'
```

---

## Procédure de désactivation d'urgence

En cas de problème grave (P0) :

1. **Désactiver MCP pour tous les restos** :

   ```sql
   UPDATE restaurants SET agentic_opt_in = false;
   ```

   (Note : la colonne est `agentic_opt_in` pour la rétrocompat avec
   l'agentic P0. Renommage à `acceptsReservations` prévu en P5 — cf.
   spec Suppernote Connect v1.1 §13.7.)

2. **Désactiver OpenAI Reserve** :

   ```sql
   UPDATE restaurants SET openai_reserve_enabled = false;
   ```

3. **Désactiver Suppernote Connect** (nouveau) :

   ```sql
   UPDATE restaurant_exposure_settings
   SET connect_published = false, connect_agentic = false;
   ```

4. **Communication** : status page (à créer) + canaux restos (à créer)

5. **Investigation** : root cause analysis dans les 24h

6. **Réactivation** : resto par resto, après validation manuelle

Scripts SQL d'urgence :

- `infra/sql/emergency-disable.sql` (existe)
- `scripts/reactivation.sql` (à créer)

---

## Backups et restauration

### Topologie des backups

| Type    | Script                                   | Cible                        | Fréquence         | Rétention |
| ------- | ---------------------------------------- | ---------------------------- | ----------------- | --------- |
| Local   | `scripts/database/backup-postgres.sh`    | `/var/backups/sokar` (VPS)   | cron 03:20 (hôte) | 14 jours  |
| Offsite | `scripts/database/backup-postgres-r2.sh` | `r2:sokar-backups/postgres/` | cron 04:00 (hôte) | 30 jours  |

Les deux heures de cron suivent le fuseau de l'hôte (Europe/Paris), soit
respectivement 01:20 UTC et 02:00 UTC — ce sont ces heures UTC qui apparaissent
dans le nom des dumps.

- **Local** : dump `pg_dump --format=custom --compress=6`, vérifié par
  restauration temporaire (compare le nombre de tables source vs restauré).
- **Offsite R2** : dump identique, upload via `rclone`, **vérification
  d'intégrité par hash SHA256 local vs distant**, rotation automatique,
  garde-fou de quota (5 GB / 10 GB free tier), alerte optionnelle via
  `ALERT_CMD`.
- Crons versionnés dans `infra/cron/` (`sokar-postgres-backup`, `sokar-r2-backup`)
  et installés par `sokar-deploy-root install-runtime prod`. Le cron offsite a
  longtemps existé **uniquement sur le serveur** (créé par le script archivé
  `scripts/_archive/install-r2-backup.sh`) : une reconstruction du VPS perdait
  la copie hors-site sans que rien ne le signale.
- Logs : `/var/log/sokar/postgres-r2-backup.log` (rotaté par
  `infra/logrotate/sokar`).
- Surveillance : `sokar-watchdog` vérifie l'âge **et** la ligne de succès des
  deux journaux (`postgres-backup.log`, `postgres-r2-backup.log`), avec un
  seuil de 26 h.

### Carte des scripts de sauvegarde

Six scripts et une archive. Trois d'entre eux sont appelés directement par des
crons sur le VPS : ne renommez ni ne déplacez ces fichiers sans mettre à jour
le cron correspondant sur le VPS, sinon la sauvegarde s'arrête sans message.

| Script                                        | Rôle                                                                                                                           | Appelé par                                                                                                                                                                                    | Statut                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `scripts/database/backup-postgres.sh`         | Dump local de prod, vérifié par restauration temporaire, rétention 14 j                                                        | Cron `/etc/cron.d/sokar-postgres-backup` via la copie `/usr/local/sbin/sokar-backup-postgres` (installée par `sokar-deploy-root install-runtime prod`) ; exécuté aussi par le wrapper staging | Actif                    |
| `scripts/database/backup-postgres-r2.sh`      | Copie hors site R2 : garde-fou de quota, upload, SHA256, rétention 30 j                                                        | Cron `/etc/cron.d/sokar-r2-backup`, chemin direct `/opt/sokar/scripts/database/` ; versionné dans `infra/cron/sokar-r2-backup`                                                                | Actif                    |
| `scripts/database/backup-staging-postgres.sh` | Wrapper staging : fixe `POSTGRES_DB=sokar_staging` et `BACKUP_DIR=/var/backups/sokar-staging`, puis lance `backup-postgres.sh` | Cron `/etc/cron.d/sokar-staging-postgres-backup` via `/usr/local/sbin/sokar-staging-backup-postgres` ; installé par `sokar-deploy-root install-runtime staging` et `setup-staging.sh`         | Actif                    |
| `scripts/ops/db-backup.sh`                    | Bibliothèque sourcée par `deploy.sh` : dump et restauration avant déploiement, utilisés par le rollback                        | `deploy.sh` (pas de cron)                                                                                                                                                                     | Actif                    |
| `scripts/database/restore-postgres-backup.sh` | Restaure un dump dans une base. Refuse la base `sokar` sauf avec `SKIP_PROD_GUARD=1`                                           | Manuel, procédure P0 ci-dessous                                                                                                                                                               | Actif                    |
| `scripts/database/test-restore-vierge.sh`     | Exercice de restauration de bout en bout dans une base temporaire                                                              | `sokar-deploy-root restore-test` (root) ou manuel                                                                                                                                             | Actif                    |
| `scripts/_archive/install-r2-backup.sh`       | Installation ponctuelle du cron R2                                                                                             | Rien : déjà exécutée sur le VPS                                                                                                                                                               | Archivé, ne pas relancer |

Pour une fusion future des trois crons en une seule commande, il faut d'abord
un exercice `restore-test` réussi sur le VPS. C'est une opération de production,
pas un simple refactor.

### Vérifier qu'un backup est restaurable (test régulier)

Le script `scripts/database/test-restore-vierge.sh` prouve bout-en-bout qu'on sait
restaurer sur une base vierge :

1. Télécharge le dump R2 le plus récent
2. Crée une base temporaire from scratch
3. Restore via `pg_restore --exit-on-error`
4. Vérifie : nombre de tables > 0, contraintes présentes, index présents,
   index critique `one_active_hold_per_slot`, comptage de lignes sur
   `restaurants` / `reservation_hold` / `voice_call`, jointure test
5. Nettoie la base temporaire

```bash
# Sur le VPS, via le wrapper privilégié : le compte deploy n'a ni le groupe
# docker ni les clients PostgreSQL, donc le script ne peut pas tourner
# directement sous ce compte.
sudo /usr/local/sbin/sokar-deploy-root restore-test prod

# En local avec Docker + rclone configuré, le script reste utilisable tel quel
bash scripts/database/test-restore-vierge.sh

# Conserver la base de test pour debug
KEEP_DB=1 bash scripts/database/test-restore-vierge.sh
```

**À exécuter au moins une fois après chaque changement de schéma
(migration Prisma) et idéalement une fois par semaine.**

### Procédure de restauration en production (P0 — perte de données)

> ⚠️ Cette procédure écrase la base de production. À n'utiliser qu'en cas
> de perte de données confirmée (corruption, drop accidentel, ransomware).

1. **Identifier le dump à restaurer** :

   ```bash
   rclone lsf r2:sokar-backups/postgres/ --sort-by modtime --max-depth 1 | tail -5
   ```

2. **Télécharger le dump** :

   ```bash
   rclone copyto r2:sokar-backups/postgres/<TIMESTAMP>.dump /tmp/restore.dump
   ```

3. **Stopper l'API** (éviter les écritures pendant le restore) :

   ```bash
   pm2 stop sokar-api
   ```

4. **Sauvegarder la base cassée** (pour forensic) :

   ```bash
   docker exec infra-postgres-1 psql -U sokar -c \
     'ALTER DATABASE sokar RENAME TO sokar_broken_$(date +%Y%m%d);'
   ```

5. **Restaurer** (la garde anti-prod est levée explicitement) :

   ```bash
   SKIP_PROD_GUARD=1 bash scripts/database/restore-postgres-backup.sh /tmp/restore.dump sokar
   ```

6. **Vérifier l'intégrité** :

   ```bash
   docker exec infra-postgres-1 psql -U sokar -c \
     "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';"
   docker exec infra-postgres-1 psql -U sokar -c \
     "SELECT count(*) FROM restaurants;"
   ```

7. **Relancer l'API** :

   ```bash
   pm2 start sokar-api
   curl -fsS https://api.suppernote.com/health
   ```

8. **Post-mortem** : documenter la cause de la perte, le RTO/RPO observé,
   et vérifier que le backup suivant s'exécute normalement.

### Vérifier que le cron tourne sur le VPS

```bash
ssh sokar 'crontab -l | grep backup'
ssh sokar 'tail -20 /var/log/sokar/postgres-r2-backup.log'
rclone ls r2:sokar-backups/postgres/ | tail -5
```

Si le dernier dump date de plus de 24h, redéployer :

```bash
VPS_HOST=sokar bash scripts/_archive/install-r2-backup.sh --test
```

---

## Post-mortem template

```
## Incident : [titre court]
- Date : YYYY-MM-DD HH:MM
- Durée : X min
- Sévérité : P1 / P2 / P3
- Restaurants affectés : [noms ou "tous"]
- KPIs impactés : [lesquels]

## Timeline
- HH:MM : événement
- HH:MM : détection
- HH:MM : ack on-call
- HH:MM : mitigation
- HH:MM : résolution

## Root cause
[Description technique]

## Action items
- [ ] [action] - [owner] - [deadline]
```

---

## Liens utiles

- Spec agentic-reservations v3.2 : `docs/sokar-mcp-agentic-reservations-v3.2.md`
- Spec Suppernote Connect v1.1 : `docs/connect-v1.1.md`
- Code metrics : `apps/api/src/shared/observability/metrics.ts`
- Code PII leak detector : `apps/api/src/shared/observability/pii-leak.ts`
- Code hold service : `apps/api/src/modules/agentic-reservations/core/hold.service.ts`
- Migration `one_active_hold_per_slot` (partial unique index) :
  `packages/database/prisma/migrations/20260621004000_agentic_p0_constraints/`

---

**Changelog** :

- 2026-06-24 : squopé. Retiré "On-call P1 (24/7)", "9h daily async",
  "Weekly retro (1h)", "page de statut publique (à créer)". Ajouté procédure
  désactivation Suppernote Connect. Ajouté référence aux specs v3.2 agentic et
  v1.1 Suppernote Connect. Renommé "Runbook opérationnel — Pilote Lyon" en
  "Runbook opérationnel Suppernote" (transversal, plus seulement pilote).
- 2026-06-26 : ajout section "Backups et restauration" (topologie,
  test de restore sur base vierge, procédure P0, vérification cron VPS).
  Ajout section "Rollback de déploiement" (release dirs, rollback auto/manuel).
