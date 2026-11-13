# Runbook — Observabilité

> **Statut : ACTIF — créé le 21 septembre 2026.** Chantier R1-6 de
> [`roadmap-production-readiness.md`](../roadmap-production-readiness.md). Remplace la lecture
> implicite « tout est dans `/metrics` de l'API », qui n'était plus vraie après R1-1.

## Topologie

Depuis R1-1, deux process publient des métriques, et **Prometheus doit scraper les deux** :

| Process                            | Endpoint                        | Ce qu'il publie                                                                                                                                                |
| ---------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sokar-api` (`dist/main.js`)       | `http://127.0.0.1:4000/metrics` | HTTP (`suppernote_http_requests_total`), Connect, réservations, agentic, **sessions vocales actives** (`suppernote_voice_active_sessions`) et latences vocales |
| `sokar-workers` (`dist/worker.js`) | `http://127.0.0.1:4001/metrics` | Files BullMQ (`suppernote_queue_jobs`), appels/réservations en défaut sur 24 h, **SLO** (`suppernote_slo_status`, `suppernote_slo_value`), alertes envoyées    |

Staging utilise les ports décalés `4100` (API) et `4101` (worker). Les deux environnements tournent
sur le même VPS, donc un seul Prometheus scrape les quatre cibles et chaque série porte un label
`env` (`production` ou `staging`) — c'est ce label que les dashboards filtrent.

## Garde d'accès

L'endpoint `/metrics` est protégé par `shared/observability/metrics-auth.ts`, partagé par les deux
process : auth basique si `METRICS_BASIC_AUTH_USER` + `METRICS_BASIC_AUTH_PASSWORD` sont définis,
sinon allowlist d'IP (`METRICS_ALLOWLIST_IPS`, loopback par défaut).

Prometheus tourne en `network_mode: host`, donc il atteint les deux endpoints depuis la loopback :
aucun secret n'est nécessaire. Si Prometheus repasse un jour en réseau bridge, il faudra définir les
identifiants basiques sur les deux process et les déclarer dans `infra/prometheus/prometheus.yml`.

## Accès à Grafana

Grafana écoute sur `127.0.0.1:3030` et n'est **pas** exposé par Nginx. L'accès se fait par tunnel :

```zsh
ssh -L 3030:127.0.0.1:3030 deploy@sokar
# puis http://localhost:3030 — accès lecture seule, sans compte requis
```

Le compte anonyme est limité au rôle Viewer ; les inscriptions sont désactivées. Le mot de passe
admin unique est conservé comme secret `GRAFANA_ADMIN_PASSWORD` dans l'environnement GitHub
`production`, puis provisionné dans `/etc/sokar/grafana.env` avec les droits `0600` par le wrapper
privilégié. Il reste hors du checkout, n'est pas versionné et n'est pas affiché dans les journaux.
Seul le compose Grafana consomme ce secret ; Prometheus reste démarrable indépendamment. N'exposez
pas le port 3030 dans Nginx ou sur une interface publique.

## Démarrer la stack

```zsh
# Le workflow de déploiement production provisionne le secret puis démarre
# Prometheus et Grafana via sokar-deploy-root. Pour un diagnostic manuel :
sudo /usr/local/sbin/sokar-deploy-root start-prometheus prod
# Grafana requiert GRAFANA_ADMIN_PASSWORD, synchronisé par le workflow de production.
sudo /usr/local/sbin/sokar-deploy-root start-grafana prod
```

Prometheus conserve 30 jours de séries (`prometheus-data`), Grafana ses dashboards et son état
(`grafana-data`). Les deux dashboards sont provisionnés depuis `infra/grafana/dashboards/` — ils ne
s'éditent pas dans l'interface, toute modification passe par le dépôt :

- **Suppernote — Voice & SLO** : état des cinq SLO, sessions vocales simultanées (seuil 70), erreurs
  fournisseurs voice, p95 Connect, TTFT LLM, premier audio TTS ;
- **Suppernote — Files & Alertes** : dead-letter, appels sans transcription, réservations sans SMS, taux
  de 5xx, profondeur des files, alertes envoyées par canal.

## Ajouter ou modifier une alerte

1. Ajouter la règle dans `infra/prometheus/alerts.yml` (`expr`, `for`, `labels.severity`,
   `annotations.summary` — les quatre sont exigés).
2. Le test `apps/api/src/shared/observability/__tests__/alert-rules.test.ts` échoue si la règle
   référence une métrique qui n'existe pas, ou si une métrique maison n'a pas le préfixe `sokar_`.
   C'est ce test qui remplace l'ancienne vérification manuelle : une règle qui cite une métrique
   inexistante ne se déclenche jamais, silencieusement.
3. Mettre à jour le dashboard concerné si la règle introduit une nouvelle métrique.

