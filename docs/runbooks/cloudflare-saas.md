# Runbook — Cloudflare for SaaS (Premium Subdomain P2)

> **Statut : RUNBOOK ACTIF — audité le 12 septembre 2026.** Le provisioning et le mode dégradé
> staging sont implémentés. Vérifier les tarifs, quotas et options dans la documentation Cloudflare
> au moment d'une décision commerciale. Voir
> [`../DOCUMENTATION_STATUS.md`](../DOCUMENTATION_STATUS.md).

## Objectif

Permet aux restaurants d'utiliser leur propre domaine (ex: `reserve.chezmario.fr`)
pour leur page de réservation Sokar. Cloudflare gère le SSL automatiquement
(no certbot) et route le trafic vers l'origin `suppernote.com`.

## Prérequis

- Le domaine `suppernote.com` doit être géré par Cloudflare (DNS + proxy orange cloud).
- Le VPS doit être accessible depuis Cloudflare (ports 80/443 ouverts).

## Configuration Cloudflare (one-time)

### 1. Activer Cloudflare for SaaS

1. Dashboard Cloudflare → **suppernote.com** → **SSL/TLS** → **Custom Hostnames**
2. Cliquer **Enable Cloudflare for SaaS**
3. Définir le **fallback origin** : `suppernote.com`
4. Attendre que le statut passe à **Active**

### 2. Créer un API Token

1. Dashboard Cloudflare → **My Profile** → **API Tokens** → **Create Token**
2. Utiliser le template **Edit zone DNS** ou créer un custom token avec :
   - **Zone.SaaS** : Edit (pour gérer les Custom Hostnames)
   - **Zone.DNS** : Read (pour vérifier les CNAME)
   - **Zone** : Read (pour lister les zones)
3. **Zone Resources** : Include → Specific zone → `suppernote.com`
4. Copier le token (il ne sera plus affiché)

### 3. Récupérer le Zone ID

1. Dashboard Cloudflare → **suppernote.com** → **Overview**
2. En bas à droite : **Zone ID** → copier

### 4. Configurer les variables d'env sur le VPS (automatisée)

Utiliser le script idempotent `scripts/ops/setup-cloudflare-saas.sh` depuis votre machine locale :

```zsh
bash scripts/ops/setup-cloudflare-saas.sh --env prod --token "cf-token-xxx" --zone-id "zone-xxx"
```

Le script :

- Backup le `.env` (timestamp automatique)
- Ajoute ou met à jour les 3 vars `CLOUDFLARE_*` (idempotent — ne redémarre pas si rien à changer)
- Redémarre `sokar-api` via PM2
- Vérifie le health check sur `localhost:4000/livez`
- **Ne logge jamais le token en clair** (affiche `[REDACTED]`)

Pour staging (optionnel — voir note ci-dessous) :

```zsh
bash scripts/ops/setup-cloudflare-saas.sh --env staging --token "cf-token-xxx" --zone-id "zone-xxx" --fallback-origin "staging.suppernote.com"
```

> **Note — Staging :** Les vars Cloudflare SaaS sont **optionnelles en staging**. Le guard `isCloudflareSaaSEnabled()` (dans `apps/api/src/modules/connect/cloudflare-saas.service.ts`) vérifie que `CLOUDFLARE_API_TOKEN` ET `CLOUDFLARE_ZONE_ID` sont définies. Si elles sont absentes, le customDomain est stocké en DB sans provisioning Cloudflare — l'API continue de fonctionner normalement. En staging, on laisse généralement ces vars vides.

#### Procédure manuelle (fallback)

Si le script ne fonctionne pas, vous pouvez configurer les vars manuellement :

```zsh
ssh deploy@sokar
cd /opt/sokar/apps/api
cp .env .env.backup.$(date +%Y%m%d%H%M%S)
nano .env
```

Ajouter à la fin :

```env
CLOUDFLARE_API_TOKEN="votre-token-ici"
CLOUDFLARE_ZONE_ID="votre-zone-id-ici"
CLOUDFLARE_SAAS_FALLBACK_ORIGIN="suppernote.com"
```

Puis redémarrer l'API :

