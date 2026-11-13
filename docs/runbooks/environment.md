# Runbook — Environment

> **Statut : ACTIF — audité le 13 septembre 2026.** Les versions locales sont indicatives ; lancer
> `node --version`, `pnpm --version` et `pnpm node:check` avant un diagnostic d'environnement. Voir
> [`../DOCUMENTATION_STATUS.md`](../DOCUMENTATION_STATUS.md).

## Node version

- Repo constraint: `>=20.0.0 <23.0.0` (root `package.json` engines).
- `.nvmrc` = `22`.
- `.npmrc` has `engine-strict=true` — `pnpm` refuses to run under Node 26+.
- Local Mac vérifié le 12 septembre 2026 : Node 22.23.2 est le défaut à `~/.local/bin/node`
  (symlink vers `~/.hermes/node/bin/node`). Aucun préfixe PATH n'est nécessaire pour `pnpm`.
- pnpm 10.33.3 installed via `npm i -g pnpm@10.33.3`, symlinked at `~/.local/bin/pnpm`.

## Convention

- One `.env` file per app, sourced at startup. No `.env.prod`.
- `NEXT_PUBLIC_*` is baked at build time — must be present during `next build`, not only at runtime.
- Deploy scripts fail-fast if a critical `.env` is missing (API, dashboard, connect).
- `packages/database/.env` is the only intentional duplicate: Prisma CLI does not follow symlinks and does not read `.env.local` from the root.

### Recherche d'établissement Google Places

- La recherche facultative d'établissement utilise `GOOGLE_PLACES_API_KEY` côté API uniquement.
  Activer Places API (New) et restreindre la clé à cette API et aux IP des serveurs; ne jamais la
  exposer dans `NEXT_PUBLIC_*` ou le navigateur.
- L'API onboarding reste fermée tant que `GOOGLE_PLACES_ONBOARDING_ENABLED` n'est pas explicitement
  à `true`; sa valeur d'exemple est `false`.
- Les résultats de Places ont des règles d'attribution et de conservation propres à Google Maps.
  Avant activation en production, valider les conditions EEE, la conservation des champs importés,
  l'attribution, l'usage conjoint avec la carte OpenStreetMap de Connect et les mentions publiques
  de conditions d'utilisation et de confidentialité.

## MCP et OAuth

- `OAUTH_ISSUER_URL` est une URL validée au démarrage. En son absence, `API_URL` sert d'issuer ;
  les métadonnées OAuth ne retombent plus sur localhost en production.
- `MCP_ALLOWED_ORIGINS` est une liste facultative d'origines navigateur supplémentaires, séparées
  par des virgules et validées au démarrage. Les origines MCP connues sont déjà autorisées sur
  `/mcp`, y compris pour le preflight CORS. `CORS_ORIGINS` continue de protéger les autres routes.
- Les échecs d'authentification MCP sont limités à 30 par minute et par IP ; un token valide est
  ensuite soumis au budget partagé de 60 requêtes par minute et par client.

## Files

| File                         | Role                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `.env.local` (root)          | `DATABASE_URL`, `REDIS_URL`, `POSTGRES_PASSWORD`                                  |
| `packages/database/.env`     | `DATABASE_URL` for Prisma CLI (`db:push`, `db:seed`, `db:studio`)                 |
| `apps/connect/.env`          | Connect dev vars (`SITE_URL`, `API_URL`, `NEXT_PUBLIC_API_URL`, `PUBLIC_API_URL`) |
| `apps/api/.env` (prod)       | All API vars (Telnyx, Deepgram, Cartesia, DB, Redis, etc.)                        |
| `apps/dashboard/.env` (prod) | Clerk keys, `API_URL`, Sentry                                                     |
| `apps/connect/.env` (prod)   | `SITE_URL`, `API_URL`, `NEXT_PUBLIC_API_URL`, `DASHBOARD_URL`                     |

## Base de données locale

La base de dev (`sokar`) est gérée par `pnpm db:push`, pas par migrations : elle n'a **aucun
historique** dans `_prisma_migrations`. `prisma migrate status` liste donc les 78 migrations comme
« non appliquées » alors que le schéma est bien en place. C'est attendu, et il ne faut pas chercher
à corriger ce chiffre.

- Pour synchroniser le schéma local : `pnpm db:push`. Jamais `prisma migrate deploy` en local, qui
  tenterait de recréer toutes les tables par-dessus l'existant.
- `pnpm db:push` refuse toute cible non locale depuis le 21 septembre 2026
  (`scripts/quality/check-db-push-target.mjs`, chantier R1-5). Sur une base partagée, écrire une
  migration et la déployer. Le forçage existe pour une base de test distante jetable :
  `SOKAR_ALLOW_REMOTE_DB_PUSH=I-UNDERSTAND-DB-PUSH-IS-DESTRUCTIVE`. Voir
  [`migration.md`](./migration.md).
- `db:push` peut réclamer `--accept-data-loss` pour un simple index unique : vérifier le diff avant
  d'accepter avec
  `prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script`.
  Il doit être purement additif — aucun `DROP`, aucun `ALTER COLUMN ... TYPE`.
- `sokar_preview` suit la même logique ; elle était à jour au 21 septembre 2026.
- Sauvegarder avant toute synchro : `pg_dump` doit être en version 17
  (`/opt/homebrew/opt/postgresql@17/bin/pg_dump`). Le binaire 16 du `PATH` refuse de dumper un
  serveur 17 (« server version mismatch »).

### Clé Clerk staging

La clé Development est stockée dans le secret GitHub Actions `CLERK_SECRET_KEY`
(préfixe `sk_test_`). Le workflow `Deploy Staging` valide le préfixe, transfère
temporairement le secret vers le VPS avec des permissions strictes, puis appelle
`scripts/ops/sync-env.sh clerk`, qui met à jour atomiquement les deux fichiers
privés du VPS et supprime le fichier de transport :
`/opt/sokar-staging/apps/api/.env` et
`/opt/sokar-staging/apps/dashboard/.env`. Ces fichiers ne sont pas suivis par
Git et ne doivent jamais être créés dans le dépôt ou copiés dans le navigateur.
La production utilise un secret live séparé ; le workflow de production ne
réutilise pas la clé staging.

### Numéros Telnyx (admin Provisioning)

L'attribution d'un numéro à un restaurant (`POST /admin/provisioning/:id/assign-phone`) relie
le numéro à l'application voix Telnyx avec `TELNYX_CONNECTION_ID` (l'identifiant de
l'application Call Control qui envoie les appels à `/voice/telnyx`). Sans cette variable, ou si
le numéro est saisi à la main plutôt que choisi dans l'inventaire, le numéro est attribué dans
Sokar mais ne reçoit aucun appel : la page Provisioning affiche alors un avertissement et il
faut le relier dans le portail Telnyx. `TELNYX_APP_ID` figure dans les exemples mais n'est lu
par aucun code ; il désigne probablement le même identifiant, à confirmer dans le portail avant
de les fusionner.

La liste des numéros vient du compte Telnyx (toutes les pages). Sans `TELNYX_API_KEY`, un jeu de
numéros fictifs n'est proposé qu'en développement ; ailleurs, la liste est vide et la page
l'indique.

### Alerting de production

Les secrets GitHub de l’environnement `production` (et, si souhaité, `staging`)
peuvent fournir `SENTRY_DSN`, `ALERT_EMAIL_TO`, `ALERT_WEBHOOK_URL` et
`ALERT_SMS_TO`. Le workflow les synchronise vers `apps/api/.env` sans les
afficher. `ALERT_WEBHOOK` et `HEALTHCHECKS_PING_URL` alimentent le watchdog VPS
dans `/etc/sokar/watchdog.env`, fichier root lisible uniquement par le cron.
Si aucun secret n’est défini, le déploiement conserve la configuration existante.

### Régulation Resend (préparation locale du 16 octobre 2026)

Le transport partagé régule les créations et les lectures d'e-mails : un départ au
plus toutes les 150 ms, coordonné par Redis entre API et workers. Il attend au plus
5 secondes avant de refuser une requête qui n'a pas encore contacté Resend.
Une panne Redis refuse également l'admission ; aucun envoi différé ne survient après
ce refus. Les jobs persistants conservent leurs mécanismes de reprise existants ;
un appel direct (dont la notification démo) peut rester en échec, sans reprise ajoutée.
Un timeout fournisseur reste ambigu : pas de rejeu automatique ajouté par le transport.

Par défaut, la coordination utilise `redisCache` de l'environnement. Si plusieurs
environnements partagent la même équipe Resend, définir **le même**
`RESEND_RATE_LIMIT_REDIS_URL` (URL Redis secrète, même base logique) dans chaque
processus API/worker concerné. Le raccordement préparé localement transmet le secret
GitHub `RESEND_RATE_LIMIT_REDIS_URL` via les deux workflows et
`scripts/ops/sync-env.sh alerting`. Une valeur absente conserve l'existant ; une
valeur fournie doit désigner explicitement une base (`redis[s]://hôte:port/numéro`),
sans espaces, fragment, paramètres ni caractères nécessitant une citation dotenv.
Encoder les caractères réservés des identifiants dans l'URL.

Constat du 16 octobre 2026 après autorisation : secret **de dépôt** configuré
(le workflow staging n'est lié à aucun environnement GitHub), valeur commune ajoutée
aux deux `.env` API, permissions 0600. Coordination sur la base cache 1 du Redis
existant, clé de régulation dédiée ; bases sessions/files et clés métier inchangées.
Test isolé sur le serveur avec deux clients lisant ces configurations : 30 admissions,
espacement minimum 150 ms, clé temporaire supprimée, aucun appel Resend.
Mise à jour après livraison : PR #463 fusionnée, commit `e5eb3520` livré en staging
puis production après CI et smoke tests verts. API et workers en ligne, santé
base/Redis/files OK. Clé staging distincte créée sur confirmation spécifique,
Sending access limité à `suppernote.com`, secret `RESEND_API_KEY_STAGING` et `.env`
staging configurés ; clé production et allowlist inchangées. Le nouvel artefact
staging a groupé deux alertes dans un e-mail accepté vers l'adresse de test
fournisseur, puis supprimé leur répétition. Admission production vérifiée sans
appel fournisseur. Les erreurs et jobs historiques ne sont ni purgés ni corrigés.
Voir `docs/runbooks/resend-alert-regulation.md` pour la qualification et le retour arrière.

Retour arrière de cette préparation : les trois entrées de coordination étaient
absentes avant l'opération. Retirer uniquement la variable ajoutée des deux `.env`
et le secret de dépôt homonyme, après vérification qu'ils n'ont pas été modifiés
depuis. Ne pas restaurer un `.env` complet ni effacer les autres paramètres.
Ne pas le déduire de la clé API : plusieurs clés peuvent partager la limite d'une
équipe. Les appels hors de ce transport (console, scripts externes) ne sont pas régulés.
La marge sous 10 req/s ne garantit pas l'absence de 429 et n'augmente aucun quota.

Le worker `system-health` groupe les findings éligibles du tick dans un e-mail.
Rappel e-mail après deux heures par `(kind, identifier, severity)` ; une autre file
ou une escalade critique possède une entrée distincte. Même après un bref retour
à la normale, une réapparition de la même combinaison reste soumise à ce délai.
Logs/Sentry, webhook et SMS conservent une cadence de 30 minutes, distincte du
résultat e-mail. Une tentative refusée n'acquiert pas le rappel de deux heures :
seulement un verrou court de 60 secondes, puis réévaluation au tick suivant.
Les autres émetteurs d'alertes, dont `alert-evaluation`, gardent leur cadence actuelle.
Aucune file historique n'est purgée ni rejouée, aucun incident n'est corrigé par ce regroupement.

### Notification des demandes de démonstration

`DEMO_REQUEST_NOTIFY_TO` (adresses séparées par des virgules) reçoit une notification pour chaque
demande envoyée depuis `/demo`. Sans valeur, aucune notification n'est envoyée : la demande reste
enregistrée et apparaît comme « Notification non envoyée » dans `/dashboard/admin/demo-requests`.
L'envoi utilise `RESEND_API_KEY` et `EMAIL_FROM`. Le destinataire est choisi par le responsable
commercial avant l'ouverture de la vitrine. Il se définit comme secret GitHub
`DEMO_REQUEST_NOTIFY_TO` des environnements staging et production ; le script
`scripts/ops/sync-env.sh demo-request` le copie dans le `.env` de l'API à chaque
déploiement, sans l'afficher. Sans secret, la configuration existante est conservée.

Ces canaux servent au monitoring interne de Sokar. Ils ne constituent pas une
notification client et ne peuvent pas limiter la consommation d'un restaurant.
La promesse Essential/Pro reste sans quota ; le suivi visuel par établissement
se fait dans l'espace opérateur séparé `/admin/margin` (l'ancienne URL
`/dashboard/admin/margin` redirige les opérateurs vers cette surface). Les variables optionnelles
`USAGE_ALERT_VOICE_BUDGET_MINUTES` et `USAGE_ALERT_SMS_BUDGET_SEGMENTS` ne
définissent que des budgets de cost-watch opérateur.

### Espace opérateur Sokar

Le dashboard restaurant et l'espace opérateur ont des URLs et des layouts distincts :

