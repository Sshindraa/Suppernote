# Suppernote Project Map

Carte d'orientation haut niveau. Ce n'est pas une source de vérité absolue. Pour le détail, voir `docs/runbooks/` et `docs/architecture/`.

> **Statut : ACTIF — présentation produit actualisée le 29 octobre 2026.**
> Le statut de chaque document produit et opérationnel est centralisé dans
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md), avec la réconciliation des audits dans
> [`audits/2026-09-15-current-state.md`](./audits/2026-09-15-current-state.md).

<a id="ce-quest-sokar"></a>

## Ce qu'est Suppernote

Suppernote est une plateforme française pour aider les restaurants à gérer leurs réservations, organiser
leur service et entretenir la relation avec leurs clients. L'assistant téléphonique vocal est une
fonction de cette plateforme, pas sa définition à lui seul.

Le produit couvre plusieurs usages, à des niveaux de disponibilité différents :

| Usage                     | Capacités développées                                                                                  | État et limites connus                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Réservations et accueil   | Carnet et planning, réservations en salle, page Connect et widget, disponibilités, liste d'attente     | Parcours présents dans le code ; vérifier les conditions de mise en service et les preuves par canal avant une proposition.                                |
| Service                   | Plan de salle, tables, allocation et Service Copilot                                                   | Fonctions développées ; la qualification terrain du Copilot reste à faire.                                                                                 |
| Téléphone                 | Assistant vocal, appels transférés, consultation des disponibilités et prise de réservation            | Recette vocale et installation à vérifier avant activation client ; ne pas garantir une disponibilité continue.                                            |
| Clients et fidélisation   | Fichier client, historique, préférences ; CRM avancé, segments, campagnes, retours privés et avantages | Socle et modules développés ; CRM avancé et envois marketing soumis aux portes de release. Fournisseurs et pilotes à qualifier avant promesse commerciale. |
| Cartes cadeaux            | Cartes, packs, utilisation et parcours Stripe                                                          | Parcours développés ; compte Stripe sandbox de démonstration et notifications à qualifier avant ouverture commerciale.                                     |
| Expériences et événements | Catalogues, sessions, capacités, réservations ou billets et contrôle d'accès                           | Fondations développées sous flags ; paiement et ouverture publique des expériences à qualifier ; paiement et distribution des événements non actifs.       |
| Plusieurs établissements  | Comptes, sélection de site, rôles et facturation                                                       | Socle développé ; isolation avec identités réelles et partage client inter-sites à qualifier.                                                              |
| Canaux et intégrations    | Réservation agentique/MCP, fondations de distribution et de connexion caisse                           | Présence dans le code ne vaut pas ouverture partenaire ; accord OpenAI Reserve non confirmé, aucun connecteur caisse ou distribution partenaire actif.     |

Cette liste décrit le produit développé, pas une liste d'inclusions disponibles pour chaque client.
Avant de vendre ou d'activer une fonction, consulter les flags et portes de
[`product-gates.json`](./release/product-gates.json), les runbooks concernés et les TODOs actifs de
[`Context.md`](./obsidian/Context.md). Les prix et droits d'une formule ne prouvent pas à eux seuls
qu'un parcours est qualifié. Les SMS de réservation et WhatsApp restent désactivés en production
selon le suivi courant.

- **Dashboard** : espace privé restaurateur (Next.js + Clerk).
- **Suppernote Connect** : site public et widget de réservation (Next.js).
- **Voice** : assistant vocal, une fonction de la plateforme (Telnyx + ElevenLabs + Cartesia TTS).
- **MCP / OpenAI Reserve** : couche agentic pour ChatGPT, Claude, etc.

## Layout du monorepo

```text
apps/
  api/            # Fastify backend (routes, workers, voice, MCP)
  dashboard/      # Next.js dashboard restaurateur (Clerk)
  connect/        # Next.js site public (SEO, fiches resto, widget)
  widget/         # Next.js widget embeddable (export)
packages/
  database/       # Prisma schema, seed, migrations
  config/         # Config partagée (ESLint, TS, Tailwind)
  shared/         # Utilitaires partagés
```

## Modules API (`apps/api/src/modules/`)

