# Audit de fiabilité des déploiements — 2026-11-18

Point 2 de la reprise. Périmètre : `scripts/deploy.sh`, `scripts/ops/deploy-common.sh`, `infra/ecosystem*.config.js`, `.github/workflows/deploy-staging.yml` et `deploy-prod.yml`, `apps/api/src/main.ts`, `apps/api/src/modules/voice/stream/shutdown-drain.ts`, et les 30 derniers runs `Deploy Staging` / `Deploy Production` (`gh run list`).

Aucun déploiement ni redémarrage n'a été lancé. La lecture seule du VPS a été refusée à la session d'audit pendant l'audit ; la vérification du point 1 a été faite le 19/11 par la session d'audit, en lecture seule sur le VPS.

## Résumé

| #   | Gravité                     | Sujet                                                                                                                                              | Statut                                                           |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Faible, vérifié : non actif | `wait_for_voice_idle` lit `/metrics` sans identifiants. L'auth basique n'est pas activée sur le VPS : la fonction lit le vrai nombre d'appels      | Aucun correctif requis ; à traiter si l'auth basique est activée |
| 2   | Haute                       | Redémarrage pm2 en mode `fork` = arrêt puis relance : une fenêtre de quelques secondes sans API à chaque déploiement (webhooks Telnyx/Stripe, SMS) | Structurel, pas de correctif petit                               |
| 3   | Moyenne                     | Au-delà de 300 s d'attente, le déploiement continue avec des appels vivants ; ils n'ont que 25 s de grâce à l'arrêt                                | Connu (Journal 2026-11-08), limite assumée                       |
| 4   | Faible (corrigé ici)        | Smoke tests `/health` staging et prod : une seule tentative juste après redémarrage                                                                | Retry ajouté (15 × 4 s)                                          |
| 5   | Faible                      | Échec du 17/11 : cause réelle différente de celle du Journal, déjà corrigée dans `main`                                                            | Journal corrigé dans cette PR                                    |

## 1. Faible, vérifié : auth basique non active

`scripts/ops/deploy-common.sh`, fonction `wait_for_voice_idle` :

```bash
sessions="$(curl -fsS -m 3 "http://127.0.0.1:${PORT_API}/metrics" 2>/dev/null | awk ...)"
case "$sessions" in ''|*[!0-9.]*) return 0 ;; esac
```

- `/metrics` est servi par l'API (`observability.routes.ts`), protégé par `metrics-auth.ts`. Si `METRICS_BASIC_AUTH_USER` et `METRICS_BASIC_AUTH_PASSWORD` sont définis, un appel sans identifiants reçoit 401 ; `curl -fsS` échoue, `sessions` est vide, et la fonction rendrait `0` : le redémarrage n'attendrait pas.
- **Vérifié le 19/11 par la session d'audit, en lecture seule sur le VPS** : `curl http://127.0.0.1:4000/metrics` → 200 et `:4100` → 200 ; `suppernote_voice_active_sessions 0` est exposé sur les deux ports ; `/opt/sokar/apps/api/.env` ne définit pas `METRICS_BASIC_AUTH_USER/PASSWORD`. `wait_for_voice_idle` lit donc le vrai nombre d'appels.
- **Remarque pour plus tard :** le jour où l'auth basique sera activée, il faudra passer les identifiants à `wait_for_voice_idle` (par exemple `curl -u` depuis l'environnement de `apps/api/.env`, dans une sous-shell), et ne jamais traiter un échec de lecture comme « zéro appel » : réessayer, puis ne déployer qu'à l'échéance `VOICE_DRAIN_MAX_SECONDS`. Ce changement touche aux secrets du déploiement et doit être testé sur `scripts/ops/test-deploy-common.sh`.

## 2. Haute — le redémarrage coupe l'API quelques secondes

- `infra/ecosystem.config.js` et `ecosystem.staging.config.js` : `sokar-api` est en mode `fork`, une seule instance. Le journal du run du 17/11 le confirme : `[PM2] Applying action restartProcessId on app [sokar-staging-api]`.
- En `fork`, PM2 ne sait pas faire de `reload` sans coupure : il arrête le process, puis en lance un nouveau. Entre les deux, Nginx renvoie `502` ou `Connection reset`. C'est le symptôme décrit dans le Journal du 17/11.
- Le `wait_ready` (signal `ready`) et `listen_timeout: 30000` garantissent que le nouveau process est prêt avant la suite, mais pas l'absence de coupure.
- Un webhook reçu pendant la fenêtre peut être perdu si son fournisseur ne rejoue pas. Telnyx et Stripe rejouent en principe ; non vérifié ici.
- Un correctif sans coupure demande soit un second process (bleu/vert, deux ports et bascule Nginx), soit le mode `cluster`. Le `cluster` est risqué : les sessions vocales sont en mémoire, donc un appel doit rester sur le même worker. Ce n'est pas un correctif petit ; à planifier à part.