- `https://suppernote.com/dashboard` pour un établissement ;
- `https://suppernote.com/admin` pour l'équipe Sokar.

Les pages `/admin/*` et les routes API `/admin/*` exigent un identifiant Clerk présent dans
`SOKAR_OPERATOR_USER_IDS`, une liste CSV injectée uniquement dans l'environnement de l'API par
`scripts/ops/sync-env.sh operator` depuis la variable GitHub Actions de l'environnement.
En développement local, `apps/api/.env` autorise explicitement l'utilisateur de démonstration
`dev-user`; cette valeur ne doit jamais être utilisée en production. Un membre de restaurant qui
ouvre une ancienne URL `/dashboard/admin/*` est renvoyé vers son dashboard.

Le feed interne de coûts `/api/internal/usage/margin` exige un secret séparé
`SOKAR_INTERNAL_USAGE_TOKEN`. Il est injecté uniquement dans l'environnement
de l'API opérateur et envoyé dans l'en-tête `x-sokar-internal-usage-token`.
Sans ce secret, la route répond `503`; elle ne doit jamais être ajoutée à un
écran ou une intégration client.

`RESERVATION_SERVICE_TOKEN` protège la route legacy `POST /reservations`. Il
doit être généré et injecté uniquement par le secret manager (au moins 32
caractères), jamais dans le dépôt, le navigateur ou les payloads Connect. Les
workflows staging et production le synchronisent vers `apps/api/.env` via
`scripts/ops/sync-env.sh reservation`. Le pipeline vocal n'en a pas besoin :
il appelle `ReservationService` dans le processus API.

Pour la télémétrie Service Copilot, définir `SERVICE_COPILOT_TELEMETRY_SECRET` dans l’environnement
de l’API (valeur aléatoire d’au moins 32 caractères). Elle signe les jetons de recommandation ; ne pas
la réutiliser pour un autre usage et ne jamais la mettre dans une variable `NEXT_PUBLIC_*`.

### Marketing CRM local

Les variables suivantes sont nécessaires uniquement pour le contrôle marketing CRM en local ou en
staging contrôlé. Elles ne doivent jamais être committées ni exposées au dashboard :

| Variable                         | Rôle et défaut sûr                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MARKETING_ATTRIBUTION_SECRET`   | Secret HMAC des liens d'attribution, au moins 32 caractères ; absence = liens refusés.                                                                                                                                                                                                                                                                                                                                            |
| `MARKETING_UNSUBSCRIBE_SECRET`   | Secret HMAC des désinscriptions, au moins 32 caractères ; à séparer du secret d'attribution en environnement réel.                                                                                                                                                                                                                                                                                                                |
| `MARKETING_UNSUBSCRIBE_BASE_URL` | URL absolue optionnelle de la route publique de désinscription ; sinon `API_URL/marketing/unsubscribe`.                                                                                                                                                                                                                                                                                                                           |
| `MARKETING_OPTOUT_HASH_SECRET`   | Clé HMAC du registre d'opposition marketing (`marketing_opt_outs`), au moins 32 caractères, distincte des autres secrets ; absence ou clé trop courte = **aucun message marketing n'est envoyé** (`OPT_OUT_REGISTER_UNAVAILABLE`) et l'aperçu d'audience le signale. **À sauvegarder** : changer ou perdre la clé rend le registre inutilisable. Posée à la main dans `apps/api/.env` du VPS, comme les autres secrets marketing. |
| `MARKETING_SENDS_ENABLED`        | `false` par défaut ; seul `true` autorise les routes et le worker à appeler un fournisseur.                                                                                                                                                                                                                                                                                                                                       |
| `MARKETING_WHATSAPP_ENABLED`     | `false` par défaut ; doit rester `false` tant que le template et le compte WhatsApp ne sont pas qualifiés.                                                                                                                                                                                                                                                                                                                        |
| `MARKETING_RECIPIENT_ALLOWLIST`  | Vide par défaut (aucune restriction). Adresses e-mail ou numéros séparés par des virgules : seuls ces contacts reçoivent un message marketing (tous restaurants), les autres sont annulés `NOT_IN_TEST_ALLOWLIST`. Ne touche pas les e-mails transactionnels, contrairement à `EMAIL_TEST_ALLOWLIST`. Voir `marketing-email-pilot.md`.                                                                                            |
| `MARKETING_EMAIL_FROM`           | Expéditeur dédié aux seuls e-mails marketing, par exemple `bonjour@news.suppernote.com` (adresse seule : le nom affiché est celui du restaurant). Absent = aucun envoi marketing (`MARKETING_EMAIL_FROM_MISSING`, la campagne reste prête) ; Adresse seule, validée au démarrage ; jamais de repli sur `EMAIL_FROM`.                                                                                                              |
| `MARKETING_EMAIL_DAILY_BUDGET`   | Budget quotidien global des e-mails marketing, toute la plateforme (jour UTC), `40` par défaut. Entier ≥ 0, validé au démarrage. Une campagne dont l'audience dépasse le reste du jour est refusée au lancement (envoi immédiat ou programmation). Garde le quota Resend Free, partagé avec les transactionnels, hors de portée du marketing. Voir `marketing-email-pilot.md` §3.                                                 |
| `RESEND_WEBHOOK_SECRET`          | Secret de signature (Svix) du webhook Resend `POST /marketing/webhooks/resend` ; absent = `503`. À poser à la main dans l'`.env` du VPS (aucun workflow ne le propage).                                                                                                                                                                                                                                                           |
| `WHATSAPP_ENABLED`               | `false` par defaut. Rappel WhatsApp J-1 uniquement pour WEB avec accord et fournisseur qualifie (`WHATSAPP_PROVIDER`). Aucun rappel SMS, y compris en secours.                                                                                                                                                                                                                                                                    |
| `TELNYX_WHATSAPP_FROM`           | Expediteur WhatsApp dedie requis, distinct de la configuration voix ; aucun repli implicite sur `TELNYX_FROM_NUMBER`. Voir `whatsapp-reservation-activation.md`.                                                                                                                                                                                                                                                                  |
| `WHATSAPP_PROVIDER`              | `telnyx` par defaut ; `meta` selectionne la Cloud API directe, sans modifier les SMS/voix.                                                                                                                                                                                                                                                                                                                                        |
| `WHATSAPP_CONSENT_ENABLED`       | `false` par defaut ; autorise la collecte facultative de l'accord pour le rappel dans les deux parcours web. Ne declenche pas d'envoi a lui seul.                                                                                                                                                                                                                                                                                 |
| `RESERVATION_MANAGEMENT_ENABLED` | `false` par defaut. Page personnelle et lien dans la confirmation SMS/web ; requiert cle et routage Dashboard qualifies. Voir `reservation-management.md`.                                                                                                                                                                                                                                                                        |
| `RESERVATION_MANAGEMENT_SECRET`  | Secret dedie aleatoire 32 octets, encode en 64 caracteres hexadecimaux, `key_env` uniquement. Identique API/workers, stable entre releases ; rotation = invalidation des liens existants. Aucun secret reel configure dans ce lot.                                                                                                                                                                                                |
| `TEST_BOOKING_ENABLED`           | Drapeau de la reservation test d'onboarding (`true` pour activer). Defaut `false` : les boutons ouvrent la page publique comme avant.                                                                                                                                                                                                                                                                                             |
| `TEST_BOOKING_SECRET`            | Secret dedie aleatoire 32 octets, encode en 64 caracteres hexadecimaux, `key_env` uniquement. Signe les jetons de lien test (validite 1 h) ; rotation = invalidation des liens en cours. Aucun secret reel configure dans ce lot.                                                                                                                                                                                                 |
| `META_WHATSAPP_ACCESS_TOKEN`     | Secret du compte Meta direct (`key_env` uniquement), absent tant que le compte n'est pas qualifie. Ne pas utiliser la cle Telnyx.                                                                                                                                                                                                                                                                                                 |
| `META_WHATSAPP_PHONE_NUMBER_ID`  | Identifiant Meta du numero, pas le numero de telephone ni le WABA.                                                                                                                                                                                                                                                                                                                                                                |
| `META_WHATSAPP_GRAPH_VERSION`    | Version Graph explicite au format `vN.N`, a qualifier avant activation ; pas de selection automatique de version.                                                                                                                                                                                                                                                                                                                 |
| `META_WHATSAPP_WEBHOOK_ENABLED`  | `false` par defaut. Active uniquement les callbacks signes `/webhooks/meta/whatsapp`, pas les envois.                                                                                                                                                                                                                                                                                                                             |
| `META_WHATSAPP_APP_SECRET`       | Secret d'application Meta, `key_env` uniquement ; HMAC SHA-256 du corps brut obligatoire.                                                                                                                                                                                                                                                                                                                                         |
| `META_WHATSAPP_VERIFY_TOKEN`     | Secret aleatoire de verification de l'abonnement GET, `key_env` uniquement. Ne jamais copier une URL contenant ce secret dans les logs ou captures.                                                                                                                                                                                                                                                                               |
| `META_WHATSAPP_WABA_ID`          | Identifiant du compte WhatsApp autorise pour les callbacks ; filtre cumule avec `META_WHATSAPP_PHONE_NUMBER_ID`.                                                                                                                                                                                                                                                                                                                  |
| `SOKAR_INTERNAL_MARKETING_TOKEN` | Jeton opérateur séparé pour `/api/internal/marketing/reconciliation`; absent = route désactivée (`503`).                                                                                                                                                                                                                                                                                                                          |
| `CRM_SENSITIVE_NOTE_ROLES`       | Fallback CSV des rôles pouvant lire les notes CRM ; `OWNER,MANAGER` par défaut. Une surcharge par site se configure via `PATCH /crm/privacy` (Owner).                                                                                                                                                                                                                                                                             |

### POS, paiements et CRM groupe en qualification

Ces flags sont indépendants des entitlements et doivent rester fermés dans les environnements
suivis tant qu'un pilote n'a pas produit ses preuves externes :

| Variable                       | Défaut sûr          | Ce que l'ouverture autorise                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POS_CONNECTORS_ENABLED`       | `false`             | Routes POS provider-neutral, import de tickets et matcher ; aucun fournisseur n'est appelé sans adaptateur qualifié. Posé à `"true"` sur staging et en production le 2026-11-10 (import CSV seul) ; la valeur par défaut reste `false`.                            |
| `RESERVATION_PAYMENTS_ENABLED` | `false`             | Empreinte bancaire de réservation (routes dashboard). Les événements arrivent par l'endpoint Connect `/webhooks/stripe` : y abonner `setup_intent.succeeded`, `payment_intent.*`, `charge.refunded`, `charge.dispute.*`. À retirer après la qualification sandbox. |
| `CUSTOMER_GROUPS_ENABLED`      | `false`             | API d'identité de groupe Multi-site, sous consentement ; aucun rapprochement automatique ni campagne inter-sites n'est activé.                                                                                                                                     |
| `REPUTATION_EMAIL_SECRET`      | requis pour l’envoi | Secret aléatoire (32 caractères minimum), conservé hors Git ; à configurer avant déploiement sur chaque environnement.                                                                                                                                             |
| `EXPERIENCES_ENABLED`          | `false`             | Catalogue et gestion interne des expériences, sessions et réservations.                                                                                                                                                                                            |
| `EXPERIENCE_BOOKING_ENABLED`   | `false`             | Parcours public de réservation et paiement intégral Stripe Connect ; exige aussi `EXPERIENCES_ENABLED=true`.                                                                                                                                                       |
| `EVENTS_ENABLED`               | `false`             | Catalogue, sessions, tarifs, jauges, billets, check-in et liste d'attente ; aucun paiement, facture fiscale, notification ou canal de distribution n'est déclenché par le socle.                                                                                   |
| `DISTRIBUTION_ENABLED`         | `false`             | Connexions, snapshots, runs, liens et inbox webhook provider-neutral ; aucun OAuth, secret fournisseur, webhook public ou appel Google/Meta/API n'est déclenché par le socle.                                                                                      |

Avant toute ouverture, vérifier la capability correspondante (`pos.connect`,
`reservations.payments`, `customers.group`, `reputation.feedback`, `reputation.loyalty` ou
`experiences.manage`, `events.manage` ou `distribution.manage`), le
rôle Owner/Manager/Staff adapté à l'opération, le backup, le plan de rollback et le compte de test
explicitement autorisé. Les secrets fournisseur restent dans le gestionnaire
de secrets ; aucune valeur ne doit être ajoutée aux fichiers `.env.example`.

Le flag d'envoi est indépendant des entitlements : un restaurant Pro peut préparer et rapporter une
campagne sans qu'un provider externe soit appelé. Tout changement de secret ou de flag doit être
rejoué sur un environnement non productif, avec consentement de test et rollback documenté.

## Voice LLM

Le chemin vocal a un seul fournisseur LLM : **Cerebras** (API OpenAI-compatible,
modèle Qwen 3.8). Groq a été retiré le 27 septembre 2026 ; `GROQ_*`,
`VOICE_LLM_HEDGE_*` et `VOICE_LLM_FALLBACK_MODEL` ne sont plus lus, et
`VOICE_LLM_PROVIDER=groq` est refusé au démarrage.

Définir dans `apps/api/.env` :

