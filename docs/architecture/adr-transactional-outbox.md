# ADR — Outbox transactionnelle et livraison at-least-once

> **Statut** : accepté, première implémentation livrée
> **Date** : 2026-09-13
> **Périmètre** : événements d'usage voix et socle réutilisable pour CRM, marketing et POS

## Contexte

Une écriture Postgres suivie directement d'un `queue.add()` peut laisser une réservation,
une consommation ou une projection sans job si Redis tombe entre les deux opérations. Le
problème inverse existe aussi : BullMQ peut rejouer un job après un timeout. Suppernote a donc besoin
d'une intention durable en base et de consommateurs idempotents.

## Décision

`OutboxEvent` est une table additive, avec un `idempotencyKey` unique, un payload JSON sans PII,
un topic, un agrégat, une version de schéma et un état explicite :

```text
PENDING -> DISPATCHING -> DISPATCHED
       \\-> PENDING (erreur ou lease expiré)
       \\-> FAILED (réservé aux traitements qui ajoutent cette politique)
```

`enqueue(tx, event)` reçoit le client Prisma de la transaction appelante. La mutation métier et
l'intention outbox doivent être écrites dans la même transaction lorsqu'un nouveau domaine sera
branché. `enqueueOnDatabase` est le point d'entrée de secours pour les sources externes déjà
finales, comme les compteurs de providers à la fermeture d'un appel.

Le dispatcher planifié chaque minute :

1. remet en `PENDING` les lignes `DISPATCHING` dont le lease de cinq minutes est expiré ;
2. revendique au plus 100 lignes avec `FOR UPDATE SKIP LOCKED` ;
3. incrémente `attempts`, pose `lockedAt` et publie uniquement `{ outboxEventId }` dans BullMQ ;
4. passe la ligne à `DISPATCHED` après l'acceptation Redis ;
5. remet en `PENDING` une ligne si l'ajout dans BullMQ échoue.

Le worker de livraison recharge l'événement en base. Le topic `usage` reconstruit la date et
appelle le recorder tarifé ; la clé source unique du ledger absorbe les rejeux du worker. Les
topics inconnus échouent explicitement afin de ne pas masquer un consommateur manquant.

## Protection des données

Le payload accepte des identifiants et des mesures, mais refuse les clés évidentes `phone`,
`email`, `customerName`, `transcript`, `messageBody`, `secret` et `token`, y compris dans les
objets imbriqués. Un consommateur recharge les données autorisées depuis Postgres avec son tenant.

## Conséquences

- garantie visée : **at-least-once**, jamais exactly-once ;
- Redis peut être indisponible sans perdre l'intention durable ;
- la purge/rétention et le traitement des mutations CRM restent à brancher sur l'outbox ; le
  contrôle de campagne actuel conserve ses états dans Postgres et publie directement dans la queue
  BullMQ, avec un flag d'envoi désactivé par défaut ;
- l'implémentation actuelle ne marque pas encore la consommation métier comme un nouvel état :
  BullMQ, les retries et les clés idempotentes restent la preuve de traitement.

## Vérification

Les tests couvrent l'insertion/rejeu, le rejet PII et la revendication SQL `SKIP LOCKED`. Un test
Postgres avec deux dispatchers et une panne Redis reste requis avant l'activation commerciale.
