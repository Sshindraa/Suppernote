# API Endpoints

> **Dernière mise à jour** : 2026-09-15
> **Base URL dev** : `http://localhost:3001` (port configuré dans `apps/api/src/main.ts`)
> **Auth globale** : Clerk (sauf routes explicitement publiques — MCP, voice webhook, public Sokar Connect, RGPD `request-verification`, `confirm-link`, `privacy-policy`)
> **Génération** : inventaire auto depuis les fichiers `*.routes.ts` / `*.pipeline.ts`

Inventaire de référence des routes Fastify. Le code et les tests de route restent l'autorité lorsque
ce document n'indique pas encore un module récent.

---

## Restaurants

Module : `apps/api/src/modules/restaurants/restaurant.routes.ts`

### POST /restaurants

Crée un restaurant. (probablement utilisé en onboarding initial — à confirmer)

### GET /restaurants/:id

Récupère un restaurant par ID (auth Clerk requise).

### PATCH /restaurants/:id

Met à jour un restaurant.

### GET /restaurants/:id/public

Profil public basique (auth Clerk requise). **Note** : ne pas confondre avec
les futures routes `/public/r/:slug` de Sokar Connect qui seront **anonymes**.

### GET /restaurants/:id/availability

Disponibilités d'un restaurant. Réutilisée par les canaux agentic.

### GET /restaurants/:id/personality / PATCH /restaurants/:id/personality

Configuration de la personnalité vocale (AgentPersonality).

### Onboarding

| Méthode | Route                                                                        | Description                                                                     |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| GET     | `/restaurant/onboarding` ou `/api/restaurant/onboarding`                     | État d'onboarding                                                               |
| PATCH   | `/restaurant/onboarding` ou `/api/restaurant/onboarding`                     | Mise à jour état                                                                |
| POST    | `/restaurant/onboarding/test-call` ou `/api/restaurant/onboarding/test-call` | Déclenche un appel outbound et conserve son `callControlId` en attente          |
| PATCH   | `/restaurant/onboarding` ou `/api/restaurant/onboarding`                     | `action=first_call` avec le `callControlId` confirme l'appel reçu               |
| GET     | `/restaurant/onboarding/floor` ou `/api/restaurant/onboarding/floor`         | Tables actives du plan par défaut, groupées par taille, et effectifs            |
| PUT     | `/restaurant/onboarding/floor` ou `/api/restaurant/onboarding/floor`         | Création rapide de la salle : `{ tables: [{ capacity, count }] }`               |
| PUT     | `/restaurant/onboarding/practical` ou `/api/restaurant/onboarding/practical` | Faits pratiques : `{ practicalInfo: {…}, dietary? }`, `null` efface une réponse |

`GET /restaurant/onboarding` renvoie aussi `readiness` (`ready`, `checks`, `tableCount`, `seatCount`,
`largestTableCapacity`) : vrai seulement avec horaires, tables actives et règles. `PATCH` refuse
`complete` sur `floor` sans table (409 `NO_TABLES`) et `activate` si `readiness.ready` est faux
(409 `NOT_READY_TO_BOOK`).

Les routes existent en double préfixe (`/restaurant` et `/api/restaurant`)
probablement pour des raisons de compat historique.

---

## Reservations

Module : `apps/api/src/modules/reservations/reservation.routes.ts`

### GET /reservations

Liste les réservations du restaurant, avec date facultative. Route historique : la pagination est ignorée.

### GET /v2/reservations

Liste les réservations du restaurant authentifié ; `date` facultative (`AAAA-MM-JJ`), `limit` de 1 à 100 (50 par défaut), `offset` à partir de 0. Réponse : tableau, trié par date puis identifiant. Une page de moins de `limit` éléments indique la fin. Les modifications pendant la lecture peuvent déplacer des éléments entre pages.

### GET /v2/reservations/day

Lecture cohérente du service : `date` obligatoire (`AAAA-MM-JJ`), même garde et même périmètre que la route historique. Les pages sont lues dans une transaction PostgreSQL en `REPEATABLE READ` et renvoyées ensemble : la liste reflète le début de la lecture, pas les modifications ultérieures.

### POST /reservations

Crée une réservation pour une intégration legacy `phone`. Cette route est
interne et exige `X-Sokar-Reservation-Token`, correspondant à
`RESERVATION_SERVICE_TOKEN` côté API. Le pipeline vocal appelle directement le
service ; les réservations publiques utilisent les routes Connect
`/public/r/:slug/hold` puis `/public/r/:slug/confirm`.

### PATCH /reservations/:id / DELETE /reservations/:id

Mise à jour / suppression.

### Protection bancaire (fondation locale)

Module : `apps/api/src/modules/reservation-payments/reservation-payment.routes.ts`

| Méthode | Route                                       | Garde / comportement                                                   |
| ------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| GET     | `/reservation-payment-policies`             | Pro/Multi-site, lecture tenant-scoped ; policies versionnées           |
| POST    | `/reservation-payment-policies`             | Owner/Manager + flag `RESERVATION_PAYMENTS_ENABLED`                    |
| GET     | `/reservations/:id/payment`                 | État de la dernière tentative, sans identifiant secret                 |
| POST    | `/reservations/:id/payment/prepare`         | Préparation idempotente ; `dryRun=true` par défaut, aucun appel Stripe |
| POST    | `/reservations/:id/payment/expire`          | Expiration manuelle d'une tentative, Owner/Manager                     |
| POST    | `/api/internal/reservation-payments/expire` | Opérateur Sokar, nettoyage borné des échéances                         |
| POST    | `/reservations/:id/payment/capture`         | Owner/Manager : prélève une empreinte après `NO_SHOW`, 7 j max ; 202   |
| POST    | `/reservations/:id/payment/refund`          | Owner/Manager : remboursement total ou partiel du prélèvement ; 202    |