```zsh
cd /opt/sokar
pm2 restart sokar-api
```

### 5. Vérifier

```zsh
# Sur le VPS
curl -s http://127.0.0.1:4000/livez | jq .
# Doit retourner 200 OK
```

## Flux restaurateur (2 clics)

1. Le restaurateur va dans **Dashboard → Connect → Domaine personnalisé**
2. Il entre `reserve.chezmario.fr` et clique **Configurer le domaine**
3. L'API provisionne un Custom Hostname sur Cloudflare (statut `pending`)
4. Le dashboard affiche les instructions CNAME :
   - `reserve.chezmario.fr` → `suppernote.com`
5. Le restaurateur configure le CNAME chez son registrar (OVH, Gandi, etc.)
6. Il clique **Vérifier le DNS** → l'API vérifie le CNAME localement (`dig`) + rafraîchit le statut Cloudflare
7. Cloudflare provisionne le SSL automatiquement (quelques minutes)
8. La page `https://reserve.chezmario.fr` est live

## Monitoring

- **Statut CF** : visible dans le dashboard restaurant (champ `customDomainStatus`)
- **Métriques** : `sokar_connect_custom_domain_total` (à implémenter si besoin)
- **Logs** : `grep "CF Custom Hostname" /opt/sokar/apps/api/logs/*.log`

## Troubleshooting

### Le statut reste `pending`