| Module                 | Rôle                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `restaurants`          | CRUD resto, onboarding, personnalité, images, score Connect, slug.                                                                                                                               |
| `reservations`         | CRUD réservations legacy.                                                                                                                                                                        |
| `agentic-reservations` | MCP server, OAuth, OpenAI Reserve, holds, devis, state-machine, audit log, workers.                                                                                                              |
| `calls`                | Historique et transcripts d'appels.                                                                                                                                                              |
| `customers`            | CRM avancé local : identité, timeline, RFM, préférences, tags et segments bornés.                                                                                                                |
| `pos`                  | Fondation caisse provider-neutral : connexions, tickets normalisés, import idempotent et matcher réservation-ticket.                                                                             |
| `marketing`            | Permissions par canal, audiences, campagnes, automations bornées, worker, désinscription et attribution locale.                                                                                  |
| `reputation`           | Feedback privé post-visite par e-mail, scores bornés, tâches de récupération et expiration périodique.                                                                                           |
| `loyalty`              | Catalogue d'avantages Pro, règles explicables, grants à code hashé, consommation atomique et expiration ; providers désactivés.                                                                  |
| `experiences`          | Catalogue d'expériences Pro, sessions datées, capacité atomique, snapshot prix, réservations/annulations idempotentes et expiration ; paiement/canaux externes désactivés.                       |
| `events`               | Catalogue événementiel Pro, sessions/tarifs, jauge atomique, commandes et billets hashés, check-in, liste d'attente et traces locales ; paiement/distribution désactivés.                        |
| `distribution`         | Fondation provider-neutral : connexions hachées, snapshots de disponibilité, runs idempotents, liens explicites, inbox webhook et dashboard de qualification ; fournisseurs externes désactivés. |
| `floor-plan`           | Plan de salle, sections, tables, disponibilité capacitaire.                                                                                                                                      |
| `gift-cards`           | Cartes cadeaux, packs, redeem, contributions, Stripe.                                                                                                                                            |
| `billing`              | Abonnements SaaS Stripe Checkout, synchronisation webhook et état de formule.                                                                                                                    |
| `connect`              | API publique Connect, disponibilités, Google Places, JSON-LD.                                                                                                                                    |
| `dashboard`            | Métriques dashboard, réactivation.                                                                                                                                                               |
| `analytics`            | Événements, ROI, rapports.                                                                                                                                                                       |
| `voice`                | Pipeline Telnyx, media stream, session manager, LLM, TTS, fillers.                                                                                                                               |
| `sms` / `whatsapp`     | Webhooks entrants SMS / WhatsApp.                                                                                                                                                                |
| `auth`                 | Sync Clerk / provisionnement org.                                                                                                                                                                |
| `rgpd`                 | Effacement et export des données.                                                                                                                                                                |
| `admin`                | Feature flags, onboarding funnel, provisioning Telnyx et garde de readiness pilote.                                                                                                              |
| `integrations`         | Routes Google.                                                                                                                                                                                   |
| `pilot`                | Gestion des pilotes.                                                                                                                                                                             |
| `test`                 | Helpers dev-only (non chargés en prod).                                                                                                                                                          |

## Points d'entrée publics

- **Dashboard** : `https://suppernote.com` (Next.js App Router, Clerk).
- **Connect** : `https://suppernote.com/restaurant/<slug>`, `/restaurants/<city>`, `/widget/<slug>/gift-card`. Le formulaire `/widget/<slug>` et `/book/<slug>` vient du dashboard.
- **Widget** : `apps/widget/src/app/restaurant-reservation/`.
- **API** : `https://api.suppernote.com`.
- **Versioning API public** : `main.ts` réécrit `/public/v1/*` vers `/public/*` (transition progressive). Les routes publiques sont dans `connect.routes.ts`.

Les routes CRM et marketing sont authentifiées par organisation via `requireOrg` et les capabilities
Pro. Les routes de désinscription et de clic d'attribution sont publiques, mais n'acceptent que des
tokens HMAC expirants dont le hash est conservé en base.

La fondation POS est authentifiée par organisation via `requireOrg`, la capability `pos.connect` et
un rôle Owner/Manager. `POS_CONNECTORS_ENABLED=false` bloque toutes les routes tant qu'un fournisseur
et son sandbox ne sont pas qualifiés ; aucune donnée de secret ou payload brut n'est stockée.

Le CRM groupe est authentifié par organisation via `requireOrg`, la capability `customers.group`
(Multi-site uniquement) et un rôle Owner/Manager. `CUSTOMER_GROUPS_ENABLED=false` bloque les routes
tant que les identités Clerk, le consentement inter-sites et l'effacement consolidé ne sont pas
qualifiés. Les projections `Customer` restent attachées à leur établissement ; un
`CustomerGroupMembership` explicite et unique par compte/client fait le lien, et les réponses ne
retournent que les quatre derniers chiffres du téléphone.

La réputation est réservée à Pro/Multi-site et aux rôles Owner/Manager. Après une visite honorée, un e-mail de retour privé part à J+1, au plus une fois par client et restaurant en 90 jours, avec désinscription et plafond de 10 tentatives par jour UTC. Une note ≤ 2 crée une tâche de récupération. Aucun lien vers une plateforme d'avis n'est envoyé.

