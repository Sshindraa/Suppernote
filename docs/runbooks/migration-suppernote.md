# Passage de Sokar à Suppernote

Décision de Hamza du 3 novembre 2026 : la marque Sokar devient Suppernote et `sokar.tech` devient `suppernote.com`.

**État au 3 novembre 2026 :** bascule faite (PR #640 fusionnée). La production sert `suppernote.com` et `api.suppernote.com` ; `sokar.tech` redirige (301, 308 pour l'API) et relaie les webhooks. Il reste les points de la section « Reste à faire ».

## Ce qui ne change pas

Ces noms sont internes ou consommés hors du dépôt. Les renommer ne s'est pas justifié ici :

- dossiers `/opt/sokar`, sauvegardes, services et scripts `sokar-*`, base de données ;
- en-tête `X-Sokar-Site-ID`, `sokar-mcp`, noms d'outils MCP, champs d'API, événements analytics ;
- identifiant iOS `tech.sokar.ios` et projet Xcode ;
- migrations Prisma, journal `docs/obsidian/` et bancs voix.

## Renommage dans le dépôt

Les paquets privés utilisent `@suppernote/*` dans le workspace, le lockfile, la CI et les scripts. Exécuter `pnpm install --frozen-lockfile` avant d'utiliser le nouveau périmètre. La migration Prisma renomme l'affichage de « Chez Suppernote » uniquement pour le restaurant officiel dont le nom n'a pas été personnalisé. Son ID et son slug sont restés inchangés dans cette migration ; la mise à jour du slug est une étape distincte ci-dessous.

Le changement de slug est une mise à jour de données distincte, pas une migration Prisma automatique : l'ordre de qualification exige de la faire après les smoke tests de staging. Le seed refuse de créer un doublon tant que la fiche garde l'ancien slug.

Après le déploiement compatible, qualifier en staging les pages Connect, les widgets et les cartes cadeaux sur les deux slugs. Vérifier aussi que `/public/widget/chez-suppernote-demo` et `/public/widget/chez-sokar-demo` répondent tous deux 200. Ensuite seulement, sur la base staging explicitement choisie :

```zsh
psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 \
  --file packages/database/prisma/scripts/migrate-demo-slug.sql
```

Le SQL ne modifie que le champ `slug` du restaurant existant, refuse les collisions et accepte une seconde exécution après réussite. Refaire les smoke tests des deux slugs après la mise à jour. Ne l'exécuter en production qu'après cette qualification staging et la release compatible.

## Bascules techniques à qualifier séparément

| Surface                          | Étapes avant le retrait de l'ancien nom                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chemin VPS et services           | Installer la release dans un second chemin et basculer les unités, sauvegardes, permissions et outils de déploiement ensemble. Qualifier staging et tester un retour à l'ancienne release avant la production.                                                                                                                                                                                                                                                                                                                |
| Redis, queues et clés de hachage | Inventorier les préfixes par propriétaire et durée de vie. Prévoir une lecture compatible pour les jetons OAuth, conserver l'accès aux jobs en cours et qualifier la concurrence avec deux versions. Les préfixes des hachages persistés nécessitent un traitement par contrat.                                                                                                                                                                                                                                               |
| API et MCP                       | Ajouter les nouveaux noms avec compatibilité pour les en-têtes, clients, outils et événements actuels. Vérifier les clients existants et nouveaux en staging avant toute annonce de retrait.                                                                                                                                                                                                                                                                                                                                  |
| Slug de démo                     | `chez-suppernote-demo` est le slug canonique ; `chez-sokar-demo` reste un alias de lecture. API Connect, widget, cartes cadeaux, expériences, MCP, seed et liens émettent le nouveau slug, tandis que l’API résout les deux pendant la transition. Vérifier l’absence du nouveau slug en staging et production ; déployer d’abord la compatibilité, qualifier les deux URL en staging, puis seulement modifier la fiche staging. Requalifier les deux URL, puis appliquer la même mise à jour en production après la release. |

## Préalables, avant de fusionner la PR (faits le 3 novembre 2026)

La fusion déclenche le déploiement : `install-nginx` échoue si le certificat de `suppernote.com` manque.

1. Cloudflare : zone active, enregistrements `@`, `www`, `*`, `api`, `staging` et `api-staging` vers le VPS, proxifiés comme ceux de `sokar.tech`. Retirer les enregistrements de parking IONOS importés.
2. VPS : certificat `/etc/letsencrypt/live/suppernote.com/` couvrant ces noms ; conserver celui de `sokar.tech`, utilisé par les redirections.
3. Clerk : domaine `suppernote.com` en staging et en production, enregistrements `clerk` et `accounts`, adresses de redirection OAuth.
4. E-mails : domaines `suppernote.com` et `news.suppernote.com` vérifiés dans Resend (SPF, DKIM, DMARC) ; alias Google Workspace `privacy@`, `hello@`, `support@`, `dpo@`, `ops@`, `hamza@`.
5. Webhooks : ajouter les adresses `api.suppernote.com` chez Telnyx, Stripe et Meta sans retirer les anciennes. Mettre à jour les secrets Stripe si un nouveau point d'accès en crée. _(Le relais des anciennes adresses est en place ; Telnyx et Stripe sont basculés, Meta reste à vérifier.)_
6. `.env` de staging puis de production : `SITE_URL`, `API_URL`, `PUBLIC_API_URL`, `PUBLIC_URL`, `DASHBOARD_URL`, `CORS_ORIGINS`, `OAUTH_ISSUER_URL`, `EMAIL_FROM`, `MARKETING_EMAIL_FROM`, `MARKETING_UNSUBSCRIBE_BASE_URL`, `ALERT_EMAIL_TO`, `DEMO_REQUEST_NOTIFY_TO`, `CLOUDFLARE_SAAS_FALLBACK_ORIGIN`, `NEXT_PUBLIC_API_URL`. Les variables `NEXT_PUBLIC_*` imposent une reconstruction.

## Après la bascule

Fait le 3 novembre 2026 : redirections de `sokar.tech` vers `suppernote.com` (301) et de `api.sokar.tech` vers `api.suppernote.com` (308) ; webhooks (`/webhooks/`, `/whatsapp/webhook`, `/voice/`) non redirigés mais relayés à l'API par `api.sokar.tech`, car Stripe, Telnyx et Meta ne suivent pas les redirections.

## Reste à faire

- Webhooks fournisseurs : Telnyx et Stripe pointent vers `api.suppernote.com` (état communiqué le 4 novembre). Vérifier la configuration Meta et, si nécessaire, remplacer son adresse unique ; contrôler les POST signés sur les anciennes adresses avant de retirer le relais.
- Déclarer le changement d'adresse dans Google Search Console.
- Reconnecter les connecteurs MCP : l'adresse de l'émetteur OAuth change.
- Faire changer le CNAME des domaines personnalisés (cible `suppernote.com`) et prévenir les restaurants qui ont un widget.
- Le monogramme Suppernote remplace le logo du dashboard (PR #646) ; les anciennes URL SVG servent le nouveau visuel.
- App iOS : jamais publiée au 3 novembre 2026, donc rien à migrer ; à la première publication, vérifier que `suppernote.com` est traité comme un lien interne.

## Plan de bascule (exécuté le 3 novembre 2026)

Plan conservé pour mémoire et pour un éventuel retour arrière. Activité en production relevée le 3 novembre 2026 : 84 appels au total, tous de `Chez Sokar`, dernier le 25 octobre ; un seul utilisateur Clerk actif par semaine. La coupure de connexion touchait donc très peu de monde.

Avant (T-1 h) : CI de la PR verte ; crédit OpenRouter rechargé ; clé Clerk `sk_test` renouvelée ; sauvegardes `.env` (`*.bak-avant-suppernote-*`) et snapshot de release présents ; `pm2 jlist` relevé.

1. Staging : `.env` et `PUBLIC_API_URL_STAGING`, `pm2 delete`, `deploy-staging.yml` sur la branche, contrôle de `pm2 jlist`, smoke tests.
2. Clerk : `Change domain` vers `suppernote.com` (instance de production, domaine principal actuel `sokar.tech`). Poser dans Cloudflare, non proxifiés, les enregistrements demandés. Attendre la vérification et les certificats. Mettre à jour la redirection OAuth Google et la clé publique (secret GitHub et `.env`).
3. Cloudflare : remplacer A et AAAA de `@` (parking IONOS) par le VPS, proxifiés ; retirer les CNAME `autodiscover` et `_domainconnect` importés d'IONOS.
4. Production : `.env`, `pm2 delete`, fusion de la PR (déclenche le déploiement, reconstruction des `NEXT_PUBLIC_*`), `pm2 jlist`. La fusion s'est faite sur accord explicite de Hamza.
5. Contrôles : redirections `sokar.tech`, `POST api.sokar.tech` hors webhooks (308), POST signé sur chaque ancienne adresse de webhook (relais), désinscription marketing, connexion, appel de test, connecteur MCP.
6. Fournisseurs : adresses `api.suppernote.com` chez Stripe et Telnyx ; configuration Meta à vérifier (remplacement de son adresse unique si nécessaire).

Retour arrière : restaurer les `.env` d'avant, `pm2 delete`, `scripts/deploy.sh --env prod rollback`. Le DNS de `@` peut rester ; `sokar.tech` continue de servir via les anciens vhosts tant que la release précédente est restaurée. Clerk : le retour au domaine `sokar.tech` n'est pas testé, à vérifier avant le créneau.

## `sokar.tech` (ancien domaine)

Garder le domaine renouvelé et les redirections au moins 12 mois à partir du 3 novembre 2026 (donc jusqu'au 3 novembre 2027), puis garder le renouvellement : un tiers qui le rachèterait recevrait les liens déjà envoyés et les e-mails adressés aux anciennes adresses.

## PM2 fige d'anciennes valeurs

`pm2 restart` garde les variables enregistrées au dernier démarrage, et elles priment sur `.env`. Après avoir changé `.env`, dans un shell qui n'a pas chargé `.env` : `pm2 delete` des processus concernés, relancer le déploiement, puis vérifier `pm2 jlist`. Constaté en staging le 3 novembre 2026 ; la production doit suivre la même étape.

## Retour arrière pendant la transition

L'ancien code refuse les adresses `suppernote.com` au démarrage. Revenir à une version antérieure à cette PR impose de restaurer aussi le `.env` d'avant (`*.bak-avant-suppernote-*`), puis `pm2 delete` et redémarrage. Le premier test de retour arrière du workflow staging échoue pour cette raison ; il passe dès que la release précédente contient cette PR.

## Ne pas figer le staging sur le nouveau domaine avant la fusion

Leçon de la bascule, utile pour toute prochaine migration de domaine. Avant la fusion, le code de `main` refusait `suppernote.com`. Si le `.env` de staging y passe avant la fusion, tout déploiement de `main` échoue en staging et la production ne reçoit plus rien (constaté le 3 novembre 2026 avec #606). Pour qualifier la branche : changer `.env` et `PUBLIC_API_URL_STAGING`, lancer `deploy-staging.yml` sur la branche, puis tout remettre et relancer `main`. Le passage définitif du staging se fait juste avant la fusion.

Qualifié ainsi le 3 novembre 2026 : déploiement, smoke tests et E2E verts, retour arrière vert sur la branche. Non testés : connexion réelle, webhooks entrants.
