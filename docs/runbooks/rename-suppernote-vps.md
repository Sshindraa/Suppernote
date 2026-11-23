# Runbook — Renommage du VPS `sokar` → `suppernote` (palier 1)

> **Statut : PRÉPARATION (préflight lecture seule terminé le 23/11/2026, 10:15–10:45 CET).**
> Fenêtre validée par Hamza : **mardi 24/11/2026, 15h00–16h00 (CET)**, hors service.
>
> **Toutes les heures de ce document sont en HEURE DE PARIS** (Europe/Paris, CET = UTC+1 le 24/11 ;
> c'est le fuseau du serveur). Hamza est au Maroc et son Mac est en UTC+0 : **15h00 à Paris = 14h00
> sur le Mac**, 16h00 à Paris = 15h00 sur le Mac. Ne pas caler la fenêtre sur l'heure du Mac ni du
> téléphone ; l'heure de référence est celle du serveur (`ssh deploy@sokar date`).
>
> **Règle n° 1 de la fenêtre : `apply` et `rollback` se lancent TOUJOURS dans `tmux` sur le serveur**
> (`sudo tmux new -A -s rename`, §3.10). Après une coupure ou un kill pendant `apply`, ne **pas** relancer
> `apply` : suivre §3.11.
> Rien n'a été modifié sur le VPS pour rédiger ce document : uniquement `ls`, `cat`, `grep`,
> `pm2 jlist`, `crontab -l`, `systemctl status/cat`, `stat`, `readlink`, `df`, `du`, `nginx -v`,
> `curl` sur `127.0.0.1` et sur les domaines publics (GET). Aucune valeur de `.env`, `watchdog.env`
> ou URL de heartbeat n'est reproduite ici : seuls les noms de variables et les chemins comptent.
>
> Le script `scripts/ops/rename-sokar-to-suppernote.sh` et ses tests sont livrés dans la PR #795
> (non fusionnée). Les commandes exactes à copier-coller sont au **§3.10** ; le traitement de chaque
> référence H01–H36 par le script est au **§1.7**. Le script n'a été exécuté qu'en bac à sable local
> (stubs pm2/nginx/systemctl/docker/sudo/visudo), jamais sur le VPS.

Périmètre du palier 1 (décidé par le lead) :

| Ancien                                                                                    | Nouveau                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| `/opt/sokar`, `/opt/sokar-staging`                                                        | `/opt/suppernote`, `/opt/suppernote-staging` |
| `/var/log/sokar`, `/var/lib/sokar`, `/etc/sokar`                                          | équivalents `suppernote`                     |
| `/var/backups/sokar`, `/var/backups/sokar-staging`                                        | équivalents `suppernote`                     |
| PM2 `sokar-{api,workers,dashboard,connect}`, `sokar-staging-*`                            | `suppernote-*`                               |
| nginx `sites-*/sokar`, `sokar-staging` + snippets `sokar-{proxy,security-headers,…}.conf` | `suppernote-*`                               |
| `/usr/local/sbin/sokar-{deploy-root,watchdog,backup-postgres,staging-backup-postgres}`    | `suppernote-*`                               |
| `/etc/cron.d/sokar-*`, `/etc/logrotate.d/sokar`                                           | `suppernote-*`                               |

Liens de compatibilité ancien → nouveau pour les dossiers et pour `/usr/local/sbin/sokar-deploy-root`.

**À ne pas toucher :** bases et rôles Postgres (`sokar`, `sokar_staging`), buckets R2 et remote rclone
`r2`, noms de variables d'environnement, secrets GitHub, slugs `chez-sokar-demo`, noms de job
Prometheus, hostname du VPS, domaines `sokar.tech` (redirections et certificat).

---

## 0. Synthèse : ce qu'il faut retenir avant de lire le reste

Risques majeurs, par ordre d'importance :

1. **Le premier déploiement automatique après le renommage peut défaire le renommage.** Le wrapper
   installé (`sokar-deploy-root`, identique au repo) code en dur les anciens chemins, noms de vhost,
   fichiers cron et logrotate. `install-runtime`, `install-nginx` et `self-update` recréeraient
   `/etc/nginx/sites-enabled/sokar`, `/etc/cron.d/sokar-*`, `/etc/logrotate.d/sokar` à côté des
   nouveaux fichiers. Conséquences : doublons de cron (backups et watchdog lancés deux fois), vhost en
   double, **`nginx -t` en échec**, `check-prod-vhost` en échec (il exige exactement un fichier avec
   `api.sokar.tech`). **Le correctif dev (wrapper, workflows, scripts) ne doit être fusionné qu'après
   le renommage serveur, et les déploiements doivent rester gelés entre-temps** (§3.1).
2. **`self-update` écrase le lien de compatibilité du wrapper.** Il fait `install … $PRIVILEGED_WRAPPER`,
   donc remplace `/usr/local/sbin/sokar-deploy-root` (lien) par un fichier régulier (ancienne copie).
3. **Le watchdog n'a pas de mode maintenance et casserait dès le `mv`.** Il lit `/etc/sokar/watchdog.env`,
   `/var/backups/sokar`, `/var/lib/sokar/watchdog` et source `/opt/sokar/scripts/ops/logging.sh`
   (`notify()` indisponible = alertes muettes, plus de ping Healthchecks). Il tourne toutes les 5 min,
   donc **il faut suspendre son cron pendant toute la fenêtre** et le réactiver après correction.
4. **Les builds Next (`.next-deploy-*`, `standalone/server.js`, `required-server-files.json`) contiennent
   le chemin absolu `/opt/sokar*`**, y compris dans les releases conservées pour le rollback
   (5,5 Go en prod, 3,4 Go en staging). Les liens de compatibilité doivent rester **tant qu'un
   rollback vers ces releases est envisageable** (§3.9).
5. **PM2 ne renomme pas un process** : il faut `pm2 delete` + `pm2 start` avec la nouvelle définition
   (≈ 4 s de coupure par process, mesurés au dernier déploiement), puis `pm2 save`
   (`pm2-deploy.service` fait `pm2 resurrect` depuis `~/.pm2/dump.pm2`, qui contient les chemins absolus).
6. **Plusieurs éléments sont illisibles pour `deploy`** (sudoers, `/etc/sokar`, crontab root, `docker`,
   `nginx -T`, dumps staging). Ils ne sont pas vérifiés. Un préflight root est demandé (§1.5) **avant**
   la fenêtre.
7. **Le « creux » de 15h–16h n'est pas démontré par les journaux** : trafic API plat (~4 000 req/h, quasi
   tout du bruit), environ 10 appels en 14 jours dont 3 à 15h21–15h27 le 20/11 (probablement des
   tests de Hamza). À confirmer (§5.2, Q1).
8. **Faux amis à ne pas « renommer »** : les dumps restent `sokar-*.dump` (nom de la base Postgres), la
   chaîne `Backup offsite sokar terminé` aussi. Le watchdog dépend de ces deux chaînes (§1.2, H10).
9. **Une coupure SSH (SIGHUP) ou un kill (SIGTERM) pendant `apply` laisse l'environnement coupé.** Si le
   script est tué entre `pm2 delete` et `pm2 start`, les 4 process PM2 de l'environnement restent
   `stopped` ou absents et **il n'y a pas de retour arrière automatique** : relancer `apply` est alors
   refusé par le préflight (code 3, état partiel). Deux parades : tout lancer dans `tmux` (§3.10), et
   après toute interruption faire `status` puis `rollback --env <env>` (§3.11).

---

## 1. Préflight : inventaire de ce qui référence « sokar » sur le serveur

### 1.1 Méthode

Accès : `ssh deploy@sokar` (lecture seule, `deploy` sans sudo sans mot de passe, pas de docker.sock).
Commandes utilisées : `grep -rIl -i sokar /etc /usr/local /var/spool /lib/systemd`, `grep -n` sur
`/etc/nginx`, `/etc/cron.d`, `/etc/logrotate.d`, `/usr/local/sbin`, `~deploy`, `/opt/sokar{,-staging}`
(hors `node_modules`, `.git`), `systemctl cat/status pm2-deploy`, `pm2 jlist`, `stat -c %d`, `df`, `du`.
Le wrapper installé (`/usr/local/sbin/sokar-deploy-root`), le watchdog et `nginx/sites-available/sokar`
ont été comparés au repo (`diff`) : **identiques**. `sites-enabled/sokar-staging` est identique à
`sites-available/sokar-staging`.

### 1.2 Références hors de l'inventaire initial

Colonne **Action** : `patch` = modifier le contenu ; `recréer` = recréer un conteneur ou un process ;
`rien` = aucune action, avec la raison. Les lignes sont celles du serveur au 23/11/2026.