Les événements Stripe arrivent par `/webhooks/stripe` (endpoint Connect partagé), aiguillés vers
`reservation-payment.webhook.ts` avant les cartes cadeaux (`metadata.type = reservation_guarantee`,
ou PaymentIntent déjà enregistré pour `charge.*`). La route `/webhooks/stripe/reservation-payments`
a été retirée le 2026-11-13. Le webhook exige les métadonnées `restaurantId` et `reservationPaymentId`, vérifie montant/devise,
ignore les événements inconnus en les conservant sous forme de hash et ne stocke aucune carte ni
payload brut. Les intents Stripe réels, le modèle marchand Connect, le hold de capacité, les
captures et les remboursements restent désactivés tant que le pilote n'est pas qualifié.

---

## Floor plan

Module : `apps/api/src/modules/floor-plan/floor-plan.routes.ts`

### GET /restaurants/:id/floor-plan/reservations/:reservationId/suggest-table

Prévisualisation read-only de l’allocation pour une réservation, avec
`floorPlanId` optionnel. Retourne jusqu’à trois candidats dans `suggestions`
(`tableId`, `name`, `capacity`, `sectionId`, `score`, `reasons`) sans poser de
verrou SQL. Les champs `tableId` et `reason` restent retournés pour la
compatibilité des consommateurs existants.

### Service Copilot — retard et récupération

| Méthode | Route                                                                        | Description                                                                                 |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET     | `/restaurants/:id/service-copilot/recommendations`                           | Recommandations déterministes, sans mutation.                                               |
| POST    | `/restaurants/:id/service-copilot/telemetry`                                 | Événement silencieux `VIEWED`/`OPENED` signé, sans effet sur le service.                    |
| GET     | `/restaurants/:id/service-copilot/telemetry-summary?days=30`                 | Indicateurs de qualité par type et état, pour un espace séparé du Live service.             |
| GET     | `/restaurants/:id/service-copilot/telemetry-review?days=30`                  | Occurrences ouvertes ou expirées à qualifier après le service, sans donnée client.          |
| POST    | `/restaurants/:id/service-copilot/telemetry-review/:occurrenceId`            | Qualifie manuellement `APPLIED` ou `IGNORED` dans Copilot Qualité.                          |
| POST    | `/restaurants/:id/service-copilot/actions/server-rebalance`                  | Rééquilibre une table sur jeton HMAC, avec contrôle atomique et résultat audité.            |
| POST    | `/restaurants/:id/service-copilot/delay-impact`                              | Simule le déplacement et la promotion de liste d’attente.                                   |
| POST    | `/restaurants/:id/service-copilot/delay-impact/drafts`                       | Produit des brouillons `review-required`, sans envoi.                                       |
| POST    | `/restaurants/:id/service-copilot/delay-impact/apply`                        | Revalide, verrouille et applique le plan. Retourne aussi `operationId`.                     |
| POST    | `/restaurants/:id/service-copilot/delay-impact/revert`                       | Restaure le plan initial si aucune donnée n’a changé ; idempotent, audité, 409 sinon.       |
| GET     | `/restaurants/:id/service-copilot/delay-recoveries?date=YYYY-MM-DD&limit=10` | Reconstitue l’historique persistant des plans appliqués, annulés ou devenus non annulables. |
| GET     | `/restaurants/:id/service-copilot/pulse?date=YYYY-MM-DD`                     | Résumé serveur du service : retards, arrivées à installer, tables en service et attente.    |

`revert` reçoit `reservationId` et l’`operationId` retourné par `apply`. Il restaure les horaires et
la table d’origine, annule la réservation promue et remet l’entrée en `PENDING`. Les communications
déjà effectuées restent à corriger humainement.

`apply` conserve une empreinte SHA-256 des données métier confirmées. Un rejeu avec la même clé et
le même plan retourne le premier résultat sans nouvelle écriture. Avec la même clé mais un retard,
une table, une entrée d’attente ou une confirmation différente, il retourne `409` avec une demande
de recharger l’analyse. Le contrôle est refait avant et après les verrous transactionnels.

Les recommandations peuvent contenir un `telemetryToken` HMAC émis par le serveur. Il ne permet
que de déclarer les lectures et ouvertures ; les états appliqué, annulé ou en conflit sont enregistrés
par les routes serveur de récupération de retard et de rééquilibrage. Les décisions terrain que Sokar
ne peut pas vérifier (par exemple l’usage réel d’une table bientôt libre) sont qualifiées après le
service dans Copilot Qualité, avec traçabilité et sans donnée client. La télémétrie est optionnelle
hors production et nécessite `SERVICE_COPILOT_TELEMETRY_SECRET` (au moins 32 caractères) en production.

`delay-recoveries` lit les audits append-only et l’état métier courant, sans nouvelle table. Il permet
au dashboard de retrouver un plan après rafraîchissement ou depuis un autre appareil. Le champ
`revertible` reste indicatif : `revert` refait toujours la validation transactionnelle complète.

`pulse` est une lecture seule calculée dans le fuseau du restaurant. Sur la date courante, il
signale les arrivées en retard, à installer et attendues dans les 30 prochaines minutes ; sur une
autre date, il reste une synthèse non actionnable pour ne pas présenter de faux temps réel.

