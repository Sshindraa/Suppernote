# ADR-3E — Clôture opérationnelle des notifications

- **Date** : 2026-09-02
- **Statut** : décisions techniques retenues ; validation provider staging ouverte
- **Périmètre** : Phase 3E, cinq workers de notification protégés par claim
- **Références** : `adr-reservation-integrity-3c.md`, `queue-runtime-map.md`, `runbooks/testing.md`

## Contexte

La Phase 3D protège les notifications contre les renvois aveugles après un
résultat `unknown`, mais laisse trois fenêtres opérationnelles : un processus
peut mourir avec une claim `in_progress`, la réconciliation peut connaître
l'acceptation provider sans réparer le marqueur local, et un échec certain ne
doit pas dépendre d'un retry implicite non observable.

Cette phase ne change ni `Reservation.status/state`, ni la capacité, les holds,
les deux `ReservationService`, l'API, Prisma, PM2 ou les schedulers. Elle ne
revendique pas une garantie exactly-once chez Telnyx ou Resend.

## Décisions

### D3E-1 — Lease et claims orphelines

La TTL de conservation de la claim reste de 7 jours. Elle est distincte d'une
lease opérationnelle de 15 minutes :

- `in_progress` est active si `updatedAt` est valide et âgé de moins de 15
  minutes ;
- elle est orpheline au-delà de cette lease ou si l'horodatage est invalide ;
- la récupération ne renvoie jamais le provider ; elle transforme une claim
  versionnée orpheline en `unknown` par comparaison atomique du token, puis
  ajoute le job `notification-status` déterministe ;
- une ancienne valeur littérale `claimed`, sans token exploitable, reste
  conservée et rejoint la revue manuelle ; elle n'est jamais rejouée.

Le balayage réutilise le job existant `reconciliation/sms` quotidien. Aucun
nouveau scheduler ou entrypoint n'est créé. Si Redis ou la queue est
indisponible, la claim reste conservée et aucun provider n'est appelé.

### D3E-2 — Réconciliation et réparation locale

Une consultation provider positive ne clôture l'opération qu'après une
réparation locale idempotente, ou après vérification que la réparation n'est
pas applicable :

| Opération                    | Réparation autorisée                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| confirmation outbound        | créer une seule fois l'audit `reservation_confirmation_sms_sent` existant                                                                            |
| rappel J-1                   | poser `confirmationSentAt` et conserver la projection `confirmationStatus` existante, seulement après relecture d'une réservation toujours confirmée |
| rappel gift card             | poser `reminderSentAt` s'il est absent                                                                                                               |
| waiting list / call recovery | aucune nouvelle écriture métier ; l'absence de marqueur durable existant est documentée et la claim reste la protection de notification              |

Les lectures et écritures sont limitées à l'entité référencée par la claim.
Une réparation déjà présente est un succès idempotent. Une entité absente, un
état devenu incohérent ou une erreur d'écriture restent en revue manuelle sans
réenvoi. Aucun nouvel événement d'audit n'est inventé pour waiting list ou
call recovery sans décision produit.

### D3E-3 — Retry après échec certain

Un `failure_certain` libère la claim et fait échouer le job source avec une
erreur non-PII. BullMQ rejoue alors le même job déterministe, avec son payload
original, selon la politique déjà attachée à la queue :

- `sms-client`, `confirmation-sms`, `call-recovery` et `reconciliation` : 5
  tentatives au total, backoff exponentiel initial de 5 secondes ;
- `waiting-list-promote` : 3 tentatives au total, backoff exponentiel initial
  de 5 secondes ;
- `gift-card-reminder` : 3 tentatives au total, backoff exponentiel initial de
  60 secondes.

Le `jobId` d'origine reste la référence de déduplication ; aucune nouvelle
queue de retry ni payload parallèle n'est créée dans cette phase. Le dead-letter
existant reçoit le job après épuisement de sa borne, avec les données nettoyées
par le listener commun. Un `unknown` ne libère jamais la claim et ne crée
jamais ce retry certain. Cette stratégie garantit un retry borné et
déterministe côté Suppernote, sans prétendre à l'exactly-once chez le provider.

### D3E-4 — Contrat provider

Les adapters exposent seulement un reçu borné : `provider`, `channel`,
`providerMessageId` éventuel et résultat. `success` signifie « requête acceptée
par le provider », pas « livrée au destinataire ». Les fixtures testent les
réponses acceptées, les identifiants, les refus et les états de livraison
ambiguës sans appeler un provider.

Une validation staging reste ouverte. Elle ne pourra utiliser qu'un compte,
un restaurant, des destinataires de test et des providers explicitement
autorisés ; elle devra journaliser les identifiants sans PII et ne pourra pas
être exécutée par cette phase sans procédure d'autorisation séparée.

### D3E-5 — Crash, concurrence et panne de queue

Les tests doivent injecter une interruption après l'appel provider simulé et
avant `recordNotificationResult`, redémarrer le traitement avec la claim
vieillie, puis vérifier `unknown` + réconciliation sans deuxième appel. Ils
doivent également simuler l'échec de `queue.add`, Redis indisponible, deux
réconciliations concurrentes et un retry certain concurrent.

Le résultat attendu dans toute panne de coordination est conservateur : pas
de nouvel envoi automatique, claim conservée ou passage en revue manuelle, et
aucune mutation `status/state`.

## Points encore ouverts

1. La durée de 15 minutes est un paramètre technique initial à observer ; un
   SLA provider différent devra être validé avant modification.
2. La procédure humaine de revue `dead-letter` et son délai de résolution ne
   sont pas encore un engagement produit.
3. La validation de staging Telnyx/Resend et la correspondance exacte des
   statuts de livraison restent à exécuter avec autorisation explicite.
4. L'audit durable des notifications waiting list et call recovery nécessite
   une décision produit avant toute nouvelle écriture.
5. Si la lecture de réconciliation établit finalement un `failure_certain`
   après un `unknown`, la claim ne contient volontairement ni payload source ni
   référence de job permettant de reconstruire l'envoi sans PII. Cette phase
   libère la claim pour revue manuelle, mais ne relance pas automatiquement ce
   cas. Un mécanisme de rejeu contrôlé nécessiterait une décision séparée sur
   la conservation d'une référence sûre au job source ; il ne faut pas le
   confondre avec le retry direct, borné, d'un refus observé par le worker.

## Critère de sortie Phase 3E

La phase est techniquement clôturée lorsque les claims orphelines, les
réparations idempotentes, les retries certains bornés, les crashs et les
indisponibilités de queue sont couverts par des tests déterministes et un
runbook. Le statut commercial reste **NO-GO** tant que la validation staging,
la procédure manuelle et les décisions produit ouvertes ne sont pas approuvées.
