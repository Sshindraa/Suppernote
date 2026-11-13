# ADR — Fondation locale des canaux partenaires et de la distribution

Date : 14 septembre 2026
Statut : livré localement, activation externe bloquée
Portée commerciale : Pro et Multi-site (`distribution.manage`)

## Contexte

La distribution est l'écart le plus visible entre le socle Suppernote et un produit comme
SevenRooms : disponibilité publiée sur un canal tiers, réservation rattachée à la bonne
source et synchronisation contrôlable. La demande commerciale peut viser Google Reserve,
Meta Reserve, une plateforme de réservation ou une API publique. Les contrats, les secrets,
les identifiants et les règles de réconciliation varient selon le fournisseur.

Il serait dangereux de brancher un fournisseur directement dans les routes de réservation
avant d'avoir choisi un premier pilote. Une erreur de capacité ou un webhook rejoué peut
créer une double réservation, et la conservation d'un token tiers dans PostgreSQL créerait
une surface de fuite inutile. Cette phase fournit donc un contrat provider-neutral testable
et une interface opérateur visible. Elle ne prétend pas qu'un canal tiers est déjà connecté.

## Décision

Le module `apps/api/src/modules/distribution/` persiste les connexions, les runs, les
snapshots de disponibilité, les liens de réservation et les enveloppes de webhook. Toutes
les lignes portent `restaurantId`; les relations sont filtrées par le tenant avant toute
lecture ou mutation.

La capability `distribution.manage` est incluse dans Pro et Multi-site, pas dans Essential.
Le flag `DISTRIBUTION_ENABLED=false` reste fermé dans tous les environnements suivis. Tant
qu'il est fermé, aucune route métier ne lit la base et aucun appel réseau n'est effectué.
Les lectures sont ouvertes aux rôles Owner/Manager/Staff ; les écritures de connexion,
snapshot, run et lien sont réservées à Owner/Manager. Les entrées d'adaptateur et la finition
d'un run ou d'un webhook sont opérateur-only jusqu'à la définition d'un contrat de signature
public.

La première intégration réelle devra implémenter l'interface ci-dessous derrière un adaptateur
isolé. Elle devra être activée par un pilote et une nouvelle preuve ; ce document ne donne
pas d'autorisation de production.

## Modèle de données

La migration additive est
`packages/database/prisma/migrations/20260914210000_distribution_foundation/migration.sql`.

### `DistributionConnection`

- clé unique `(restaurantId, provider)` pour empêcher deux comptes concurrents sur un site ;
- `provider` vaut `GOOGLE_RESERVE`, `META_RESERVE` ou `PUBLIC_API` ;
- `externalAccountHash` est le SHA-256 préfixé de l'identifiant fournisseur ; seuls les
  quatre derniers caractères sont affichables ;
- `credentialRef` est une référence opaque vers un secret manager, jamais un token ;
- `configHash` est l'empreinte d'une configuration bornée et triée ;
- état `DISCONNECTED`, `PENDING`, `ACTIVE`, `PAUSED` ou `ERROR`, curseur et dernière erreur
  pour la santé opérateur ;
- `connectedAt` et `disconnectedAt` sont des dates de preuve locale, pas une preuve de santé
  fournisseur.

### `DistributionSyncRun`

- direction `PUSH`, `PULL` ou `BIDIRECTIONAL` ;
- état `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED` ou `NEEDS_REVIEW` ;
- `idempotencyKey` hachée et unique ; une clé est en plus liée au restaurant et à la connexion
  avant hash ;
- fenêtre optionnelle, curseurs source/cible, compteurs et code d'erreur bornés ;
- hash optionnel de l'acteur opérateur pour l'audit, jamais l'identifiant en clair ;
- aucune charge fournisseur brute n'est persistée, uniquement `payloadHash` lorsqu'un adaptateur
  en fournit une preuve.

### `DistributionAvailabilitySnapshot`

- une ligne unique `(connectionId, slotKey)` ;
- date de service, début/fin, taille de groupe, disponibilité et capacité bornées ;
- révision source et `payloadHash` pour expliquer une valeur ;
- `observedAt` permet de détecter un snapshot périmé ;
- le snapshot est informatif et ne devient jamais la source autoritaire de capacité Suppernote.

### `DistributionReservationLink`

- association explicite entre `Reservation` et identifiant externe haché ;
- unicité `(connectionId, externalIdHash)` et `(connectionId, reservationId)` ;
- seuls les quatre derniers caractères de la référence et sa source sont renvoyés ;
- un lien ne crée ni ne modifie une réservation. Le rapprochement automatique est hors périmètre.

