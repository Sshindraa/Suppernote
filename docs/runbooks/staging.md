# Runbook — Staging

> **Statut : ACTIF — mis à jour le 23 septembre 2026.**
> La dernière preuve documentée confirme ElevenLabs et Cartesia fonctionnels en staging ; Telnyx
> reste absent et bloque un appel réel. Toujours contrôler `/health` (qui expose les dépendances)
> et les variables présentes sans afficher leur valeur avant un test voice. Voir
> [`../DOCUMENTATION_STATUS.md`](../DOCUMENTATION_STATUS.md).

## URLs

- Dashboard: `https://staging.suppernote.com`
- API directe: `https://api-staging.suppernote.com`
- Suppernote Connect (canonique): `https://staging.suppernote.com/restaurant/chez-suppernote-demo`
- Suppernote Connect (legacy): `https://staging.suppernote.com/restaurant/chez-sokar-demo`

## Infrastructure (VPS `sokar`, isolated from prod)

- Root: `/opt/sokar-staging/`
- Ports: API=4100, Dashboard=3100, Connect=4102 (prod: 4000/3000/4002)
- DB Postgres: `sokar_staging`
- Redis: db=3 (isolé de prod db=0/1/2)
- PM2: `sokar-staging-api`, `sokar-staging-dashboard`, `sokar-staging-connect`
- Nginx: `infra/nginx/sokar-staging.conf`

## Security / isolation

- Clerk staging keys (`pk_test` / `sk_test`) — **never** prod keys.
- La configuration voice est évolutive : `VOICE_DISABLED` doit refléter le but de la campagne.
  ElevenLabs et Cartesia peuvent être activés pour les tests de transcription/synthèse. Sans
  `TELNYX_API_KEY` et configuration Telnyx complète, aucun appel réel ne doit être tenté.
- Les emails sortants sont désactivés par défaut en staging (`RESEND_API_KEY` vide). Ne copiez
  pas la clé de production. Les rapports nocturnes doivent rester coupés via
  `EVENING_REPORTS_ENABLED=false`. Avant d'activer des tests email, prévoir une clé dédiée et une
  destination de test/allowlist. Un rejeu d'un ancien `evening-report` peut envoyer un rapport du
  jour courant (le scheduler ne fige pas `dayKey`) ; ne rejouez pas un rapport périmé.
- `CORS_ORIGINS` must be explicit in production.
- Stripe staging utilise exclusivement des clés et Price IDs de test.
- `X-Robots-Tag: noindex, nofollow` on all staging vhosts.

## Initial setup

- Script: `scripts/ops/setup-staging.sh` — idempotent, prepares directory, clones repo, creates `sokar_staging` DB, copies `.env.staging.example` to `.env`, installs Nginx vhost and validates config.
- Prerequisites: DNS `staging.suppernote.com` + `api-staging.suppernote.com` pointing to VPS, swap configured (`scripts/ops/setup-swap.sh` if needed).
- After setup: fill `.env` with staging keys. N'activer que les providers voice nécessaires à la
  campagne prévue, puis vérifier leur health check avant le premier déploiement.

## Manual commands

```zsh
# Déploiement : passer par le workflow (pas de deploy.sh à la main)
gh workflow run deploy-staging.yml --ref main

# Rollback (même commande que celle du workflow)
ssh deploy@sokar "cd /opt/sokar-staging && bash scripts/deploy.sh --env staging rollback"

# Services
ssh deploy@sokar "pm2 status"                        # see services
ssh deploy@sokar "pm2 logs sokar-staging-api"        # API logs
```

## Notes

- TLS certificate: `/etc/letsencrypt/live/suppernote.com/`, the Cloudflare Origin certificate for `*.suppernote.com` shared with prod (valid until 2041, no renewal). Depuis le 22 octobre 2026, staging n'utilise plus son ancien certificat Let's Encrypt : son renouvellement échouait depuis juillet et il a expiré ce jour-là (Cloudflare 526). Both hosts must stay proxied by Cloudflare: an Origin certificate is only trusted through Cloudflare.
- Connect page `/restaurant/[slug]` is rendered dynamically (`force-dynamic`) in staging to avoid `DYNAMIC_SERVER_USAGE` during VPS build. In prod it stays ISR.