La fidélité opérationnelle est authentifiée par organisation via `requireOrg`, la capability
`reputation.loyalty` (Pro/Multi-site) et un rôle Owner/Manager/Staff selon l'opération. Les avantages sont limités à une règle, un coût estimé en EUR et une validité ; un grant
conserve uniquement le hash d'un code à usage unique. Le redeem est atomique et le worker
`loyalty-grant-expiry` expire les grants toutes les 15 minutes. Aucun point, canal d'envoi, POS ou
débit n'est appelé.

La fondation expériences est authentifiée par organisation via `requireOrg`, la capability
`experiences.manage` (Pro/Multi-site) et un rôle Owner/Manager/Staff selon l'opération, avec
`EXPERIENCES_ENABLED=false` par défaut. Les fiches restent en brouillon jusqu'à activation ; une
réservation d'une session active acquiert un advisory lock PostgreSQL, vérifie la capacité et fige
le prix. `EXPERIENCE_BOOKING_ENABLED=false` sépare l'ouverture publique : lorsqu'il est activé en
plus du flag socle, Suppernote Connect publie les dates, tient les places pendant Stripe Checkout et
confirme uniquement après webhook signé. Remboursements complets à l'annulation restaurateur ; les
conditions commerciales et notifications restent à qualifier avant production.

La fondation événements est authentifiée par organisation via `requireOrg`, la capability
`events.manage` (Pro/Multi-site) et un rôle Owner/Manager/Staff selon l'opération, avec
`EVENTS_ENABLED=false` par défaut. Les sessions partagent une jauge transactionnelle protégée par
un advisory lock ; chaque commande fige le tarif et émet des codes billet dont seul le hash est
conservé. Le check-in est atomique et idempotent, la liste d'attente est ordonnée et le worker
`event-session-expiry` ferme les sessions échues toutes les 15 minutes. Les champs de facture et
de remboursement sont des traces locales : aucun paiement, notification ou canal partenaire n'est
appelé.

La fondation distribution est authentifiée par organisation via `requireOrg`, la capability
`distribution.manage` (Pro/Multi-site) et un rôle Owner/Manager/Staff selon l'opération, avec
`DISTRIBUTION_ENABLED=false` par défaut. Les connexions ne conservent que des hashes, quatre
derniers caractères et une référence opaque de secret ; les snapshots sont informatifs, les
runs et webhooks sont idempotents et les liens de réservation doivent être explicites. Aucun
adaptateur Google/Meta, OAuth, webhook public ou appel fournisseur n'est activé.

Le gel de production des offres 199/299 est contrôlé par [`docs/release/product-gates.json`](./release/product-gates.json)
et `scripts/verify-product-gates.mjs`. Le manifest contient toutes les portes P0 à P9 et le
pilote, avec un tableau `blockers` pour chaque porte non fermée ; `LOCAL_ONLY` signifie que le lot
est livré et testé localement, mais que la preuve externe manque. Une promotion peut utiliser le
profil `productionRelease` uniquement pour un périmètre explicite : les portes requises doivent
être `CLOSED`, les portes différées doivent être partitionnées exactement et leurs flags doivent
rester désactivés dans `apps/api/.env`. Sans profil scoped, `scripts/deploy.sh` refuse la promotion
tant que le manifest n'est pas entièrement `CLOSED` et que `productionFreeze` reste à `true` ; un
rollback reste possible.

## Pages Dashboard (`apps/dashboard/src/app/`)

- `/` — landing/marketing.
- `/login`, `/register` — Clerk auth.
- `/onboarding/[step]` — onboarding restaurateur.
- `/dashboard` — métriques, graphiques, sync org.
- `/dashboard/usage` — ancienne surface opérateur conservée comme alias vers `/admin/margin` ; aucun coût interne n'est exposé au restaurant.
- `/admin` — espace opérateur Suppernote séparé du dashboard restaurant ; vue générale, coûts opérationnels, santé et provisioning.
- `/admin/provisioning` — cockpit opérateur : numéro, webhook, renvoi et appel test avec confirmation avant activation. L'ancienne URL `/dashboard/admin/provisioning` redirige vers cet espace.
- `/admin/margin` — cockpit opérateur du coût par établissement, du catalogue local, de la marge calculable, de la file des corrections et du téléchargement du suivi interne. Le script `usage:accounting:package` emballe ensuite cet export pour une éventuelle étape comptable, en séparant les devises.
- `/dashboard/reservations` — liste réservations.
- `/dashboard/calls` — appels.
- `/dashboard/customers` — CRM.
- `/dashboard/marketing` — configuration des automations Pro, campagnes snapshot et rapports.
- `/dashboard/marketing/segments` — constructeur Pro borné, preview, CRUD et refresh des segments.
- `/dashboard/reputation` — score moyen, retours récents et boîte de récupération Owner/Manager.
- `/dashboard/loyalty` — catalogue d'avantages Pro, émissions à code unique et consommation auditée.
- `/dashboard/experiences` — catalogue Pro, sessions à capacité contrôlée et réservations annulables.
- `/dashboard/events` — catalogue Pro, sessions/tarifs, commandes, billets et contrôle d'accès ; paiement et distribution verrouillés.
- `/dashboard/distribution` — connexions provider-neutral, snapshots, runs, liens de réservations et inbox webhook pour la qualification ; fournisseurs externes verrouillés.
- `/dashboard/floor-plan` — plan de salle.
- `/dashboard/gift-cards`, `/dashboard/gift-card-packs` — cartes cadeaux.
- `/dashboard/connect` — publication Connect.
- `/dashboard/agentic` — agentic reservations.
- `/dashboard/reactivation` — campagnes VIP.
- `/dashboard/settings` — paramètres.
- Les connexions POS sont pour l'instant opérées par l'API (`/pos/connections*`) ; aucune page
  dashboard ne les présente avant la qualification d'un fournisseur.
