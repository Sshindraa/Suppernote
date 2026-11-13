# ADR — Fondation événements, billetterie et contrôle d'accès

Date : 14 septembre 2026
Statut : livré localement, activation commerciale bloquée

## Contexte

Les événements sont un élargissement de l'offre Pro à 299 € : dégustation, soirée, atelier,
concert privé ou autre séance à jauge limitée. Le besoin minimal est de pouvoir définir un
catalogue, ouvrir plusieurs sessions, vendre plusieurs tarifs, contrôler les entrées et suivre
une liste d'attente sans créer une seconde source de capacité.

La fondation doit rester utilisable sans compte marchand, fournisseur de billetterie, terminal de
paiement ou canal de distribution. Elle sert donc de contrat interne vérifiable. Elle ne constitue
pas encore une billetterie publique ou une facture fiscale.

## Décision

Le module `apps/api/src/modules/events/` et les modèles Prisma associés portent toute la donnée
tenant-scoped. La capability `events.manage` est incluse dans Pro et Multi-site ; elle est refusée
à Essential. Le flag `EVENTS_ENABLED=false` reste le verrou de runtime dans tous les environnements
suivis tant qu'un pilote et les fournisseurs éventuels ne sont pas qualifiés.

Les responsables Owner/Manager administrent le catalogue, les sessions et les tarifs. Owner,
Manager et Staff peuvent lire les événements, émettre/annuler une commande et contrôler un billet,
selon la procédure du restaurant. Les remboursements, les traces de facture et la promotion d'une
liste d'attente restent réservés à Owner/Manager.

Une commande confirmée consomme une jauge de session, quelle que soit la répartition des tarifs.
La réservation de capacité est transactionnelle et sérialisée par un advisory lock PostgreSQL
par restaurant/session. Toute commande reçoit un snapshot immuable de `unitPriceCents`,
`totalPriceCents` et `currency`.

## Modèle de données

La migration additive est
`packages/database/prisma/migrations/20260914200000_events_foundation/migration.sql`.

### `Event`

- `restaurantId`, `key`, `name`, `description`, `timezone` et `status` (`DRAFT`, `ACTIVE`,
  `ARCHIVED`) ;
- unicité `(restaurantId, key)` ;
- compteurs dérivés exposés par `_count`, jamais utilisés comme source de capacité ;
- suppression en cascade des sessions, tarifs, commandes, billets et entrées de liste d'attente
  conformément au contrat Prisma.

### `EventSession`

- occurrence datée d'un événement avec `startsAt`, `endsAt`, `capacity` et statut `OPEN`,
  `CLOSED` ou `CANCELLED` ;
- unicité `(eventId, startsAt)` ;
- contrainte SQL `endsAt > startsAt` et capacité bornée ;
- `capacity` est la limite globale de la session, partagée entre tous les tarifs.

### `EventTicketType`

- tarif rattaché à un événement (`key`, `name`, `priceCents`, `currency`, `maxPerOrder`) ;
- unicité `(eventId, key)` ;
- uniquement EUR dans la fondation ;
- `ACTIVE` ou `INACTIVE`. Un tarif inactif ne peut plus recevoir de nouvelle commande.

### `EventOrder`

- référence tenant-scoped vers événement, session, tarif et éventuellement `Customer` ou
  réservation existante ;
- `quantity`, snapshot de prix, état (`CONFIRMED`, `CANCELLED`, `REFUND_PENDING`, `REFUNDED`) ;
- clé d'idempotence hachée, unique lorsqu'elle est fournie ;
- champs de trace locale de facture (`invoiceNumber`, `invoicedAt`) ;
- champs de trace de remboursement (`refundIdempotencyKey`, `refundReason`, `refundedAt`) ;
- aucun identifiant de carte, payload Stripe ou réponse de prestataire n'est stocké.

### `EventTicket`

- une ligne par unité de commande ;
- code admission aléatoire de 12 caractères hexadécimaux, jamais retourné dans les lectures ;
- seul `codeHash` SHA-256 et `codeLast4` sont persistés ;
- état `ISSUED`, `CHECKED_IN`, `CANCELLED` ou `REFUNDED` ;
- `checkedInAt` et `checkedInByHash` permettent l'audit sans conserver l'identifiant opérateur en
  clair.

### `EventWaitlistEntry`

- événement/session, quantité et client facultatif ;
- état `WAITING`, `PROMOTED`, `CANCELLED` ou `EXPIRED` ;
- clé d'idempotence hachée lorsqu'elle est fournie ;
- l'ordre de lecture est `createdAt ASC` afin de rendre la promotion déterministe.

## Invariants et transitions

Les normalisateurs du service et les checks SQL imposent des bornes indépendantes du client :