## Écouter un appel (enregistrement instrumenté)

Pour juger un appel au-delà de sa transcription (silences réellement perçus,
chevauchements, bruit de ligne, saturation), sur les seuls restaurants de
`CALL_RECORDING_TEST_RESTAURANT_IDS` :

```zsh
python3 scripts/ops/voice_call_audio.py latest --restaurant <restaurantId>
python3 scripts/ops/voice_call_audio.py <début-de-l-id-d-appel>
```

Le script récupère l'enregistrement privé via le VPS (MP3 deux pistes :
appelant à gauche, agent à droite), mesure chaque piste et produit une
chronologie recalée sur les tours transcrits, plus un spectrogramme. L'audio
est une donnée personnelle : il reste dans `$TMPDIR/sokar-call-audio/`, jamais
dans le dépôt. Dépendances locales : `ffmpeg`, `numpy`.

`--listen` fait en plus écouter les deux pistes par un modèle audio
(`google/gemini-3.8-flash` via OpenRouter, clé lue sur le VPS, ~1 centime par
appel) : ce que l'appelant a réellement dit (à comparer à la transcription du
direct), son ton, la diction de l'agent et les incompréhensions. Ses
horodatages sont approximatifs ; la chronologie mesurée fait foi.

## Limites connues

- Le test des règles valide les **noms** de métriques, pas le fait qu'elles soient peuplées dans le
  process scrapé. La répartition API / worker est celle du tableau ci-dessus ; se tromper de cible
  donne un panneau vide, pas une erreur.
- Les compteurs HTTP vivent en mémoire : un redémarrage remet les séries à zéro. C'est sans
  conséquence sur Prometheus (les compteurs sont monotones par process), mais `rate()` peut produire
  un pic au redémarrage.
- `dispatchAlert()` envoie les alertes in-app à Sentry et, selon `ALERT_*`, par email, webhook et
  SMS critique. Les appels STT utilisent ce dispatcher avec un cooldown Redis ; les règles
  Prometheus ne notifient personne car aucun Alertmanager n'est configuré.

## Quota ElevenLabs pour le STT

Le worker BullMQ `elevenlabs-subscription` lit `GET /v1/user/subscription` une fois par heure
et publie `suppernote_elevenlabs_character_count` et `suppernote_elevenlabs_character_limit`. Il ne
transcrit aucun audio et ne journalise jamais la clé. Les dernières jauges restent visibles
jusqu'au prochain relevé réussi ; les erreurs réseau ou HTTP suivent les retries BullMQ.

Le groupe Prometheus `sokar-voice-providers` évalue les règles toutes les 15 secondes. Il sert de
miroir et ne notifie personne sans Alertmanager :

- `ElevenLabsSttTerminalError` : première hausse observée de quota, authentification ou
  conditions refusées en 5 minutes ; le flux STT appelle `dispatchAlert()` en critique, au plus
  une fois par heure globalement.
- `ElevenLabsSttAffectedCalls` : plus de cinq appels distincts touchés en 10 minutes ; le flux
  STT envoie un avertissement au franchissement, avec cooldown Redis de 10 minutes.
- `ElevenLabsCharacterUsage80Percent`, `ElevenLabsCharacterUsage95Percent` et
  `ElevenLabsCharacterUsage100Percent` : avertissement à 80 %, critique à 95 % et à 100 %.
  Le worker `elevenlabs-subscription` les envoie via `dispatchAlert()` et Redis mémorise chaque
  seuil par période de facturation ; il réarme le seuil si la consommation repasse en dessous.

## Alertes du modèle vocal (Cerebras, repli OpenRouter)

`/health` reste à 200 quand Cerebras refuse (le 29/09, quota 402 : agent muet, API « saine »),
ni le watchdog ni Healthchecks.io ne le voient. Le flux vocal appelle `dispatchAlert()` avec un
cooldown Redis ; aucune charge utile ne contient de donnée d'appel :

- `voice_llm_quota` / `voice_llm_auth` (critique, 1 h) : Cerebras répond 402 / 401-403.
- `voice_llm_all_providers_down` (critique, 30 min) : au moins 3 tours en 10 minutes où le
  principal et le repli ont échoué.
- `voice_llm_primary_slow` (avertissement, 1 h) : au moins 10 doublons de hedging en 15 minutes.
- `voice_llm_circuit_open` (avertissement, 30 min) : le disjoncteur du principal vient de s'ouvrir.
- `openrouter_credit_low` (avertissement sous 2 $) et `openrouter_credit_critical` (critique
  sous 0,5 $) : le worker `openrouter-credit` lit `GET /credits` chaque heure (à la minute 15),
  publie `suppernote_openrouter_credit_usd` et réarme les seuils après une recharge.

La clé partagée staging/production et les consignes de banc sont documentées dans
`docs/runbooks/environment.md`.