---

## Calls

Module : `apps/api/src/modules/calls/call.routes.ts`

### GET /calls / GET /calls/:id / DELETE /calls/:id

Historique des appels, transcripts, durées.

---

## Customers

Module : `apps/api/src/modules/customers/customer.routes.ts`

### GET /customers / POST /customers

Liste et upsert tenant-scoped. La liste masque `notes` et `specialOccasion` pour les rôles absents de la politique CRM
effective du site. L'upsert conserve les champs opérationnels pour l'équipe, mais la modification
de `notes` ou de `specialOccasion` est réservée aux rôles autorisés à lire les notes (même politique que la lecture, jamais READ_ONLY ; `CUSTOMER_NOTES_WRITE_ROLE_REQUIRED`).
Le numéro est stocké en E.164 (« 06… » → « +33… ») et un client connu est retrouvé sous l'une ou
l'autre forme ; l'upsert n'écrit que les champs envoyés (`isVip` absent = VIP conservé).
Chaque client porte `lifecycle` et `visitSummary` (visites honorées, 365 j, no-show, dernière
visite réelle), calculés sur les réservations. Les colonnes `visitCount` et `loyaltyScore` n'existent plus
(migration `20261027150000`) ; `lastSeenAt` bouge à chaque appel et ne doit pas être affiché
comme dernière visite. Recherche commune avec CRM Pro : nom, email, numéro saisi à la
française. Tri : dernier contact. Filtres : `isVip` (toutes les formules) ; `lifecycle` et
`minHonored365d` (visites honorées sur 365 j) exigent `customers.advanced` (offre Pro, 403
`CAPABILITY_NOT_INCLUDED` sinon ; offre Essential = CRM de base) et portent sur les 5 000 premiers
clients. Pagination `limit`/`offset`, `total` = résultats filtrés. `sort` : `recent` (défaut,
dernier contact), `visits365d` ou `lastVisit` (décroissant, calculés, `customers.advanced`).

### GET /customers/segment-counts

Effectifs des onglets de la liste (`customers.advanced`) : `{ data: { all, vip, new, active,
regular, at_risk, dormant } }`, avec la même `search` et le même périmètre que la liste. `all` et
`vip` sont exacts ; les statuts portent sur les 5 000 premiers clients.

### Admin : recalcul des chiffres d'un client

`GET /admin/restaurants/:restaurantId/customers/:customerId/projection-repair-preview` et
`POST …/projection-repair` (en-tête `Idempotency-Key`), opérateurs Sokar uniquement
(`requireSokarOperator`). Même calcul que `/crm/customers/:id/projection-repair*`, conservées
côté restaurant pour compatibilité mais sans écran ; l'outil vit dans l'admin « Santé du restaurant ».

### PATCH /customers/:id

Mise à jour. Comme pour l'upsert, une modification de `notes` ou `specialOccasion` suit la même règle ;
les autres champs restent soumis à l'authentification du site. Aucune suppression définitive
(`DELETE /customers/:id` retiré le 27/10/2026) : elle effaçait en cascade les refus marketing et
les preuves de consentement. L'effacement passe par l'anonymisation RGPD.

### POST /customers/:id/vip

Passe un client en VIP (notification gérée côté worker BullMQ).

### CRM avancé

Module : `apps/api/src/modules/customers/customer-crm.routes.ts`

| Méthode     | Route                                                                                  | Description                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| GET         | `/crm/customers`                                                                       | Liste CRM Pro : recherche commune, VIP, `lifecycle`, `minHonored365d` (calculés sur les réservations), tri stable par création. |
| GET         | `/crm/customers/:id`                                                                   | Profil, métriques, préférences, tags et 50 événements récents.                                                                  |
| GET         | `/crm/customers/:id/timeline`                                                          | Chronologie cursor-paginée.                                                                                                     |
| GET         | `/crm/tags`                                                                            | Tags du site courant.                                                                                                           |
| POST/DELETE | `/crm/customers/:id/tags[/:tagId]`                                                     | Ajout ou retrait idempotent d'un tag (Owner/Manager).                                                                           |
| PUT/DELETE  | `/crm/customers/:id/preferences/:key`                                                  | Préférence structurée allow-listée (Owner/Manager).                                                                             |
| GET         | `/crm/duplicates`, `/crm/merges`                                                       | Détection et audit des fusions (Owner/Manager).                                                                                 |
| POST        | `/crm/customers/:id/merge-preview`                                                     | Preview d'une fusion sans mutation (Owner/Manager).                                                                             |
| POST        | `/crm/customers/:id/merge`                                                             | Fusion auditée et idempotente (Owner uniquement).                                                                               |
| GET/POST    | `/crm/customers/:id/projection-repair-preview`, `/crm/customers/:id/projection-repair` | Vérification puis réparation de projection (Owner pour la mutation).                                                            |

| GET | `/crm/privacy` | Politique effective de visibilité des notes du site (Owner). |
| PATCH | `/crm/privacy` | Définit `sensitiveNoteRoles` pour le site ou `null` pour revenir au fallback environnement (Owner). |

Les deux routes de lecture du profil et de la chronologie masquent `notes`, `specialOccasion` (profil) et `metadata` pour les
rôles absents de la politique effective du site. Sans surcharge, `CRM_SENSITIVE_NOTE_ROLES` est
utilisé ; la valeur par défaut est `OWNER,MANAGER`. Le masquage est fait dans la réponse et ne
modifie pas les données persistées.