- clé en minuscules, caractères `[a-z0-9][a-z0-9-]{1,63}` ;
- nom 1–160 caractères, description 2 000 caractères maximum ;
- fuseau IANA non vide et dates ISO valides ;
- session 15 minutes à 24 heures, capacité 1–10 000 ;
- tarif EUR entre 0 et 10 000 € et maximum 100 billets par commande ;
- quantité 1–100, total calculé en entier et plafonné ;
- justification de remboursement limitée à 1 000 caractères.

Une nouvelle commande suit cette séquence :

1. normaliser et hacher la clé `Idempotency-Key` ;
2. rechercher un ordre existant ; une même clé rejoue le même ordre et une charge incompatible
   renvoie un conflit ;
3. relire la session, l'événement et le tarif dans le tenant du site ;
4. refuser une session fermée, annulée ou passée, un événement non `ACTIVE` ou un tarif inactif ;
5. prendre `pg_advisory_xact_lock(hashtext('event:<restaurantId>:<sessionId>'))` ;
6. relire la session dans la transaction et agréger les quantités `CONFIRMED` ;
7. refuser si la nouvelle quantité dépasse la jauge ;
8. créer l'ordre et ses billets avec le snapshot de prix ;
9. retourner les codes bruts une seule fois, avec `replayed=false`.

Une annulation conditionne `CONFIRMED → CANCELLED` et `ISSUED → CANCELLED` pour les billets.
Un second appel ne modifie plus la donnée et renvoie `replayed=true`. Un remboursement local
conditionne un ordre confirmé, annulé ou déjà en attente de remboursement, pose la clé de
remboursement, passe l'ordre à `REFUNDED` et les billets disponibles à `REFUNDED`. Il expose
`providerContacted=false` et `dryRun=true` pour empêcher une lecture commerciale ambiguë.

Le contrôle d'accès calcule le hash du code fourni, cherche dans le tenant (et, pour la route
REST, dans le billet demandé), puis effectue `ISSUED → CHECKED_IN` par `updateMany` conditionnel.
Une course concurrente relit l'état : si l'autre requête a contrôlé le billet, la réponse est un
rejeu ; sinon une erreur d'état stable est renvoyée. Un code inconnu, annulé ou remboursé ne révèle
pas l'existence d'un autre billet.

La promotion de liste d'attente s'appuie sur une clé stable `waitlist-<entryId>` pour appeler la
création de commande. Elle est donc rejouable ; l'entrée ne passe à `PROMOTED` qu'après création ou
rejeu de la commande. Les sessions terminées sont fermées et les entrées encore `WAITING` passent
à `EXPIRED` par le worker périodique.

## Contrat HTTP

Les routes sont enregistrées dans `main.ts` et protégées par `requireOrg`,
`requireCapability('events.manage')`, le rôle du site et `EVENTS_ENABLED`.

