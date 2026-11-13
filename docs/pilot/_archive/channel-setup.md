# Channel setup — Pilote Lyon

> Cette checklist décrit comment configurer les channels Discord ou Slack
> pour le pilote. À exécuter avant le kickoff.

## Choix de plateforme

| Plateforme  | Quand l'utiliser                                            |
| ----------- | ----------------------------------------------------------- |
| **Discord** | Équipe petite (< 10), pilot informel, vocal facile          |
| **Slack**   | Équipe scaling, intégrations tierces (Sentry, GitHub, etc.) |

Pour le pilote Lyon (3-5 personnes), Discord suffit. Si on scale à 10+,
basculer sur Slack.

## Discord (recommandé pour MVP)

### Channels à créer

| Channel                     | Audience       | Usage                                           |
| --------------------------- | -------------- | ----------------------------------------------- |
| `#sokar-pilot-incidents`    | Toute l'équipe | Alertes P1 (double booking, PII leak, 5xx > 1%) |
| `#sokar-pilot-feedback`     | Toute l'équipe | Retours restos (positifs, frictions, demandes)  |
| `#sokar-pilot-data`         | Hamza + équipe | Daily async, KPIs                               |
| `#sokar-pilot-random`       | Toute l'équipe | Off-topic, célébration                          |
| `#sokar-pilot-restos-<nom>` | Resto + Hamza  | Canal privé 1-1 par resto (optionnel)           |

### Webhooks à connecter

| Webhook                 | Channel                  | Événement source               |
| ----------------------- | ------------------------ | ------------------------------ |
| Sentry                  | `#sokar-pilot-incidents` | `level=error` ET tag `alert:*` |
| GitHub Actions          | `#sokar-pilot-incidents` | CI failures sur main           |
| Prometheus AlertManager | `#sokar-pilot-incidents` | `up == 0` > 5min               |

### Permissions

- `@on-call` role : ping-able seulement par Hamza ou désigné
- `@bot` integrations : read+write sur les channels ci-dessus
- Tous les autres : read-only

## Slack (optionnel, si on scale)

### Channels équivalents

| Slack channel            | Description  |
| ------------------------ | ------------ |
| `#sokar-pilot-incidents` | Idem Discord |
| `#sokar-pilot-feedback`  | Idem Discord |
| `#sokar-pilot-data`      | Idem Discord |

### Apps à installer

- **Sentry** : notifier sur `#sokar-pilot-incidents` pour `level=error` + tag `alert:*`
- **GitHub** : notifier sur `#sokar-pilot-incidents` pour CI failures
- **Prometheus** : via AlertManager webhook → channel Slack

## Script de setup Discord (rapide)

```bash
# 1. Créer un serveur Discord "Suppernote Pilot Lyon"
# 2. Créer les channels ci-dessus
# 3. Créer un webhook pour #sokar-pilot-incidents
#    → Server Settings → Integrations → Webhooks → New Webhook
#    → Copier l'URL

# 4. Configurer Sentry (dans Sentry UI) :
#    Settings → Integrations → Discord → Add → coller webhook URL

# 5. Configurer Prometheus AlertManager (alertmanager.yml) :
#    receivers:
#      - name: 'sokar-pilot-discord'
#        webhook_configs:
#          - url: '<DISCORD_WEBHOOK_URL>'
#            send_resolved: true
```

## Invitation des restos

Chaque resto a accès à un channel privé `#sokar-pilot-restos-<nom>`.
On les invite juste avant leur date d'onboarding (pas avant, sinon
ils voient des trucs internes).

## Exemples de messages

### Daily (par Hamza, 9h)

```
🗞️ Daily Pilote Lyon — 21 juin 2026

Hier :
- 12 résas créées (8 MCP, 4 OpenAI Reserve)
- 11 honorées, 1 annulée
- 0 double booking, 0 PII leak
- p95 latence : 420ms ✅

Aujourd'hui :
- 2 formations resto (Le Bistrot 10h, Café Sillon 14h)
- 0 incident attendu

Blockers : aucun
```

### Incident (auto via Sentry webhook)

```
🚨 DOUBLE BOOKING ATTEMPT 🚨

Restaurant : Le Bistrot (r-abc-123)
Slot : 2026-12-01T19:00:00Z
Party size : 4
Attempted by : agent:dev-client
Time : 14:32:18

⚠️ Should never happen with partial unique index.
Investigate immediately: https://sokar.sentry.io/issues/...
```

### Feedback resto (par gérant, dans son channel privé)

```
@hamza Hello, j'ai eu 3 résas hier via ChatGPT mais 2 d'entre elles
n'ont pas honoré (no-show). Est-ce que c'est normal à votre avis ?
```

---

## Post-pilote

- Archiver les channels privés resto (garder le transcript 90 jours pour RGPD)
- Promouvoir le canal `#sokar-pilot-data` en `#sokar-prod-data`
- Garder `#sokar-pilot-incidents` actif (renommer en `#sokar-prod-incidents`)