### `DistributionWebhookEvent`

- fournisseur, connexion facultative, type d'événement et `externalEventHash` unique par
  restaurant et fournisseur ; le hash inclut aussi le tenant pour éviter toute corrélation
  inter-sites ;
- charge réduite à `payloadHash`, avec états `RECEIVED`, `PROCESSED`, `IGNORED` ou `FAILED` ;
- `processedAt` et code d'erreur borné pour la revue ;
- le modèle accepte les événements d'un compte non encore rattaché, mais ne déclenche aucune
  mutation de réservation sans adaptateur validé.

## Invariants et normalisation

Les normalisateurs du service et les schémas Zod des routes imposent des bornes indépendantes
du dashboard :

- fournisseur parmi l'enum, identifiants externes de 1 à 191 caractères ;
- référence de secret ASCII sans contrôle, préfixe de token courant ou valeur `bearer` ;
- configuration sérialisée de manière déterministe, 4 000 caractères maximum, sans contrôle ;
- clé d'idempotence de 8 à 200 caractères, identifiant de slot de 1 à 160 caractères ;
- dates valides, fenêtre entièrement renseignée ou entièrement vide et fin strictement après le
  début ;
- taille de groupe de 1 à 100, capacité et disponibilité de 0 à 10 000, disponibilité ≤ capacité ;
- hash explicite strictement SHA-256 hexadécimal ; source, type d'événement et curseurs bornés.

Les réponses n'exposent jamais l'identifiant externe complet, la référence de secret, la clé
d'idempotence, le payload ou l'identifiant opérateur en clair.

## Services et transitions

`distribution.service.ts` fournit les opérations suivantes :

1. créer ou mettre à jour une connexion ; une modification de compte, secret ou configuration
   efface le curseur et repasse en `PENDING` ;
2. déconnecter une connexion, opération idempotente qui conserve l'historique ;
3. créer un run avec une clé hachée ; la direction, la fenêtre et le curseur source font partie de
   la charge idempotente. Un rejeu identique renvoie `replayed=true`, une charge différente renvoie
   `409 DISTRIBUTION_SYNC_IDEMPOTENCY_CONFLICT` ;
4. terminer un run une seule fois ; un état final rejoué à l'identique est un no-op, un autre
   état est refusé ;
5. upsert un snapshot borné par slot, sans écrire dans les tables de capacité Suppernote ;
6. lier un identifiant externe uniquement à une réservation existante du même tenant ; un
   collision de hash ou de réservation est un conflit ;
7. ingérer une enveloppe de webhook et la rejouer par `(restaurantId, provider, externalEventHash)` ;
   une charge, un type ou une connexion différente derrière la même clé est un conflit ;
8. terminer un webhook de façon monotone (`RECEIVED` vers un état final).

Une course sur les uniques Prisma `P2002` est convertie en conflit typé ou en rejeu après
relecture. Les lignes finales ne sont jamais réécrites silencieusement.

## Contrat HTTP local

Les routes sont enregistrées dans `main.ts` et utilisent `requireOrg`,
`requireCapability('distribution.manage')`, le rôle du site et `DISTRIBUTION_ENABLED`.

| Méthode        | Route                                                  | Rôle et comportement                                                               |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `GET`          | `/distribution/connections`                            | Liste tenant-scoped pour l'équipe du site.                                         |
| `POST`         | `/distribution/connections`                            | Owner/Manager ; connexion ou mise à jour locale, référence de secret opaque.       |
| `GET`          | `/distribution/connections/:id`                        | Détail masqué d'une connexion.                                                     |
| `POST`         | `/distribution/connections/:id/disconnect`             | Owner/Manager ; conserve les traces.                                               |
| `GET` / `POST` | `/distribution/connections/:id/availability`           | Lecture équipe ; upsert de snapshot Owner/Manager.                                 |
| `GET`          | `/distribution/sync-runs`                              | Runs bornés, filtrables par connexion/état.                                        |
| `POST`         | `/distribution/connections/:id/sync-runs`              | Owner/Manager ; `Idempotency-Key` obligatoire. Crée une trace locale uniquement.   |
| `GET`          | `/distribution/reservation-links`                      | Associations masquées pour l'équipe.                                               |
| `POST`         | `/distribution/connections/:id/reservation-links`      | Owner/Manager ; association explicite à une réservation existante.                 |
| `GET`          | `/distribution/webhooks`                               | Inbox hachée pour la revue de l'équipe.                                            |
| `POST`         | `/api/internal/distribution/webhook-events`            | Opérateur Suppernote ; fixture/enveloppe préparatoire, sans route publique signée. |
| `POST`         | `/api/internal/distribution/webhook-events/:id/finish` | Opérateur Suppernote ; transition finale idempotente.                              |
| `POST`         | `/api/internal/distribution/sync-runs/:id/finish`      | Opérateur/adaptateur futur ; compteurs et état final bornés.                       |