## POS / caisse (fondation locale)

Module : `apps/api/src/modules/pos/`

Toutes les routes exigent `requireOrg`, la capability Pro `pos.connect`, un rôle Owner/Manager et
`POS_CONNECTORS_ENABLED=true`. Le flag vaut `false` dans les environnements suivis ; un fournisseur
réel n'est pas encore appelé.

| Méthode | Route                                | Description                                                                                                        |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| GET     | `/pos/connections`                   | Liste tenant-scoped des connexions et de leur état sans référence de secret.                                       |
| POST    | `/pos/connections`                   | Crée ou réinitialise une connexion à partir d'un provider, d'une localisation et d'une référence opaque de secret. |
| GET     | `/pos/connections/:id/health`        | Santé redacted de la connexion.                                                                                    |
| POST    | `/pos/connections/:id/disconnect`    | Déconnexion logique (`DISCONNECTED`) tenant-scoped.                                                                |
| POST    | `/pos/connections/:id/checks/import` | Import normalisé ; dry-run par défaut, upsert idempotent et rapprochement optionnel si `reservationId` est fourni. |

Les tickets sont persistés dans `PosCheck` sans payload brut ni contact ; le matcher calcule un score
explicable et ne crée une association CRM qu'au-dessus d'une donnée de réservation explicitement
fournie.

## CRM groupe / identité multi-site (fondation locale)

Le capability `customers.group` est réservé au plan Multi-site. Toutes les routes utilisent le
compte et l'établissement actifs injectés par `requireOrg`; aucun identifiant de compte ou de site
fourni par le client n'est accepté. `CUSTOMER_GROUPS_ENABLED=false` dans les environnements suivis,
et les écritures restent donc fermées jusqu'à la qualification du pilote.

| Méthode | Route                                           | Description                                                                                                                       |
| ------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| GET     | `/customer-groups`                              | Liste les groupes du compte actif avec le nombre de membres.                                                                      |
| POST    | `/customer-groups`                              | Crée un groupe ; `consentStatus` peut être `UNKNOWN`, `OPTED_IN` ou `OPTED_OUT`.                                                  |
| GET     | `/customer-groups/:groupId`                     | Détail tenant-scoped ; les membres retournent le nom et les quatre derniers chiffres du téléphone.                                |
| PATCH   | `/customer-groups/:groupId/consent`             | Owner uniquement ; un retrait supprime les liens inter-sites dans la même transaction.                                            |
| POST    | `/customer-groups/:groupId/members`             | Owner/Manager ; rattachement explicite d'un `customerId`, source et confiance bornées ; idempotent sur `(accountId, customerId)`. |
| DELETE  | `/customer-groups/:groupId/members/:customerId` | Dé-rattachement limité au site actif.                                                                                             |

Le rapprochement automatique entre identités, l'export/effacement consolidé, les campagnes groupe et
les sessions Clerk multi-sites réelles restent à prouver. Le service ne stocke aucune copie de
téléphone au niveau groupe.

## Fidélité opérationnelle (fondation locale)

Module : `apps/api/src/modules/loyalty/`

La capability `reputation.loyalty` est incluse dans Pro/Multi-site et refusée par Essential. Toutes
les routes utilisent l'établissement actif de `requireOrg`, les rôles Owner/Manager/Staff selon
l'opération. Aucun provider, point,
paiement ou POS n'est appelé.

| Méthode | Route                                 | Description                                                                                  |
| ------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| GET     | `/loyalty/benefits`                   | Liste le catalogue tenant-scoped et le nombre d'émissions.                                   |
| POST    | `/loyalty/benefits`                   | Crée un avantage EUR avec une règle bornée (`ANY`, `VIP`, visites, anniversaire ou dépense). |
| PATCH   | `/loyalty/benefits/:id`               | Active/désactive un avantage ; les grants existants restent auditables.                      |
| GET     | `/loyalty/grants`                     | Liste les émissions avec téléphone limité aux quatre derniers chiffres.                      |
| POST    | `/loyalty/grants`                     | Émet un grant éligible ; la réponse initiale contient le code brut, jamais la liste.         |
| POST    | `/loyalty/grants/:id/redeem`          | Vérifie le code et effectue `ISSUED → REDEEMED` de façon atomique/idempotente.               |
| POST    | `/loyalty/grants/:id/void`            | Annule un grant `ISSUED` avec une note d'audit bornée (Owner/Manager).                       |
| POST    | `/api/internal/loyalty/grants/expire` | Expire les grants échus dans une limite fournie par le scheduler opérateur.                  |

Le code à usage unique est haché avec SHA-256 en base ; la limite d'utilisation par client est
protégée par un advisory lock PostgreSQL. La page correspondante est `/dashboard/loyalty` et reste
verrouillée tant que la procédure en salle, les canaux éventuels et le pilote ne sont pas qualifiés.

## Expériences et sessions (fondation locale)

Module : `apps/api/src/modules/experiences/`

La capability `experiences.manage` est incluse dans Pro/Multi-site et refusée par Essential.
Les routes utilisent l'établissement actif de `requireOrg`, les rôles Owner/Manager/Staff selon
l'opération et `EXPERIENCES_ENABLED=false` dans les environnements suivis. Le catalogue, les
sessions et les réservations restent provider-neutral : aucun paiement, widget, téléphone ou canal
d'événement externe n'est appelé.