1. Vérifier que le CNAME est bien configuré : `dig CNAME reserve.chezmario.fr`
2. Le CNAME doit pointer vers `suppernote.com` (pas vers l'IP du VPS)
3. Attendre la propagation DNS (TTL du registrar, généralement 5-30 min)

### Le statut est `dns_validated` mais pas `active`

1. Le SSL est en cours de provisionnement (Cloudflare)
2. Attendre 5-15 min
3. Vérifier dans le dashboard Cloudflare → **Custom Hostnames**

### Erreur 502 sur le custom domain

1. Vérifier que Nginx route bien le trafic : `curl -H "Host: reserve.chezmario.fr" http://127.0.0.1/`
2. Le server block catch-all (`server_name _`) doit être actif
3. Vérifier que le fallback origin est bien `suppernote.com` dans Cloudflare

### Le restaurateur veut changer de domaine

1. Il entre le nouveau domaine dans le dashboard
2. L'API supprime l'ancien Custom Hostname sur Cloudflare + en crée un nouveau
3. Les CNAME doivent être reconfigurés chez le registrar

### Le restaurateur veut supprimer le domaine

1. Il clique sur le bouton **X** dans le dashboard
2. L'API supprime le Custom Hostname sur Cloudflare + clear DB
3. Le domaine ne pointe plus vers Sokar

## Rollback

En cas de problème, on peut désactiver Cloudflare for SaaS :

1. Supprimer les variables d'env `CLOUDFLARE_*` sur le VPS
2. Redémarrer l'API : `pm2 restart sokar-api`
3. Les custom domains existants restent en DB mais ne sont plus provisionnés
4. Les restaurateurs doivent reconfigurer leur DNS pour pointer vers `suppernote.com` directement

## Coûts

Cloudflare for SaaS : **$0.10 par custom hostname par mois** (au-delà du free tier de 100).
Voir https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/pricing/

## Subdomain gratuit \*.suppernote.com (zero config)

Chaque restaurant qui active Sokar Connect obtient automatiquement un subdomain gratuit
`chezmario.suppernote.com` (basé sur le slug). Zero configuration, instantané.

Le custom domain (`reserve.chezmario.fr`) reste une option premium avec le flux CNAME
décrit ci-dessus. Le subdomain gratuit est détecté par le middleware Connect **avant**
le flux custom domain, évitant tout lookup DB sur les sous-domaines Sokar.

### Configuration one-time (Cloudflare)

#### 1. Wildcard DNS record

Dans le dashboard Cloudflare → suppernote.com → DNS :

- Type : A
- Name : `*`
- IPv4 address : [IP du VPS]
- Proxy status : Proxied (orange cloud)

#### 2. Certificat Origin CA wildcard

Dans le dashboard Cloudflare → suppernote.com → SSL/TLS → Origin Server → Create Certificate :

- Private key type : RSA (2048)
- Hostnames : `*.suppernote.com, suppernote.com`
- Certificate Validity : 15 years
- Copier le cert et la key sur le VPS :
  - `/etc/letsencrypt/live/suppernote.com/fullchain.pem` (remplacer par le cert Origin CA)
  - `/etc/letsencrypt/live/suppernote.com/privkey.pem` (remplacer par la key Origin CA)
- Reload nginx : `sudo systemctl reload nginx`

#### 3. Vérification

```zsh
curl -s -o /dev/null -w '%{http_code}' -H 'Host: chez-sokar-demo.suppernote.com' http://127.0.0.1/
# Doit retourner 200
curl -s -o /dev/null -w '%{http_code}' -H 'Host: chez-suppernote-demo.suppernote.com' http://127.0.0.1/
# Doit retourner 200
```

### Widget de réservation sur un sous-domaine ou un domaine personnalisé

La fiche (`/`) vient de Connect, mais le bouton « Réserver » ouvre `/book/<slug>` : nginx
l'envoie au **dashboard**, comme sur `suppernote.com`, pour servir le même widget partout
(consentement marketing, liste d'attente). Seules ces routes vont au dashboard
(bloc `server_name _` de `infra/nginx/sokar.conf`) :

- `/book/<slug>`, `/widget/<slug>` ;
- `/api/proxy/public/…`, `/api/proxy/marketing/attribution/click`,
  `/api/proxy/restaurants/<id>/public` et `/api/proxy/restaurants/<id>/availability` ;
- `/_next/static/` (Connect sert ses fichiers sous `/connect-assets/`).

Tout le reste (`/dashboard`, les autres `/api/proxy/…`) reste chez Connect, qui le renvoie
vers la fiche. Sur ces routes publiques, le middleware du dashboard n'appelle pas Clerk
(`apps/dashboard/src/proxy.ts`) : un restaurateur connecté n'est jamais redirigé.

Vérification après déploiement :

```zsh
curl -s -o /dev/null -w '%{http_code}\n' https://chez-suppernote-demo.suppernote.com/book/chez-suppernote-demo
curl -s https://chez-suppernote-demo.suppernote.com/api/proxy/public/widget/chez-suppernote-demo | head -c 80
# Les mêmes vérifications restent valides sur le sous-domaine legacy :
curl -s -o /dev/null -w '%{http_code}\n' https://chez-sokar-demo.suppernote.com/book/chez-sokar-demo
curl -s https://chez-sokar-demo.suppernote.com/api/proxy/public/widget/chez-sokar-demo | head -c 80
# 200, puis un JSON qui commence par {"id":
```

Limite connue : la carte cadeau (`/widget/<slug>/gift-card`) reste chez Connect, qui la
renvoie vers la fiche sur un sous-domaine. C'était déjà le cas avant ce routage.

Retour arrière : le formulaire de Connect n'existe plus (supprimé le 26/10/2026). Pour revenir
à l'ancien routage, il faudrait restaurer ce code depuis l'historique git ; le simple retrait du
bloc nginx ci-dessus renverrait `/book/<slug>` vers une page introuvable.

### Flux restaurateur (zero clic)

1. Le restaurateur active Sokar Connect dans le dashboard
2. Le subdomain `{slug}.suppernote.com` est immédiatement fonctionnel (détecté par le middleware)
3. Le dashboard affiche le subdomain dans la carte « Sous-domaine gratuit » avec un bouton copier
4. Aucune action supplémentaire requise — le SSL est géré par le wildcard Origin CA

### Test en développement local

Le routing subdomain ne fonctionne pas en local sans configuration DNS. Pour tester :

1. Ajouter dans `/etc/hosts` :
   ```
   127.0.0.1 chezmario.localhost
   ```
2. Accéder à `http://chezmario.localhost:4002`
3. Le middleware détecte `localhost` comme primary host, donc le subdomain routing ne se déclenche PAS en local avec `localhost`. Pour tester réellement le subdomain routing en local, il faut modifier le middleware temporairement ou utiliser un tunnel (ngrok, cloudflared).