- Les groupes client sont pour l'instant opérés par l'API (`/customer-groups*`) ; aucune page
  dashboard ne les présente avant la qualification d'un fournisseur d'identité et d'un pilote
  multi-site.
- La page réputation (`/dashboard/reputation`) lit les retours et les tâches via l'API et permet les
  transitions `OPEN → IN_PROGRESS → RESOLVED` pour Pro/Multi-site.
- La page fidélité (`/dashboard/loyalty`) lit les avantages et grants via l'API et expose les
  transitions d'émission/consommation pour Pro et Multi-site, en version manuelle.
- La page expériences (`/dashboard/experiences`) lit le catalogue, ouvre des dates et annule les
  réservations via l'API. Elle affiche l'état réel de l'ouverture publique ; le checkout Connect
  reste désactivé par `EXPERIENCE_BOOKING_ENABLED=false` jusqu'à qualification staging.
- La page distribution (`/dashboard/distribution`) lit les connexions et traces de qualification,
  permet de créer une référence opaque et de mettre un run local en file. Elle reste verrouillée
  par `DISTRIBUTION_ENABLED=false` tant que le fournisseur, la signature, le worker et le pilote ne
  sont pas qualifiés.
- `/dashboard/widget` — widget embarqué.
- `/mcp` — page MCP OAuth.
- `/api/auth/sync` — sync Clerk.
- `/api/proxy/[...path]` — proxy vers l'API.

## Pages Connect (`apps/connect/src/app/`)

- `page.tsx` — homepage.
- `restaurant/[slug]/` — fiche restaurant (ISR prod, `force-dynamic` staging).
- `restaurants/[city]/` — listing ville.
- `widget/[slug]/` — widget standalone (réservation + cartes cadeaux).
- `assistant/` — page assistant.
- `.well-known/ai-plugin/` — discovery MCP/OpenAI.
- `llms.txt` — context LLM.
- `privacy/` — privacy policy.

## Flux de réservation

### Legacy (téléphone / web dashboard)

- Appel entrant → Telnyx → `voice/telnyx.pipeline.ts` → LLM/Scribe → `reservations`.
- Dashboard → `reservations/reservation.routes.ts` → `reservation.service.ts`.

### Agentic / MCP

- Agent IA → `agentic-reservations/mcp/server.ts`.
- Tools : availability, hold, quote, confirm, cancel.
- State-machine : `agentic-reservations/core/state-machine.ts`.
- Expiration des holds/devis : `agentic-reservations/workers/`.
- Feed OpenAI Reserve : `agentic-reservations/openai-reserve/`.
- Spec détaillée : `docs/sokar-mcp-agentic-reservations-v3.2.md`.

### Connect / widget

- Page publique → `connect.service.ts` (agrégateur) ; disponibilités via `CapacityAwareAvailabilityService` (floor-plan).
- Widget de réservation : `apps/dashboard/src/components/reservation/reservation-widget.tsx`, servi par le dashboard sur `/widget/<slug>` et `/book/<slug>` (suppernote.com, sous-domaines et domaines personnalisés). Écran ChatGPT : `apps/widget/src/app/restaurant-reservation/` (non publié).
- Cartes cadeaux : `widget/[slug]/gift-card/` et `gift-card-*` components.

### CRM / marketing