## 3. Moyenne — limite du drain vocal

- `wait_for_voice_idle` attend au plus `VOICE_DRAIN_MAX_SECONDS` (300 s), puis déploie quand même (`log_warn`).
- Côté process, `waitForVoiceCallsToEnd` (`shutdown-drain.ts`) donne 25 s aux appels restants, puis ferme. `kill_timeout` vaut 30 s : la marge est suffisante.
- Un appel plus long que 25 s après le signal est coupé. Un appel qui démarre pendant la fenêtre de redémarrage est coupé aussi.
- C'est le compromis déjà documenté le 2026-11-08. La protection est réelle aujourd'hui, l'auth basique n'étant pas activée (point 1). Elle ne couvre pas un appel encore vivant après 300 s d'attente.

## 4. Faible, corrigé — smoke tests sans nouvelle tentative

Les smoke tests `api(-staging).suppernote.com/health` faisaient une seule requête juste après le déploiement. Un `reset` à ce moment faisait échouer le job et bloquait la prod (gate staging → prod).

**Correctif appliqué dans cette PR :** boucle de 15 tentatives espacées de 4 s, arrêt dès `200`, dans `deploy-staging.yml` et `deploy-prod.yml`. Même schéma que le check post-rollback, qui retentait déjà (30 × 2 s). Le temps de retry est borné à 60 s ; un vrai arrêt échoue toujours.

Vérification : parsing YAML des deux workflows et `bash -n` sur les blocs modifiés (OK). Pas de test de bout en bout : le retry ne se déclenche que sur un échec réel.

## 5. Échec du 17/11 — cause réelle

Run `44141590757` (staging, PR #765 squash `c5ab1590`) :

- Déploiement : `restartProcessId` sur les apps staging à 17:55:09–14, `wait_for_services` OK, `Staging deploy complete` à 17:55:22.
- Smoke tests : **tous verts** à 17:55:42 (`/health` → 200 à 17:55:38, `/livez` → 200, pages → 200).
- `Test rollback staging` : rollback volontaire, lancé après chaque smoke vert sur `main` (`continue-on-error: true`). Il restaure la release précédente.
- `Verify rollback health` : **un seul** `curl -fsS https://api-staging.suppernote.com/livez` à 17:56:01 → `Connection reset by peer`. Ce check échoue, le job échoue, la suite E2E est sautée, `Deploy Production` est sauté (gate).

Le Journal du 17/11 dit « smoke test sans réponse sur `/health` ». Le log montre que `/health` a répondu 200 : l'échec est le check `livez` post-rollback. Le workflow sur `main` contient déjà une boucle de 30 tentatives sur ce check (`deploy-staging.yml`, « Verify rollback health ») ; ce mode d'échec est donc déjà corrigé dans `main`.

Dans les 30 derniers runs `Deploy Staging` : un seul échec (17/11). `Deploy Production` : aucun échec sur la même période, un `skipped` (17/11 19:37, gate staging).

**Risque prod :** le même `reset` peut survenir sur le check de santé de `deploy.sh` (`health_checks`) ou sur le smoke prod. Le smoke prod est maintenant retenté ; `health_checks` s'appuie sur `wait_for_services` (60 s, boucle). Pas de risque supplémentaire identifié.

## Rollback (`docs/runbooks/rollback.md`)

- Fiable pour l'application sur staging : le rollback du 17/11 a restauré la release, `api → 200 | dashboard → 200` à 17:55:55 (`Restore current staging release` remet la release courante).
- Limites : le rollback restaure les artefacts et les dépendances (`pnpm install` depuis le lockfile), **pas la base** sans `--with-db-rollback`. Une migration additive reste en place (le runbook le dit). Le rollback redémarre les services avec le même `restart`, donc même fenêtre de coupure que le point 2.
- Non couvert par la CI : le rollback prod n'est jamais exercé automatiquement ; seul staging le teste à chaque push.

## Actions

1. Si l'auth basique `METRICS_BASIC_AUTH_*` est activée un jour, passer les identifiants à `wait_for_voice_idle` et ne jamais traiter un échec de lecture comme zéro appel (point 1).
2. Décider si le point 2 (bleu/vert) est planifié.
3. Corriger le Journal du 17/11 (cause réelle, voir point 5) : fait dans cette PR.