```dotenv
VOICE_LLM_PROVIDER="cerebras"        # seule valeur acceptée (défaut)
CEREBRAS_API_KEY="csk-..."
CEREBRAS_BASE_URL="https://api.cerebras.ai/v1"
VOICE_LLM_MODEL="qwen-3.8-27b"
VOICE_LLM_TIMEOUT_MS="8000"
# Adresse de Prometheus lue par la page admin « Capacité et système » (courbes). Défaut : le Prometheus local.
# PROMETHEUS_URL="http://127.0.0.1:9090"
# Seuil d'appels vocaux simultanés par process API : CALCULÉ (capacity-model.ts) à partir du coût CPU et mémoire
# mesuré sur les appels réels et de la limite mémoire PM2 (PROCESS_MEMORY_LIMIT_MB, posée par l'écosystème).
# Ne le définir que pour IMPOSER une valeur ; le dashboard admin (Capacité vocale) la remplace aussi.
# Suivi : alerte à 50 % puis 70 % du seuil selon le pic sur 7 jours ; au seuil, dernier filet : message
# d'occupation puis raccroché.
# VOICE_MAX_CONCURRENT_CALLS="80"
# Premier fragment du modèle principal (tour structuré) : au-delà, OpenRouter prend le tour (500 à 8000 ms).
VOICE_LLM_FIRST_CHUNK_TIMEOUT_MS="2500"
```

En production, `CEREBRAS_API_KEY` est obligatoire (≥20 caractères). Les
clés sont des secrets locaux au VPS, jamais commités ni envoyés dans le chat.