- CRM : `customer-crm.routes.ts`, `customer-segment.routes.ts`, `customer-merge.service.ts`,
  dual-write dans les services de réservation/appel et backfill
  `apps/api/scripts/backfill-customer-crm.ts`. Les routes `/crm/duplicates`,
  `/crm/customers/:id/merge-preview`, `/crm/customers/:id/merge` et `/crm/merges` sont tenant-scoped ;
  la mutation exige `Idempotency-Key` et le rôle Owner. La fiche CRM lance l'export RGPD par code
  SMS et télécharge un JSON sans exposer le token de vérification. Les profils et timelines
  masquent `notes` et `metadata` aux rôles absents de la politique du site ; `GET/PATCH
/crm/privacy` la consulte et la configure pour Owner, avec fallback sur
  `CRM_SENSITIVE_NOTE_ROLES` (Owner/Manager par défaut). La route historique `/customers` applique
  le même masquage et réserve l'écriture des notes à Owner/Manager. La lecture est faite dans la
  réponse et n'écrit jamais les notes en clair.
- Marketing : `marketing.routes.ts`, `marketing-provider.routes.ts`, `marketing-campaign.service.ts`,
  `marketing-automation.service.ts`, `marketing-provider.service.ts`, workers BullMQ
  `marketing-campaign.worker.ts`, `marketing-automation.worker.ts` et
  `marketing-provider-reconciliation.worker.ts`, permissions par canal, liens
  d'attribution, rapport et export CSV agrégé. Les pages `/dashboard/marketing`, `/dashboard/marketing/segments` et
  `/dashboard/marketing/campaigns/new` exposent les réglages bornés, le constructeur de segments,
  l'éditeur de brouillon, le preview serveur, le report CSV et l'état de readiness sans secrets
  (avec les noms des variables manquantes)
  sans ouvrir les envois fournisseurs. Les callbacks non rattachés sont stockés dans
  `MarketingProviderReconciliation` et réconciliés par le feed interne protégé par token.
- Les campagnes restent désactivées tant que `MARKETING_SENDS_ENABLED` n'est pas explicitement
  activé dans un environnement de test validé.

### POS / caisse

- `apps/api/src/modules/pos/pos.routes.ts` expose les connexions, la santé, la déconnexion et
  l'import manuel dry-run/commit sous `pos.connect`.
- `pos-connector.ts` est le contrat à implémenter après le choix fournisseur ;
  `pos-connection.service.ts` ne conserve qu'une référence opaque vers le gestionnaire de secrets.
- `pos-sync.service.ts` normalise les montants en `DECIMAL(12,2)`, hash le payload, avance le curseur
  après la transaction et peut enregistrer un `ReservationCheckMatch` explicable.

### Protection bancaire des réservations

- `apps/api/src/modules/reservation-payments/reservation-payment.routes.ts` expose les policies
  versionnées, la préparation dry-run/commit, l'état d'une tentative, l'expiration, le prélèvement et
  le remboursement d'une empreinte sous le capability Pro `reservations.payments`. Les événements
  Stripe passent par `/webhooks/stripe` puis `reservation-payment.webhook.ts`.
- `reservation-payment.service.ts` calcule les montants fixes/par personne, applique une machine
  d'états idempotente, vérifie devise/montant, hash les événements et confirme une réservation
  `PENDING` dans la transaction. Aucun numéro de carte, payload brut ou secret n'est stocké.
- Empreinte bancaire (spec `docs/reservation-card-guarantee-spec.md`) : compte Connect du restaurant
  (direct charges), Checkout en mode `setup`, prélèvement hors session décidé par l'équipe, place tenue
  par la réservation `PENDING` et libérée chaque minute à l'expiration. Parcours client, écrans et
  qualification sandbox à venir ; `RESERVATION_PAYMENTS_ENABLED=false` par défaut.

### CRM groupe / identité multi-site

- `apps/api/src/modules/customer-groups/customer-group.routes.ts` expose la liste, la création, le
  détail, le consentement, le rattachement et le dé-rattachement sous `customers.group`.
- `customer-group.service.ts` valide le compte et le site actif, exige `OPTED_IN` avant tout lien,
  normalise la source et la confiance, gère l'idempotence sur `(accountId, customerId)` et supprime
  les liens dans la transaction de retrait de consentement.
- Les modèles `CustomerGroupProfile` et `CustomerGroupMembership` ne déplacent jamais
  `Customer.restaurantId` ; les téléphones sont masqués dans les vues de groupe.
- Le rapprochement automatique, les identités Clerk réelles, l'export/effacement multi-sites et les
  campagnes consolidées restent hors activation ; `CUSTOMER_GROUPS_ENABLED=false` par défaut.

### Réputation et récupération

- `apps/api/src/modules/reputation/reputation.routes.ts` expose la création/liste des demandes,
  les feedbacks, les tâches de récupération et la soumission publique par token.
- `reputation.service.ts` vérifie `HONORED`, hache les tokens, borne score/commentaire, rend la
  soumission idempotente et crée une tâche pour les scores faibles dans la même transaction.
- `reputation-feedback-expiry.worker.ts` expire les demandes `PENDING`/`SENT` toutes les 15 minutes.
  L’envoi privé utilise Resend et le budget transactionnel, avec un plafond de 10 tentatives quotidiennes.