| Méthode | Route                                               | Description                                                                                                    |
| ------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| GET     | `/experiences`                                      | Liste le catalogue tenant-scoped, avec statut et compteurs de sessions/réservations.                           |
| POST    | `/experiences`                                      | Crée une fiche bornée (clé, durée, prix EUR et capacité), par défaut en brouillon.                             |
| PATCH   | `/experiences/:id`                                  | Modifie les attributs ou active/archive la fiche.                                                              |
| GET     | `/experiences/:id/sessions`                         | Liste les occurrences datées, filtrables par statut et intervalle.                                             |
| POST    | `/experiences/:id/sessions`                         | Ouvre une session avec capacité optionnelle et unicité par début.                                              |
| PATCH   | `/experiences/:id/sessions/:sessionId`              | Ferme, annule ou ajuste une session du catalogue ciblé.                                                        |
| GET     | `/experience-reservations`                          | Liste les réservations, sans exposer le téléphone complet.                                                     |
| POST    | `/experiences/:id/sessions/:sessionId/reservations` | Réserve des places avec snapshot de prix, clé `Idempotency-Key` hachée et contrôle de capacité transactionnel. |
| POST    | `/experience-reservations/:id/cancel`               | Annule une réservation confirmée de façon idempotente et libère ses places.                                    |
| POST    | `/api/internal/experiences/sessions/expire`         | Opérateur Sokar ; ferme les sessions terminées dans une limite bornée.                                         |

La transaction de réservation prend un advisory lock PostgreSQL par session, relit le statut et la
capacité, puis additionne les quantités `CONFIRMED`. Les fiches non `ACTIVE`, sessions passées ou
fermées et réutilisations incompatibles de clé renvoient une erreur stable. La page correspondante
est `/dashboard/experiences` et reste verrouillée tant que paiement, distribution et pilote ne sont
pas qualifiés.

## Événements et billetterie locale

Module : `apps/api/src/modules/events/`

La capability `events.manage` est incluse dans Pro/Multi-site et refusée par Essential. Les routes
utilisent l'établissement actif de `requireOrg`, les rôles Owner/Manager/Staff selon l'opération et
`EVENTS_ENABLED=false` dans les environnements suivis. La fondation ne contacte aucun paiement,
messagerie, widget, voix ou canal de distribution.

| Méthode    | Route                                      | Description                                                                                 |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| GET / POST | `/events`                                  | Liste ou crée le catalogue tenant-scoped (`DRAFT/ACTIVE/ARCHIVED`).                         |
| PATCH      | `/events/:id`                              | Modifie les attributs ou active/archive un événement.                                       |
| GET / POST | `/events/:id/sessions`                     | Liste ou crée les sessions datées avec jauge.                                               |
| PATCH      | `/events/:id/sessions/:sessionId`          | Ajuste, ferme ou annule une session dans le double scope.                                   |
| GET / POST | `/events/:id/ticket-types`                 | Liste ou crée les tarifs EUR bornés.                                                        |
| PATCH      | `/events/:id/ticket-types/:ticketTypeId`   | Modifie ou désactive un tarif dans le double scope.                                         |
| GET        | `/event-orders`                            | Liste les commandes avec filtres événement/session/client/statut.                           |
| POST       | `/events/:id/sessions/:sessionId/orders`   | Émet une commande idempotente, réserve la jauge et retourne les codes bruts une seule fois. |
| POST       | `/event-orders/:id/cancel`                 | Annule la commande et ses billets de façon idempotente.                                     |
| POST       | `/event-orders/:id/invoice`                | Ajoute une référence de facture locale ; aucun document fiscal n'est généré.                |
| POST       | `/event-orders/:id/refund`                 | Pose une trace de remboursement dry-run avec clé obligatoire ; aucun provider n'est appelé. |
| GET        | `/event-tickets`                           | Liste les billets sans code brut.                                                           |
| POST       | `/event-tickets/check-in`                  | Contrôle par code seul pour le dashboard et le service.                                     |
| POST       | `/event-tickets/:id/check-in`              | Contrôle le code avec contrainte supplémentaire sur l'identifiant du billet.                |
| GET        | `/event-waitlist`                          | Liste les entrées ordonnées et filtrables.                                                  |
| POST       | `/events/:id/sessions/:sessionId/waitlist` | Ajoute une entrée idempotente.                                                              |
| POST       | `/event-waitlist/:id/cancel`               | Annule une entrée `WAITING`.                                                                |
| POST       | `/event-waitlist/:id/promote`              | Promeut une entrée via une commande contrôlée par la capacité.                              |
| POST       | `/api/internal/events/sessions/expire`     | Opérateur Sokar ; ferme les sessions et expire la liste d'attente.                          |

La commande prend `pg_advisory_xact_lock` par restaurant/session, additionne les quantités
`CONFIRMED` et fige `unitPriceCents`, `totalPriceCents` et `currency`. Chaque billet conserve un
hash SHA-256 du code et ses quatre derniers caractères ; les lectures masquent le téléphone. Le
worker `event-session-expiry` est programmé toutes les 15 minutes. Les commandes, billets et
entrées sont inclus dans l'export/effacement RGPD ; paiement, facture fiscale, notifications,
distribution et reporting encaissé restent à qualifier.

## Canaux partenaires et distribution locale

Module : `apps/api/src/modules/distribution/`

La capability `distribution.manage` est incluse dans Pro/Multi-site et refusée par Essential.
Les routes utilisent `requireOrg`, les rôles Owner/Manager/Staff selon l'opération et
`DISTRIBUTION_ENABLED=false` dans les environnements suivis. La fondation ne contacte aucun
fournisseur : les identifiants sont hachés, les secrets sont des références opaques, les
snapshots sont non autoritaires, les runs incluent le curseur source dans leur empreinte de rejeu
et les webhooks sont rejouables avec une unicité restaurant/fournisseur.