Les erreurs d'entrée renvoient `400`, les ressources hors tenant `404`, et les collisions ou
états finaux `409`. Une route interne exige `restaurantId` dans le corps car le guard opérateur
ne porte pas de contexte d'établissement.

## Adaptateur futur

Le choix du premier canal doit produire une implémentation distincte, par exemple
`distribution/providers/google-reserve.adapter.ts`, qui :

1. reçoit un `DistributionConnection` déjà validé, résout `credentialRef` via le secret manager
   sans renvoyer le secret au domaine ;
2. mappe les disponibilités vers `slotKey`, date et capacité, en conservant une révision source ;
3. crée un `DistributionSyncRun`, utilise le curseur et signe chaque requête ;
4. associe une réservation externe uniquement après confirmation d'une réservation Suppernote ;
5. vérifie la signature, l'horodatage et l'anti-rejeu d'un webhook avant de créer l'enveloppe ;
6. journalise des métriques sans nom, téléphone, token ou payload ;
7. finit le run en `SUCCEEDED`, `FAILED` ou `NEEDS_REVIEW` selon une classification explicite.

Il n'y a volontairement aucun worker fournisseur ou scheduler supplémentaire dans cette phase.
Les runs `QUEUED` sont des preuves opérateur locales ; ils ne sont pas traités automatiquement.
Un worker futur devra avoir un `jobId` déterministe basé sur le run, une concurrence limitée,
un dead-letter et un runbook de rotation de secret.

## RGPD et sécurité

Les liens de réservation ne contiennent pas de PII externe en clair et suivent la suppression
ou l'anonymisation de la réservation. Les événements webhook ne contiennent que des hashes et
des états ; l'export RGPD n'a pas à restituer de token ou de payload. Une future extension
d'export pourra inclure le fournisseur, les états et les dates pour la traçabilité.

Le service filtre toujours par `restaurantId` avant de lire une connexion, une disponibilité,
un lien ou un webhook. Le dashboard affiche les quatre derniers caractères seulement. Les logs
et métriques ne doivent pas reprendre `credentialRef`, `externalAccountId`, `externalEventId`
ou le corps d'une requête.

## Rollout, preuve et rollback

Avant d'activer un canal réel, il faut :

1. choisir un fournisseur et obtenir ses conditions de sandbox, limites, signature et DPA ;
2. créer le secret manager et vérifier que la rotation ne change pas le contrat applicatif ;
3. implémenter l'adaptateur et ses fixtures de contrat, puis vérifier idempotence et concurrence
   sur une copie anonymisée ;
4. exécuter un pilote sur un restaurant avec disponibilité observée, réservations entrantes,
   annulations, webhook rejoué et déconnexion ;
5. rapprocher au moins 30 jours de runs et de réservations, traiter les `NEEDS_REVIEW` et signer
   le runbook d'incident ;
6. fermer la porte `P9_ECOSYSTEM` et `PILOTS` dans `docs/release/product-gates.json`.

La preuve locale du 14 septembre 2026 comprend la migration Prisma, 13 tests de service, 5 tests
de routes, le dashboard et 4 tests UI. Aucun appel Google, Meta, API publique, paiement,
notification ou webhook public n'a été effectué. Le rollback local remet
`DISTRIBUTION_ENABLED=false` et restaure l'artefact ; la suppression des tables exige une
migration séparée et une sauvegarde vérifiée.

## Hors périmètre

- inscription OAuth, compte marchand, secret manager réel ou certification Google/Meta ;
- disponibilité autoritaire, réservation créée automatiquement ou modification silencieuse ;
- webhook public signé, retry provider, worker BullMQ et dead-letter ;
- widget, voix, événements ou paiement déclenchés depuis un canal tiers ;
- facturation, commission, reporting de revenu encaissé et attribution marketing ;
- marketplace de canaux, catalogue de 65 intégrations ou synchronisation multi-groupe ;
- résolution automatique des doublons, client CRM enrichi ou rapprochement POS.

Cette frontière permet de dire précisément ce qui est fait : le contrat local et la traçabilité
sont livrés ; la valeur de distribution externe reste une porte de pilote séparée.