### Fidélité opérationnelle

- `apps/api/src/modules/loyalty/loyalty.routes.ts` expose le catalogue, l'émission, le redeem, le
  void et l'expiration interne sous `reputation.loyalty`.
- `loyalty.service.ts` borne les règles et les montants, vérifie l'éligibilité CRM, hache le code,
  protège la limite d'utilisation par advisory lock et rend le redeem idempotent.
- `loyalty-grant-expiry.worker.ts` traite la queue `loyalty-grant-expiry` toutes les 15 minutes.
  Les points, l'envoi et le POS sont hors périmètre.

### Expériences et sessions

- `apps/api/src/modules/experiences/experience.routes.ts` expose le catalogue, les sessions, les
  réservations, le checkout public, l'état de préparation Stripe, l'annulation et l'expiration
  interne sous `experiences.manage`.
- `experience.service.ts` borne les dates, montants et capacités, refuse les fiches inactives,
  hache les clés d'idempotence, verrouille la session et conserve le snapshot de prix.
- `experience-payment.service.ts` réserve temporairement la capacité, vérifie le webhook Stripe
  Connect, confirme la réservation après paiement et déclenche les remboursements totaux.
- `experience-session-expiry.worker.ts` traite la queue `experience-session-expiry` toutes les
  15 minutes. Les deux flags restent à `false` par défaut. Voir
  [`docs/runbooks/experience-booking-pilot.md`](runbooks/experience-booking-pilot.md) avant tout
  pilote réel.

### Événements et billetterie locale

- `apps/api/src/modules/events/event.routes.ts` expose le catalogue, les sessions, les tarifs, les
  commandes, les billets, le check-in, la liste d'attente et l'expiration interne sous
  `events.manage`.
- `event.service.ts` borne les prix EUR et les quantités, hache les clés d'idempotence et les codes,
  prend un advisory lock par session, émet un billet par unité et applique les transitions
  `CONFIRMED → CANCELLED/REFUNDED` et `ISSUED → CHECKED_IN` de façon conditionnelle.
- `event-session-expiry.worker.ts` traite la queue `event-session-expiry` toutes les 15 minutes.
  `EVENTS_ENABLED=false` reste le défaut ; facture fiscale, paiements, notifications et canaux
  partenaires sont hors périmètre.

## Paiements

- Les abonnements SaaS passent par Stripe Checkout (`POST /billing/checkout-session`) ; les six prix récurrents sont configurés par `STRIPE_PRICE_*`.
- Le webhook partagé `/webhooks/stripe` synchronise les abonnements et conserve l'état dans `RestaurantBilling`.
- Module `gift-cards/` : cartes cadeaux, packs, redeem, contributions et paiements Stripe.
- Modèles : `GiftCard`, `GiftCardPack`, `GiftCardRedemption`, `GiftCardContribution`.
- Protection réservation (fondation locale) : `ReservationPaymentPolicy`, `ReservationPayment`,
  `ReservationPaymentEvent`. Les intents Stripe sont optionnels jusqu'à la qualification du marchand.
- Spec : `docs/gift-cards-spec.md`.

## Voice

- Carrier : Telnyx.
- Pipeline : `apps/api/src/modules/voice/telnyx.pipeline.ts`.
- WebSocket media stream : `modules/voice/stream/` (handler, session manager, LLM, TTS, fillers cache).
- TTS : Cartesia Sonic 3.6 continu (`sonic-3.6`) avec locale, normalisation, `generation_config`, dictionnaire de prononciation et empreinte de cache (`voice/cartesia-synth.ts`, `stream/cartesia-config.ts`, `fillers-cache.ts`).
- STT : ElevenLabs.
- Voir `docs/architecture/voice.md` et `docs/obsidian/Telnyx Pipeline.md`.

## Authentification

- Clerk JWT multi-tenant.
- Plugin Fastify : `apps/api/src/plugins/clerk.ts` (`requireOrg` pre-handler).
- Dashboard : middleware/pages Clerk dans `login/`, `register/`.
- MCP OAuth : `agentic-reservations/mcp/oauth.ts`.

## Base de données (Prisma)

Modèles clés (`packages/database/prisma/schema.prisma`) :