| Méthode    | Route                                                  | Description                                                                                                      |
| ---------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| GET        | `/distribution/connections`                            | Liste les connexions tenant-scoped et masquées.                                                                  |
| POST       | `/distribution/connections`                            | Crée ou met à jour une connexion locale ; Owner/Manager, aucun OAuth.                                            |
| GET        | `/distribution/connections/:id`                        | Lit une connexion et sa santé locale sans secret.                                                                |
| POST       | `/distribution/connections/:id/disconnect`             | Déconnecte localement et conserve l'historique.                                                                  |
| GET / POST | `/distribution/connections/:id/availability`           | Lit ou upsert des snapshots bornés par slot ; la capacité Sokar reste la source de vérité.                       |
| GET        | `/distribution/sync-runs`                              | Liste les runs filtrables par connexion et état.                                                                 |
| POST       | `/distribution/connections/:id/sync-runs`              | Met un run `QUEUED` en file locale avec `Idempotency-Key` obligatoire ; aucun worker fournisseur ne le consomme. |
| GET        | `/distribution/reservation-links`                      | Liste les liens externes masqués.                                                                                |
| POST       | `/distribution/connections/:id/reservation-links`      | Lie explicitement un identifiant externe à une réservation existante.                                            |
| GET        | `/distribution/webhooks`                               | Liste l'inbox des enveloppes hachées.                                                                            |
| POST       | `/api/internal/distribution/webhook-events`            | Opérateur/fixture ; ingère une enveloppe sans payload brut.                                                      |
| POST       | `/api/internal/distribution/webhook-events/:id/finish` | Opérateur ; termine un webhook de façon monotone.                                                                |
| POST       | `/api/internal/distribution/sync-runs/:id/finish`      | Opérateur/adaptateur futur ; termine un run avec compteurs bornés.                                               |

Les erreurs d'entrée sont en 400, les ressources hors tenant en 404 et les conflits d'idempotence
ou d'état en 409. Les routes internes demandent `restaurantId` dans le corps car le guard opérateur
ne fournit pas de site. Aucun webhook public, compte marchand ou adaptateur Google/Meta n'est
enregistré avant la clôture de `P9_ECOSYSTEM` et `PILOTS`.

---

## Dashboard

Module : `apps/api/src/modules/dashboard/dashboard.routes.ts`

### GET /dashboard/stats

KPIs temps réel : `total_calls`, `total_reservations`, `covers`,
`conversion_rate`, `answered_rate`, `estimated_revenue`.

### GET /dashboard/analytics

Timeseries (24h/7j/30j) : `calls`, `reservations`, `revenue`.

### GET /dashboard/weekly-calls / GET /dashboard/recent-activity

Widgets annexes.

---

## Analytics

Module : `apps/api/src/modules/analytics/analytics.routes.ts`

### GET /analytics/roi

ROI consolidé (revenue recovered vs coût Telnyx).

### GET /analytics/latency

Latences p50/p95/p99 STT/LLM/TTS.

---

## Companion

Module : `apps/api/src/modules/companion/`

### POST /companion/chat