| ID  | Fichier : ligne                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Contenu (sans secret)                                                                                                                                                                                                                                                                                                                                                                                             | Impact du renommage                                                                                                                                                                                                                                                  | Action                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| H01 | `/etc/nginx/sites-enabled/sokar-staging`                                                                                                                                                                                                                                                                                                                                                                                                                              | **Fichier régulier** (14 583 o), copie identique de `sites-available/sokar-staging`, pas un lien                                                                                                                                                                                                                                                                                                                  | Renommer seulement `sites-available` laisse l'ancien vhost actif : `server_name` et `upstream` en double, `nginx -t` KO                                                                                                                                              | patch : renommer les deux, ou recréer `sites-enabled/suppernote-staging` en lien                      |
| H02 | `sites-available/sokar` (71 lignes), `sites-available/sokar-staging` (39 lignes), ex. `sokar:62,79,87`                                                                                                                                                                                                                                                                                                                                                                | `include /etc/nginx/snippets/sokar-{proxy,security-headers,cloudflare-real-ip}.conf`                                                                                                                                                                                                                                                                                                                              | Les snippets sont renommés : l'`include` d'un fichier absent fait échouer `nginx -t` et le reload                                                                                                                                                                    | patch (même `sed` que le renommage des snippets, avant `nginx -t`)                                    |
| H03 | `sites-available/sokar:571,584,609`                                                                                                                                                                                                                                                                                                                                                                                                                                   | `access_log /var/log/sokar/nginx-legacy.log sokar_legacy;`                                                                                                                                                                                                                                                                                                                                                        | nginx ouvre ce fichier à chaque reload : chemin absent = reload refusé. Fonctionne via le lien, mais `cleanup-compat` le casserait                                                                                                                                   | patch vers `/var/log/suppernote/nginx-legacy.log`                                                     |
| H04 | `sites-available/sokar:21,45,50,55` (+58 `proxy_pass`), `sites-available/sokar-staging:27,32,37` (+39)                                                                                                                                                                                                                                                                                                                                                                | `log_format sokar_legacy`, `upstream sokar_{dashboard,api,connect}`, `sokar_staging_{…}`                                                                                                                                                                                                                                                                                                                          | Identifiants internes nginx, sans effet externe. Les renommer multiplie les modifications pour rien                                                                                                                                                                  | rien (recommandé : ne pas renommer au palier 1, Q7)                                                   |
| H05 | `sites-available/sokar:568-569,581-582,606-607`, `sokar-staging:348-349,360-361`, `/etc/letsencrypt/renewal/staging.sokar.tech-0001.conf`                                                                                                                                                                                                                                                                                                                             | `ssl_certificate /etc/letsencrypt/live/sokar.tech/…` (domaine legacy, redirections 301/308 et relais webhooks)                                                                                                                                                                                                                                                                                                    | Ce sont des **domaines**, pas des chemins `/opt` ni `/var`. `live/suppernote.com` est déjà utilisé pour les autres blocs                                                                                                                                             | rien (ne pas toucher : décision lead)                                                                 |
| H06 | `/etc/sudoers.d/deploy` (illisible ; repo `infra/sudoers.d/deploy:6`)                                                                                                                                                                                                                                                                                                                                                                                                 | `deploy ALL=(root) NOPASSWD: /usr/local/sbin/sokar-deploy-root *`                                                                                                                                                                                                                                                                                                                                                 | Les workflows appellent `sudo /usr/local/sbin/sokar-deploy-root` (`deploy-prod.yml:122,128,129,147,151,152`). Un sudoers pointant seulement sur le nouveau nom refuserait l'ancien appel                                                                             | patch : garder la ligne ancienne **et** ajouter la nouvelle jusqu'à `cleanup-compat` ; `visudo -c`    |
| H07 | `/usr/local/sbin/sokar-deploy-root` L10, 24-31, 80-98, 110, 162, 215, 315-329, 382-384                                                                                                                                                                                                                                                                                                                                                                                | `PRIVILEGED_WRAPPER`, `ROOT=/opt/sokar`, `VHOST=sokar`, destinations `/usr/local/sbin/sokar-*`, `/etc/cron.d/sokar-*`, `/etc/logrotate.d/sokar`, `/var/backups/sokar`, `/var/lib/sokar/watchdog`, `/etc/sokar/{watchdog,grafana}.env`, `--project-name sokar-monitoring`                                                                                                                                          | Tout déploiement avec l'ancien wrapper recrée les anciens noms (risque n° 1)                                                                                                                                                                                         | patch + réinstallation du wrapper depuis la branche dev **avant** de dégeler les workflows            |
| H08 | `sokar-deploy-root:167-193` (`self_update`)                                                                                                                                                                                                                                                                                                                                                                                                                           | `install -o root -g root -m 0755 "$wrapper_src" "$PRIVILEGED_WRAPPER"`                                                                                                                                                                                                                                                                                                                                            | `install` supprime la cible puis la recrée : le lien de compatibilité devient un fichier régulier (ancienne copie), compat perdue                                                                                                                                    | patch (le wrapper cible `suppernote-deploy-root` ; le lien ancien → nouveau est recréé par le script) |
| H09 | `/usr/local/sbin/sokar-watchdog` L42-48, 61, 66, 132, 141, 151, 165, 177, 196                                                                                                                                                                                                                                                                                                                                                                                         | `SOKAR_ROOT=/opt/sokar` → `source …/scripts/ops/logging.sh` ; `ENV_FILE=/etc/sokar/watchdog.env` ; `BACKUP_DIR=/var/backups/sokar` ; `STATE_DIR=/var/lib/sokar/watchdog` ; `OFFSITE_BACKUP_LOG=/var/log/sokar/postgres-r2-backup.log`                                                                                                                                                                             | Sans `logging.sh`, `notify()` n'existe plus (alertes muettes). Sans `watchdog.env`, plus de `HEALTHCHECKS_PING_URL` : la supervision externe se déclenche à tort. Sans `BACKUP_DIR`, alerte « backup introuvable »                                                   | patch (défauts + textes d'alerte) ; suspendre le cron pendant la fenêtre                              |
| H10 | `sokar-watchdog:136` et `:161`                                                                                                                                                                                                                                                                                                                                                                                                                                        | `find … -name 'sokar-*.dump'` et `${last#*Backup offsite sokar terminé}`                                                                                                                                                                                                                                                                                                                                          | Ces chaînes viennent de `DB_NAME=sokar` (`backup-postgres.sh:26,31` ; `backup-postgres-r2.sh:43,142`), pas du dossier                                                                                                                                                | **rien : ne pas les modifier.** Les dumps resteront `sokar-<ts>.dump` dans `/var/backups/suppernote`  |
| H11 | `sokar-watchdog:208`, `sokar-staging-backup-postgres:14-16`, `backup-postgres.sh:26-27`                                                                                                                                                                                                                                                                                                                                                                               | `pg_isready -U sokar`, `POSTGRES_DB=sokar_staging`, `POSTGRES_USER=sokar`, conteneur `infra-postgres-1`                                                                                                                                                                                                                                                                                                           | Rôle et bases Postgres : hors périmètre                                                                                                                                                                                                                              | rien                                                                                                  |
| H12 | `/etc/cron.d/sokar-watchdog:7`, `sokar-postgres-backup:6`, `sokar-r2-backup:10`, `sokar-staging-postgres-backup:5`                                                                                                                                                                                                                                                                                                                                                    | Chemins `/usr/local/sbin/sokar-*` et redirections `>> /var/log/sokar/*.log` ; **`sokar-r2-backup` exécute `/opt/sokar/scripts/database/backup-postgres-r2.sh` directement**                                                                                                                                                                                                                                       | Un cron qui tombe sur un chemin absent échoue en silence jusqu'à l'alerte du watchdog. Les noms de fichiers `cron.d` ne doivent pas contenir de point                                                                                                                | patch + renommage (un seul exemplaire de chaque, voir §4)                                             |
| H13 | `/etc/cron.d/sokar-r2-backup:3`, `backup-postgres-r2.sh:12,45,51`                                                                                                                                                                                                                                                                                                                                                                                                     | `RCLONE_CONFIG=/home/deploy/.config/rclone/rclone.conf`, remote `[r2]`, bucket par défaut `sokar-backups`                                                                                                                                                                                                                                                                                                         | Hors périmètre (bucket, remote, config rclone de `deploy`)                                                                                                                                                                                                           | rien                                                                                                  |
| H14 | `/etc/logrotate.d/sokar:1,9`                                                                                                                                                                                                                                                                                                                                                                                                                                          | `/var/log/sokar/*.log { daily, rotate 14, … su deploy deploy }`                                                                                                                                                                                                                                                                                                                                                   | Si l'ancien fichier subsiste à côté du nouveau avec un lien `/var/log/sokar`, les mêmes journaux sont rotés deux fois                                                                                                                                                | patch (glob `/var/log/suppernote/*.log`) + renommage, **sans copie résiduelle**                       |
| H15 | `~deploy/.pm2/dump.pm2` (+ `dump.pm2.bak`, `.bak-avant-nettoyage-20261114…`, `.bak-staging-20261114…`)                                                                                                                                                                                                                                                                                                                                                                | Noms `sokar-*`, `pm_cwd` et `pm_exec_path` `/opt/sokar*/apps/*/…`, `/var/log/sokar/*.log`, `~/.pm2/logs/sokar-{dashboard,connect}-*.log`                                                                                                                                                                                                                                                                          | `pm2-deploy.service` (`ExecStart=pm2 resurrect`) relit ce fichier au boot. Non mis à jour = après un reboot, anciens noms (démarrage encore possible via les liens)                                                                                                  | recréer les 8 process puis `pm2 save` ; ne pas rejouer les `.bak` après le renommage                  |
| H16 | `/etc/systemd/system/pm2-deploy.service` et `pm2-deploy.service.d/override.conf`                                                                                                                                                                                                                                                                                                                                                                                      | Aucune occurrence de « sokar » (`PM2_HOME=/home/deploy/.pm2`, `pm2 resurrect`, `Type=oneshot` en override)                                                                                                                                                                                                                                                                                                        | Aucun                                                                                                                                                                                                                                                                | rien                                                                                                  |
| H17 | `~/.pm2/logs/sokar-{dashboard,connect}-{out,error}.log` (prod) vs `infra/ecosystem.config.js:86-87,108-109`                                                                                                                                                                                                                                                                                                                                                           | `pm2 jlist` donne `~/.pm2/logs/…` pour dashboard/connect prod, alors que l'ecosystem demande `/var/log/sokar/{dashboard,connect}-*.log`                                                                                                                                                                                                                                                                           | **Dérive** : la prod ne suit pas l'ecosystem pour ces deux process. Après recréation, les logs iront dans `/var/log/suppernote/` ; les anciens restent dans `~/.pm2/logs`                                                                                            | rien (à savoir ; ne pas chercher les nouveaux logs dans `~/.pm2/logs`)                                |
| H18 | `apps/connect/.next-deploy-*/standalone/server.js`, `required-server-files.json`, `server/**` (prod : 20261115T221010Z, 20261122T223835Z ; staging : 20261117T175320Z, 20261122T223310Z ; + dashboard)                                                                                                                                                                                                                                                                | Chemin absolu `/opt/sokar*` écrit dans les builds Next                                                                                                                                                                                                                                                                                                                                                            | Les 4 `next-server` en cours et les releases de rollback référencent l'ancien chemin. Tout fonctionne via le lien, rien sans lui                                                                                                                                     | rien jusqu'au redéploiement ; **`cleanup-compat` interdit avant les conditions du §3.9**              |
| H19 | `/opt/sokar/apps/api/.env:73` (prod seulement)                                                                                                                                                                                                                                                                                                                                                                                                                        | `DEBUG_LOG_PATH=/opt/sokar/apps/api/scratch/call_debug.log` (fichier existant)                                                                                                                                                                                                                                                                                                                                    | Valeur de chemin (la clé ne change pas). Fonctionne via le lien                                                                                                                                                                                                      | patch de la **valeur** avant `cleanup-compat` (Q9 : accord pour modifier une valeur de `.env`)        |
| H20 | `apps/{api,dashboard,connect}/.env`, `infra/.env` (prod et staging)                                                                                                                                                                                                                                                                                                                                                                                                   | Clés dont la **valeur** contient « sokar » (domaines, buckets, adresses mail, DSN) : `DATABASE_URL`, `CALL_RECORDINGS_BUCKET`, `ALERT_EMAIL_TO`, `DEMO_REQUEST_NOTIFY_TO`, `EMAIL_TEST_ALLOWLIST`, `AGENT_STAGING_KEY`, `AZURE_SPEECH_NEU_ENDPOINT`, `AZURE_VOICELIVE_ENDPOINT`, `PUBLIC_URL`. Clés nommées `SOKAR_*` : `SOKAR_OPERATOR_USER_IDS`, `SOKAR_VOICE_READ_TOKEN`, `SOKAR_GIFT_CARD_CONNECT_WEBHOOK_ID` | Hors périmètre (variables et services externes)                                                                                                                                                                                                                      | rien                                                                                                  |
| H21 | `/opt/sokar-staging/releases/*/.env.before` (≥ 3 fichiers, mode 600)                                                                                                                                                                                                                                                                                                                                                                                                  | Anciennes copies de `.env` de staging, avec secrets                                                                                                                                                                                                                                                                                                                                                               | Suivent le `mv`. Hygiène : des copies de secrets traînent dans les releases                                                                                                                                                                                          | rien pour le renommage ; à purger plus tard (hors périmètre)                                          |
| H22 | `infra/prometheus-compose.yml:7`, `infra/grafana-compose.yml:6`, wrapper `--project-name sokar-monitoring`                                                                                                                                                                                                                                                                                                                                                            | `container_name: sokar-prometheus`, `sokar-grafana`, projet `sokar-monitoring` (volumes préfixés par le projet)                                                                                                                                                                                                                                                                                                   | Renommer le projet orphelinerait les volumes (dont `grafana-data`) ; renommer les conteneurs les recrée                                                                                                                                                              | rien (hors palier 1, Q7)                                                                              |
| H23 | `infra/prometheus-compose.yml:10-11`, `grafana-compose.yml:17-18`, `docker-compose.yml:84-85,103-104`                                                                                                                                                                                                                                                                                                                                                                 | Bind mounts relatifs `./prometheus/*.yml`, `./grafana/{provisioning,dashboards}` (résolus en `/opt/sokar/infra/…` à la création)                                                                                                                                                                                                                                                                                  | Le `mv` garde l'inode : les conteneurs en cours ne voient rien. Mais `deploy-prod.yml:151-152` relance `start-prometheus` / `start-grafana` à chaque déploiement : depuis `/opt/suppernote/infra`, le chemin source change et Compose **recrée** les deux conteneurs | recréer : attendu et court (Prometheus, Grafana) ; à vérifier dans le préflight root                  |
| H24 | `infra/docker-compose.yml` (postgres, redis, redis-staging, localstack)                                                                                                                                                                                                                                                                                                                                                                                               | Volumes nommés (`pgdata`, `redis-data`, `redis-staging-data`, `localstack-data`), projet `infra`, `/var/run/docker.sock`                                                                                                                                                                                                                                                                                          | Indépendants de `/opt`                                                                                                                                                                                                                                               | rien                                                                                                  |
| H25 | `infra/prometheus/prometheus.yml:21,30,38,45` ; `infra/prometheus/alerts.yml:28`                                                                                                                                                                                                                                                                                                                                                                                      | `job_name: sokar-api`, `sokar-workers`, `sokar-staging-api`, `sokar-staging-workers`                                                                                                                                                                                                                                                                                                                              | Noms de job : décision lead                                                                                                                                                                                                                                          | rien                                                                                                  |
| H26 | `infra/ecosystem.config.js:4,5,21,22,37,38,52,53,65,66,86,87,97,98,108,109` ; `ecosystem.staging.config.js:13,14,29,30,43,44,57,58,69,70,80,81,91,92,102,103`                                                                                                                                                                                                                                                                                                         | `name`, `cwd`, `error_file`, `out_file`                                                                                                                                                                                                                                                                                                                                                                           | Les process sont recréés avec la définition patchée (voir H15). L'ecosystem du serveur est la version ancienne tant que le repo serveur n'est pas mis à jour                                                                                                         | patch (dev) ; le script `apply` doit utiliser la version de la branche dev                            |
| H27 | Repo : `scripts/ops/{deploy-common.sh:1103,1224,1253,1286-1296 ; sync-env.sh:31-37 ; nginx-common.sh:16,27,62 ; setup-staging.sh:23,114 ; setup-cloudflare-saas.sh:5,107,111 ; sokar-watchdog.sh ; voice_call_audio.py:47,158,162,178 ; verify-stripe-catalog.mjs:13}`, `scripts/database/backup-*.sh`, `apps/api/scripts/{call-report-local.ts:94,110,124,147 ; voice-listen/listen-call.sh:8,10 ; voice-behavior-replay.mjs:13,32 ; openrouter-region-test.mjs:13}` | Chemins absolus `/opt/sokar*`, `/var/log/sokar`, `/etc/sokar`, `/usr/local/sbin/sokar-*`                                                                                                                                                                                                                                                                                                                          | Fonctionnent via les liens de compatibilité. `nginx-common.sh:62` fait `touch /var/log/sokar/nginx-legacy.log` à chaque `install-nginx`                                                                                                                              | patch (dev), fusionné après le renommage serveur                                                      |
| H28 | `apps/api/src/modules/voice/call-report/job-runtime.ts:30` ; `log-events.ts:2` ; `apps/api/src/env.ts:348`                                                                                                                                                                                                                                                                                                                                                            | `const DEFAULT_LOG_DIR = '/var/log/sokar'` : le worker du rapport d'appel lit `api-out.log` dans ce dossier                                                                                                                                                                                                                                                                                                       | Sans lien `/var/log/sokar`, les rapports d'appel seraient vides **sans erreur visible**                                                                                                                                                                              | patch du code (dev) ; sinon `cleanup-compat` bloqué                                                   |
| H29 | `.github/workflows/deploy-prod.yml:96,118-122,128-129,147,151-152,284` ; `deploy-staging.yml:152,189-191,318,341,346,426`                                                                                                                                                                                                                                                                                                                                             | `cd /opt/sokar*`, `sudo /usr/local/sbin/sokar-deploy-root …`, `releases/.latest`, `deploy.sh rollback`                                                                                                                                                                                                                                                                                                            | Fonctionnent via les liens de compatibilité                                                                                                                                                                                                                          | patch (dev), fusionné après le renommage serveur                                                      |
| H30 | `AGENTS.md:7,137` ; `docs/runbooks/migration-suppernote.md` (section « Ce qui ne change pas ») ; `rollback.md`, `staging.md`, `deployment.md`, … (127 fichiers sous `docs/`)                                                                                                                                                                                                                                                                                          | Chemins et noms de scripts en clair                                                                                                                                                                                                                                                                                                                                                                               | Documentation obsolète après le renommage                                                                                                                                                                                                                            | patch après qualification                                                                             |
| H31 | `/var/log/sokar/api-out.log` (champ pino)                                                                                                                                                                                                                                                                                                                                                                                                                             | `"service":"sokar-api"` dans chaque ligne                                                                                                                                                                                                                                                                                                                                                                         | Si Sentry, Grafana ou une alerte filtre sur ce champ, un renommage de process ne le change pas, mais un changement de valeur le casserait                                                                                                                            | rien au palier 1 (Q12)                                                                                |
| H32 | `/var/log/sokar/` hors pm2 : `nginx-legacy.log`, `temp-suspend-restore.log`, `postgres-{backup,r2-backup,staging-backup}.log`, `watchdog.log`                                                                                                                                                                                                                                                                                                                         | Propriétaire `deploy` (dossier 755) ; nginx écrit `nginx-legacy.log`                                                                                                                                                                                                                                                                                                                                              | Suivent le `mv` du dossier                                                                                                                                                                                                                                           | rien                                                                                                  |
| H33 | `~deploy/.sokar-ops-private`, `~/.sokar-voice01`, `~/sokar-backups` (copies d'anciens `.env`), `~/sokar-billing-*-20261021` (3), `~/backups/sokar`                                                                                                                                                                                                                                                                                                                    | Dossiers personnels hors table de renommage ; aucun service ne les référence                                                                                                                                                                                                                                                                                                                                      | Aucun                                                                                                                                                                                                                                                                | rien (Q8)                                                                                             |
| H34 | `~deploy/.bashrc:1`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Commentaire `# Sokar PostgreSQL client…`                                                                                                                                                                                                                                                                                                                                                                          | Aucun (`.profile` : aucune occurrence)                                                                                                                                                                                                                               | rien                                                                                                  |
| H35 | `/etc/hostname` (`sokar`), `~/.ssh/config` du Mac (`Host sokar`), `known_hosts*`                                                                                                                                                                                                                                                                                                                                                                                      | Hostname du VPS, alias SSH                                                                                                                                                                                                                                                                                                                                                                                        | Hors périmètre                                                                                                                                                                                                                                                       | rien                                                                                                  |
| H36 | `/opt/sokar{,-staging}/.git/config`                                                                                                                                                                                                                                                                                                                                                                                                                                   | `origin` = dépôt GitHub `Sshindraa/Sokar` (aucun worktree annexe)                                                                                                                                                                                                                                                                                                                                                 | Renommer le dossier ne change rien ; renommer le dépôt GitHub est un autre chantier                                                                                                                                                                                  | rien                                                                                                  |

### 1.3 Ce que le renommage ne casse pas

- Les processus en cours gardent leur répertoire de travail après le `mv` (même inode) ; seuls les chemins **rouverts par nom**
  (Next qui relit `.next/…`, `logging.sh` sourcé par le watchdog, `access_log` nginx au reload) dépendent du lien de compatibilité.
- Postgres et Redis (conteneurs, volumes nommés) ne dépendent d'aucun chemin `/opt` (H24).
- Les domaines publics, Cloudflare, Telnyx, Stripe, Clerk et le widget (Cloudflare Pages) ne dépendent pas du VPS pour leur nom.

### 1.4 Dernières précisions

Dumps : les 23 fichiers `.dump` de `/var/backups/sokar` ne sont pas un défaut de rétention. À côté du dump quotidien de 03:20, on
trouve des dumps manuels ou pré-déploiement (08/11 14:11, 12/11 01:53, 13/11 02:27, 14:10, 20:19, 16/11 16:28, 17/11 01:15, 20:21).
Le plus ancien a 15 jours ; la rétention de 14 jours (`find -mtime +14`) s'applique bien.

### 1.5 Préflight root à faire AVANT mardi (Hamza ; sortie masquée, clés et chemins seulement)

Aucune de ces commandes ne modifie quoi que ce soit.

```zsh
sudo ls -l /etc/sudoers.d && sudo grep -n -v '^#' /etc/sudoers.d/deploy
sudo ls -la /etc/sokar /var/lib/sokar/watchdog /var/backups/sokar-staging
sudo sed -E 's/=.*/=<masqué>/' /etc/sokar/watchdog.env          # clés seulement
sudo crontab -l
sudo nginx -T 2>&1 | grep -n -i sokar | head -150
sudo docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
sudo docker inspect -f '{{.Name}} {{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}} {{end}}' $(sudo docker ps -q)
sudo diff /usr/local/sbin/sokar-backup-postgres /opt/sokar/scripts/database/backup-postgres.sh && echo identique
sudo grep -rIl -i sokar /etc/ufw /etc/letsencrypt 2>/dev/null
```

Remettre la sortie (sans valeur de secret) à ops pour compléter §1.2 et §5.1.

Autres vérifications sans occurrence : `/etc/systemd/system`, `/lib/systemd`, `/usr/lib/systemd`,
`/usr/local/bin` (vide), `/var/spool` lisible, `~deploy/.profile`, crontab de `deploy` (« no crontab »),
`at` (spool absent), `anacron` (pas de `/etc/anacrontab`), timers systemd (aucun lié à sokar).

### 1.6 Éléments de l'inventaire initial : précisions constatées

| Élément                    | Constat                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/opt/sokar` et `-staging` | Propriétaire `deploy`. 13 Go (dont `releases` 5,5 Go) et 7,1 Go (dont `releases` 3,4 Go). Même filesystem que `/opt` (voir §2.4).         |
| `/var/log/sokar`           | 33 Mo, propriétaire `deploy`. Contient aussi les journaux staging (`staging-*`), cron et nginx legacy.                                    |
| `/var/backups/sokar`       | `drwx------ deploy`, dumps en `root:root 600`. `/var/backups/sokar-staging` : `drwx------ root` (illisible pour `deploy`).                |
| `/var/lib/sokar/watchdog`  | `root:root 750` : état du watchdog (cooldowns), illisible pour `deploy`. Un renommage perd les cooldowns si le dossier n'est pas déplacé. |
| `/etc/sokar`               | `root:root 750` : `watchdog.env` (`ALERT_WEBHOOK`, `HEALTHCHECKS_PING_URL`, éventuellement `ALERT_CMD`) et `grafana.env`. Contenu non lu. |
| `/usr/local/sbin`          | `sokar-backup-postgres` est en `0750 root` (illisible, 3 080 o, installé le 22/11 23:40 comme le reste). Les 3 autres sont lisibles.      |
| Sites nginx                | `sites-enabled/sokar` est un lien vers `sites-available/sokar` ; `sokar-staging` est une **copie** (H01).                                 |
| Snippets nginx             | Les 3 fichiers ne contiennent aucune occurrence de « sokar » : seul le nom change.                                                        |

---

### 1.7 Traitement de chaque référence par le script (carte `t_ae0c8153`)

| Réf.            | Traitement                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H01             | Traité : `sites-enabled/sokar-staging` (copie) est déplacé comme un fichier ; `sites-enabled/sokar` (lien) est recréé vers `sites-available/suppernote`.           |
| H02             | Traité : `include` de snippets patchés (sed borné) ; liens de compatibilité des snippets tant qu'un site utilise l'ancien nom.                                     |
| H03             | Traité : `/var/log/sokar` → `/var/log/suppernote` dans les sites (`access_log`).                                                                                   |
| H04, H05        | Rien à faire (identifiants nginx internes, certificats et domaines `sokar.tech`), conservés et vérifiés par test.                                                  |
| H06             | Traité : ligne sudoers ajoutée, ancienne gardée, `visudo -cf`. L'ancienne ligne n'est retirée que par `cleanup-compat`.                                            |
| H07, H08        | Traité : wrapper installé patché (chemins, VHOST, `PRIVILEGED_WRAPPER`) ; le lien `sokar-deploy-root` reste un lien. Le wrapper du dépôt arrive au déploiement.    |
| H09             | Traité : watchdog patché, cron suspendu pendant le script (`.rename-hold`), remis par trap EXIT.                                                                   |
| H10, H11, H13   | Rien à faire : dumps `sokar-*.dump`, message R2, rôle `sokar`, `RCLONE_CONFIG` et bucket conservés.                                                                |
| H12             | Traité : les 4 crons sont déplacés (jamais copiés) et leurs chemins patchés, dont `backup-postgres-r2.sh`.                                                         |
| H14             | Traité : `/etc/logrotate.d/sokar` déplacé et glob patché (un seul fichier).                                                                                        |
| H15, H26        | Traité : `pm2 delete` + `pm2 start` depuis l'ecosystem renommé (version de la PR ou ancienne version transformée) + `pm2 save`.                                    |
| H16, H17        | Rien à faire (`pm2-deploy.service` sans occurrence ; logs `~/.pm2/logs/sokar-*` : dérive existante).                                                               |
| H18             | Rien pendant le renommage (builds suivent le lien) ; **condition de `cleanup-compat`**, non vérifiable par le script (avertissement affiché).                      |
| H19             | Traité seulement au `cleanup-compat --patch-debug-log-path` (préfixe de chemin, valeur jamais imprimée), en attente de la décision Q9.                             |
| H20, H21        | Rien à faire (palier 2 ; `.env` jamais ouverts).                                                                                                                   |
| H22–H25         | Rien à faire (noms Docker, volumes, jobs Prometheus) ; mounts listés par `preflight`, aucune recréation.                                                           |
| H27–H30         | Hors script : PR #795 (scripts du dépôt, code, workflows, docs). `cleanup-compat` refuse tant que les scripts appelés par cron référencent encore l'ancien chemin. |
| H31–H36         | Rien à faire.                                                                                                                                                      |
| Inconnus (§1.5) | `preflight` signale par nom de fichier toute référence à un ancien chemin hors table (`/etc`, sbin, crontabs) ; **non traitées par le script**.                    |

## 2. État de départ (relevé du 23/11/2026, 10:15–10:45 CET)

### 2.1 Processus PM2 (même daemon `deploy`, `PM2 v7.0.3`, `pm2-deploy.service` actif depuis le 18/11 02:15)

| Nom                       | Statut | Redémarrages | cwd                                 | Script                 | Logs                                     |
| ------------------------- | ------ | ------------ | ----------------------------------- | ---------------------- | ---------------------------------------- |
| `sokar-api`               | online | 16           | `/opt/sokar/apps/api`               | `dist/main.js`         | `/var/log/sokar/api-{out,error}.log`     |
| `sokar-workers`           | online | 16           | `/opt/sokar/apps/api`               | `dist/worker.js`       | `/var/log/sokar/workers-*.log`           |
| `sokar-dashboard`         | online | 0            | `/opt/sokar/apps/dashboard`         | `bin/run-dashboard.sh` | `~/.pm2/logs/sokar-dashboard-*.log`      |
| `sokar-connect`           | online | 0            | `/opt/sokar/apps/connect`           | `bin/run-connect.sh`   | `~/.pm2/logs/sokar-connect-*.log`        |
| `sokar-staging-api`       | online | 59           | `/opt/sokar-staging/apps/api`       | `dist/main.js`         | `/var/log/sokar/staging-api-*.log`       |
| `sokar-staging-workers`   | online | 59           | `/opt/sokar-staging/apps/api`       | `dist/worker.js`       | `/var/log/sokar/staging-workers-*.log`   |
| `sokar-staging-dashboard` | online | 1            | `/opt/sokar-staging/apps/dashboard` | `bin/run-dashboard.sh` | `/var/log/sokar/staging-dashboard-*.log` |
| `sokar-staging-connect`   | online | 1            | `/opt/sokar-staging/apps/connect`   | `bin/run-connect.sh`   | `/var/log/sokar/staging-connect-*.log`   |

Tous en `fork_mode`, `unstable_restarts = 0`, en ligne depuis ≈ 10,6 h (dernier déploiement : 22/11 23:34 staging,
23:40 prod). Les 8 process ont leur cwd sous `/opt/sokar*` (vérifié via `/proc/*/cwd` : 4 `next-server`,
4 `node`). Ports locaux : API prod 4000 (workers 4001), dashboard prod 3000, connect prod 4002 ; staging API 4100
(workers 4101), dashboard 3100, connect 4102. Sur `127.0.0.1` : API 200, dashboard 200, connect 200.

**Durée d'un redémarrage observée au déploiement du 22/11 (pm2.log, 23:40:29 → 23:40:33) :** l'API repasse
`online` en 2 s, les 4 process prod en 4 s. Ce sont des durées d'amorçage PM2, pas de disponibilité applicative
(Next peut mettre quelques secondes de plus avant de répondre).

### 2.2 Hôte

`Ubuntu`, uptime 5 j 8 h au relevé, charge 0,07. Fuseau **Europe/Paris (CET, UTC+1)** : les commentaires de
`/etc/cron.d/sokar-*` parlent d'UTC, mais les heures de cron suivent l'heure locale.

### 2.3 Docker

`deploy` n'a **pas** accès à `docker.sock` : `docker ps` et `docker inspect` sont impossibles en lecture seule.
Éléments connus par les fichiers : projet `infra` (`infra-postgres-1`, `infra-redis-1`, redis-staging, `infra-localstack-1`),
projet `sokar-monitoring` (`sokar-prometheus`, `sokar-grafana`, `network_mode: host`). `findmnt` montre 7 conteneurs
(7 overlays sous `/var/lib/docker/rootfs`). Prometheus répond `ready` sur `127.0.0.1:9090`. **Les mounts réels et
les noms exacts sont à relever en root** (§1.5).

### 2.4 nginx, disque, filesystem

- nginx **1.24.0 (Ubuntu)**. `nginx -T` échoue pour `deploy` : la clé privée `suppernote.com` est illisible
  (`BIO_new_file() failed … Permission denied`) ; la configuration a donc été lue fichier par fichier (§1.2).
- `/` : 72 Go, 34 Go utilisés (48 %), **38 Go libres**.
- `/opt/sokar`, `/opt/sokar-staging`, `/var/log/sokar`, `/var/backups/sokar{,-staging}`, `/var/lib/sokar`, `/etc/nginx`,
  `/etc/cron.d`, `/usr/local/sbin` : `stat -c %d` = **2049** partout (`/dev/sda1`, ext4, un seul filesystem pour `/`).
  Tous les `mv` de la table sont donc des `rename(2)` atomiques, sans copie ni besoin d'espace libre.
  `/boot` et `/boot/efi` sont des partitions séparées, non concernées.

### 2.5 Backups

| Sauvegarde       | Dernière exécution (CET)                                                 | Résultat                                                                                             | Rétention                    |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| Postgres prod    | 23/11 03:20 → `sokar-20261123T022001Z.dump` (901 Ko, root 600)           | « Sauvegarde vérifiée … (104 tables) » (restauration de contrôle dans une base temporaire)           | 14 jours (23 dumps présents) |
| Postgres staging | 23/11 04:20 → `sokar_staging-20261123T032001Z.dump` (d'après le journal) | « Sauvegarde vérifiée … (104 tables) ». Dossier `/var/backups/sokar-staging` illisible pour `deploy` | 14 jours                     |
| Offsite R2       | 23/11 04:00 (journal modifié à 04:00:05)                                 | « ✅ Backup offsite sokar terminé — bucket: 0.022GB », rotation terminée                             | 30 jours                     |

### 2.6 Watchdog (`/usr/local/sbin/sokar-watchdog`, cron `*/5 * * * *`, root)

- **Ce qu'il surveille :** API `http://127.0.0.1:4000/health` (CRITIQUE), dashboard `:3000` (CRITIQUE), Connect `:4002`
  (WARNING), `redis-cli ping` dans `infra-redis-1`, `pg_isready -U sokar` dans `infra-postgres-1`, présence d'un
  `sokar-*.dump` de moins de 26 h dans `/var/backups/sokar`, ligne de succès du journal R2 de moins de 26 h,
  disque `/` (80 % / 90 %), mémoire (90 %). **Il ne surveille pas staging.**
- **Alertes :** `notify()` (de `scripts/ops/logging.sh`) via `ALERT_WEBHOOK` et/ou `ALERT_CMD` ; cooldown 30 min par check ;
  message de rétablissement quand le check repasse au vert.
- **Heartbeat externe :** si **tous** les checks passent et que `HEALTHCHECKS_PING_URL` est défini, un `curl` le ping.
  Un seul check en échec = pas de ping (donc alerte Healthchecks si la panne dure plus que la période + grace).
- **Mode maintenance : non.** Aucune variable ni fichier drapeau. Seules options : suspendre le cron, ou accepter les alertes.
- Dernier passage lu : 23/11 10:15, `ALL_OK=1`. Dossier d'état : `/var/lib/sokar/watchdog` (illisible).
- **Check Healthchecks.io : `Suppernote production watchdog`** (déjà renommé dans l'interface Healthchecks), **période 5 min,
  grace 5 min** : sans ping, l'alerte part au bout de ≈ 10 min. La fenêtre dure 60 min : la **pause du check** à 14:50 (§3.2)
  reste donc indispensable (le script suspend le cron du watchdog pendant chaque `apply` ou `rollback`, donc plus aucun ping
  n'est envoyé). Le nom du check ne dépend pas du renommage du VPS ; l'URL de ping reste dans `watchdog.env` (non lue ici).

### 2.7 Crons actifs et collisions avec la fenêtre (heure locale CET ; fenêtre = 15h00–16h00)

| Tâche                            | Horaire CET (UTC)                          | Dans la fenêtre ?                                                      |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `sokar-watchdog` (root)          | toutes les 5 min (`*/5`)                   | **Oui : 12 passages. À suspendre.**                                    |
| `sokar-postgres-backup`          | 03:20 (02:20 UTC)                          | Non                                                                    |
| `sokar-r2-backup`                | 04:00 (03:00 UTC)                          | Non                                                                    |
| `sokar-staging-postgres-backup`  | 04:20 (03:20 UTC)                          | Non                                                                    |
| `logrotate.timer`                | 00:00                                      | Non                                                                    |
| `certbot.timer`                  | ≈ 23:33 (aléatoire, dernier passage 09:47) | Non (à re-vérifier le 24 au matin)                                     |
| `apt-daily.timer`                | aléatoire ; prochain le 23/11 à 14:52      | **Possible le 24/11** : tirage non prévisible, ne fait que télécharger |
| `apt-daily-upgrade.timer`        | ≈ 06:12 (aléatoire)                        | Non                                                                    |
| `sysstat-collect.timer`          | toutes les 10 min                          | Oui, inoffensif                                                        |
| GitHub `nightly-staging-journey` | 03:30 UTC = 04:30 CET                      | Non                                                                    |
| crontab root, crontab deploy     | root illisible ; deploy : aucune           | Root à vérifier au préflight root                                      |

Aucun backup n'est planifié entre 04:20 et 03:20, donc aucune collision avec 15h–16h hormis le watchdog.

### 2.8 Trafic réel (journaux pino, comptages uniquement, 14 jours de rotation)

- Requêtes API hors `/health` : plat, **3 800–5 000 par heure à toute heure** (bruit de fond, webhooks de relais, sondes).
- Appels vocaux finalisés (« call finalized », chaque ligne est journalisée en double) : 10/11 (2 appels), 19/11 (1),
  20/11 (6 : 12h17–12h18, **15h21–15h27**, 19h35), 22/11 (1, 17h23). Soit ≈ 10 appels en 14 jours, la plupart ressemblant aux
  tests de voix décrits dans le journal du 20 et 22/11.
- **15h–16h n'est pas prouvé creux** : 3 appels le 20/11 entre 15h21 et 15h27. Q1.

---

## 3. Runbook de la fenêtre (mardi 24/11/2026, 15h00–16h00 CET)

**Toutes les heures de cette section sont en heure de Paris** (fuseau du serveur ; le Mac de Hamza est en UTC+0, soit 1 h de
moins : 15h00 à Paris = 14h00 sur le Mac). **Tous les `apply` et `rollback` se lancent dans `tmux` sur le serveur** (§3.10) et,
après toute interruption, on suit §3.11 avant de toucher à autre chose.

Acteurs : **Hamza** (root, UI Healthchecks, GitHub, décision GO/NO-GO), **suppernote-dev** (script, PR),
**suppernote-ops** (vérifications lecture seule via `ssh deploy@sokar`, relevé de Sentry), **lead** (coordination).

### 3.0 Prérequis, avant le mardi 15h (aujourd'hui lundi 23/11 et mardi matin)

| #   | Qui          | Action                                                                                                                                                                                                                                                |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | dev          | **Livré** : `scripts/ops/rename-sokar-to-suppernote.sh` + tests dans la PR #795 (branche `chore/rename-sokar-suppernote-infra`, **non fusionnée**), avec les patchs repo (wrapper, watchdog, cron, logrotate, ecosystem, nginx, workflows, code H28). |
| P2  | Hamza        | Répondre aux questions du §5.2 (en particulier Q1, Q2, Q3, Q6).                                                                                                                                                                                       |
| P3  | Hamza (root) | **Préflight root** (§1.5) : `nginx -T`, `docker inspect`, sudoers, `/etc/sokar`, crontab root. Transmettre la sortie **masquée** (clés et chemins seulement) à ops.                                                                                   |
| P4  | dev + Hamza  | Copier le script **hors de `/opt/sokar`** dans `/root/rename/` avec contrôle d'empreinte (§3.10, étape 0) : un script lancé depuis un dossier qu'il déplace perd ses chemins relatifs, et `preflight` le refuse.                                      |
| P5  | Hamza (root) | `preflight --env all`, puis `apply --env all --dry-run`, puis `status --env all` (§3.10, étapes 1 à 3). Aucune modification attendue.                                                                                                                 |
| P6  | ops          | Relire les sorties P3 et P5 contre ce document, mettre à jour §1 et §5. **Pas de fenêtre si P3/P5 ne sont pas faits.**                                                                                                                                |
| P7  | Hamza        | Annonce (gabarit §3.8) aux restaurants concernés, si des restaurants sont en production réelle (Q1).                                                                                                                                                  |
| P8  | Hamza        | **Ne fusionner aucune PR** avant la fenêtre dont le déploiement toucherait nginx, cron ou scripts ops. PR #747 (draft, relais `api.sokar.tech`) ne doit pas être fusionnée avant le renommage.                                                        |

### 3.1 Gel des déploiements automatiques (point critique)

Déclencheurs actuels : `deploy-staging.yml` sur **tout push sur `main`**, `deploy-prod.yml` sur `workflow_run` de la CI
réussie sur `main` (et `workflow_dispatch`), `deploy-widget.yml` manuel (Cloudflare Pages, hors VPS),
`nightly-staging-journey.yml` à 03:30 UTC. Au 23/11 10:40 : **3 PR ouvertes, aucune en auto-merge** (#793
`feat/sentry-dashboard-connect`, #791 `fix/dead-letter-repeat-jobs`, #747 draft). L'état peut changer d'ici mardi.

À **T-60 (14:00), Hamza** :

```zsh
# 1. Aucune PR en auto-merge (liste vide attendue)
gh pr list --state open --json number,headRefName,autoMergeRequest \
  --jq '.[] | select(.autoMergeRequest != null) | "\(.number) \(.headRefName)"'
# Si une ligne apparaît : gh pr merge --disable-auto <numéro>

# 2. Désactiver les deux workflows de déploiement
gh workflow disable deploy-staging.yml
gh workflow disable deploy-prod.yml

# 3. Aucun run en cours
gh run list --status in_progress --limit 10
gh workflow list | grep -E 'Deploy (Staging|Production)'   # attendu : disabled
```

Pendant toute la fenêtre : aucun merge sur `main`. Les workflows ne sont **pas** réactivés à 16h : ils le sont
au moment du déploiement de validation (§3.9, étape 2).

### 3.2 Minutes et rôles

| Heure            | Qui          | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **14:00 (T-60)** | Hamza        | Gel des déploiements (§3.1).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **14:30 (T-30)** | Hamza (root) | Sauvegardes à froid : `sudo /usr/local/sbin/sokar-deploy-root backup-db prod` et `… backup-db staging` (autorisés par sudoers). Snapshot de config : `sudo tar -czf /root/pre-rename-20261124.tgz /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/snippets /etc/cron.d /etc/logrotate.d/sokar /etc/sokar /etc/sudoers.d /usr/local/sbin/sokar-* /home/deploy/.pm2/dump.pm2` puis `sudo chmod 600 /root/pre-rename-20261124.tgz` (contient des secrets). |
| 14:30            | ops          | Relevé de départ : `pm2 jlist` (8 online), `/health` prod et staging 200, nombre d'erreurs Sentry des 24 h.                                                                                                                                                                                                                                                                                                                                                            |
| **14:45 (T-15)** | Hamza        | Vérifier qu'aucun appel n'est en cours : `ssh deploy@sokar "grep -E 'call.initiated\|call finalized' /var/log/sokar/api-out.log \| tail -3"` (dernière ligne ancienne, pas de session ouverte).                                                                                                                                                                                                                                                                        |
| **14:50 (T-10)** | Hamza (UI)   | **Mettre en pause le check Healthchecks.io** (durée ≥ 90 min). Seule action côté UI.                                                                                                                                                                                                                                                                                                                                                                                   |
| 14:50            | Hamza (root) | **Ne PAS suspendre le cron du watchdog à la main** : le script le fait (il renomme `suppernote-watchdog` en `.rename-hold`, nom ignoré par cron, pendant chaque `apply` ou `rollback`, et le remet toujours en place, y compris en cas d'échec). Il reste actif entre le staging et la prod. Seule la pause Healthchecks.io (UI) reste manuelle.                                                                                                                       |
| 14:55            | Hamza (root) | **Ouvrir la session tmux** : `sudo tmux new -A -s rename` (§3.10), puis y rester pour tout `apply`/`rollback`. Heure de Paris : contrôler `date` sur le serveur.                                                                                                                                                                                                                                                                                                       |
| 14:55            | lead         | Message d'ouverture de fenêtre (gabarit §3.8).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **15:00 (T0)**   | Hamza        | **Contrôle GO d'entrée** : P3/P5 faits, sauvegardes du T-30 présentes, workflows désactivés, watchdog suspendu, Healthchecks (`Suppernote production watchdog`) en pause, session tmux `rename` ouverte, aucun appel en cours, dev et ops joignables. Un « non » = report.                                                                                                                                                                                             |
| 15:00–15:12      | Hamza (root) | **Staging** : `sudo bash /root/rename/rename-sokar-to-suppernote.sh apply --env staging` (§3.10, étape 4). Le script fait lui-même `pm2 save` ; code de sortie 0 attendu.                                                                                                                                                                                                                                                                                              |
| 15:12–15:22      | ops + Hamza  | **Validation staging** : checklist §4 version staging, critères GO/NO-GO §3.3.                                                                                                                                                                                                                                                                                                                                                                                         |
| **15:22**        | Hamza        | **Décision GO/NO-GO prod.** NO-GO = fin de fenêtre (ou retour arrière staging si non réparable en 10 min), prod intacte.                                                                                                                                                                                                                                                                                                                                               |
| 15:22–15:32      | Hamza (root) | **Prod** : `sudo bash /root/rename/rename-sokar-to-suppernote.sh apply --env prod` (§3.10, étape 6). Le script fait lui-même `pm2 save`. **Coupure prod ciblée < 2 min, plafond 10 min** (§3.4).                                                                                                                                                                                                                                                                       |
| 15:32–15:45      | ops + Hamza  | **Validation prod** : checklist §4 (health, domaines, webhooks, nginx -t, pm2, logs).                                                                                                                                                                                                                                                                                                                                                                                  |
| 15:45            | Hamza (root) | Le cron watchdog est déjà remis par le script (`suppernote-watchdog`, un seul exemplaire : `ls /etc/cron.d`). Lancer le watchdog une fois à la main (`sudo /usr/local/sbin/suppernote-watchdog`), **reprendre le check Healthchecks** (UI) et attendre le ping.                                                                                                                                                                                                        |
| 15:50            | Hamza + ops  | Backups lancés une fois (§4, lignes 13–14) si le temps le permet, sinon à 17:00 après la fenêtre (les prochains automatiques sont à 03:20 / 04:00 / 04:20).                                                                                                                                                                                                                                                                                                            |
| **16:00**        | lead         | Message de clôture. **Workflows toujours désactivés** tant que §3.9 n'est pas fait.                                                                                                                                                                                                                                                                                                                                                                                    |

### 3.3 Critères GO / NO-GO entre staging et prod

**GO prod** uniquement si **tout** est vrai (relevé par ops, validé par Hamza) :

1. `pm2 list` : 4 process `suppernote-staging-*` en `online`, 0 redémarrage supplémentaire après 3 min ; les 4 process prod `sokar-*` **toujours online et non touchés**.
2. `curl https://api-staging.suppernote.com/health` → 200 et `/livez` → 200 ; `https://staging.suppernote.com/` → 200.
3. `sudo nginx -t` → `syntax is ok` et `test is successful` ; rechargement fait (`reload`, pas `restart`).
4. `nightly-staging-journey` lancé à la main (`gh workflow run nightly-staging-journey.yml`) → vert (parcours santé, disponibilités, facturation, MCP, pages publiques).
5. Journaux staging écrits dans `/var/log/suppernote/staging-*.log` avec un horodatage de moins d'une minute.
6. Aucun nouveau groupe d'erreurs Sentry (staging) depuis T0, hors erreurs de connexion pendant les secondes de redémarrage.
7. Les liens de compatibilité staging sont présents et la prod n'a **pas** été touchée (`ls -l /opt/` : `sokar` reste un dossier).
8. Durée mesurée de la coupure staging ≤ 3 min (référence pour le plafond prod).

**NO-GO** si un seul est faux et n'est pas corrigeable en moins de 10 minutes ; on ne passe jamais à la prod « en espérant ».

### 3.4 Durée maximale de coupure prod et seuil de retour arrière

- **Cible : < 2 min** (4 process × ≈ 4 s de redémarrage PM2 + reload nginx sans coupure ; le reste est du `mv` atomique
  sur le même filesystem). **Plafond accepté : 10 min** de coupure totale, qui ne doit jamais empiéter sur un service
  (midi, soir, week-end ; mardi 15h00–16h00 est hors service sous réserve de Q1).
- **Point de décision à T_prod + 5 min** : si `https://api.suppernote.com/health` ne répond pas 200, ou si un des
  4 process prod n'est pas `online`, ou si `nginx -t` échoue → **retour arrière immédiat** (§3.5). Pas d'attente jusqu'à 10 min
  pour « voir ».
- Autres déclencheurs de retour arrière prod : 5xx persistants sur `/voice/telnyx` ou `/webhooks/stripe` plus de 2 min
  après la remise en ligne ; redémarrages en boucle PM2 (`restarts` qui augmente après T+3 min) ; tout comportement
  inattendu du watchdog après reprise.
- La coupure se mesure du premier `pm2 delete` prod jusqu'au premier `200` sur `https://api.suppernote.com/health`.

### 3.5 Rollback pas à pas

> **Après une coupure ou un kill pendant `apply` (SSH tombé, SIGHUP/SIGTERM) : aller d'abord au §3.11** (`status`, puis
> `rollback --env <env>`). Ne jamais relancer `apply` directement.

Principe : toutes les modifications étant des `mv`, `ln -s`, `sed` et recréations de process, le retour arrière
inverse l'ordre. Les anciens chemins existent encore via les liens, donc la prod peut être rendue avant d'avoir
tout défait.

**Option A (préférée) :** `sudo bash /root/rename/rename-sokar-to-suppernote.sh rollback --env <staging|prod|all>`
(§3.10, étape 8), puis checklist §4 adaptée aux anciens noms. Le retour arrière est piloté par l'état réel
des fichiers : il reprend un `apply` interrompu et peut être relancé sans effet. Il redémarre les anciens
process PM2 depuis l'ecosystem d'origine sauvegardé dans le journal, puis fait `pm2 save`. Il défait le
PARTAGÉ (dossiers, snippets, sbin, logrotate, sudoers) seulement quand le dernier environnement revient en arrière.

**Option B, manuelle (si le script ne répond pas).** Pour un environnement `E` (prod : `sokar` ; staging : `sokar-staging`) :

1. **Process** (en tant que `deploy`) : `pm2 delete suppernote-<…>` pour les process de l'environnement, puis
   `pm2 start` depuis l'**ancien** ecosystem (`/opt/sokar/infra/ecosystem.config.js` ou `ecosystem.staging.config.js`,
   versions du serveur non modifiées), puis `pm2 save`. Un reboot ressusciterait sinon les noms `suppernote-*` depuis `dump.pm2`
   (sauvegarde disponible dans `/root/pre-rename-20261124.tgz`).
2. **nginx** (root) : restaurer `sites-available/sokar*`, `sites-enabled/sokar-staging` et `snippets/sokar-*.conf` depuis le
   tar du T-30 ; supprimer les fichiers `suppernote-*` correspondants (sinon doublons) ; `sudo nginx -t && sudo systemctl reload nginx`.
3. **cron.d, logrotate, sbin** (root) : remettre `sokar-*` depuis le tar, supprimer les `suppernote-*` (aucun doublon) ;
   rétablir le watchdog en dernier.
4. **Dossiers** (root) : supprimer les liens de compatibilité puis `mv /opt/suppernote /opt/sokar`, idem
   `/opt/suppernote-staging`, `/var/log/suppernote`, `/var/backups/suppernote{,-staging}`, `/var/lib/suppernote`,
   `/etc/suppernote`. **Pour chaque dossier : supprimer le lien d'abord, `mv` ensuite** (jamais l'inverse, `mv` vers un
   lien existant déplacerait le dossier à l'intérieur de la cible).
5. **sudoers** : restaurer `/etc/sudoers.d/deploy` d'origine ; `sudo visudo -c`.
6. **Vérifier** : §4 lignes pm2, health, nginx, domaines ; `ls /etc/cron.d | grep -c sokar` = 4 ; aucun `suppernote-*` restant
   dans `/etc/cron.d`, `/etc/logrotate.d`, `/etc/nginx`.
7. Réactiver le watchdog (ancien nom), reprendre Healthchecks, **laisser les workflows désactivés** jusqu'à décision.
8. Post-mortem court dans `docs/` (symptôme → cause → correctif) comme pour tout incident.

Les données (bases, Redis, buckets) ne sont pas modifiées par le renommage : **aucun rollback de base de données n'est nécessaire**
(`--with-db-rollback` n'a pas de raison d'être utilisé).

### 3.6 Ordre à l'intérieur de chaque environnement (implémenté par le script)

1. Préflight automatique (script hors `/opt`, espace disque, même filesystem, aucun conflit de cible, `nginx -t`,
   `visudo -cf`, pm2 via `sudo -u deploy`, aucun déploiement en cours, mounts docker listés, références hors table
   signalées). Un échec = code 3 et **rien n'est modifié**.
2. Sauvegarde de l'ecosystem d'origine ; suspension du cron watchdog (`.rename-hold`).
3. `pm2 stop` des seuls process de l'environnement ciblé (`sudo -u deploy`).
4. `mv` des dossiers (partagés `/etc`, `/var/log`, `/var/lib` à la première exécution, puis ceux de l'environnement), chacun immédiatement suivi du `ln -s` de compatibilité ; puis `mv` des fichiers système (sbin, cron, logrotate, snippets nginx, site nginx available + enabled) : **déplacés, jamais copiés**.
5. Patch borné des fichiers (`sed` limité aux chaînes de la table, jamais de `sed` global ; chaque fichier sauvegardé dans le journal avant écriture) et ligne sudoers `suppernote-deploy-root` ajoutée à côté de l'ancienne (`visudo -cf` avant installation).
6. `nginx -t` puis `systemctl reload nginx` (jamais `restart`). Si `nginx -t` échoue : **retour arrière automatique** de l'environnement, code 4.
7. `pm2 delete` des anciens noms, `pm2 start` des nouveaux depuis l'ecosystem du dossier renommé (transformé en fichier temporaire si c'est encore l'ancienne version), `pm2 save`.
8. Remise du cron watchdog sous le nom correspondant, vérifications finales (pm2 online, `/health`, dashboard, connect, nginx local) et résumé. Échec de vérification = code 5, **pas de retour arrière automatique** : décision humaine (§3.4).
9. Journal : `/root/rename-suppernote-<horodatage>/` (`run.log`, `manifest.tsv`, `backup/`, `ecosystem-orig/`), mode 0700.

Les retours arrière automatiques ne couvrent que les étapes 1 à 7 (avant que le trafic ne passe par les nouveaux process) ; une erreur inattendue y déclenche aussi un retour arrière (code 6).

### 3.7 Garanties du script (vérifiées par `scripts/ops/test-rename-sokar-to-suppernote.sh`)

- Idempotence : relancer `apply` ne change rien (arborescence, pm2, reload nginx) ; `rollback` aussi.
- `--dry-run` n'écrit rien (ni journal, ni sauvegarde, ni `pm2`, ni reload) et affiche chaque commande.
- Aucun `install` sur un lien de compatibilité ; le wrapper installé cible `suppernote-deploy-root` (H08).
- Un seul exemplaire de chaque cron et logrotate (déplacés, pas copiés) ; watchdog jamais laissé désactivé (trap EXIT).
- `sudoers` : ancienne ligne conservée avec la nouvelle, `visudo -cf` avant installation, restauration sinon.
- Exécution refusée depuis `/opt/sokar*` et refusée si non root.
- Aucune lecture ni impression de secrets : `.env`, `watchdog.env`, `grafana.env` ne sont jamais ouverts.
- Ne touche pas aux bases, rôles, buckets, remote rclone, variables d'environnement, hostname, `chez-sokar-demo`, jobs Prometheus, domaines `sokar.tech`, upstreams `sokar_*`, dumps `sokar-*.dump`, projet Docker `sokar-monitoring`.
- Prod intacte (octet pour octet) tant que `--env prod` n'a pas tourné ; `nginx -t` reste vert grâce aux liens de compatibilité des snippets (`sokar-*.conf` → `suppernote-*.conf`), retirés dès que plus aucun site ne les référence.
- Le script ne recrée aucun conteneur (H22–H24) et ne lance jamais `cleanup-compat`.

### 3.8 Communication

Gabarit d'annonce (à envoyer par Hamza à T-24 h aux restaurants utilisant la prod en réel, s'il y en a) :

> Bonjour, nous réalisons une opération de maintenance technique sur Suppernote demain, mardi 24 novembre, entre 15h et 16h.
> Vous pouvez constater une brève interruption (quelques minutes au plus) de la prise d'appels et du tableau de bord. Aucune
> donnée n'est modifiée. Nous vous confirmons la fin de l'opération dès qu'elle est terminée. L'équipe Suppernote

Messages internes : ouverture (14:55) « Fenêtre ouverte, déploiements gelés, watchdog et Healthchecks suspendus » ; décision
GO/NO-GO (15:22) ; fin (16:00) « Renommage terminé / retour arrière effectué ; workflows toujours gelés ». En cas de retour
arrière : un message à Hamza avec la cause, l'état actuel et la prochaine action, sans attendre le post-mortem.

### 3.9 Après la fenêtre : remise en service des déploiements et retrait de la compatibilité

1. Hamza décide (Q6) de l'ordre : **la PR dev ne se fusionne qu'après un renommage validé en prod**.
2. Hamza réactive les workflows (`gh workflow enable deploy-staging.yml` puis `deploy-prod.yml`), puis fusionne la PR dev
   (ou la merge-queue) **hors service**, c'est-à-dire avant 18h30 ou le lendemain 14h (Q13). Le déploiement attendu enchaîne
   staging, smoke tests, prod, smoke tests, puis ops vérifie la checklist §4 ligne 22.
3. **`cleanup-compat` (retrait des liens `sokar → suppernote`) uniquement si** : (a) au moins un déploiement complet
   staging **et** prod s'est terminé avec les nouveaux chemins ; (b) plus aucune release ni build antérieur à ce déploiement
   n'est nécessaire au rollback (les releases actuelles contiennent des chemins absolus, H18), ou la perte de ces rollbacks
   est acceptée explicitement ; (c) H19 et H28 sont corrigés ; (d) `grep -rn 'sokar' /etc/nginx/sites-*` ne trouve plus que
   des domaines `sokar.tech` et des noms d'`upstream` ; (e) délai minimal suggéré : 14 jours (Q10).

---

### 3.10 Commandes exactes à copier-coller (Hamza)

Toutes les commandes `rename-sokar-to-suppernote.sh` se lancent **en root, depuis `/root/rename/`**
(jamais depuis `/opt/sokar*`). Chaque commande accepte `--dry-run` (rien n'est écrit).

**Règle : `apply` et `rollback` se lancent TOUJOURS dans `tmux` sur le serveur, jamais directement dans la session SSH.**
Une coupure SSH envoie SIGHUP au script, qui s'arrête au milieu de l'`apply` (§3.11) ; sous `tmux`, le script continue sans toi.

```zsh
# Sur le VPS. Crée la session « rename » ou s'y rattache si elle existe déjà :
sudo tmux new -A -s rename
# Dans la session (déjà root) : lancer les commandes ci-dessous (le « sudo » devant reste valable) ;
# détacher sans arrêter : Ctrl-b puis d.
# Après une coupure de connexion : se reconnecter en SSH, puis REFAIRE EXACTEMENT la même commande :
sudo tmux new -A -s rename
```

`tmux` doit être installé (`command -v tmux`) : le vérifier au P5 (avant mardi) et l'installer **hors fenêtre** si absent.
Lancer aussi un `date` dans la session : l'heure du serveur est l'heure de Paris, pas celle du Mac.

**Étape 0, avant mardi : copier le script avec contrôle d'empreinte** (PR #795 relue, non fusionnée) :

```zsh
# Sur le Mac, dans le dépôt :
git fetch origin chore/rename-sokar-suppernote-infra
git show origin/chore/rename-sokar-suppernote-infra:scripts/ops/rename-sokar-to-suppernote.sh > /tmp/rename-sokar-to-suppernote.sh
shasum -a 256 /tmp/rename-sokar-to-suppernote.sh          # noter l'empreinte
scp /tmp/rename-sokar-to-suppernote.sh deploy@sokar:/tmp/

# Sur le VPS :
sha256sum /tmp/rename-sokar-to-suppernote.sh              # doit être identique à celle du Mac
sudo install -d -m 0700 /root/rename
sudo install -m 0700 /tmp/rename-sokar-to-suppernote.sh /root/rename/ && rm /tmp/rename-sokar-to-suppernote.sh
```

**Étapes 1 à 3, avant mardi (lecture seule) :**

```zsh
sudo bash /root/rename/rename-sokar-to-suppernote.sh preflight --env all
sudo bash /root/rename/rename-sokar-to-suppernote.sh apply --env all --dry-run
sudo bash /root/rename/rename-sokar-to-suppernote.sh status --env all     # tout doit être « ANCIEN (à renommer) »
```

Transmettre à ops les lignes `ATTENTION` du préflight (fichiers hors table, conteneurs) : elles complètent §1.2 et §5.1.

**Répétition staging seul avant mardi (demande Hamza du 23/11).** `apply --env staging` renomme aussi le PARTAGÉ (watchdog, snippets, `/etc`, `/var/log`, `/var/lib`, wrapper, logrotate, sudoers) mais laisse la prod entièrement sous ses anciens noms (liens de compatibilité, snippets `sokar-*.conf` gardés en lien tant que le site prod les référence). Pré-requis impératifs : `gh workflow disable deploy-staging.yml` ET `deploy-prod.yml` (un déploiement avec le dépôt non renommé recréerait `sokar-staging-*` en doublon et casserait `nginx -t`), aucune PR en auto-merge, PR #795 non fusionnée. Commandes :

```zsh
sudo bash /root/rename/rename-sokar-to-suppernote.sh apply --env staging --dry-run   # relire le plan
sudo bash /root/rename/rename-sokar-to-suppernote.sh apply --env staging
sudo bash /root/rename/rename-sokar-to-suppernote.sh status --env all                # staging NOUVEAU, prod ANCIEN
# Pour tout remettre comme avant (staging seul renommé : défait aussi le partagé) :
sudo bash /root/rename/rename-sokar-to-suppernote.sh rollback --env staging
```

Tant que la répétition n'est pas défaite ou que la prod n'est pas renommée, les workflows de déploiement restent désactivés.

**Étape 4, 15:00 : staging.** Code de sortie 0 attendu ; le script affiche les vérifications et un résumé :

```zsh
sudo bash /root/rename/rename-sokar-to-suppernote.sh apply --env staging
echo "code de sortie : $?"
```

**Étape 5, 15:12–15:22 : validation staging** (puis checklist §4 et critères GO/NO-GO §3.3) :

```zsh
sudo bash /root/rename/rename-sokar-to-suppernote.sh status --env all
# attendu : staging « NOUVEAU + lien de compatibilité », prod « ANCIEN (à renommer) », nginx -t : OK,
# cron watchdog : 1 fichier (suppernote-watchdog), « verdict prod : état initial »
sudo nginx -t
sudo ls /etc/cron.d | grep -c watchdog                                    # 1
curl -s -o /dev/null -w '%{http_code}\n' https://api-staging.suppernote.com/health   # 200
curl -s -o /dev/null -w '%{http_code}\n' https://api.suppernote.com/health           # 200 (prod, encore aux anciens noms)
sudo -u deploy pm2 list                                                   # 4 suppernote-staging-* + 4 sokar-* online
```

**Étape 6, 15:22 si GO : prod.** Coupure ciblée < 2 min (pm2 stop → renommage → reload nginx → pm2 start) :

```zsh
sudo bash /root/rename/rename-sokar-to-suppernote.sh apply --env prod
echo "code de sortie : $?"
```

**Étape 7, 15:32 : validation prod** (checklist §4) :

```zsh
sudo bash /root/rename/rename-sokar-to-suppernote.sh status --env all    # verdicts « RENOMMÉ » pour prod et staging
sudo -u deploy pm2 list                                                  # 8 suppernote-* online, plus aucun sokar-*
sudo nginx -t
sudo ls /etc/cron.d                                                      # 4 fichiers suppernote-*, aucun sokar-*
```

**Étape 8 : retour arrière** (seuil : API prod pas en 200 à T+5 min, process pas online, `nginx -t` KO : §3.4).
Idempotent, utilisable après un `apply` interrompu :

```zsh
sudo bash /root/rename/rename-sokar-to-suppernote.sh rollback --env prod      # prod seule (staging et partagé restent renommés)
sudo bash /root/rename/rename-sokar-to-suppernote.sh rollback --env staging
sudo bash /root/rename/rename-sokar-to-suppernote.sh rollback --env all       # prod puis staging : état initial complet
```

**Étape 9, au plus tôt le 30/11/2026 et seulement si les conditions du §3.9 sont réunies** (déploiement complet
avec les nouveaux chemins, plus de rollback vers les anciennes releases, H19/H28 corrigés). Toujours en `--dry-run` d'abord :

```zsh
sudo bash /root/rename/rename-sokar-to-suppernote.sh cleanup-compat --env all --dry-run
sudo bash /root/rename/rename-sokar-to-suppernote.sh cleanup-compat --env all
# Facultatif, après décision Q9 : corrige aussi le préfixe de DEBUG_LOG_PATH dans apps/api/.env (valeur jamais affichée)
sudo bash /root/rename/rename-sokar-to-suppernote.sh cleanup-compat --env all --patch-debug-log-path
```

`cleanup-compat` refuse avant le 30/11 (`--force` pour passer outre), tant qu'un fichier système, un script appelé par cron,
`dump.pm2` ou un process pm2 référence encore un ancien chemin, et ne retire les liens et l'ancienne ligne sudoers
partagés que lorsque les deux environnements sont nettoyés. `apply` ne le lance jamais.

**Codes de sortie et conduite à tenir :**

| Code | Signification                                                                    | Action                                                                                 |
| ---- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 0    | Terminé, vérifications OK                                                        | Poursuivre                                                                             |
| 1    | Usage ou refus (`cleanup-compat` avant le 30/11, verrou déjà pris)               | Corriger la commande                                                                   |
| 2    | Pas root                                                                         | Relancer avec `sudo`                                                                   |
| 3    | Préflight en échec : **rien n'a été modifié**                                    | Lire les lignes `ÉCHEC`, corriger, relancer                                            |
| 4    | `nginx -t` a échoué après modification : **retour arrière automatique fait**     | Lire l'erreur nginx, NO-GO ou correction ; l'environnement est revenu à l'état initial |
| 5    | `apply` fait, mais une vérification (pm2, `/health`) est en échec                | Décision du §3.4 : corriger en moins de 5 min, sinon `rollback --env <env>`            |
| 6    | Erreur inattendue (retour arrière automatique tenté) ou retour arrière incomplet | Lire `run.log`, lancer `status`, puis `rollback`, sinon l'option B manuelle du §3.5    |

**Interruption (pas de code utile : connexion coupée, ou code 129 = SIGHUP / 143 = SIGTERM / 130 = Ctrl-C)** : le script s'arrête
là où il est, **sans retour arrière automatique** (seuls le cron watchdog et le verrou sont remis en place). Procédure : **§3.11**.

Journal de chaque exécution : `/root/rename-suppernote-<horodatage>/` (`run.log`, `manifest.tsv`, `backup/`, `ecosystem-orig/`).
Il ne contient aucun secret ; le dossier est en mode 0700. Le transmettre à ops en cas d'incident.

### 3.11 Après une interruption de `apply` ou de `rollback` (coupure SSH, kill, SIGHUP/SIGTERM)

**Décision pour Hamza : après toute interruption d'`apply`, on ne relance JAMAIS `apply` directement. On fait `status`,
puis `rollback --env <env>`, on vérifie, et seulement ensuite on décide d'un nouvel `apply` (ou d'un report si la fenêtre est
dépassée).**

**Pourquoi.** Si le script est tué entre `pm2 delete` et `pm2 start` d'un environnement, les 4 process PM2 de cet
environnement sont `stopped` ou absents : **l'API de cet environnement est coupée** et rien ne les relance. Le script n'a pas de
retour arrière automatique pour un signal (SIGHUP/SIGTERM) : il remet seulement le cron watchdog et supprime son verrou. Un
nouvel `apply` est refusé par le préflight (code 3, état partiel). Si c'est la **prod**, la coupure court tant qu'on n'a pas
fait le `rollback` : appliquer le seuil du §3.4 (pas d'attente « pour voir »).

**Procédure** (heures de Paris ; dans la session `tmux`, en root) :

1. **Se reconnecter et rouvrir la session** : `ssh deploy@sokar`, puis `sudo tmux new -A -s rename`. Si l'écran montre que le
   script tourne encore ou s'est terminé normalement (la coupure n'a touché que la connexion), **ne rien relancer** : le laisser
   finir et lire son code de sortie. Si la session n'existe plus (`tmux` tué avec le serveur ou avec le script), passer à l'étape 2.
2. **Constater l'état** (lecture seule, sans verrou ; remplacer `<env>` par `staging` ou `prod`) :

   ```zsh
   sudo bash /root/rename/rename-sokar-to-suppernote.sh status --env <env>
   ```

   Lire : les lignes `pm2 <env> :` (process `stopped` ou absents, ou anciens **et** nouveaux noms mélangés), `cron watchdog`
   (`SUSPENDU` : le `rollback` le remet), `nginx -t`, `verdict <env>`. En cas de doute, `sudo -u deploy pm2 list`.

3. **Retour arrière** (idempotent ; il reprend un `apply` interrompu et redémarre les anciens process depuis l'ecosystem sauvegardé
   dans le journal de l'`apply` interrompu : **ne pas supprimer `/root/rename-suppernote-*`**). Code 0 attendu ; sinon voir le
   tableau des codes (§3.10) et, pour le code 6, l'option B manuelle du §3.5 :

   ```zsh
   sudo bash /root/rename/rename-sokar-to-suppernote.sh rollback --env <env>
   echo "code de sortie : $?"
   ```

   Si un message dit qu'une autre exécution est en cours (verrou, pid vivant), un `apply` tourne encore : revenir à l'étape 1.
   Un verrou dont le pid n'existe plus est repris automatiquement.

4. **Vérifier** : `sudo bash /root/rename/rename-sokar-to-suppernote.sh status --env all` (verdict `<env>` : état initial),
   `sudo -u deploy pm2 list` (4 process anciens de l'environnement `online`),
   `curl -s -o /dev/null -w '%{http_code}\n' https://api.suppernote.com/health` (prod) ou
   `https://api-staging.suppernote.com/health` (staging) = 200, `sudo nginx -t`, `sudo ls /etc/cron.d | grep -c watchdog` = 1
   (aucun `.rename-hold`).
5. **Ensuite seulement**, décision : relancer `apply --env <env>` (dans `tmux`) si la fenêtre le permet (marge jusqu'à 16:00 heure de
   Paris) et que la cause de l'interruption est comprise ; sinon **report**, environnement laissé à l'état initial, workflows
   toujours désactivés. Prévenir ops et le lead, et leur transmettre le dossier `/root/rename-suppernote-<horodatage>/`.

## 4. Checklist post-renommage

À exécuter depuis le Mac (`ssh deploy@sokar` sauf mention « root » = Hamza). **Résultats attendus** entre crochets. Les valeurs
publiques « avant » ont été mesurées le 23/11 à 10:40 (aucun POST, GET seulement).

| #   | Contrôle                                                               | Commande                                                                                                                                                                                                                                                                        | Résultat attendu                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | PM2 : 8 online, noms `suppernote-*`                                    | `ssh deploy@sokar 'pm2 list'`                                                                                                                                                                                                                                                   | 8 lignes `online` : `suppernote-{api,workers,dashboard,connect}` et `suppernote-staging-*` ; aucun `sokar-*` ; compteur de redémarrages ≈ 0                                                                 |
| 2   | `pm2 save` pris en compte                                              | `ssh deploy@sokar 'grep -c "/opt/sokar" ~/.pm2/dump.pm2; grep -o "suppernote-[a-z-]*" ~/.pm2/dump.pm2 \| sort -u'`                                                                                                                                                              | `0` occurrence de l'ancien chemin ; 8 noms `suppernote-*`                                                                                                                                                   |
| 3   | `/health` et `/livez`, prod et staging                                 | `for u in https://api.suppernote.com/health https://api.suppernote.com/livez https://api-staging.suppernote.com/health https://api-staging.suppernote.com/livez; do curl -s -o /dev/null -w "$u %{http_code}\n" $u; done`                                                       | 4 × `200` (avant : 200, 200, 200, 200)                                                                                                                                                                      |
| 4   | Smoke tests existants prod                                             | Reproduire le job `smoke-tests` de `deploy-prod.yml:154-215` : `/public/widget/chez-suppernote-demo` et `…/chez-sokar-demo` → 200, `/health` 200, `/livez` 200, `POST /reservations` sans jeton → **401**, `/dashboard` → 200 ou 302 (307 vers `/login` aujourd'hui), `/` → 200 | Identique à l'avant ; le slug `chez-sokar-demo` répond toujours 200 (alias de lecture)                                                                                                                      |
| 5   | Parcours staging                                                       | `gh workflow run nightly-staging-journey.yml` puis `gh run watch`                                                                                                                                                                                                               | Vert (santé, disponibilités, facturation, MCP, pages publiques)                                                                                                                                             |
| 6   | nginx                                                                  | root : `sudo nginx -t` ; `sudo nginx -T \| grep -n -c 'snippets/sokar-'` ; `ls -l /etc/nginx/sites-enabled/` ; `sudo systemctl status nginx --no-pager \| head -5`                                                                                                              | `syntax is ok` / `test is successful` ; `0` ; uniquement `suppernote` et `suppernote-staging` (liens ou fichiers cohérents, aucun `sokar*`) ; `active (running)`                                            |
| 7   | Domaines publics                                                       | `for u in https://suppernote.com/ https://api.suppernote.com/health https://staging.suppernote.com/ https://api-staging.suppernote.com/health; do curl -s -o /dev/null -w "$u %{http_code}\n" $u; done`                                                                         | 200 partout (avant : 200, 200, 200, 200)                                                                                                                                                                    |
| 8   | Redirections legacy conservées                                         | `curl -sI https://sokar.tech/ \| head -1 ; curl -sI https://api.sokar.tech/health \| head -1`                                                                                                                                                                                   | `301` vers `suppernote.com/` et `308` vers `api.suppernote.com/health`                                                                                                                                      |
| 9   | Webhooks Telnyx entrants (sans POST)                                   | `curl -s -o /dev/null -w "%{http_code}\n" https://api.suppernote.com/voice/telnyx` ; puis `ssh deploy@sokar 'tail -n 20 /var/log/suppernote/api-out.log \| grep -c "voice/telnyx"'`                                                                                             | `404` en GET (avant : 404, la route n'accepte que POST). Le premier vrai webhook Telnyx (ou l'appel test, ligne 11) doit apparaître dans le journal sans 5xx                                                |
| 10  | Widget                                                                 | `curl -sL -o /dev/null -w "%{http_code}\n" https://widget.suppernote.com/restaurant-reservation.html`                                                                                                                                                                           | **Aujourd'hui `404` avant tout renommage** (hébergé sur Cloudflare Pages, indépendant du VPS) : ne pas le compter comme régression ; Q14 le signale                                                         |
| 11  | **Appel vocal de test** (à ne **pas** déclencher sans accord de Hamza) | Hamza appelle le numéro de démonstration ; ensuite `ssh deploy@sokar 'grep -E "call finalized\|Answering call" /var/log/suppernote/api-out.log \| tail -3'`                                                                                                                     | Appel décroché, accueil entendu, ligne « call finalized » horodatée de l'appel                                                                                                                              |
| 12  | Watchdog exécuté une fois                                              | root : `sudo /usr/local/sbin/suppernote-watchdog ; echo "exit=$?"` ; `tail -n 3 /var/log/suppernote/watchdog.log` ; UI Healthchecks                                                                                                                                             | `fin des checks (ALL_OK=1)`, aucune alerte ; ping visible dans l'UI Healthchecks dans la minute ; `notify` disponible (pas de `command not found`)                                                          |
| 13  | Backup Postgres prod et staging (**une seule fois**)                   | root : `sudo /usr/local/sbin/suppernote-backup-postgres` ; `sudo /usr/local/sbin/suppernote-staging-backup-postgres` ; `sudo ls -lt /var/backups/suppernote /var/backups/suppernote-staging \| head`                                                                            | « Sauvegarde vérifiée … (104 tables) » ; fichiers **`sokar-<ts>.dump`** et **`sokar_staging-<ts>.dump`** (le préfixe `sokar` est le nom de la base, normal) dans les nouveaux dossiers                      |
| 14  | Backup R2 (**une seule fois**)                                         | root : `sudo RCLONE_CONFIG=/home/deploy/.config/rclone/rclone.conf /opt/suppernote/scripts/database/backup-postgres-r2.sh` ; `tail -n 2 /var/log/suppernote/postgres-r2-backup.log`                                                                                             | `✅ Backup offsite sokar terminé — bucket: …GB` (la chaîne contient `sokar` : c'est attendu, le watchdog la cherche)                                                                                        |
| 15  | logrotate                                                              | root : `sudo logrotate -d /etc/logrotate.d/suppernote 2>&1 \| tail -15` ; `ls /etc/logrotate.d \| grep -c sokar`                                                                                                                                                                | `considering log /var/log/suppernote/*.log`, aucune ligne `error` ni `duplicate log entry` ; `0` fichier `sokar` restant                                                                                    |
| 16  | cron.d : un seul exemplaire de chaque                                  | `ls /etc/cron.d \| grep -E 'sokar\|suppernote'` ; `grep -rn sokar /etc/cron.d`                                                                                                                                                                                                  | Exactement 4 : `suppernote-{watchdog,postgres-backup,r2-backup,staging-postgres-backup}` ; 0 `sokar-*` ; aucune ligne `sokar` hors commentaires éventuels                                                   |
| 17  | Journaux écrits dans le nouveau dossier                                | `ssh deploy@sokar 'ls -lt /var/log/suppernote \| head -6 ; date ; ls -ld /var/log/sokar'`                                                                                                                                                                                       | Fichiers modifiés dans la dernière minute (`api-out.log`, `watchdog.log` après passage) ; `/var/log/sokar` est un lien (`lrwxrwxrwx`)                                                                       |
| 18  | Liens de compatibilité et sudoers                                      | `ssh deploy@sokar 'ls -ld /opt/sokar /opt/sokar-staging /var/log/sokar /var/lib/sokar /usr/local/sbin/sokar-deploy-root'` ; `ssh deploy@sokar 'sudo -n /usr/local/sbin/suppernote-deploy-root check-prod-vhost prod; echo exit=$?'` et la même commande via `sokar-deploy-root` | Tous des liens `->` vers `suppernote*` ; `exit=0` par les deux chemins (valide sudoers + wrapper sans effet de bord)                                                                                        |
| 19  | Prometheus                                                             | `ssh deploy@sokar 'curl -s http://127.0.0.1:9090/api/v1/targets \| python3 -c "import sys,json; d=json.load(sys.stdin); print([(t[\"labels\"][\"job\"], t[\"health\"]) for t in d[\"data\"][\"activeTargets\"]])"'`                                                             | Jobs `sokar-api`, `sokar-workers`, `sokar-staging-api`, `sokar-staging-workers` (noms inchangés) tous `up`                                                                                                  |
| 20  | Conteneurs (si recréation Prometheus/Grafana)                          | root : `sudo docker ps --format '{{.Names}} {{.Status}}'`                                                                                                                                                                                                                       | `infra-postgres-1`, `infra-redis-1`, redis-staging, `infra-localstack-1`, `sokar-prometheus`, `sokar-grafana` tous `Up` ; Postgres et Redis **non redémarrés** (uptime ≥ celui du 23/11)                    |
| 21  | Sentry                                                                 | ops : `search_issues` projets API, dashboard, connect, environnements prod et staging, `firstSeen` ≥ 24/11 15:00                                                                                                                                                                | Aucun nouveau groupe, hormis des erreurs de connexion datées des secondes de redémarrage ; 0 erreur liée à un chemin (`ENOENT /opt/sokar`)                                                                  |
| 22  | **Déploiement automatique complet** (après fusion de la PR dev)        | Réactiver les workflows, fusionner la PR hors service (§3.9), puis `gh run watch` sur `deploy-staging` puis `deploy-prod`                                                                                                                                                       | Staging puis prod verts, smoke tests verts, **aucun** fichier `sokar-*` recréé dans `/etc/cron.d`, `/etc/logrotate.d`, `/etc/nginx/sites-*`, `/usr/local/sbin` ; nginx `-t` OK ; `watchdog.env` toujours lu |

Si les lignes 1, 3, 6, 7 ou 12 ne sont pas conformes dans les 5 minutes qui suivent la fin de `apply`, on applique §3.4.

---

## 5. Pièges et inconnues

### 5.1 Ce qui n'a pas pu être vérifié en lecture seule

| Sujet                                                                        | Raison                                                                                 | Comment le lever                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/etc/sudoers.d/*`, `/etc/sudoers`                                           | `Permission denied` (`/etc/sudoers.d` en `root 750`)                                   | root : `sudo ls -l /etc/sudoers.d ; sudo cat /etc/sudoers.d/deploy` (la version du repo est `infra/sudoers.d/deploy`)                                                                             |
| `/etc/sokar/watchdog.env`, `grafana.env`                                     | `root 750`                                                                             | root : `sudo sed -E 's/=.*/=<masqué>/' /etc/sokar/watchdog.env` (clés seulement)                                                                                                                  |
| Crontab de root, `/var/spool/cron/crontabs`                                  | `Permission denied` ; `crontab -l -u root` exige un privilège                          | root : `sudo crontab -l`                                                                                                                                                                          |
| `docker ps` / `docker inspect` / mounts réels                                | `deploy` n'est pas dans le groupe docker                                               | root : `sudo docker ps --format '{{.Names}} {{.Image}} {{.Status}}'` ; `sudo docker inspect -f '{{.Name}} {{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}} {{end}}' $(sudo docker ps -q)` |
| `nginx -T` (configuration effective)                                         | Clé privée Let's Encrypt illisible ; seul le fichier source a été lu                   | root : `sudo nginx -T \| grep -n -i sokar \| head -100`                                                                                                                                           |
| `/var/lib/sokar/watchdog` (état, cooldowns)                                  | `root 750`                                                                             | root : `sudo ls -la /var/lib/sokar/watchdog`                                                                                                                                                      |
| `/var/backups/sokar-staging` (liste des dumps)                               | `root 700`                                                                             | root : `sudo ls -lt /var/backups/sokar-staging \| head`                                                                                                                                           |
| `/usr/local/sbin/sokar-backup-postgres`                                      | `0750 root` : contenu non lu (supposé = `scripts/database/backup-postgres.sh` du repo) | root : `sudo diff /usr/local/sbin/sokar-backup-postgres /opt/sokar/scripts/database/backup-postgres.sh`                                                                                           |
| `/etc/ufw/*`, `/etc/letsencrypt/live/*`                                      | `Permission denied` (non lus ; aucune raison de supposer une occurrence)               | root : `sudo grep -rIl -i sokar /etc/ufw /etc/letsencrypt`                                                                                                                                        |
| Période et grace du check Healthchecks.io                                    | Réglage dans l'interface Healthchecks, URL dans `watchdog.env` illisible               | Levé : check `Suppernote production watchdog`, période 5 min, grace 5 min (§2.6)                                                                                                                  |
| Destinataires réels des alertes (`ALERT_WEBHOOK`, `ALERT_CMD`)               | Dans `watchdog.env`                                                                    | Q3                                                                                                                                                                                                |
| Temps réel de `apply` et du redémarrage Next sous charge                     | Le script n'existe pas encore ; les 4 s relevées sont des durées d'amorçage PM2        | Mesurer au dry-run P5 puis au staging (critère n° 8 du §3.3)                                                                                                                                      |
| Comportement de `sudo` avec un lien de compatibilité                         | Dépend du sudoers réel et de la version de sudo                                        | Ligne 18 de la checklist, **à tester sur staging avant la prod**                                                                                                                                  |
| Configuration Sentry, Grafana, Healthchecks filtrant sur `service=sokar-api` | Hors serveur                                                                           | Q12                                                                                                                                                                                               |

### 5.2 Questions pour Hamza

| #   | Question                                                                                                                                                                                                                                                               | Reco ops                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Q1  | Mardi 15h00–16h00 est-il réellement hors service ? Aucun restaurant en production réelle ni test d'appel prévu ? (3 appels le 20/11 entre 15h21 et 15h27 dans les journaux.)                                                                                           | Confirmer ; sinon décaler à un créneau sans appel. Annoncer si des restaurants sont en réel. |
| Q2  | ~~Période et grace time du check Healthchecks.io, nom du check~~ **Réponse :** check `Suppernote production watchdog` (déjà renommé), période 5 min, grace 5 min. Reste : pause du check pendant 90 min depuis l'UI à 14:50 (heure de Paris) ?                         | Pause à T-10, reprise à 15:45 (§3.2).                                                        |
| Q3  | Accord pour suspendre le cron du watchdog (`mv` hors de `cron.d`) pendant toute la fenêtre, plutôt que d'accepter les alertes CRITIQUE (API, dashboard, dossier backup introuvable) ? Où partent les alertes (Slack, Discord, SMS) ?                                   | Suspendre ; réactiver à 15:45 après un passage manuel.                                       |
| Q4  | Accord pour un préflight root complet (docker, nginx -T, sudoers, `/etc/sokar` masqué) **avant** mardi ?                                                                                                                                                               | Oui, commandes en §5.1. Sans cela, §1 reste incomplet.                                       |
| Q5  | Qui lance `apply` : toi seul en root, ou dev en visio ? Le script sera copié hors de `/opt/sokar` (par ex. `/root/rename/`) : OK ?                                                                                                                                     | Toi en root, dev et ops en écoute.                                                           |
| Q6  | Ordre de fusion de la PR dev (wrapper, workflows, scripts) : après le renommage validé en prod (recommandé, §3.1 et §3.9) plutôt qu'avant ? Si avant, un auto-déploiement casserait le serveur non renommé.                                                            | Après, avec workflows gelés entre-temps.                                                     |
| Q7  | Laisser tels quels : conteneurs `sokar-prometheus` / `sokar-grafana`, projet Compose `sokar-monitoring`, `upstream` et `log_format` nginx `sokar_*` ? Les renommer est possible mais recrée des conteneurs et orpheline des volumes.                                   | Laisser (hors palier 1).                                                                     |
| Q8  | Laisser tels quels les dossiers personnels `~deploy/.sokar-*`, `~/sokar-backups`, `~/sokar-billing-*` (copies d'anciens `.env` avec secrets) ?                                                                                                                         | Laisser pour le renommage ; prévoir une purge séparée.                                       |
| Q9  | Accord pour modifier la **valeur** (chemin) de `DEBUG_LOG_PATH` dans `/opt/suppernote/apps/api/.env` (prod) avant `cleanup-compat` ? La règle « ne pas toucher aux variables d'environnement » vise les noms ; ce point n'est qu'une valeur.                           | Oui, au moment du `cleanup-compat`, pas pendant la fenêtre.                                  |
| Q10 | Durée de vie des liens de compatibilité et conditions de `cleanup-compat` (§3.9) : 14 jours après deux déploiements complets, ou autre ?                                                                                                                               | 14 jours minimum.                                                                            |
| Q11 | Aucun reboot du VPS pendant la fenêtre (`pm2-deploy.service` fait `pm2 resurrect` depuis `dump.pm2` qui contient les anciens chemins tant que `pm2 save` n'est pas fait) : OK ?                                                                                        | Oui. `pm2 save` dès la fin de chaque environnement.                                          |
| Q12 | Y a-t-il des filtres ou alertes Sentry, Grafana ou Healthchecks qui s'appuient sur `service:"sokar-api"` ou sur les noms PM2 / chemins `sokar` ?                                                                                                                       | Aucune action au palier 1, mais à lister avant `cleanup-compat`.                             |
| Q13 | Quand fusionner la PR dev et lancer le déploiement automatique complet : mardi avant 18h30, ou mercredi 14h hors service ?                                                                                                                                             | Mercredi 14h : marge de rollback et de surveillance Sentry plus confortable.                 |
| Q14 | `https://widget.suppernote.com/restaurant-reservation.html` répond déjà **404** avant le renommage (Cloudflare Pages, workflow manuel `deploy-widget.yml:45`). Est-ce attendu ? Hors périmètre VPS, mais il faut le savoir pour ne pas le prendre pour une régression. | À vérifier séparément (carte distincte).                                                     |
| Q15 | `id` montre que `deploy` appartient au groupe `sudo` (gid 27) alors qu'`AGENTS.md` dit le contraire et que le sudo sans mot de passe n'est pas disponible. Souhaites-tu corriger `AGENTS.md` ou le serveur ?                                                           | Corriger `AGENTS.md` si c'est voulu ; hors renommage.                                        |

### 5.3 Pièges à garder en tête pendant la fenêtre

1. **`mv` puis `ln -s` ne sont pas atomiques ensemble.** Quelques millisecondes sans chemin : le watchdog et les crons doivent être suspendus (§3.2).
2. **Ne jamais faire `mv A B` quand `B` est déjà un lien vers un dossier** : le dossier irait _dans_ la cible. Au rollback : lien supprimé d'abord.
3. **`pm2 reload` / `restart` ne renomment rien.** Tout `reload` après le renommage garde les anciens noms tant que `pm2 delete` n'a pas eu lieu.
4. **Un script lancé depuis `/opt/sokar/scripts/…` perd ses chemins relatifs pendant son propre `mv`.** Le lancer depuis un dossier extérieur.
5. **Les fichiers de `cron.d` dont le nom contient un point sont ignorés par cron.** C'est ce qui permet de suspendre le watchdog avec un suffixe `.disabled`, mais aussi ce qui rend silencieux un `.bak` ou une copie oubliée : un cron « renommé » avec un point ne tourne plus sans erreur.
6. **Les timestamps sont en CET (heure de Paris), les commentaires de cron en « UTC »** : ne pas se fier aux commentaires pour placer des backups (voir §2.7).
7. **`logrotate` + lien :** deux fichiers de configuration pour le même dossier (`sokar` et `suppernote`) = double rotation ou `duplicate log entry`.
8. **Recréation de Prometheus et Grafana au premier déploiement** (H23) : normale, brève, à ne pas prendre pour un incident ; vérifier `:9090/-/ready` après.
9. **Chaque déploiement prod relance `configure-watchdog`** (`deploy-prod.yml:147`) avec les secrets GitHub et réécrit `watchdog.env`. Avec l'ancien wrapper, il écrit dans `/etc/sokar` (donc, via le lien, dans `/etc/suppernote`, sans dégât) ; avec le nouveau, directement dans `/etc/suppernote`. Dans les deux cas le fichier lu par le watchdog doit être le même : à vérifier après le déploiement de validation (§4 ligne 12).
10. **Les dumps gardent le préfixe `sokar-`** : ne pas « corriger » `sokar-*.dump` dans le watchdog, ni le message R2 (H10).
11. **`/opt/sokar-staging/releases/*/.env.before`** (H21) contiennent des secrets : ne pas les inclure dans un `tar` partagé hors root.
12. **Sudoers** : `visudo -c` avant de se déconnecter. Un sudoers invalide fait perdre tout `sudo` ; garder une session root ouverte pendant toute la fenêtre.
13. **Dérive prod/ecosystem** (H17) : dashboard et connect prod écrivent dans `~/.pm2/logs`, pas dans `/var/log/sokar`. Après recréation ils iront dans `/var/log/suppernote` : c'est un changement de comportement, pas une erreur.
14. **Les 8 process partagent un seul daemon PM2** : un `pm2 delete all` ou `pm2 kill` par erreur coupe staging **et** prod.

---

## Références

- `docs/runbooks/deployment.md`, `docs/runbooks/rollback.md`, `docs/runbooks/staging.md`
- `docs/runbooks/migration-suppernote.md` (qui indique encore que `/opt/sokar` et les scripts `sokar-*` ne changent pas : à corriger après qualification)
- `scripts/ops/sokar-deploy-root.sh`, `scripts/ops/sokar-watchdog.sh`, `infra/cron/`, `infra/logrotate/sokar`, `infra/nginx/`