| Modèle                                                                                                                                              | Rôle                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `Restaurant`, `RestaurantImage`, `RestaurantExposureSettings`                                                                                       | Core resto et publication Connect.                                                             |
| `Call`, `Reservation`, `AgentPersonality`, `CallQuota`                                                                                              | Appels et réservations.                                                                        |
| `Customer`, `CustomerIdentity`, `CustomerTimelineEvent`, `CustomerMetricSnapshot`, `CustomerMergeAudit`                                             | Projection CRM, RFM et audit des fusions.                                                      |
| `CustomerPreference`, `CustomerTag`, `CustomerTagAssignment`, `CustomerSegment`                                                                     | Préférences, tags et segments bornés.                                                          |
| `MarketingPermission*`, `MarketingSuppression`, `MarketingCampaign`, `CampaignAudienceMember`, `CampaignMessage`, `MarketingProviderReconciliation` | Contrôle marketing et réconciliation provider.                                                 |
| `MarketingAutomation`, `MarketingAutomationDispatch`                                                                                                | Déclencheurs bornés et claims dédupliquées.                                                    |
| `MarketingConversion`, `MarketingAttributionLink`, `MarketingFrequencyWindow`                                                                       | Attribution et pression marketing.                                                             |
| `Message`, `CustomerConsent`, `ReactivationCampaign`                                                                                                | Compatibilité legacy ; la réactivation validée est liée à `MarketingCampaign`.                 |
| `FloorPlan`, `Section`, `Table`                                                                                                                     | Plan de salle.                                                                                 |
| `AgenticHold`, `ReservationAuditLog`, `IdempotencyRecord`, `AgentClient`                                                                            | Agentic layer.                                                                                 |
| `GiftCard`, `GiftCardPack`, `GiftCardRedemption`, `GiftCardContribution`                                                                            | Paiements (cartes cadeaux).                                                                    |
| `ReservationPaymentPolicy`, `ReservationPayment`, `ReservationPaymentEvent`                                                                         | Protection bancaire versionnée des réservations ; provider désactivé par défaut.               |
| `CustomerGroupProfile`, `CustomerGroupMembership`                                                                                                   | Identité client groupe et liens inter-sites consentis ; flag désactivé par défaut.             |
| `ReputationFeedbackRequest`, `ReputationFeedback`, `ReputationRecoveryTask`                                                                         | Retour post-visite tokenisé, récupération opérateur et expiration ; flag désactivé par défaut. |
| `IdentityVerificationOtp`, `SignedTokenUsage`                                                                                                       | RGPD — vérification identité.                                                                  |
| `OnboardingEvent`                                                                                                                                   | Analytics onboarding.                                                                          |
| `LatencyTrace`                                                                                                                                      | Latence voice.                                                                                 |
| `UsageEvent`, `UsageMonthlyRollup`, `UsageTariff`, `UsageReconciliationAdjustment`                                                                  | Ledger d'usage, rollups, coûts internes versionnés et corrections comptables séparées.         |
| `OutboxEvent`                                                                                                                                       | Intentions Postgres durables avant livraison BullMQ.                                           |

## Jobs & queues (BullMQ)

Définitions de queues : `apps/api/src/shared/queue/queues.ts`. Workers : `apps/api/src/shared/queue/workers/`.

Deux topologies d'exécution (R1-1) : en développement, l'API porte aussi les workers
(`RUN_WORKERS_IN_PROCESS=true`, défaut) ; en production, `dist/main.js` ne sert que le HTTP
(`RUN_WORKERS_IN_PROCESS=false` posé par PM2) et les workers tournent dans `dist/worker.js`
(PM2 `sokar-workers`). La liste des workers à charger est unique :
`apps/api/src/workers/index.ts`, protégée par un test qui échoue si un `*.worker.ts` n'y est pas
importé. L'inscription des jobs récurrents vit dans `apps/api/src/shared/queue/schedulers.ts` et
utilise `upsertJobScheduler`, idempotent par identifiant.

- `eveningReport` — rapport nocturne par restaurant.
- `confirmationSms` — SMS de rappel J-1 à 17h.
- `reconciliation` — reconciliation appels/SMS journalière.
- `reactivation` — scan VIP hebdomadaire ; la validation migre vers la queue marketing gouvernée.
- `analytics` / `connectAnalytics` — événements analytics.
- `telnyxWebhooks` — webhooks Telnyx entrants.
- `callRecovery` — recovery d'appels.
- `smsManager` / `smsClient` — envoi SMS.
- `googlePlacesSync` — sync Google Places.
- `alertEvaluation` — évaluation d'alertes Prometheus (toutes les 5 min).
- `usageAlerts` — seuils de consommation 70/90/100 % avec claims Redis (horaire, désactivé par défaut).
- `systemHealth` — contrôles périodiques de santé des dépendances.
- `idempotencyPurge` — purge des enregistrements d'idempotence expirés.
- `holdCleanup` — nettoyage des holds et devis expirés.
- `waitingListCleanup` / `waitingListPromote` — expiration et promotion de liste d'attente.
- `giftCardReminder` — rappels liés aux cartes cadeaux.
- `outboxDispatcher` — revendication `SKIP LOCKED`, leases et publication des événements durables.
- `outboxDelivery` — consommation idempotente des topics outbox (usage voix et messagerie).
- `usageRollup` — reconstruction horaire des projections mensuelles depuis le ledger append-only.
- `marketingCampaign` — exécution bornée des messages de campagne, recontrôle de consentement et
  états durables en Postgres.