Assistant du dashboard (OWNER, MANAGER, ORG_MEMBER ; STAFF et READ_ONLY : 403). Corps : `messages` (1 à 20, le dernier de l'utilisateur, 4000 caractères max). Réponse JSON : `reply`, `sources` (`tool`, `href`), `responseId` (UUID de cette réponse). 503 sans clé OpenRouter, 429 au-delà de 100 messages par jour, 502 si OpenRouter échoue.

### POST /companion/feedback

Avis sur une réponse (OWNER, MANAGER, ORG_MEMBER ; STAFF et READ_ONLY : 403). Corps strict : `responseId` (UUID renvoyé par `/companion/chat`) et `rating` (`up` ou `down`). Aucun texte libre. Réponse 204, sans corps ; 400 si un champ manque, est inconnu ou invalide. L'avis n'est écrit que dans les logs (`companion feedback`).

---

## Voice (Telnyx)

Module : `apps/api/src/modules/voice/telnyx.pipeline.ts`

Voir [[Telnyx Pipeline]] pour le détail.

### POST /voice/telnyx

Webhook `call.initiated`. Retourne `ai_config` à Telnyx.
**Public** (signature Ed25519 vérifiée par `telnyx.guard.ts`).

### POST /voice/telnyx/end

Webhook fin d'appel. Met à jour Call record + transcript + outcome.

---

## Auth

Module : `apps/api/src/modules/auth/auth.routes.ts`

### POST /api/auth/sync

Sync Clerk → DB (création/mise à jour restaurant + onboarding state).

---

## Agentic Reservations (Admin)

Module : `apps/api/src/modules/agentic-reservations/admin/admin.routes.ts`

### GET/POST /api/agentic/opt-in

Toggle opt-in agentic par restaurant.

### GET/PUT /api/agentic/exposure-settings

Édition des exposure settings (mcpEnabled, openaiReserveEnabled,
`connectPublished`, `connectAgentic`, etc.).

### GET/POST/DELETE /api/agentic/mcp-clients

CRUD des clients MCP (API keys, scopes, allowedOrigins).

---

## Agentic Reservations (MCP Server)

Module : `apps/api/src/modules/agentic-reservations/mcp/server.ts`

### GET/POST /mcp

Endpoint JSON-RPC MCP. **Public** via OAuth 2.0 (RFC 8414 discovery,
RFC 7591 DCR) ou API key ; un token peut être limité à un restaurant via
`restaurant_id` sur `/oauth/authorize`. Sert les tools :
`search_restaurants`, `get_restaurant_details`, `check_availability`,
`create_quote`, `create_hold`, `create_reservation`, `join_waiting_list`,
`cancel_waiting_list`, `modify_reservation`, `cancel_reservation`,
`get_reservation_status`. Budget global de 60 requêtes/minute par client.

Voir `docs/sokar-mcp-integrator-guide.md` pour le détail intégrateur.

---

## OpenAI Reserve (Apps SDK)

Module : `apps/api/src/modules/agentic-reservations/openai-reserve/openai-reserve.routes.ts`

### GET /v1/businesses / GET /v1/tools

Business feed (référencé par l'Apps SDK).

### POST /v1/tools/restaurant_reservation

Tool execution (widget OpenAI).

---

## RGPD

Module : `apps/api/src/modules/rgpd/rgpd.routes.ts`

### POST /api/rgpd/request-verification

Demande OTP (SMS/email) — three-token pattern.

### POST /api/rgpd/confirm-verification

Confirme l'OTP et retourne un verification token.

### GET /api/rgpd/confirm-link

Lien signé one-shot (alternative à OTP pour web).

### POST /api/rgpd/erase

Effacement données sujet (vérification token requis).

### POST /api/rgpd/export

Export données sujet (vérification token requis).

### POST /api/rgpd/withdraw-marketing

Retrait consentement marketing.

### GET /api/rgpd/privacy-policy

Page privacy policy publique (RGPD Article 13).

---

## Entitlements

Module : `apps/api/src/modules/entitlements/entitlement.routes.ts`

### GET /entitlements

Retourne le plan commercial effectif et ses capabilities pour le restaurant Clerk courant. La
consommation voix/SMS reste sans quota client ; les coûts fournisseurs et la marge interne ne sont
jamais exposés. La décision combine le plan Postgres et un éventuel override ConfigCat valide.

Une route métier protégée par `requireCapability` répond `403 CAPABILITY_NOT_INCLUDED` lorsque le
plan ne couvre pas la fonction. La réactivation utilise déjà ce garde.

---

## Usage

Module : `apps/api/src/modules/usage/usage.routes.ts`

### GET /usage/current

Retourne les quantités du mois UTC courant, regroupées par catégorie. La réponse annonce
`customerUsagePolicy=UNLIMITED` : aucune limite de minutes ou de SMS n'est appliquée au restaurant.
Les champs historiques `included`, `limitsEnforced` et `quotas` restent renvoyés avec des limites
nulles pour compatibilité ; ils ne doivent pas être utilisés pour bloquer un parcours.

### GET /usage/history?from=YYYY-MM&to=YYYY-MM

Retourne les projections mensuelles du restaurant Clerk courant sur une fenêtre maximale de 24
mois. Les coûts, marges et fournisseurs restent internes. La projection est recalculable depuis le
ledger brut ; sa planification automatique reste à livrer.

### GET /api/internal/usage/margin?month=YYYY-MM

Route opérateur protégée par l'en-tête `x-sokar-internal-usage-token`. Retourne les volumes, coûts
estimés et statuts `PRICED`/`UNPRICED`/`MIXED` par restaurant et catégorie ; elle n'est jamais
exposée au dashboard restaurateur.

### GET /admin/usage/margin?month=YYYY-MM

Route opérateur Clerk consommée par `/admin/margin` (l'ancienne URL `/dashboard/admin/margin` reste
un alias de transition). Elle agrège les mêmes événements et
retourne le prix du catalogue local, la marge uniquement lorsque tous les coûts sont tarifés, et
les marqueurs `LOCAL_CATALOG` / `NOT_STRIPE_RECONCILED` pour empêcher toute confusion avec une
facture réelle. Les lignes incluent `estimatedCostEur` (source), `adjustedCostEur`,
`approvedAdjustmentCostEur` et `approvedAdjustmentCount` ; seuls les ajustements `APPROVED` avec
une portée `restaurant:<id>` et une période entièrement comprise dans le mois sont appliqués. Les corrections
`global` restent hors calcul jusqu'à leur affectation explicite.

Le catalogue fournisseur n'est pas modifiable par une route HTTP. Les lignes validées par facture
sont importées localement avec `apps/api/scripts/import-usage-tariffs.ts` (CSV/JSON, dry-run par
défaut), qui bloque les conflits de version et les fenêtres d'effet qui se chevauchent avant toute
écriture `--apply`.

Le rapprochement facture/ledger commence par une opération interne en lecture seule :
`apps/api/scripts/reconcile-usage-invoice.ts` compare les quantités et coûts par fournisseur,
unité et période UTC et échoue si une ligne n'est pas `MATCH`. L'option `--output` permet de
conserver le rapport JSON avant le code de sortie, y compris en cas d'écart. Le JSON contient aussi
`reportHash`, calculé sur les bornes, tolérances, compteurs et lignes sans l'horodatage local.

Les routes opérateur `GET/POST /admin/usage/reconciliation-adjustments` et
`POST /admin/usage/reconciliation-adjustments/:id/decision` conservent ensuite une correction
séparée dans `UsageReconciliationAdjustment`. La création est idempotente par hash du rapport,
portée, dimension et période ; la décision `APPROVED` ou `REJECTED` n'est possible que depuis
`OPEN` et ne modifie jamais `UsageEvent` ou `UsageMonthlyRollup`.

### GET /admin/usage/accounting-export.csv?month=YYYY-MM[&restaurantId=<id>]

Route opérateur Clerk, consommée par le bouton d'export du cockpit de marge. Elle renvoie un CSV
UTF-8 à schéma stable avec une ligne agrégée par établissement et dimension d'usage, puis une ligne
distincte par correction `APPROVED`. Les corrections globales sont conservées avec
`cost_status=UNALLOCATED` et un `restaurant_id` vide : aucun rattachement comptable implicite n'est
effectué. Le fichier est borné au mois UTC et ne contient ni téléphone, ni email, ni corps de
message. Le catalogue prix et l'état Stripe ne sont pas ajoutés à ce flux comptable.

Le script `apps/api/scripts/build-usage-accounting-package.ts` constitue
l'étape aval fichier : il copie ce CSV, le rapport de rapprochement et la
pièce jointe Telnyx dans un paquet hashé, puis produit un CSV fournisseur
séparé pour les lignes MRC dans leur devise d'origine. Le manifeste porte
`READY_FOR_IMPORT` jusqu'à ce qu'un outil comptable soit choisi et qu'un reçu
d'import soit conservé.

Décision : `docs/architecture/adr-usage-ledger-and-costing.md`.

---

## Admin / Flags

Module : `apps/api/src/modules/admin/flags.routes.ts`

### GET /admin/flags

Liste des feature flags (ConfigCat).

---

## Pilot (interne)

Module : `apps/api/src/modules/pilot/pilot.routes.ts`

### GET /api/internal/pilot-kpis

KPIs internes pilote (VPN only). Cf. `docs/runbook.md`.

---

## Test (dev only)

Module : `apps/api/src/modules/test/test.routes.ts`

### POST /api/test/simulate-call

Simule un appel Telnyx entrant (dev/test).

### GET /api/test/simulate-call/:callControlId/reservations

Liste les résas créées par un appel simulé.

### GET /api/test/restaurants / DELETE /api/test/restaurants

CRUD restos de test.

> ⚠️ **Dev only** — ne jamais exposer en prod.

---

## Health / Observability (en shared/, pas dans modules/)

Modules : `apps/api/src/shared/observability/`

### GET /health

Health check agrégé (db, redis, queues, telnyx, elevenlabs, cartesia).
Pattern multi-check parallèle avec timeout individuel (cf. `sokar-fastify-testing` §health).

### GET /metrics

Exposition Prometheus (texte brut, scrape par Grafana).

### GET /health/observability

Smoke test Sentry + metrics.

---

## Sokar Connect (actif — T2-T10 faits le 2026-06-24)

Module : `apps/api/src/modules/connect/` (créé en T2, vérifié vert)

Endpoints, **tous publics** (no Clerk) :

| Méthode | Route                          | Description                            |
| ------- | ------------------------------ | -------------------------------------- |
| GET     | `/public/r/:slug`              | Fiche restaurant publique              |
| GET     | `/public/r/:slug/availability` | Slots dispo temps réel                 |
| POST    | `/public/r/:slug/hold`         | Crée hold 5min (TTL)                   |
| POST    | `/public/r/:slug/confirm`      | Confirme résa (Idempotency-Key requis) |

Voir [[Sokar Connect P0]] et `docs/connect-v1.1.md` pour le détail.

---

## Récapitulatif par préfixe

| Préfixe                             | # routes        | Auth                           | Module         |
| ----------------------------------- | --------------- | ------------------------------ | -------------- |
| `/restaurant*`                      | 4 (×2 préfixes) | Clerk                          | restaurants    |
| `/restaurants/:id`                  | 3               | Clerk                          | restaurants    |
| `/reservations`                     | 4               | Clerk                          | reservations   |
| `/calls`                            | 3               | Clerk                          | calls          |
| `/customers`                        | 5               | Clerk                          | customers      |
| `/dashboard`                        | 4               | Clerk                          | dashboard      |
| `/analytics`                        | 2               | Clerk                          | analytics      |
| `/voice/*`                          | 2               | Public (Ed25519)               | voice          |
| `/api/auth/*`                       | 1               | Public                         | auth           |
| `/api/agentic/*`                    | 7               | Clerk                          | agentic admin  |
| `/mcp`                              | 1               | OAuth 2.0 / API key            | MCP            |
| `/v1/*` (OpenAI)                    | 3               | OAuth Apps SDK                 | openai-reserve |
| `/api/rgpd/*`                       | 7               | Mix (verify public, ops Clerk) | rgpd           |
| `/integrations/*`                   | 3               | Clerk                          | integrations   |
| `/admin/flags`                      | 1               | Clerk                          | admin          |
| `/api/internal/*`                   | 1               | VPN                            | pilot          |
| `/api/test/*`                       | 5               | Dev only                       | test           |
| `/health`, `/metrics`               | 3               | Public                         | shared         |
| `/public/r/:slug/*` (Sokar Connect) | 4               | **Public**                     | connect (T2)   |

Le décompte historique « ~57 routes + 4 à venir » n'est plus à jour depuis les modules CRM,
marketing, paiements, POS, groupes, réputation, fidélité et expériences. Au 14 septembre 2026,
`rg "app\\.(get|post|patch|put|delete)\\(" apps/api/src -g'*.routes.ts'` retourne 281 déclarations
(aliases, routes internes et routes de test compris) ; les tableaux ci-dessus restent la référence
par famille et par contrat.
