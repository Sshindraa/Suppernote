# Suppernote Connect — Déploiement production

> Guide de déploiement pour la nouvelle app `apps/connect` (Next.js
> standalone port 4002) derrière Nginx + Cloudflare.
> Cf. spec `docs/connect-v1.1.md` §3.3 hébergement.

## Architecture cible

```
Cloudflare (proxy + cache)
    ↓ HTTPS
VPS (sokar) — Nginx :80, derrière Cloudflare
    ├─ /, /pricing, /dashboard/*  → 127.0.0.1:3000 (sokar-dashboard, PM2)
    ├─ /r/*, /restaurants/*, /sitemap.xml, /robots.txt
    │                              → 127.0.0.1:4002 (sokar-connect, PM2)
    └─ /api/*                      → 127.0.0.1:4000 (sokar-api, PM2)
```

## Process PM2

Le déploiement normal passe par `scripts/deploy.sh --env prod`, qui construit les
trois applications, installe la configuration Nginx, puis démarre les trois
processus depuis `infra/ecosystem.config.js`.

```bash
# Sur le VPS, en tant que deploy
cd /opt/sokar/apps/connect

# 1. Build
pnpm install --frozen-lockfile --filter @suppernote/connect...
pnpm --filter @suppernote/connect build
bash scripts/copy-static.sh

# 2. Démarrer (le wrapper source .env)
pm2 delete sokar-connect 2>/dev/null || true
pm2 start bin/run-connect.sh --name sokar-connect --update-env
pm2 save
```

## Variables d'env (apps/connect/.env)

```bash
SITE_URL=https://suppernote.com
API_URL=http://127.0.0.1:4000  # API Fastify, accès interne uniquement
NEXT_PUBLIC_API_URL=https://api.suppernote.com  # URL publique pour le widget
PORT=4002
HOSTNAME=127.0.0.1
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
```

> **NE PAS** committer `.env`. Chmod 600 sur le VPS.

## Nginx

La source canonique est `infra/nginx/sokar.conf`. Le script de déploiement
l'installe dans `/etc/nginx/sites-available/sokar`, installe les snippets,
valide avec `nginx -t`, puis recharge Nginx.

## Vérification post-deploy (à CHAQUE release)

```bash
# 1. Le process est online
pm2 list | grep sokar-connect
# Doit afficher : online

# 2. Health check direct (interne, sans Cloudflare)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4002/
# Attendu : 200

# 3. Health check via Nginx (interne)
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: suppernote.com" http://127.0.0.1/sitemap.xml
# Attendu : 200

# 4. Health check via Cloudflare (URL publique, ajouter le host)
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: suppernote.com" https://suppernote.com/r/chez-sokar-demo
# Attendu : 200 (alias legacy)
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: suppernote.com" https://suppernote.com/r/chez-suppernote-demo
# Attendu : 200 (URL canonique)

# 5. JSON-LD présent (snippet de validation)
curl -s https://suppernote.com/r/chez-suppernote-demo | grep -o 'application/ld+json'
# Attendu : 1 occurrence (Restaurant schema)
```

## Tests d'intégration (post-deploy, optionnel)

```bash
# Sur le VPS
cd /opt/sokar/apps/connect
pnpm exec tsx scripts/post-deploy-smoke.ts  # à créer
```

## Rollback

Si Suppernote Connect crash, **Nginx sert un 502 aux clients**. Nginx ne fail
pas : les autres routes (`/`, `/pricing`, `/api/*`) continuent de
fonctionner.

Rollback simple :

```bash
pm2 stop sokar-connect
# Les pages /r/* renverront un 502 transparent. Le reste de suppernote.com est OK.
```

Rollback complet (restaurer le routage Nginx précédent) :

```bash
# Restaurer la version précédente de /etc/nginx/sites-available/sokar
nginx -t && systemctl reload nginx
```

## Logs

```bash
pm2 logs sokar-connect --lines 100
# Format : Pino, JSON structuré
```

Les analytics events passent par la queue `connect-analytics` côté API
(voir `apps/api/src/shared/queue/workers/connect-analytics.worker.ts`).
Vérifier les compteurs Prometheus :

```bash
curl -s http://127.0.0.1:3001/metrics | grep sokar_connect
```

## Métriques à surveiller

- `sokar_connect_events_total{event, source}` — taux d'events par source
- `sokar_connect_reservations_confirmed_total{source, city}` — conversion
- `pm2 monit` — RAM, CPU, restarts du process
- Nginx access log — 4xx/5xx sur `/r/*` et `/restaurants/*`

## Critères de go/no-go (Phase 1 → Pilote)

| Critère                                       | Statut | Commentaire                                                                                                     |
| --------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| Page `/r/[slug]` accessible sans auth         | ✅     | Test 200                                                                                                        |
| JSON-LD Restaurant valide (Rich Results Test) | ✅     | Cf. spec v1.1 §19                                                                                               |
| Page `/r/[slug]/book` interactive             | ✅     | T6 flow complet                                                                                                 |
| 10 restos en local/staging (seed)             | ✅     | Seed: Chez Sokar demo + 5 Lyon + 5 Paris, `connectPublished=true`, `connectAgentic=false`. Skip en prod (§11.1) |
| 10 restos réels onboardés (pilote)            | ⏳     | Pilote fermé §11.2 — onboarding manuel de vrais restaurants, pas du seed                                        |
| Pages locales indexables conditionnellement   | ✅     | Règle 5/10/20 active                                                                                            |
| Tracking `page_view` et `cta_clicked`         | ✅     | Queue `connect-analytics` + prom-client                                                                         |
| RGPD : consent + IP hash + audit log          | ✅     | `ConsentService` + `hold`/`confirm`                                                                             |
| Sécurité : rate limit + honeypot + CSP        | ✅     | 5 holds/min, 10 confirms/min, honeypot widget                                                                   |
| Lighthouse > 90                               | ⏳     | À vérifier sur le VPS                                                                                           |
| 1 vraie résa via lien ChatGPT                 | ⏳     | Pilote fermé, pas avant                                                                                         |

## Dépannage courant

### "Le sitemap est vide après deploy"

Le sitemap est `force-dynamic` et appelle l'API. Si l'API est
indisponible au moment de la requête, le sitemap rend un tableau
vide. C'est attendu en P0, le cache Cloudflare lisse ce problème.

### "Le hold ne s'affiche pas dans le widget"

Vérifier :

- `NEXT_PUBLIC_API_URL` est bien `https://api.suppernote.com` (URL publique)
- `connectPublished=true` et `agenticOptIn=true` sur le restaurant
- Le `holdTtlSeconds` n'est pas expiré (TTL 5 min par défaut)
- La console navigateur montre un 409 (hold conflict) ou 410 (expired)

### "Le JSON-LD n'apparaît pas dans le head"

Next.js Server Component `<script type="application/ld+json">` est
rendu en streaming, parfois après le `</head>`. Google accepte les
JSON-LD dans le body. Si critique, passer par `next/script` avec
`strategy="beforeInteractive"`.