Modèle principal du tour structuré (depuis le 22/10/2026, pour tous les restaurants, sans liste) :
GPT-6 Luna via OpenRouter, dès que `OPENROUTER_API_KEY` est présente, avec les réglages
`VOICE_STRUCTURED_FALLBACK_*` (fournisseur le plus rapide d'abord, sans raisonnement). Le tour part en deux
requêtes OpenRouter identiques ; le premier texte gagne. Cerebras (`VOICE_LLM_MODEL`) devient le doublon
après `VOICE_LLM_OPENROUTER_PRIMARY_HEDGE_MS` (0 = seulement en repli) et le repli immédiat si OpenRouter
refuse (401, 402, 403 : alerte « secours OpenRouter refusé »). Sans `OPENROUTER_API_KEY`, Cerebras reste seul.
Le juge de fin de tour passe toujours par Cerebras : son crédit reste indispensable.

```dotenv
OPENROUTER_API_KEY=<clé OpenRouter, secret local au VPS>
OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"        # défaut ; Jev (API decisions), juge d'évaluation, suivi de crédit
# Hébergeurs du repli : par défaut, le code exige zéro conservation des données (`zdr`, `data_collection: deny`).
# VOICE_STRUCTURED_FALLBACK_MODEL="qwen/qwen3.8-27b"           # même modèle que Cerebras (banc du 20/10)
# VOICE_STRUCTURED_FALLBACK_PROVIDER_ORDER="ModelRun"          # 0,5 s, jamais au-delà de 0,8 s sur 40 tours
# VOICE_STRUCTURED_FALLBACK_PROVIDER_IGNORE="DekaLLM"          # jamais utilisés, même en secours (données hors pays admis)
# VOICE_STRUCTURED_FALLBACK_ZERO_RETENTION="false"            # défaut true ; false = performance d'abord (décision du 20/10)
# Relais GPT-6 Luna (accès prioritaire OpenAI) : 133/134 au banc, le moins « IA » à l'écoute, ~0,8 s, max 1,4 s.
# VOICE_STRUCTURED_FALLBACK_MODEL="openai/gpt-6-luna"  VOICE_STRUCTURED_FALLBACK_PROVIDER_ORDER="openai/fast"
# VOICE_STRUCTURED_FALLBACK_REASONING="none"   # défaut disabled ; Luna exige un effort nul
# VOICE_STRUCTURED_FALLBACK_SAMPLING="false"   # défaut true ; Luna refuse temperature et top_p
# Délai avant le doublon Cerebras (défaut 1500 ; Luna ~0,8 s, pire mesuré 1,4 s ; prod : 0, Cerebras en repli seul).
# Deux requêtes Luna par tour, banc du 20/10 (40 paires) : moyenne 1,04 → 0,92 s, pire tour 2,48 → 1,37 s ;
# ~0,00015 $ de plus par tour.
# VOICE_LLM_OPENROUTER_PRIMARY_HEDGE_MS="1500"
# Adresse du SEUL secours vocal (tour structuré, chemin à outils, doublon de hedging) ; vide = OPENROUTER_BASE_URL.
# Routage UE : https://eu.openrouter.ai/api/v1. Séparée parce que Jev n'existe pas en UE (decisions répond 404).
# Mesure du 01/10 : voir docs/runbooks/provider-resilience.md (un seul hébergeur UE pour le modèle de repli).
OPENROUTER_FALLBACK_BASE_URL=""
VOICE_STRUCTURED_FALLBACK_MODEL="deepseek/deepseek-v4-flash-0731"  # défaut ; modèle de repli OpenRouter du tour structuré ET du chemin à outils (autres restaurants)
# Hébergeurs du repli, dans l'ordre (vide = tri par latence historique, instable : pointes de 5 à 30 s le 29/09).
VOICE_STRUCTURED_FALLBACK_PROVIDER_ORDER="Cohere,Wafer,Baidu"
```

Latence du tour structuré (mesures du 27 septembre, appel 25650799 et rejeu des
appels enregistrés) :

```dotenv
# Premier passage lancé sur une partielle Deepgram stable, repris seulement si
# la requête finale est identique (rien n'est dit ni exécuté avant). Toujours actif.
VOICE_STRUCTURED_SPECULATION_MS="250"
# Spéculation à la pause : la requête part dès que l'appelant a été silencieux ce délai (détecteur de
# voix sur l'audio entrant), pas 250 ms après la dernière partielle, et pas pendant qu'il parle ;
# ainsi la réponse est prête pendant l'attente avant le premier son (VOICE_FIRST_AUDIO_SILENCE_MS).
# 0 : ancien déclenchement (VOICE_STRUCTURED_SPECULATION_MS). Plafond de requêtes spéculatives
# par tour (~3 k tokens chacune ; la clé Cerebras est limitée à 150 k tokens/minute).
# Métriques : sokar_voice_structured_speculation_total{outcome=hit|miss_*|none},
# sokar_voice_structured_speculation_launch_total{result=started|capped}.
VOICE_STRUCTURED_SPECULATION_PAUSE_MS="150"
VOICE_STRUCTURED_SPECULATION_MAX_LAUNCHES="3"
# Reprise de l'anticipation malgré un écart sans conséquence entre la partielle et la finale (tous les
# restaurants depuis le 22/10, sans réglage) : ponctuation et casse, « s'il vous plaît » complet en fin de phrase, mot outil répété
# (« pour pour »). Même état, même historique, même schéma exigés ; tout chiffre, jour, heure, nom, lettre
# épelée, négation, « euh », « merci » ou question ajoutée refuse la reprise (rejeu GPT-6 Luna du 20/10/2026).
# Métrique : sokar_voice_structured_speculation_total{outcome=hit_tolerant}.
# Partielle Deepgram figée : Finalize après ce délai (appel 25650799 : 8 s).
VOICE_DEEPGRAM_STALL_FINALIZE_MS="1200"
# Même chose pour une partielle d'un ou deux mots (« 4 », « oui », « demain ») :
# appel c5d6b07d, « 4 » attendait 2,7 s. Une fin trop tôt est rattrapée par le tour
# structuré (turnComplete=false, fragment recollé). Défaut : égal au délai normal.
VOICE_DEEPGRAM_SHORT_STALL_FINALIZE_MS="1200"
# Relève au silence (tous les restaurants depuis le 22/10) : quand l'appelant a parlé, se tait depuis
# VOICE_DEEPGRAM_SILENCE_FLUSH_MS et que Deepgram n'a rendu aucun texte, `Finalize` lui fait rendre le mot
# qu'il retient (« midi 30 » arrivé 2,1 s après le dernier mot, appel du 21/10). Le texte rendu est traité
# comme une partielle : partielle figée, garde de silence et verdict du modèle décident de la fin du tour.
VOICE_DEEPGRAM_SILENCE_FLUSH_MS="700"
# Garde de silence : une fin de tour forcée (partielle figée, jugement du modèle) attend que
# l'audio de l'appelant soit silencieux depuis ce délai, au lieu de tomber pendant qu'il parle
# (appel 5cebe456 : 11 fins de tour forcées sur 17 tombaient pendant la parole). 0 désactive.
# Le report cumulé est plafonné (bruit, écho) : au-delà, le comportement d'avant reprend.
# Métrique : sokar_voice_silence_guard_total{outcome=held|released_after_silence|released_at_cap}.
VOICE_STT_SILENCE_GUARD_MS="350"
VOICE_STT_SILENCE_GUARD_MAX_DEFER_MS="1500"
# Pendant une épellation (nom attendu), la garde est plus longue : les pauses entre deux groupes de lettres
# durent souvent plus d'une seconde (appel 8043662c : « …assam un » jugé fini à 428 ms de silence, le « a »
# suivant perdu). Défaut 1200 ms ; 0 : la garde normale. Le report maximal est alors d'au moins ce délai + 600 ms.
VOICE_STT_SPELLING_SILENCE_GUARD_MS="1200"
# Attente avant le premier son d'une réponse : elle est déjà calculée (texte et voix) mais ne part
# que si l'appelant est silencieux depuis ce délai ; s'il reprend la parole pendant l'attente,
# l’annulation exige 160 ms de signal continu au seuil adaptatif du détecteur (voix faible incluse).
# Un bruit bref retarde la lecture jusqu’au silence ou au plafond, sans jeter la réponse.
# Contextes Cartesia et ElevenLabs (voix de secours HTTP non concernée). 0 désactive. Le plafond évite
# qu'un bruit continu bloque une réponse. Métriques : sokar_voice_first_audio_hold_total{outcome},
# sokar_voice_first_audio_hold_ms ; télémétrie de tour : événement first_audio_hold.
VOICE_FIRST_AUDIO_SILENCE_MS="600"
VOICE_FIRST_AUDIO_HOLD_CAP_MS="1200"
# Coupure rapide de l'agent : quand la voix de l'appelant (audio entrant) dépasse le niveau RMS
# indiqué pendant cette durée alors que l'agent parle, la lecture est mise EN PAUSE tout de suite
# (~0,14 s), au lieu d'attendre la première transcription partielle (0,7 à 1,3 s). Comme l'écho de
# l'agent peut déclencher la détection, on confirme : transcription = barge-in habituel ; sinon, après
# CONFIRM_MS, appelant encore en train de parler = coupure, silence = la lecture reprend. 0 désactive.
# Contexte Cartesia seulement. Métrique : sokar_voice_fast_barge_in_total{outcome=paused|escalated|resumed}.
VOICE_FAST_BARGE_IN_MS="80"
VOICE_FAST_BARGE_IN_MIN_RMS="800"
VOICE_FAST_BARGE_IN_CONFIRM_MS="500"
# Pas de voix, pas de tour : une transcription (partielle ou validée) n'interrompt l'agent et n'ouvre un
# tour que si l'audio entrant contient de la voix depuis le début de l'énoncé (détecteur RMS de
# caller-voice-activity, marge 1,5 s pour le retard de la reconnaissance). Écarte les textes fantômes
# (bruit, écho de l'agent : appel 30172d22, piste appelant muette, « bon » puis « bonjour » coupaient
# l'agent à chaque réponse). Ne juge qu'après 500 ms d'audio suivi. La voix d'un tour déjà envoyé à
# l'agent ne compte pas : il faut de la voix arrivée au-delà de la fin de ses mots (+150 ms ; appel
# 6a70dff9, « 4 » fantôme 1,3 s après « pour quatre »). "false" ou "0" rétablit l'ancien
# comportement. Métrique : sokar_voice_no_caller_voice_transcript_total{stage=partial|committed}.
VOICE_REQUIRE_CALLER_VOICE="true"
# Fin de tour jugée par le modèle (toujours active) : dès que le premier passage spéculatif
# renvoie turnComplete=true sur une partielle inchangée, on envoie Finalize sans attendre le
# minuteur de partielle figée. Aucune liste de phrases : le modèle juge dans le contexte.
# turnComplete=false ne change rien (le minuteur reste le filet).
# Silence avant de répondre à un tour que le modèle juge inachevé (ms, 800 à 6000, défaut 2000),
# mesuré depuis la transcription finale. Tant que des mots arrivent, la réponse est reportée (5 fois max).
VOICE_INCOMPLETE_TURN_SILENCE_MS="2000"
# Vérification de compréhension du tour structuré (tous les restaurants depuis le 22/10). Le modèle lit
# littéralement ce que l'appelant a dit (`reading`) et déclare `understanding` clear/doubtful ; sur
# doubtful le code n'applique aucun changement de brouillon ni aucune action (même pas une
# vérification de disponibilité) et le modèle redemande. Aucune liste de phrases : le jugement est celui du
# modèle, dans le contexte. Aucun réglage.
# Juge de fin de tour séparé (tous les restaurants depuis le 22/10) : une requête minimale (dernière question de
# l'agent, parole de l'appelant, sortie {complete}) tourne en parallèle du passage anticipé ; son verdict
# remplace `turnComplete` pour fermer le tour (clôture sémantique) et pour décider de répondre. Délai dépassé
# ou erreur : `turnComplete` du modèle, comme sans le juge. Métriques : sokar_voice_turn_judge_total{outcome},
# sokar_voice_turn_judge_duration_ms. Banc A/B : voir Journal du 2026-10-02. Aucun réglage d'activation.
# Faits pratiques du restaurant (parking, accessibilité, animaux, options alimentaires, menu), saisis à
# l'étape « Votre restaurant en pratique » de l'onboarding et ajoutés au prompt de l'assistant, pour tous les
# restaurants depuis le 22/10 (aucun réglage). Sans fait pour une question, l'assistant ne devine pas et propose
# le gérant.
# Style de la maison : les réglages « Style » (bistrot, semi-gastro, gastronomique) et « Ton de voix »
# (chaleureux, naturel, formel) de l'étape « Consignes & démo » modifient la façon de parler de
# l'assistant, pour tous les restaurants depuis le 22/10 (aucun réglage). Le réglage par
# défaut (bistrot, naturel) n'ajoute rien. Mesuré le 08/10/2026 (scripts/voice-style-ab.ts) : formel
# et gastronomique nettement plus soignés, chaleureux peu distinct du défaut.
# Coût observé (09/10/2026, juge = modèle de production, 6 comparaisons) : la maison gastronomique formelle est
# jugée plus soignée que le défaut mais moins naturelle (4 contre 2). Pour un son le plus naturel, le réglage par
# défaut (bistrot, naturel) reste la recommandation ; la maison est un choix du restaurant.
# Profil client du CRM dans le prompt, pour tous les restaurants depuis le 22/10 (aucun réglage).
# Visites réelles lues dans les réservations (honorées, placées, ou confirmées passées ; annulées et absences
# exclues), dernière visite, prochaine réservation, taille de groupe médiane, préférences saisies ou confirmées
# par l'équipe, étiquettes ; client connu reconnu par principe, sans civilité devinée.
# Cartesia Ink-2 parallèle : désactivé par défaut. Clé seule insuffisante.
# VOICE_STT_INK_RESTAURANT_IDS autorise la comparaison sur les restaurants de test choisis.
# Deepgram reste la source du dialogue. Pour autoriser aussi le remplacement, ajouter le même restaurant
# à VOICE_STT_INK_REPLACE_RESTAURANT_IDS ; cette liste seule n'ouvre aucune connexion Ink.
# Aucun remplacement général fondé sur la seule présence d'une clé. Ce retrait de priorité ne démontre
# pas que Deepgram reconnaît mieux : qualifier les deux hypothèses avec un audio de référence.
# Les deltas Ink sont concaténés à l'identique, et seul `flush_done` rend la transcription disponible.
# Un seul `finalize` est en vol ; une reprise déjà présente à la fin Deepgram est finalisée ensuite.
# Réponse complète vide : Deepgram pour ce tour. Timeout : Deepgram pour le reste de l'appel,
# socket Ink fermée pour éviter qu'une réponse tardive ne contamine le prochain tour.
# Mots isolés : réponse Ink ignorée jusqu'à flush_done ; si le tour suivant arrive avant, fermeture Ink.
# Ink reçoit seulement la voix (0,5 s avant, 1 s après), au même codec que Deepgram ; attente bornée
# VOICE_STT_INK_WAIT_MS (250 ms par défaut, 50 à 1000) sur les seuls appels de comparaison.
# Logs généraux : source sélectionnée, longueurs et empreintes des hypothèses, jamais le texte.
# Les deux textes sont accessibles uniquement via VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS (14 jours,
# redactPii). Les confiances/mots Deepgram ne sont pas attribués à un texte Ink ; le fournisseur du
# texte sélectionné est enregistré par tour. Les horodatages de fin de parole restent ceux de Deepgram.
# Coût : 3 crédits Cartesia par seconde envoyée, au plus 10 min par appel ; compteur Redis quotidien.
VOICE_STT_INK_RESTAURANT_IDS=""
VOICE_STT_INK_REPLACE_RESTAURANT_IDS=""
# Phase 1 naturel : refus/accords liés à la proposition précédente et acquiescements pendant une
# explication. Liste UUID vide par défaut ; qualification sur restaurant de test uniquement.
# Même groupe `scripts/ops/sync-env.sh voice-stt`, aucune clé fournisseur ni réglage TTS modifié.
VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS=""
# Secours Ink-2 quand Deepgram tombe, pour tous les restaurants (`CARTESIA_API_KEY`) : au lieu de
# déclarer la transcription indisponible, l'appel bascule une fois sur Cartesia Ink-2 en mode tours
# (`/stt/turns/websocket`, ink-2, français, A-law/µ-law 8 kHz tels quels, `turn_end_timeout_ms=1500`, nom du
# restaurant en `keyterm`) ; Ink-2 décide alors seul de la fin de phrase. Une seconde panne suit le parcours normal
# (message d'indisponibilité). Métrique `sokar_voice_provider_errors_total{provider="deepgram_stt",type="fallback_ink"}`.
# Fin de phrase sur silence local, adaptée à l'appelant, pour tous les restaurants : une partielle
# Deepgram attend et l'appelant se tait depuis plus longtemps que ses propres pauses (80e centile de ses pauses
# observées pendant l'appel + 150 ms, borné entre 350 et 1 100 ms ; `VOICE_DEEPGRAM_LOCAL_SILENCE_FINALIZE_MS`, défaut
# 600, tant que moins de 3 pauses sont connues) : `Finalize` part sans attendre 1,2 s de partielle figée (12 % des tours
# du 14 au 21/10, p90 1,56 s). Mesure du 22/10 sur 41 appels : 80e centile des pauses de 164 à 1 160 ms selon
# l'appelant. Jamais pendant une épellation ni sans voix entendue. Déclencheur `silence_finalize` dans la métrique.
VOICE_DEEPGRAM_LOCAL_SILENCE_FINALIZE_MS="600"
VOICE_STT_INK_WAIT_MS="250"
# Suggestions CRM tirées des appels, pour tous les restaurants dès que `OPENROUTER_API_KEY` est présente
# (depuis le 22/10, sans liste). Après le raccroché, une
# requête OpenRouter (`OPENROUTER_API_KEY`, modèle `VOICE_CRM_SUGGESTIONS_MODEL`, sinon
# `VOICE_STRUCTURED_FALLBACK_MODEL`) lit la seule voix de l'appelant d'un client reconnu et propose zone, table,
# régime, accessibilité, langue ou occasion. Une suggestion n'est gardée que si sa preuve figure mot pour mot dans
# la transcription ; elle est écrite `VOICE_SUGGESTION` non confirmée, expire à 90 jours et n'écrase jamais une
# saisie de l'équipe. L'agent ne s'en sert qu'une fois confirmée dans la fiche CRM (Confirmer / Écarter), qui
# suit la formule (`customers.advanced`). Une requête par appel concerné ; tâche en file, une seule tentative.
VOICE_CRM_SUGGESTIONS_MODEL=""
# Délai maximal du juge en ms (200 à 3000, défaut 800) ; p90 mesuré sur Cerebras : 267 ms.
VOICE_TURN_JUDGE_TIMEOUT_MS="800"
# Fin de phrase Deepgram : 200 ms par défaut (958 → 849 ms en médiane au rejeu).
VOICE_DEEPGRAM_ENDPOINTING_MS="200"
# Mise en tampon du contexte Cartesia : 0 (nos entrées sont des phrases complètes).
VOICE_TTS_CONTEXT_MAX_BUFFER_MS="0"
# Adaptateur ElevenLabs (Text to Dialogue, tour de parole) : actif pour tous les restaurants dès que
# ELEVENLABS_API_KEY est présente, sans réglage (22/10). Prioritaire sur le contexte Cartesia.
# Ton de voix ElevenLabs v4 (balise d'expression, au plus un par réponse, jamais sur une réponse pratique) : tous
# les restaurants, sur le chemin ElevenLabs Dialogue seulement.
# Premiers mots de la réponse envoyés à ElevenLabs dès la première virgule (« Très bien, »), sans attendre la fin
# de la première phrase. Seulement une fois la voix autorisée (action, fin de tour, garde-fous lus) ; jamais sur
# une relecture de nom, un nombre ou des lettres épelées. Tous les restaurants, ElevenLabs Dialogue seulement.
# Banc du 21/10 : la voix part 0,15 à 0,26 s plus tôt (médiane), quand le juge de fin de tour a répondu avant.
# Petit mot d'attente pendant une vraie vérification de créneau ou un vrai enregistrement de réservation
# (« Un instant, je regarde. », « Un instant, j'enregistre. ») quand la réponse tarde : sons préenregistrés avec la voix
# de Léa, joués par le code (pas par le modèle), la réponse enchaîne après eux. Rien sur une question simple, jamais
# pendant une épellation ni quand l'appelant parle ; jamais deux fois de suite la même formule, plafond par appel.
# Tous les restaurants, ElevenLabs Dialogue seulement ; sons générés au démarrage (environ 200 caractères par voix).
# Délai minimal après la fin de parole (300–3000 ms) ; l'action démarre d'ordinaire vers 1,2–1,5 s.
VOICE_FILLER_DELAY_MS="750"
# Tours avec son d'attente au plus par appel (1–20).
VOICE_FILLER_MAX_PER_CALL="4"
# Voix ElevenLabs du tour (facultatif) : la voix du banc est utilisée si absente.
# ELEVENLABS_TTS_VOICE_ID="lPojg5cGgbhot31LKO2z"
# Dictionnaire de prononciation ElevenLabs (facultatif, les deux ou aucun). Un identifiant inconnu fait
# refuser la connexion (code 1008) : chaque tour retombe alors sur le repli. Vérifier avant de poser.
# ELEVENLABS_PRONUNCIATION_DICTIONARY_ID=""
# ELEVENLABS_PRONUNCIATION_DICTIONARY_VERSION_ID=""
# La langue de l'appel (`language_code`) et l'alignement par caractère (`sync_alignment`) sont toujours
# envoyés : ils n'ont pas de variable.
```

Relance quand l'appelant n'est pas entendu (appel c5d6b07d du 28 septembre : « euh…
trois » rendu vide par Deepgram, 12 s de silence, raccroché). L'agent repose sa
dernière question : « Pardon, je n'ai pas bien entendu. … » quand Deepgram signale
une parole sans aucun mot reconnu, ou « Vous êtes toujours là ? … » après un
silence. Deux relances au plus par appel, jamais pendant une clôture, et seulement
si la dernière réplique de l'agent était une question. Active pour tous les restaurants
depuis le 22/10, sans réglage. Les petits nombres (« deux »
à « dix ») sont aussi envoyés en tête des mots-clés Deepgram quand les mots-clés
sont activés pour le restaurant.

```dotenv
# Silence après une question de l'agent avant « Vous êtes toujours là ? » (3000–20000).
VOICE_NO_INPUT_TIMEOUT_MS="7000"
# La relance est formulée par le modèle à partir d'un fait (parole non comprise, silence, silence après
# l'accueil), sans phrase codée ; la phrase « Pardon, je n'ai pas bien entendu… » ne sert plus que de dernier
# recours (modèle indisponible, réponse vide ou qui demande une action). "false" ou "0" la rétablit seule.
# Journal : [voice] No-input recovery, source=model|fixed.
VOICE_RECOVERY_BY_MODEL="true"
# Attente maximale de la phrase du modèle avant la phrase codée, abandon de la requête (500–5000, défaut 2000).
# Mesuré : médiane 430 ms, un pic à 2,98 s sur 10 relances ; le hedge à 700 ms et la bascule à 2,5 s de première
# réponse existaient déjà, mais aucune borne ne couvrait la relance entière. Journal : source=fixed_timeout.
VOICE_RECOVERY_MAX_WAIT_MS="2000"
# Genre de la voix par défaut (masculine | feminine), à lire dans les métadonnées de la voix chez le fournisseur
# (ElevenLabs : champ labels.gender de ELEVENLABS_TTS_VOICE_ID). Quel que soit le fournisseur de synthèse.
# Le prompt dit alors au modèle « Ta voix est … » pour qu'il accorde ce qui le qualifie (« Désolé » ou « Désolée »).
# Vide : rien n'est dit. Ignoré pour un restaurant qui a sa propre voix (genre inconnu).
# À changer avec la voix : un genre qui ne correspond plus à la voix fait accorder au mauvais genre.
# Ancien nom CARTESIA_VOICE_GENDER : encore lu si VOICE_GENDER est absent ou vide.
VOICE_GENDER=""
```

#### Synthèse vocale du téléphone : Cartesia ou ElevenLabs

Le choix du fournisseur de synthèse des appels est une variable. Cartesia reste le défaut ; la bascule et le retour
arrière se font par ces seules variables, sans nouveau déploiement de code.

```bash
# cartesia (défaut) | elevenlabs
VOICE_TTS_PROVIDER="cartesia"
# Obligatoires seulement avec VOICE_TTS_PROVIDER=elevenlabs (en production : clé ≥20 caractères et voix).
# ELEVENLABS_API_KEY : clé de production, fournie par l'environnement, jamais écrite dans le dépôt.
# ELEVENLABS_TTS_VOICE_ID : identifiant de la voix ElevenLabs, à fournir au déploiement.
# Défaut eleven_v4_turbo, le modèle mesuré au banc.
ELEVENLABS_TTS_MODEL="eleven_v4_turbo"
# Le chemin WebSocket des tours en contexte (latence de dialogue) est actif dès que ELEVENLABS_API_KEY est présente.
```

- Le téléphone (tours HTTP, message d'accueil en cache) suit `VOICE_TTS_PROVIDER`. Le format de sortie est le G.711
  natif de Telnyx (`alaw_8000` ou `ulaw_8000`) : aucun transcodage. La clé de cache commence par `elevenlabs|`.
- `/health` contrôle ElevenLabs (clé et voix, par `GET /v1/voices/{id}`, sans audio) seulement avec
  `VOICE_TTS_PROVIDER=elevenlabs` ; hors bascule, le check est `skipped`. Une panne passe `status` à
  `degraded` sans 503, comme Telnyx et Cartesia.
- `ELEVENLABS_TTS_STREAMING="true"` passe le téléphone sur le point de synthèse en flux (`/stream`), dont le premier
  octet arrive plus tôt, au même prix par caractère. Absent ou autre valeur : point de synthèse classique. Retour
  arrière : supprimer la variable, puis redémarrer `sokar-api` et `sokar-workers` (ou leurs équivalents staging).
- Le chemin WebSocket sert tous les restaurants dès que `ELEVENLABS_API_KEY` est présente (depuis le 22/10, plus
  de drapeau ni de liste). Un échec d'ouverture retombe sur la voix HTTP, tour par tour.
- `CARTESIA_API_KEY` reste exigée en production : la démo de l'onboarding et les aperçus de voix du restaurant
  utilisent encore Cartesia.
- Retour arrière : `VOICE_TTS_PROVIDER="cartesia"`. Les caractères ElevenLabs sont comptés sous le fournisseur
  `elevenlabs` ; le modèle indiqué dans cette comptabilité reste `ELEVENLABS_DIALOGUE_MODEL`.

Les consignes `system` (prompt, langue, contexte de disponibilité) sont
fusionnées en un seul message avant l'envoi : le template Qwen de Cerebras
refuse un message `system` qui n'est pas le premier. Une réponse 402, 429, 5xx
ou une erreur réseau déclenche une réponse parlée déterministe (reprise du
créneau vérifié, sinon demande de répétition, puis proposition du gérant après
deux échecs consécutifs), après le secours OpenRouter du tour structuré.

### Latence Deepgram et secours LLM

Les seuils Deepgram ne sont utilisés que par les sockets Deepgram ; ils ne
changent pas les paramètres d'Ink-2 (secours). `speech_final` déclenche le commit
immédiat, et `UtteranceEnd` reste un filet de sécurité. Valeurs validées au
démarrage par Zod :

```dotenv
VOICE_DEEPGRAM_ENDPOINTING_MS="200"
VOICE_DEEPGRAM_UTTERANCE_END_MS="1000"
VOICE_DEEPGRAM_SPELLING_SILENCE_MS="800"
# Endpoint Deepgram : api.eu.deepgram.com (UE, ~7 ms depuis le VPS) ou api.deepgram.com (États-Unis,
# ~110 ms, défaut). Seules ces deux valeurs sont acceptées : la clé API leur est envoyée.
DEEPGRAM_API_HOST="api.deepgram.com"
# Suppression de bruit Telnyx Krisp (bêta) sur l'audio de l'appelant, avant la transcription, pour tous les
# restaurants depuis le 22/10 (aucun réglage). Facturée par direction et par minute (une seule direction
# utilisée). Un échec n'arrête pas l'appel.
# Deepgram, pour tous les restaurants et sans réglage depuis le 22/10 : nova-3, chiffres en nombres
# (`numerals=true`), sans ponctuation. Flux et la ponctuation restent mesurables au banc (scripts/voice-stt-bench).
VOICE_DEEPGRAM_MIP_OPT_OUT="true"
```

Les mots-clés Deepgram sont générés à chaque appel pour tous les restaurants, sans liste ni
interrupteur : le budget reste sous 200 tokens estimés (marge prudente sous la limite Deepgram de
500 tokens).
Le schéma actuel expose le nom, l'adresse, la ville et les
types de cuisine; il ne contient pas de menu structuré ni de modèle de personnel.

`VOICE_DEEPGRAM_MIP_OPT_OUT=true` s'applique à Nova-3 et Flux. Il exclut les
requêtes STT du programme d'amélioration et active la rétention limitée au
traitement selon la documentation Deepgram. Le défaut a volontairement changé;
mettre `false` réactive le comportement fournisseur antérieur.

L'épellation attend 800 ms de silence total, en tenant compte de
`endpointing`; elle ne cumule pas un hold hybride. Les valeurs autorisées sont
respectivement 100–1000 ms, 500–3000 ms et 400–2000 ms.

`VOICE_LLM_FILLER_DELAY_MS` n'est plus lu depuis la suppression du mode à outils (#395) ; les petits mots
d'attente actuels utilisent `VOICE_FILLER_DELAY_MS`.

```dotenv
VOICE_LLM_FILLER_DELAY_MS="1200"      # 100–5000 ms
```

Dialogue V2 active aussi la suppression d'écho par texte, valable pour Deepgram
et Ink-2. Le texte récent de l'agent est conservé uniquement en mémoire,
sans être ajouté aux logs ni à la télémétrie.

**PM2 et `.env` :** l'API lit `.env` via `node --env-file`, qui ne remplace pas
une variable déjà présente dans l'environnement du process. Si PM2 a été lancé
depuis un shell où ces variables étaient exportées, il les garde dans son
snapshot et `pm2 restart --update-env` ne les retire pas : la modification du
`.env` est alors ignorée sans erreur. Pour repartir d'un environnement propre :
`pm2 delete sokar-api sokar-workers && pm2 start infra/ecosystem.config.js --only sokar-api,sokar-workers && pm2 save`.

Pour le diagnostic d'un appel, se fier à `VoiceTurnTelemetry.llmProvider` et
`VoiceTurnTelemetry.llmModel`, puis au même couple dans le bilan
`VoiceCallTelemetry`. Le log `Start call` ajoute `openrouterKeyConfigured` et
`openrouterUsed` afin de ne pas confondre une clé présente avec une requête
effectivement envoyée à OpenRouter.

Le shadow `TurnPlan` est contrôlé par un flag global, sans ciblage par restaurant.

### Span-01, signaux sémantiques shadow

Toujours actif depuis le 23/10/2026 (le drapeau `VOICE_SEMANTIC_SIGNALS_ENABLED` est retiré). Chaque tour échantillonné
(`VOICE_SEMANTIC_SIGNALS_SAMPLE_RATE`, 0–1, défaut 1) envoie hors du chemin de
réponse les derniers tours anonymisés à Respan. `RESPAN_API_KEY` est un secret
optionnel chargé depuis l'environnement : sans clé, le tour n'est pas envoyé et le
compteur `missing_key` de la métrique de statut s'incrémente. `RESPAN_BASE_URL`
vaut `https://api.respan.ai/api/v1` par défaut ; l'appel direct cible `/scores`.
`VOICE_SEMANTIC_SIGNALS_MODEL` vaut `span-01-pro` (ou `span-01-free`).
`span-01-pro` consomme des crédits Respan : sans crédit, l'API répond HTTP 402
(statut `payment_required`). `span-01-free` applique un quota quotidien remis à zéro à 00:00 UTC.
`VOICE_SEMANTIC_SIGNALS_TIMEOUT_MS` vaut 2000 (200–10000) et
`VOICE_SEMANTIC_SIGNALS_HISTORY_TURNS` vaut 3 (1–30). L'état envoyé à Jev isole le message du client à évaluer, précédé de la dernière question de l'agent ; les échanges plus anciens sont marqués « à ne pas évaluer » (appel c5d6b07d : 14/23 → 21/23). Aucun résultat Span-01
ne modifie la policy, l'état, les outils ou la réponse. Le 403 d'accès anticipé
est mesuré `forbidden`.

`VOICE_SEMANTIC_SIGNALS_PROVIDER` vaut `openrouter` par défaut (ou `respan`).
OpenRouter appelle `POST /alpha/decisions` avec `OPENROUTER_API_KEY` et
`OPENROUTER_BASE_URL` (`https://openrouter.ai/api` par défaut) ; le modèle vaut
alors `typesafe/jev-1.13-20260917` (version figée, jamais `jev-latest`). La clé
OpenRouter n'existe qu'en production, pas en staging : le mode shadow y démarre
avec un avertissement et `missing_key`.
Respan garde le client direct `/scores` avec `RESPAN_API_KEY` et
`VOICE_SEMANTIC_SIGNALS_MODEL=span-01-pro` ou `span-01-free`. Jev accepte les
questions `noul` et `choice` : onze comportements en `noul` (une probabilité,
sans score « impossible à dire », donc `not_observable` à 0), plus deux
questions `choice` posées seulement quand l'interaction active les rend
pertinentes — `human_fallback_choice` sous `humanFallback` et
`proposal_response_choice` sous confirmation. Respan n'accepte que `noul` :
le client direct ne reçoit pas ces deux questions. La probabilité maximale de
chaque `choice` alimente l'histogramme
`sokar_voice_semantic_choice_confidence`, qui surveille la surconfiance du
modèle. `BEHAVIOR_SET_VERSION` vaut `2026-09-28.4-jev`.

Phase 2 (avis) de `needs_clarification`, sans effet sur l'appel : chaque tour noté
est comparé à ce qu'a fait l'agent (`unclear` = il fait préciser) et compté dans
`sokar_voice_semantic_advisory_total{behavior="needs_clarification",outcome}` :
`both`, `jev_only` (Jev aurait fait reposer la question alors que l'agent a
continué : les tours à relire avant toute phase 3), `agent_only`, `neither`. Le
même classement est écrit dans l'événement de tour `semantic_signals_shadow`
(`advisoryClarify`), avec le `turnId` pour retrouver le dialogue dans
`voice_debug_turns`. Seuil : `VOICE_SEMANTIC_ADVISORY_CLARIFY_THRESHOLD` (0,8).

Évaluation hors ligne : `pnpm --filter api semantic:eval [fichier.jsonl]
[--provider openrouter|respan]` avec la clé du fournisseur dans l'environnement
(le fournisseur par défaut est `VOICE_SEMANTIC_SIGNALS_PROVIDER`, sinon
`openrouter`). Le JSONL doit déjà être anonymisé ; les rapports agrégés vont dans
`apps/api/scratch/semantic-signals-eval/` (ignoré par git).

Jeu de référence figé : `apps/api/scripts/fixtures/semantic-eval/synthetic-v1.jsonl` (144 cas synthétiques, actions sensibles comprises). À passer à `semantic:eval` après chaque changement de définitions ; construction et limites dans `scripts/ops/semantic-dataset/README.md`.

Annotation : `pnpm --filter api semantic:annotation-export [--days 14] [--limit 400]
[--no-prioritize]`, à lancer sur le VPS de production. Le script lit
`voice_debug_turns` (appels de test des restaurants de
`VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS` uniquement, jamais un restaurant client),
masque téléphones et emails, puis classe les tours en mettant en tête ceux où Jev
doute le plus (nécessite `OPENROUTER_API_KEY` ; les scores ne sont pas écrits dans
l'export pour ne pas orienter l'annotation). Il écrit dans
`apps/api/scratch/semantic-annotation/` un JSONL et une page `annotate-*.html`
autonome : ouvrez-la dans un navigateur, annotez au clavier, puis « Exporter le
JSONL » produit le fichier à passer à `semantic:eval`. Les noms dits à l'oral ne
sont pas masqués : la page reste sur le poste de l'annotateur.

Évaluation automatique hebdomadaire : `VOICE_SEMANTIC_AUTO_EVAL_ENABLED=false`
par défaut ; quand le flag est activé, le worker lit les tours des 7 derniers
jours dans `voice_debug_turns`, conserve au plus
`VOICE_SEMANTIC_AUTO_EVAL_MAX_TURNS=300` tours récents et lance Jev et le juge
en parallèle (concurrence 4). Il faut au moins 20 tours annotables. Le juge
utilise `VOICE_SEMANTIC_JUDGE_MODEL=xiaomi/mimo-v2.6-pro` et la
clé secrète `OPENROUTER_API_KEY`. Le job est planifié le lundi à 06:00
(Europe/Paris), avec une tentative. Les rapports agrégés sont écrits dans
`apps/api/scratch/semantic-auto-eval/` et publiés via les métriques
`sokar_voice_semantic_eval_precision`, `..._recall`, `..._examples`,
`..._last_run_timestamp_seconds` et `..._judge_status_total`. Le résumé
opérationnel ne contient ni transcription ni raisonnement du juge. Le juge
MiMo v2.6 Pro coûte environ 0,0005 $ par tour. Sur 6 cas difficiles (28/09/2026), il a
donné 12/12 bonnes réponses, comme `anthropic/claude-sonnet-5` (environ 0,007 $ par
tour, 16 fois plus cher). `xiaomi/mimo-v2.6-flash` est écarté : 9/12 puis 7/12 sur les
mêmes cas, avec des abstentions `not_observable` qui varient d'un passage à l'autre.
Latence d'environ 4 s par tour, sans importance pour un job hebdomadaire. Les appels Jev ont leur propre
coût. Ces annotations restent des
jugements de modèle et ne constituent pas une vérité humaine.

> **Retiré le 3 octobre 2026.** Le shadow TurnPlan in-band, l'autorité TurnPlan, les tours
> différés et le taux de shadow déterministe reposaient sur le mode à outils : leur code est
> supprimé. `VOICE_TURN_PLAN_SHADOW_ENABLED`, `VOICE_TURN_PLAN_AUTHORITY_ENABLED`,
> `VOICE_TURN_PLAN_AUTHORITY_RESTAURANT_IDS` et `VOICE_TURN_PLAN_DETERMINISTIC_SHADOW_RATE` n'ont
> plus d'effet et les métriques `sokar_voice_turn_plan_*` ne sont plus alimentées par les appels.
> Le flag n'est plus lu nulle part, et le groupe `sync-env.sh runtime-flags` n'existe plus
> (retiré le 23/10/2026 avec `MARKETING_FEATURES_ENABLED`, son dernier réglage). Les paragraphes qui suivent décrivent l'ancien comportement et valent
> pour l'historique des mesures. Les signaux sémantiques shadow (Span-01) sont inchangés. Même chose pour
> `SPECULATIVE_LLM_ENABLED` / `SPECULATIVE_LLM_RESTAURANT_IDS` (pré-réflexion du chemin à outils).

Quand `VOICE_TURN_PLAN_SHADOW_ENABLED=true`, tous les restaurants sont concernés ;
`false` le désactive partout. Il ajoute un outil interne à la completion vocale
Cerebras/Qwen existante pour recevoir la proposition structurée avec la réponse
libre ; il ne lance donc pas de requête LLM shadow séparée sur ce chemin. La
policy valide puis compare la proposition à l’état effectivement conservé.
Aucune valeur proposée ne modifie la conversation ni n’autorise un effet métier,
et la télémétrie n’enregistre pas les valeurs de nom/téléphone. Si le modèle
retourne le tool interne sans contenu parlé, Sokar effectue une génération de
récupération pour préserver la réponse vocale ; ce cas est tracé `speech_missing`.
Le workflow staging active ce flag globalement. Le staging ne dispose pas de
configuration Telnyx : ses smoke tests ne valident donc pas un appel vocal réel.
En production, le flag a été explicitement activé le 2026-09-23 après
vérification qu'aucune session vocale n'était active. Le workflow de production
laisse les flags runtime absents inchangés ; cette activation persiste dans le
fichier d'environnement jusqu'à sa désactivation explicite. Pour changer un
flag vocal en production, éditer le fichier d'environnement de l'API,
attendre zéro session active, puis
recharger `sokar-api` avec `pm2 reload sokar-api --update-env`.
Les compteurs globaux de validité, décision de policy et accord sont exposés à
Prometheus et présentés dans le dashboard Grafana `Sokar — Voice & SLO`. Ils
n'ont pas de label restaurant et ne contiennent aucune transcription. Le
déploiement production démarre Prometheus et Grafana séparément sur la loopback,
avec 30 jours de rétention Prometheus. Prometheus ne dépend pas du secret Grafana.
Le workflow provisionne `GRAFANA_ADMIN_PASSWORD` depuis l'environnement GitHub
`production` dans `/etc/sokar/grafana.env` (droits `0600`, root uniquement, hors du checkout).

L'accord est aussi compté par dimension (`sokar_voice_turn_plan_shadow_dimension_total`,
labels `dimension` = `intent` | `slots` | `interaction` | `assistant_interaction`) : un
taux global masque qu'une seule dimension diverge.

`VOICE_TURN_PLAN_AUTHORITY_ENABLED=true` (défaut `false`, sans effet si le shadow est
coupé) ne s'applique qu'aux restaurants listés dans
`VOICE_TURN_PLAN_AUTHORITY_RESTAURANT_IDS` (IDs séparés par des virgules, `*` pour tous ;
vide = aucun). Cette liste se pose directement dans le fichier d'environnement de l'API,
avant le reload. Pour ces restaurants, l'autorité donne au TurnPlan valide et accepté par la policy une autorité limitée, appliquée
après la réponse vocale : il complète date, heure, couverts et intention seulement quand
ces champs étaient vides avant le tour et n'ont pas été posés par le déterministe ; il ne
remplace jamais un fait existant. Il fixe aussi l'interaction attendue au lieu de
l'inférence regex sur la phrase générée, sauf pour `confirmation`, `humanFallback` et
`partySizeConfirmation`, qui ouvrent une autorisation ou exigent des métadonnées et
restent sur l'inférence texte. Aucun tool ni confirmation ne dépend du plan. Le shadow
continue de comparer le plan à l'état déterministe seul. Décisions comptées par
`sokar_voice_turn_plan_authority_total{field,outcome}`. N'activer qu'après lecture de
l'accord par dimension sur des appels réels.

Le **tour structuré** est le seul parcours de dialogue vocal : le mode à outils (appel de
fonctions, extracteurs lexicaux, relances déterministes, fillers, TurnPlan en autorité ou en
shadow in-band) a été supprimé le 3 octobre 2026, et `VOICE_STRUCTURED_TURN_RESTAURANT_IDS`
n'existe plus. Un seul appel au modèle, en JSON Schema strict, comprend le tour (interprétation,
brouillon, attente, action) et formule la réponse ; `say` est lu en streaming. Le code valide le format et la plausibilité des valeurs
(date dans l'horizon, heure, couverts, nom), exécute les actions autorisées
(disponibilité réelle ; réservation seulement après un récapitulatif lu au tour précédent
et accepté, sur un créneau vérifié ; message ; transfert ; fin d'appel) et rend leur
résultat au modèle pour la formulation. Aucune action à effet sur un plan à confiance
faible. Si Cerebras échoue, le secours OpenRouter prend le tour. Télémétrie : événement
`structured_turn` (interprétation, action, attente, confiance, champs modifiés ou rejetés ;
aucun texte). Banc contre le vrai modèle, clé de dev uniquement :
`CEREBRAS_API_KEY=… node --env-file=.env --import tsx scripts/voice-structured-bench.ts`
depuis `apps/api`.

Un tour de contenu que les extracteurs n'ont pas compris est confié au modèle au lieu
d'une relance mécanique. Son résultat est compté par
`sokar_voice_turn_plan_deferred_total{outcome}` : `fact_applied`, `no_fact`,
`plan_rejected`, `plan_unavailable`, ou `stall_handoff`. Le garde-fou anti-boucle
s'applique aussi à ces tours : si le modèle repose la même question sans nouveau fait, la
relance est comptée ; après deux relances, le tour suivant revient au déterministe, qui
propose un repli humain réel (`stall_handoff`). Les métriques shadow portent un label
`path` (`llm`, `deferred` ou `deterministic`) pour lire l'accord séparément sur ces tours.

`VOICE_TURN_PLAN_DETERMINISTIC_SHADOW_RATE` (0 à 1, défaut `0`, sans effet si le shadow est
coupé) observe aussi une part des tours répondus sans LLM : après la réponse déterministe,
un appel TurnPlan séparé (outil forcé, température 0, 2,5 s maximum) interprète le tour.
Il ne retarde pas la réponse, ne modifie ni l'état ni l'historique, et ne passe pas par le
disjoncteur LLM, pour qu'une observation lente ne coupe jamais le LLM des appels réels.
Son coût est rattaché à l'appel. C'est la seule mesure des tours où la regex décide seule,
y compris quand elle se trompe sans le savoir (`path="deterministic"`). Commencer bas
(par exemple `0.2`) et monter selon le volume. Comme la liste d'IDs, cette valeur n'est
pas un booléen et se pose directement dans le fichier d'environnement de l'API.

Fin de tour hybride (écoute Dialogue V2, tous les restaurants) :
après la fin de phrase, l'API ajoute une attente selon la phrase : 0 ms si elle est complète
(ponctuation finale ou réponse d'un ou deux mots comme « oui »), 800 ms si elle finit en
suspens (« demain à », « au nom de », « je suis »), 600 ms pour une correction commencée
(« non, plutôt… »), 400 ms sans ponctuation. Si le client reprend pendant l'attente, la
suite est fusionnée dans le même tour. Comparer avant/après avec
`sokar_voice_end_of_speech_to_first_audio_ms` et `sokar_voice_false_end_of_turn_total`.

`VOICE_STT_CHUNK_MS` (défaut `20`) règle le regroupement des trames audio avant envoi au
fournisseur de reconnaissance. `20` conserve le comportement historique : chaque trame Telnyx de 20 ms part dans
son propre message. Une valeur multiple de 20 entre `40` et `200` accumule les trames
décodées et n'envoie qu'un message quand la durée cible est atteinte. À 20 ms, le
comportement historique reste inchangé : une trame par message. Le regroupement ne change pas
le format audio.
Le tampon est vidé avant tout commit manuel, une fin de tour, un barge-in, la fermeture ou la
reconnexion de la session, et la fin d'appel ; un timer de sécurité (`valeur + 20 ms`) envoie
un tampon partiel si le flux s'interrompt. Un couple de trames est donc retardé d'au plus la
valeur configurée, uniquement à l'intérieur d'un tour (fin de parole → commit). Toute autre
valeur fait échouer le démarrage (validation Zod). Suivre
`sokar_voice_stt_provider_audio_messages_total{provider,chunk_ms}` et
`sokar_voice_stt_provider_chunk_bytes{provider}`.

Retirés avec le code Scribe (ElevenLabs Scribe Realtime, plus utilisé en production) :
`VOICE_STT_FILTER_BACKGROUND`, `VOICE_STT_LANGUAGE_LOCK` (verrou français, sans effet réel avec Deepgram
et Ink-2), `ELEVENLABS_STT_MODEL`, `ELEVENLABS_STT_HOST`, `ELEVENLABS_STT_LANGUAGES` et
`ELEVENLABS_STT_ALL_LANGUAGES`. Une ancienne valeur laissée dans un `.env` est ignorée. Les compteurs
`sokar_voice_language_locked_total`, `sokar_voice_non_fr_transcript_after_lock_total`,
`sokar_voice_stt_audio_messages_total` et `sokar_voice_stt_chunk_bytes` n'existent plus. Le banc STT
(`apps/api/scripts/voice-stt-bench`) garde sa propre URL Scribe (`scribe-url.cjs`) pour mesurer Scribe
comme référence.

L'écoute Dialogue V2 est active pour tous les restaurants, sans réglage. Elle applique le routage
strict du dialogue : le chemin déterministe
est réservé à une réponse directe, unique et non ambiguë à la question en attente. Les questions,
corrections, contradictions et tours en boucle sont traités par le LLM sans appliquer de slot
implicite ; les questions n'exposent que l'outil de vérification de disponibilité en lecture seule.
Les fins de tour manifestement coupées ou réduites à une hésitation sont fusionnées pendant 900 ms,
puis relancées naturellement si aucune suite n'arrive.

`VOICE_TELNYX_CODEC` (défaut `PCMA`, valeurs `PCMA` ou `L16`) sélectionne le codec
entrant et sortant du Media Stream Telnyx. Avec `L16`, demander 16 kHz dans les deux
sens, envoyer le PCM16 au fournisseur de reconnaissance (Deepgram `linear16`, 16 kHz), et générer le TTS Cartesia en PCM16 16 kHz.
Le cache TTS est séparé par codec. `sokar_voice_wideband_detected_total{detected,codec}`
indique la présence d'énergie au-dessus de 4 kHz au début de chaque appel L16. Avant
activation, vérifier en staging par un appel réel que l'endianness du payload WebSocket
est bien big-endian (convention RTP L16) et que le retour TTS est audible. Le log
unique `[stream] L16 endian probe` contient `media_format`, `bigEndianRms` et
`littleEndianRms` sur les premières 500 ms de parole, sans contenu audio. Le flag
reste à `PCMA` par défaut.

`VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS` (IDs séparés par des virgules, **vide = désactivé**)
enregistre le dialogue de chaque tour pour ces seuls restaurants de test : paroles du client,
réponses et fillers de l'agent, outils appelés, type de tour. Table `voice_debug_turns`, texte
passé par `redactPii()` (téléphones, e-mails ; les noms restent), suppression 14 jours après
l'appel par la tâche quotidienne `purge-expired-voice-debug-turns` (3 h 30, Europe/Paris). Ne
jamais y mettre un restaurant client. Les mesures du tour restent dans `voice_turn_telemetry`.
Chaque réplique de l'agent est comptée par ses propres trames envoyées à Telnyx : envoyée en
entier, « [envoi coupé] », ou omise si aucune trame n'est partie. Avec le contexte Cartesia, la
réponse forme une seule réplique (l'audio ne se rattache pas phrase par phrase). Envoyé ne veut
pas dire entendu : un barge-in peut encore vider l'audio en attente côté Telnyx.

Pour ces mêmes restaurants de test, les événements STT écrivent aussi leur **texte brut** dans
les journaux du serveur (`[voice-debug] raw text`, champ `voiceDebug`) : ce que le filtre d'écho a
reçu et rendu (`echo_prefix_stripped`, `echo_suppressed`, `echo_spared`, avec la parole récente de
l'agent), chaque segment final Deepgram (`final_segment`) et la partielle au moment d'une fin de
tour forcée (`finalize_sent`, avec le silence mesuré). Mêmes garde-fous que le dialogue par tour :
téléphones et e-mails masqués, rien pour un restaurant client, jamais envoyé à un service externe ;
les journaux tournent chaque jour et sont supprimés après 14 jours (logrotate). Autorisé par le
propriétaire le 30/09/2026, car les nombres de mots ne suffisaient pas à comprendre un mot perdu.

`SOKAR_VOICE_READ_TOKEN` (secret, `openssl rand -hex 32`) protège la lecture interne, en
`Authorization: Bearer <jeton>` ; sans lui, les routes répondent 503. Lecture seule :
`GET /api/internal/voice/calls?restaurantId=…&limit=20` (derniers appels),
`GET /api/internal/voice/calls/latest?restaurantId=…` et `GET /api/internal/voice/calls/:callId`
(mesures par tour, plus le dialogue pour les seuls restaurants de
`VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS`), et `GET /api/internal/voice/calls/:callId/report`
(rapport d'appel JSON stocké, début de l'id accepté, mêmes restaurants que le dialogue). Jamais le
numéro de l'appelant, le transcript brut, l'audio ni les champs d'enregistrement. Pour une session
Claude : autoriser `api.suppernote.com` dans l'accès réseau de l'environnement et y poser la même
valeur en variable d'environnement `SOKAR_VOICE_READ_TOKEN`. Une session cloud ne peut pas ouvrir
de SSH (port 22 sortant fermé) : cette lecture HTTPS est la voie prévue.

Le rapport d'appel (plus de drapeau `CALL_REPORT_ENABLED` depuis le 23/10/2026) est construit après chaque appel d'un restaurant de
`CALL_RECORDING_TEST_RESTAURANT_IDS` : un rapport (JSON + Markdown) stocké à côté de l'enregistrement,
avec des transcriptions après coup Deepgram (Nova-3 et Whisper, environ 1 centime par appel) et les journaux de l'API
lus dans `CALL_REPORT_LOG_DIR` (défaut `/var/log/sokar`, rotation 14 jours). Il suit l'enregistrement
(`CALL_RECORDING_ENABLED`) et exige `DEEPGRAM_API_KEY` ; sans `VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS` le rapport est réduit.
Aucun effet sur l'appel. Voir
[`call-reports.md`](call-reports.md).

Le TurnPlan propose désormais des `facts` : `{field, op: set|replace|clear, value, source:
user_explicit|user_tentative|correction}` ; les anciens `slots` restent lus comme `set` affirmé.
Sous autorité, `set` remplit seulement un champ vide. `replace` corrige un fait d'origine
`contextual` ou `model`, un fait `explicit` seulement si `interpretation=correction`, et jamais
un fait `confirmation` ni un fait d'origine inconnue ou périmée. Un fait `user_tentative` n'est
jamais enregistré ; `clear` n'est pas encore pris en charge. Un remplacement invalide l'accord
de réservation et la disponibilité. La provenance est stockée dans
`conversation.slotProvenance`, liée à la valeur qu'elle décrit. Résultats ajoutés à
`sokar_voice_turn_plan_authority_total` : `replaced`, `protected`, `tentative`, `unsupported`.
Grafana donne un accès anonyme en lecture seule, sans inscription, et s'ouvre
uniquement par tunnel SSH ; ne publiez pas son port.

## Companion (assistant du dashboard)

`POST /companion/chat` répond à l'équipe de direction (OWNER, MANAGER, ORG_MEMBER). STAFF et READ_ONLY reçoivent 403
par la politique de rôles. Le modèle passe par OpenRouter avec `OPENROUTER_API_KEY` et `OPENROUTER_BASE_URL`, partagées
avec la voix : sans clé, la route répond 503. Une requête OpenRouter en erreur ou en délai dépassé (20 s) répond 502.
Plafond : 100 messages par jour et par restaurant (jour calendaire Europe/Paris), 429 au-delà. Les outils ne lisent que
des agrégats. Chaque requête OpenRouter demande `provider.data_collection: deny` : le fournisseur ne conserve pas les
messages du gérant.

```dotenv
# Modèle du Companion. Défaut : Claude Sonnet 5.5, raisonnement bas (slug OpenRouter vérifié le 31/10/2026).
COMPANION_LLM_MODEL="anthropic/claude-sonnet-5.5"
```

## Voice STT (Deepgram)

Deepgram Nova-3 est le seul fournisseur de reconnaissance, pour tous les restaurants et sans réglage
(ni `VOICE_STT_PROVIDER`, ni liste par restaurant). Les réglages Deepgram sont figés au début du Media
Stream et restent identiques pendant l'appel. **Il n'y a plus de secours vers ElevenLabs Scribe** : si
Deepgram ne s'ouvre pas (clé refusée, clé absente, réseau), l'appel suit le chemin « reconnaissance
indisponible » existant (reconnexions à 500 ms, 1 s puis 2 s, échéance de 15 s, puis le message vocal et le
transfert ; un refus d'authentification est terminal tout de suite). La clé `DEEPGRAM_API_KEY` est
obligatoire en production ; `ELEVENLABS_API_KEY` ne sert plus qu'à la synthèse vocale.
Ne l'utilisez jamais dans les scripts du banc : ceux-ci exigent une clé bench dédiée.

Le codec Telnyx reste PCMA par défaut. `VOICE_TELNYX_CODEC=L16` conserve le
comportement PCMA pour tout appel sans allowlist explicite. L16 exige que
`VOICE_TELNYX_CODEC_RESTAURANT_IDS` contienne l'ID du restaurant ciblé; une
allowlist vide ou absente reste en PCMA. Les autres appels restent PCMA. La
valeur est évaluée à l'ouverture de l'appel et ne change pas pendant le flux.

Le modèle Deepgram est `nova-3` pour tous les restaurants (le canary Flux par restaurant est retiré
depuis le 22/10/2026). Flux (`/v2/listen`, `flux-general-multi`, `language_hint=fr`) reste mesurable
au banc.

Les tours incluent maintenant `endOfSpeechToSttFinalMs`, `holdMs`,
`endOfSpeechToFirstAudioMs`, `firstAudioIsFiller` et `speechEndAt` lorsque mesurables.
La migration `voice_turn_end_of_speech_latency` n'ajoute que des colonnes nullables et doit
passer par le déploiement normal. Les métriques `sokar_voice_end_of_speech_to_stt_final_ms` (étiquetée `final_trigger` depuis le 22/10/2026)
et `sokar_voice_stt_provider_audio_messages_total` sont additives.

### ElevenLabs : clé et quota (historique, état du 24/09/2026)

ElevenLabs ne sert plus à la reconnaissance en production (voir plus haut). Le worker de suivi de solde ci-dessous
lit encore `ELEVENLABS_API_KEY` : sans cette clé il échoue chaque heure.

La production et le staging partageaient une seule clé ElevenLabs sur un
compte gratuit. Le solde communiqué est de 6 172 caractères sur 10 000, avec une
réinitialisation le 25/10/2026. Cette configuration est temporaire : la cible est un
compte payant avec une clé distincte par environnement.

L'API et le worker utilisent **ELEVENLABS_API_KEY**, conservée uniquement dans le
gestionnaire de secrets de chaque environnement. Le worker interroge
GET https://api.elevenlabs.io/v1/user/subscription une fois par heure et publie
**sokar_elevenlabs_character_count** et **sokar_elevenlabs_character_limit**. Le worker
envoie les seuils 80 % (avertissement), 95 % et 100 % (critique) via `dispatchAlert()`.
Prometheus garde un miroir consultable ; aucun Alertmanager n'est configuré. Chaque seuil
dispose d'un latch Redis par période de facturation, réarmé si la consommation repasse dessous.

Les bancs Scribe historiques utilisent encore la clé ElevenLabs unique `ELEVENLABS_API_KEY`
(décision du 14/10/2026, partagée prod, dev et staging) ; ils ne qualifient plus le STT runtime
et ne doivent pas servir aux essais fournisseur. Les bancs actuels Deepgram/Cartesia requièrent
une clé fournisseur : les clés de banc sont prioritaires, avec repli sur les clés runtime :

| Variable                       | Usage                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| **DEEPGRAM_BENCH_API_KEY**     | Clé optionnelle des bancs Deepgram ; sinon DEEPGRAM_API_KEY                          |
| **CARTESIA_BENCH_API_KEY**     | Clé optionnelle du banc STT Cartesia ; sinon CARTESIA_API_KEY                        |
| **ELEVENLABS_API_KEY**         | Clé unique : prod, dev, staging et anciens bancs Scribe/TTS (décision du 14/10/2026) |
| **OPENROUTER_BENCH_API_KEY**   | Clé dédiée du banc LLM archivé, différente de OPENROUTER_API_KEY                     |
| **CEREBRAS_BENCH_API_KEY**     | Clé dédiée du diagnostic vocal manuel, différente de CEREBRAS_API_KEY                |
| **BENCH_DG_MAX_AUDIO_SECONDS** | Plafond audio des essais Deepgram, 660 s par défaut pour les bancs rapides           |
| **BENCH_MAX_CREDITS**          | Plafond Cartesia positif obligatoire ; l'estimation précède tout envoi STT           |

Les scripts vérifient l'accès à chaque endpoint utilisé avant le corpus, avec une seule
requête de contrôle par fournisseur. Pour le banc Scribe, le contrôle ouvre la socket Realtime et
n'envoie aucun audio. Le banc STT détaillé et ses limites sont documentés dans
apps/api/scripts/voice-stt-bench/README.md. Les bancs Deepgram/Cartesia acceptent aussi les clés de production.

Historique du banc Scribe du 24/09/2026 (7 phrases × 3 passages, A-law 8 kHz) : détection sur toutes les
langues 33 % d'informations critiques justes, `fr,en` 76 %, `fr` imposé 52 %. Deepgram est configuré en
français seulement ; ajouter une langue seulement si des appelants la parlent réellement, et remesurer.

Réponses attendues (`stream/expected-answer.ts`) : quand l'agent pose une
question fermée (nombre de personnes, jour, heure) et que l'analyse exacte ne
trouve rien, la transcription est rapprochée phonétiquement des réponses
possibles. Une valeur nette est retenue puis relue dans la phrase suivante
(« Six personnes, très bien. Pour quel jour ? ») ; deux valeurs proches donnent
« Pardon, six ou seize personnes ? » ; une réponse hors sujet ne donne rien.
Les heures candidates sont les créneaux vérifiés, sinon les horaires
d'ouverture du jour, sinon une liste par défaut. Actif pour tous les restaurants
depuis le 22/10/2026, sans réglage.

Confirmation guidée par la confiance (`stream/slot-confidence.ts`) : pour
chaque valeur retenue par l'analyse exacte (nombre, jour, heure), la confiance
des mots qui la portent et la stabilité des transcriptions partielles
décident de la suite. Valeur sûre et stable : relecture seule. Valeur douteuse
ou instable avec un voisin confusable (six/dix/seize, deux/douze, trois/treize,
cinq/sept, 20 h/21 h/22 h, 8 h/20 h, et quart/et demie) : « Pardon, six ou dix
personnes ? ». Valeur très douteuse sans voisin : question reposée autrement.
Heure hors des horaires d'ouverture du jour : jamais acceptée d'office.
L'événement `slot_confidence` publie le type, la confiance arrondie,
l'instabilité et la décision, jamais le texte ni la valeur. Actif pour tous les
restaurants depuis le 22/10/2026, sans réglage.

La confiance n'agit que sur le nombre de personnes ; pour le jour et l'heure, la
décision est seulement observée : `slot_confidence` la publie préfixée `wouldBe…`,
sans rien changer au dialogue. Le banc difficile (mesuré avec Scribe) montre que la confiance
distingue les nombres de personnes justes des faux, pas les heures.

Vraisemblance des heures (toujours active, indépendante
de la confiance) : une heure hors des horaires d'ouverture du jour, ou de la
semaine si le jour est inconnu, n'est jamais retenue. L'agent demande « 10 h ou
22 h ? » avec l'heure ouverte la plus proche à l'oreille, ou cite les horaires.

Groupes : au-delà de `RestaurantExposureSettings.maxPartySize` (réglage du
tableau de bord « Assistants IA », partagé avec le canal agentique ; 7 sans
ligne de réglages), le téléphone confirme le nombre puis transfère au gérant,
ou prend un message sans ligne gérant. Aucun flag : ce parcours est toujours actif.

L'événement `expected_answer` publie le type, le statut et les scores (meilleur, écart),
jamais la transcription. Banc : `apps/api/scripts/voice-stt-bench/README.md`.

Chaque tour publie la confiance des mots (`minWordConfidence`,
`meanWordConfidence`, `lowConfidenceWordCount`) dans l'événement `stt_final`,
sans le texte.

En cas d'authentification, de quota ou de conditions du fournisseur de reconnaissance refusés, l'appel cesse
immédiatement les reconnexions. Les échecs d'ouverture utilisent un backoff de 500 ms, 1 s
puis 2 s ; chaque ouverture réussie remet le compteur consécutif à zéro. Le repli intervient
après quatre échecs d'ouverture d'affilée, huit reconnexions par appel, ou une échéance
globale de 15 s. Il appelle `dispatchAlert()` en critique (cooldown global d'une heure) pour
les erreurs terminales ; les erreurs de connexion avertissent après plus de cinq appels
touchés en dix minutes. Le message vocal suit la langue active et ne propose la réservation
en ligne que si la page Connect est publiée (opt-in, flag, slug et date de publication). Détails :
docs/runbooks/observability.md.

## Demo restaurant

The seed creates a fictional `Chez Suppernote` (canonical slug `chez-suppernote-demo`;
`chez-sokar-demo` remains a read alias during the data migration):

If the legacy slug is still stored, the seed stops instead of creating a duplicate. Complete the staged slug migration in `migration-suppernote.md` first.

- Number: `+331****0405`
- MCP + OpenAI Reserve opt-in enabled
- Hours, personality, test customers (including a VIP)

Used for local voice / MCP tests before a real pilot.

The seed also creates extra published demo listings (`chez-sokar-*` outside both official demo slugs) so
the city pages (`/restaurants/:city`, which require at least five listings per city) have something
to render. Those are **refused on a remote database** unless `SEED_DEMO_RESTAURANTS=true` is set:
seeding them on production once published ten fake restaurants in the public sitemap (2026-06-28,
cleaned up 2026-09-21). Use the opt-in for staging only, never for production.

### Cartes cadeaux / Stripe Connect

- API : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (secrets des endpoints plateforme
  et comptes connectés, liste séparée par des virgules), `DASHBOARD_URL` HTTPS,
  `CONNECT_URL` pour les liens envoyés par la voix.
- Connect : `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, injecté à la compilation.
- Parcours intégré expérimental : `STRIPE_MANAGED_CONNECT_TEST_ENABLED=true` et
  `STRIPE_MANAGED_CONNECT_TEST_RESTAURANTS` (IDs séparés par des virgules). Désactivé
  par défaut ; le serveur exige également `STRIPE_SECRET_KEY` et
  `STRIPE_PUBLISHABLE_KEY` en mode test. Ne pas utiliser de données réelles pour
  l'acceptation fictive ; ce chemin ne peut pas être activé avec des clés live.
- PDF : `GIFT_CARD_IMAGE_ORIGINS`, liste d'origines HTTPS de CDN maîtrisés ; vide désactive
  les téléchargements d'images personnalisées. Aucun domaine fourni par le client.
- Tests locaux uniquement : `GIFT_CARD_FINANCE_TEST_DATABASE_URL`, base dédiée sur localhost.

Voir [activation et qualification des cartes cadeaux](gift-card-financial-safety.md).

### Réservation publique des expériences

`EXPERIENCE_BOOKING_ENABLED` reste à `false` par défaut dans tous les environnements. Son ouverture
ne suffit pas seule : `EXPERIENCES_ENABLED` doit aussi être activé, la page Sokar Connect doit être
publiée, le compte Stripe Connect du restaurant doit autoriser les encaissements et versements, et
Sokar doit avoir renseigné la commission de ce restaurant. Le réglage opérateur accepte un taux
fractionnaire (`0.05` = 5 %) via `PATCH /api/internal/experiences/payment-config`; `null` retire le
taux et bloque à nouveau le paiement. La route exige `requireSokarOperator`.

La page publique utilise Stripe Checkout sur le compte connecté ; les places sont retenues pendant
35 minutes et la réservation n'est confirmée que par webhook signé. Une annulation depuis le
dashboard déclenche un remboursement total idempotent. Le webhook Connect doit transmettre les
événements `checkout.session.completed`, `checkout.session.expired`, `refund.created`,
`refund.updated` et `refund.failed` pour les comptes connectés ; conserver les secrets de webhook
dans `STRIPE_WEBHOOK_SECRET`, jamais dans le dépôt.

Avant d'ouvrir un pilote réel, faire la migration uniquement en staging, jouer les scénarios payé,
abandonné, expiré, webhook rejoué, capacité concurrente et remboursement échoué avec des comptes et
clés Stripe de test. La politique d'annulation côté client, les conditions de vente, le traitement
TVA/facture, les emails de confirmation/notification et le rapprochement quotidien restent à
qualifier. Garder le flag fermé tant que ces éléments et le parcours staging ne sont pas validés.

## Fournisseurs de staging : trois blocs indépendants

Staging n'envoie aucun e-mail, ne prend aucun appel et ne passe aucun appel de test tant que les réglages de
chaque bloc ne sont pas fournis. Le workflow de staging transmet ces réglages à
`scripts/ops/sync-env.sh provider`, qui les écrit dans le `.env` de staging. Le workflow de
production ne lit aucun de ces réglages : une valeur de staging ne peut pas atteindre la production.

Chaque bloc se valide seul. Un bloc ne conditionne pas les autres.

### Bloc 1 : e-mail

| Réglage                | Où le renseigner                        | Lu par         | Utilité                                                                        |
| ---------------------- | --------------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `RESEND_API_KEY`       | secret `RESEND_API_KEY_STAGING`         | `shared/email` | Clé d'envoi Resend, dédiée à staging et limitée à l'envoi                      |
| `EMAIL_FROM`           | variable `EMAIL_FROM_STAGING`           | `shared/email` | Expéditeur déjà vérifié : `noreply@suppernote.com` (production)                |
| `EMAIL_TEST_ALLOWLIST` | variable `EMAIL_TEST_ALLOWLIST_STAGING` | `shared/email` | Seuls ces destinataires reçoivent un e-mail. Campagne : `hamza@suppernote.com` |

Règles :

- Un envoi vers une adresse hors liste n'appelle pas Resend et échoue sans relance. L'adresse n'est jamais journalisée.
- Sans `EMAIL_TEST_ALLOWLIST`, il n'y a aucune restriction. Ne jamais retirer la liste tant qu'une campagne de test est en cours.

### Bloc 2 : voix entrante

| Réglage                | Où le renseigner                        | Lu par                       | Utilité                                                                   |
| ---------------------- | --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `TELNYX_API_KEY`       | secret `TELNYX_API_KEY_STAGING`         | `shared/telnyx/client`       | Clé d'API Telnyx, dédiée à staging                                        |
| `TELNYX_PUBLIC_KEY`    | secret `TELNYX_PUBLIC_KEY_STAGING`      | `voice/telnyx.guard`         | Vérifie la signature des webhooks. Sans elle, les événements sont rejetés |
| `TELNYX_CONNECTION_ID` | variable `TELNYX_CONNECTION_ID_STAGING` | `admin/provisioning.service` | Application d'appel Telnyx de staging, rattachée au numéro de test        |

Hors `.env` (à vérifier avec l'équipe) : `ELEVENLABS_API_KEY` (transcription), une clé LLM
(`CEREBRAS_API_KEY` ou `OPENROUTER_API_KEY`), et `VOICE_DISABLED=false`, réglage critique à décider.

Côté Telnyx : l'application d'appel de staging a pour webhook `https://api-staging.suppernote.com/voice/telnyx`.
Le numéro de test est rattaché à cette application (provisioning, `assign-phone`). Ce numéro n'est jamais un
numéro de production, ni le numéro public affiché sur le site.

**État vérifié le 24/10/2026 :** le compte n'a qu'un numéro, rattaché à l'application de production
`Sokar Voice` avec webhook `https://api.suppernote.com/voice/telnyx`. L'application `Sokar VOICE-01 staging`
existe avec le webhook staging, mais ses voies entrante et sortante sont désactivées et aucun numéro ne lui
est affecté. La configuration de staging réutilise actuellement le numéro de production. Ne pas appeler ni
activer un pilote staging avant d'avoir un numéro dédié, son rattachement à l'application staging, les voies
nécessaires activées et la configuration vérifiée de bout en bout.

### Bloc 3 : appel de test sortant (provisioning)

| Réglage                | Où le renseigner                        | Lu par                              | Utilité                                                                                    |
| ---------------------- | --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `TELNYX_FROM_NUMBER`   | secret `TELNYX_FROM_NUMBER_STAGING`     | `shared/telnyx/client`              | Numéro émetteur de l'appel de test (format E.164)                                          |
| `TELNYX_SMS_FROM`      | optionnel                               | `shared/telnyx/client`              | Expéditeur SMS (numéro du profil de messagerie ou `SOKAR`) ; défaut : `TELNYX_FROM_NUMBER` |
| `EMAIL_REPLY_TO`       | optionnel                               | `shared/email`                      | Adresse de réponse des e-mails ; défaut : `hello@suppernote.com`                           |
| `TELNYX_CONNECTION_ID` | variable `TELNYX_CONNECTION_ID_STAGING` | `shared/telnyx/client`              | Application d'appel utilisée pour l'appel sortant (même que le bloc 2)                     |
| `PUBLIC_API_URL`       | variable `PUBLIC_API_URL_STAGING`       | `admin/provisioning`, `restaurants` | Base des URL de webhook. Sans elle, le repli est la production                             |

Le code de l'appel de test est corrigé dans cette livraison : `connection_id` est transmis, le webhook est
`${PUBLIC_API_URL}/voice/telnyx`, et le message de test est joué au décroché puis l'appel est raccroché.
Côté Telnyx, l'application de staging doit disposer d'un profil vocal sortant autorisant les destinations
de test ; à confirmer dans le portail.

### Règles de fourniture

- Secrets : `pbpaste | gh secret set NOM --repo Sshindraa/Sokar`. Variables : `gh variable set NOM --repo Sshindraa/Sokar --body "valeur"`.
  Aucune valeur ne transite par le chat ni par le dépôt.
- Une variable vide ne modifie rien. Le script refuse une valeur hors format et n'affiche jamais de valeur.
- Les réglages prennent effet au déploiement de staging qui suit un merge sur `main`.

### Vérifications

- `GET https://api-staging.suppernote.com/health` : `telnyx` à `ok` (bloc 2).
- Le bloc 1 se vérifie par un envoi de test vers `hamza@suppernote.com` uniquement.
- Le bloc 3 se vérifie par un appel de test réel, validé par le gérant (`validate-test-call`).

### Identité opérateur staging

`SOKAR_OPERATOR_USER_IDS_STAGING` est une variable GitHub dédiée aux identités de l’instance Clerk Development. Le workflow staging l’utilise en priorité, avec repli sur `SOKAR_OPERATOR_USER_IDS` pour les installations existantes. La production continue à utiliser uniquement `SOKAR_OPERATOR_USER_IDS`. Un identifiant Clerk de production ne désigne pas automatiquement le même compte en développement ; ne pas ajouter de compte à une liste sans autorisation explicite. Aucun identifiant personnel ne doit être consigné dans le dépôt.

## Personal reservation SMS

`RESERVATION_MANAGEMENT_ENABLED` defaults to false. `RESERVATION_MANAGEMENT_SECRET` is a stable key_env secret of 32 random bytes encoded as 64 hex characters, shared by API/workers. `TELNYX_SMS_FROM` optionally selects a dedicated SMS sender (for example the alphanumeric sender already configured in the messaging profile); when unset, the historical `TELNYX_FROM_NUMBER` is preserved. Voice always keeps its existing sender. See `reservation-management.md`.

`TELNYX_SMS_WEBHOOK_URL` optionally overrides delivery callbacks per SMS with `use_profile_webhooks=false`, so a staging test does not report to the shared production profile webhook. It must point to the signed `/sms/telnyx/inbound` route on the intended environment. An accepted request/message ID is not proof of handset delivery; require the matching signed `message.finalized` receipt with `delivered` status and the tester’s reception report.

`RESERVATION_SELF_CANCELLATION_ENABLED` defaults to false and requires personal
reservation management to be enabled. Enable on staging only after qualification.
This enables free cancellation before the frozen onboarding deadline, not payment
collection or refunds. No migration is required. Turn it off to restore phone contact.

`RESERVATION_SELF_MODIFICATION_ENABLED` defaults to false. It enables signed, explicitly confirmed same-day time/party-size modifications from personal reservation links. Requires `RESERVATION_MANAGEMENT_ENABLED` and reliable frozen free-cancellation terms; independent of the cancellation flag. The original reservation stays allocated until a successful atomic replacement. No additional SMS, payment or migration.

### Qualification CRM avant activation des canaux

`CRM_QUALIFICATION_RESTAURANT_IDS` : variable serveur du dashboard, liste séparée par des
virgules d’identifiants de restaurants dédiés à la recette RGPD. Vide par défaut ; `*` est ignoré.
Après complétion des étapes `restaurant`, `hours` et `floor`, ces restaurants peuvent accéder à
`/dashboard/customers` et ses sous-pages sans numéro Sokar ni activation des canaux. Les autres
pages gardent le verrou d’onboarding complet. Ce réglage ne modifie aucune étape ni les contrôles
API (Clerk, site, rôle, formule). Il ne confère pas la formule Pro : qualifier les droits requis
séparément. Ne jamais publier le restaurant fictif. Retirer l’ID après la recette et redémarrer
le dashboard pour appliquer les changements d’environnement. La preuve P2_CRM exige toujours
l’exécution réelle des exports, effacements et refus croisés avec deux identités Clerk.