- `marketingAutomation` — scan horaire des déclencheurs Pro, création de campagnes snapshot et
  ré-enqueue des campagnes `READY` après une panne Redis (aucun envoi quand le flag est désactivé).
- `marketingProviderReconciliation` — rattachement périodique des callbacks provider reçus avant
  leur `CampaignMessage`, sans appel externe et avec clôture idempotente.
- `reputationFeedbackExpiry` — expiration bornée des demandes de feedback post-visite toutes les
  15 minutes ; aucune action fournisseur.
- `loyaltyGrantExpiry` — expiration bornée des grants fidélité `ISSUED` toutes les 15 minutes ;
  aucun canal ou provider.
- `experienceSessionExpiry` — fermeture bornée des sessions d'expérience `OPEN` terminées toutes
  les 15 minutes ; aucun paiement ou canal externe.

Les opérations de coûts sont volontairement hors route tenant :
`apps/api/scripts/import-usage-tariffs.ts` valide et charge les tarifs issus d'une facture, tandis
que `apps/api/scripts/reconcile-usage-invoice.ts` compare une facture au ledger en lecture seule et
peut conserver un rapport JSON avec `--output`. Les routes opérateur de
`usage.routes.ts` enregistrent ensuite les écarts dans `UsageReconciliationAdjustment` et
permettent une décision `APPROVED`/`REJECTED` depuis l'état `OPEN`, sans réécriture du ledger. La
route `GET /admin/usage/accounting-export.csv` et l'action de téléchargement du cockpit agrègent les usages par
dimension et ajoutent les corrections approuvées comme lignes distinctes ; les corrections globales
restent `UNALLOCATED` tant qu'elles ne sont pas réparties explicitement.
Les deux scripts sont dry-run/stricts par défaut et ne contiennent aucun taux réel. Le preview de
campagne résout ce même catalogue pour afficher un coût estimé lorsque la date et la dimension du
canal sont couvertes ; il reste `NOT_AVAILABLE` sans tarif validé.

## Tests

```zsh
pnpm test       # Vitest
pnpm lint       # turbo lint + stylelint
pnpm lint:css
pnpm test:e2e   # Playwright dashboard
pnpm test:visual # régression visuelle
```

- Tests API : `*.routes.test.ts` / `*.service.test.ts` dans les modules.
- Tests dashboard : `apps/dashboard/e2e/`.
- Tests Connect : `apps/connect/src/app/**/*.test.ts`.

## CI / déploiement

- GitHub Actions : `.github/workflows/`.
- Staging : auto-deploy sur `main` + smoke tests.
- Production : promotion automatique après CI et staging verts, avec snapshot, health checks et
  rollback obligatoires. Voir `docs/runbooks/deployment.md` et `docs/runbooks/rollback.md`.

## Points sensibles / contraintes

- Ne jamais committer de secrets ; utiliser `key_env` et `.env`.
- `NEXT_PUBLIC_*` est baked au build time.
- Les webhooks Telnyx nécessitent le raw body pour vérifier la signature. Ne pas modifier le `contentTypeParser` de `main.ts` sans retester les signatures.
- Rate limiting et CORS : `apps/api/src/plugins/`. La politique à paliers (webhooks fournisseurs,
  endpoints publics à token, écritures publiques) est dans `plugins/rate-limit.policy.ts` ; le
  global 100 req/min est dans `plugins/rate-limit.ts`.
- Agentic : expiration des holds/devis, index partiel sur l'idempotence.
- RGPD : erase/export via pattern OTP → verification token → one-shot action.
- Connect : pages publiques statiques/ISR ; staging force-dynamic pour `/restaurant/[slug]`.
- Dashboard : règles UI verrouillées par `stylelint` et `onboarding-tone.test.ts` (`vous` partout).
- Compte `deploy` restreint : `sokar-deploy-root` pour les opérations privilégiées.

## Docs connexes

- `AGENTS.md` — contexte court pour agents.
- `docs/runbooks/` — ops, déploiement, environnement, tests.
- `docs/architecture/` — dashboard, voice.
- `docs/architecture/adr-crm-marketing-control-plane.md` — décisions et limites du lot CRM/marketing.
- `docs/obsidian/` — specs, pipelines, contexte produit.
- `docs/gift-cards-spec.md` — cartes cadeaux.
- `docs/sokar-mcp-agentic-reservations-v3.2.md` — agentic reservations.
- `docs/connect-v1.1.md` — Suppernote Connect.