| Méthode        | Route                                                | Rôle et comportement                                                                             |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET` / `POST` | `/events`                                            | Lecture équipe ; création Owner/Manager.                                                         |
| `PATCH`        | `/events/:id`                                        | Mise à jour/activation Owner/Manager.                                                            |
| `GET` / `POST` | `/events/:id/sessions`                               | Lecture équipe ; création Owner/Manager.                                                         |
| `PATCH`        | `/events/:id/sessions/:sessionId`                    | Ajustement ou fermeture Owner/Manager avec double scope événement/session.                       |
| `GET` / `POST` | `/events/:id/ticket-types`                           | Lecture équipe ; tarifs Owner/Manager.                                                           |
| `PATCH`        | `/events/:id/ticket-types/:ticketTypeId`             | Activation ou modification Owner/Manager avec double scope.                                      |
| `GET`          | `/event-orders`, `/event-tickets`, `/event-waitlist` | Listes filtrables, téléphone et codes masqués.                                                   |
| `POST`         | `/events/:id/sessions/:sessionId/orders`             | Staff inclus ; `Idempotency-Key` facultative mais recommandée. Retour `201` puis `200` au rejeu. |
| `POST`         | `/event-orders/:id/cancel`                           | Staff inclus ; transition idempotente.                                                           |
| `POST`         | `/event-orders/:id/invoice`                          | Owner/Manager ; numéro local déterministe, aucune facture fiscale.                               |
| `POST`         | `/event-orders/:id/refund`                           | Owner/Manager ; `Idempotency-Key` obligatoire, dry-run local.                                    |
| `POST`         | `/event-tickets/check-in`                            | Staff inclus ; contrôle par code seul pour le dashboard et le service.                           |
| `POST`         | `/event-tickets/:id/check-in`                        | Même contrôle avec contrainte supplémentaire sur l'identifiant du billet.                        |
| `POST`         | `/events/:id/sessions/:sessionId/waitlist`           | Staff inclus ; entrée idempotente.                                                               |
| `POST`         | `/event-waitlist/:id/cancel`                         | Staff inclus ; annulation idempotente.                                                           |
| `POST`         | `/event-waitlist/:id/promote`                        | Owner/Manager ; création de commande contrôlée par capacité.                                     |
| `POST`         | `/api/internal/events/sessions/expire`               | Opérateur Suppernote, limite bornée pour le scheduler.                                           |

Les erreurs de validation renvoient `400`, les ressources hors tenant `404`, et les conflits de
capacité ou d'état `409`. Les réponses de lecture ne contiennent ni code billet brut, ni clé
d'idempotence brute, ni téléphone complet.

## Runtime et opérations

`event-session-expiry.worker.ts` consomme la queue `event-session-expiry` avec une concurrence de

1. `main.ts` programme `event-session-expiry-15min` avec une limite de 1 000 sessions. Le worker
   est relançable : les mises à jour ciblent uniquement les sessions `OPEN` échues et les entrées
   `WAITING` correspondantes.

Le scheduler et le worker restent dans le processus API actuel, comme les autres queues. Une future
séparation PM2 devra prouver l'unicité du scheduler, l'arrêt gracieux et la reprise après rollback
avant de déplacer le consumer.

Les métriques d'exploitation à ajouter avant un pilote sont : commandes par session, conflits de
jauge, taux de rejeu d'idempotence, billets contrôlés, refus de code, latence de contrôle, longueur
de liste d'attente, erreurs de worker et sessions échues non traitées. Les labels ne doivent pas
contenir de nom, téléphone, code ou identifiant client.

## RGPD et sécurité

L'export RGPD inclut les commandes et entrées de liste d'attente rattachées à un client CRM. Les
dates, quantités, snapshots de prix et états sont exportés ; les codes de billets, hashes et
identifiants opérateur ne sont pas retournés comme secrets exploitables.

L'effacement RGPD détache `customerId` des commandes et des entrées de liste d'attente et détache
les références de réservation lorsque cela est possible. Les totaux et états nécessaires à la
preuve opérationnelle restent anonymisés. Les audits contiennent uniquement des hashes et des
compteurs.

Les codes billet sont générés avec une source aléatoire cryptographiquement sûre, comparés après
normalisation en majuscules et protégés par le hash en base. Le dashboard ne peut afficher le code
qu'immédiatement après émission. La route code-seul ne renvoie pas de différence entre code inconnu
et billet appartenant à un autre événement du même tenant.

## Rollout et rollback

La migration est additive et peut être appliquée après sauvegarde. Avant ouverture du flag :

1. exécuter `prisma validate` et `prisma generate` ;
2. exécuter les tests API service/routes/worker et les tests dashboard ;
3. créer un événement DRAFT, une session, deux tarifs et une commande de test dans une base dédiée ;
4. exécuter deux commandes concurrentes au-delà de la jauge et vérifier qu'une seule est acceptée ;
5. vérifier l'export/effacement RGPD et la rotation des secrets de test ;
6. valider le parcours manuel d'entrée et la procédure de remboursement local.

Le retour arrière applicatif désactive `EVENTS_ENABLED` puis restaure l'artefact. La suppression des
tables n'est pas automatique : elle exige une décision de migration séparée et une sauvegarde
vérifiée. Aucun déploiement production n'est autorisé tant que `P9_ECOSYSTEM` et `PILOTS` ne sont
pas `CLOSED` dans `docs/release/product-gates.json`.

## Hors périmètre de cette fondation

- paiement Stripe, acompte, capture, remboursement d'une carte ou litige ;
- facture fiscale, numérotation comptable et export légal ;
- widget public, réservation vocale ou achat depuis un canal externe ;
- QR code, application de contrôle hors dashboard et mode hors-ligne ;
- e-mail, SMS, WhatsApp, notifications de promotion et preuve de délivrabilité ;
- Google Reserve, Meta, plateformes partenaires et synchronisation bidirectionnelle ;
- portefeuille de points, bundles, transfert ou revente de billet ;
- reconnaissance automatique des participants ou rapprochement POS ;
- reporting de revenu encaissé et attribution marketing réellement mesurée.

## Preuve locale

- migration et client Prisma générés le 14 septembre 2026 ;
- tests API événements : 24 tests verts (`event.service`, routes et worker) ;
- tests dashboard `/dashboard/events` : 5 tests verts ;
- typecheck API et dashboard verts ; lint API sans erreur, avec huit avertissements préexistants ;
- aucun provider de paiement, messagerie ou distribution appelé ;
- `EVENTS_ENABLED=false` et `productionFreeze=true` restent les valeurs par défaut.
