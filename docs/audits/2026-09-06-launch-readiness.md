# Audit de lancement Suppernote — 10 premiers restaurants

Date du snapshot : 6 septembre 2026. Version examinée : `b7d14da15777e8aab074859b519387bffdc32687`, identique sur GitHub `main` et le VPS de production à cette date. Constats réalisés vers 23 h, heure de Paris.

> **Document historique — ne pas utiliser comme état courant.** Ce fichier conserve le verdict, les compteurs et les reproductions observés le 06/09. La réconciliation du 15/09, qui distingue les correctifs promus, le profil scoped en production et les portes encore ouvertes, est la référence actuelle : [état courant des audits](./2026-09-15-current-state.md).

**Verdict du snapshot : NO-GO pour une ouverture commerciale payante dans l’état observé le 06/09.** Suppernote disposait déjà d’un socle de SaaS : application déployée, authentification, réservations transactionnelles, files de tâches, paiement hébergé, tests et sauvegardes restaurées. Les défauts et lacunes décrits ci-dessous sont ceux de cette version figée ; ils ne doivent pas être reportés automatiquement sur la release actuelle.

La suite pertinente est un lancement accompagné : correction des blocages, validation complète sur un établissement de test, puis deux restaurants réels, puis dix après observation. La prospection et les démonstrations accompagnées peuvent avancer pendant ce travail ; la promesse d’un service autonome et fiable doit attendre les critères de sortie ci-dessous.

Plan d’exécution : [plan de lancement phase par phase](/Users/hamza/Projects/Sokar/docs/audits/2026-09-06-launch-plan.md).

## Périmètre et méthode

- Copie temporaire du commit de production, sans changer la branche locale ni ses modifications en cours. Le dossier local était sur `c1faddb`, avec de nombreux changements non publiés ; il n’a pas servi de référence pour attribuer les défauts à la production.
- Lecture du code : authentification, routes admin, réservations, Billing, voix, notifications, RGPD, CI, déploiement et sauvegardes.
- Lectures du VPS, configuration masquée, statistiques PostgreSQL agrégées dans une transaction en lecture seule, files BullMQ sur la base Redis dédiée, API Stripe et Telnyx en lecture.
- Navigation dans le site public avec la session utilisateur déjà ouverte ; consultation du passage à Stripe. Le clic « Souscrire Pro » a automatiquement créé une session Checkout et une fiche Billing/client Stripe. **Aucun paiement ni abonnement n’a été validé.** La lecture finale confirme zéro abonnement Stripe et zéro abonnement attaché en base.
- Reproductions locales sur données fictives et dépendances simulées, en utilisant les routes et services du commit audité. Il ne s’agit pas d’une exploitation contre les restaurants en production, ni d’un test complet de Clerk avec deux comptes réels.
- Pas d’appel téléphonique, SMS, email, charge test en production, changement de configuration, correctif applicatif, commit ou déploiement effectué pendant l’audit.

Les liens de code pointent vers le commit figé. Les observations serveur sont des instantanés, pas une mesure de disponibilité sur plusieurs semaines. Les documents commerciaux ou contrats détenus hors du dépôt n’ont pas été examinés.

## Ce qui est déjà solide

| Élément                      | Preuve vérifiée                                                                                                                                                                                                                                     | Limite                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Livraison                    | [CI](https://github.com/Sshindraa/Sokar/actions/runs/33882272168), [staging](https://github.com/Sshindraa/Sokar/actions/runs/33882685394) et [production](https://github.com/Sshindraa/Sokar/actions/runs/33883086804) réussis sur le commit audité | Les tests métier de staging ne bloquent pas la livraison                                                               |
| Santé instantanée            | `/health` public HTTP 200 ; DB, Redis, queues, Telnyx, ancien fournisseur STT, Cartesia répondent                                                                                                                                                   | Ne teste ni un dialogue complet, ni un SMS livré, ni le LLM Groq                                                       |
| Ressources serveur           | 7,75 Go RAM ; environ 6 Go disponibles ; disque utilisé à 30 %                                                                                                                                                                                      | Mesure à faible charge, pas un test de dix appels simultanés                                                           |
| Sauvegardes                  | Dump du 06/09 à 01:20 UTC restauré dans une base temporaire : 32 tables ; copie R2 à 02:00 UTC avec hash identique                                                                                                                                  | Pas de reconstruction complète du VPS exécutée pendant l’audit ; cadence quotidienne, perte potentielle proche de 24 h |
| Isolation des environnements | Redis sépare sessions/cache/queues ; production et staging ont des indices distincts ; aucun flag démo actif dans l’API de production                                                                                                               | Les deux environnements partagent le même VPS                                                                          |
| Paiement                     | Clé live, huit références de prix présentes, webhook actif avec événements d’abonnement ; Checkout fonctionne jusqu’à l’écran de paiement                                                                                                           | Cycle abonnement, droits et gestion des incidents insuffisants                                                         |
| Base de qualité              | 2 082 tests existants réussis après le rejeu WebSocket                                                                                                                                                                                              | 22 tests d’intégration PostgreSQL ignorés ; mocks sur les dépendances des tests unitaires                              |

Ce socle justifie de durcir l’existant. L’audit n’apporte aucun motif pour engager une réécriture ou une infrastructure Kubernetes pour dix restaurants.

## Blocages confirmés

### P0-01 — Un restaurant peut utiliser l’administration d’un autre

**Preuve :** `requireOrg()` vérifie l’existence d’une organisation Clerk, sans rôle opérateur Suppernote. Les routes de provisioning utilisent ensuite le `restaurantId` de l’URL sans le comparer à l’organisation authentifiée. La liste admin parcourt tous les restaurants. Le même défaut existe sur la route de santé d’un restaurant.

Deux reproductions locales passent : un utilisateur rattaché à A peut demander l’attribution d’un numéro à B ; il peut aussi marquer B `ACTIVE`, avec `testCallValidatedAt` renseigné, sans appel validé. Les services externes sont simulés dans ces preuves.

**Impact :** accès aux informations d’autres restaurants, modification de leur téléphonie et activation indue. C’est bloquant avant le premier client externe, même avec seulement deux établissements.

**À faire :** autorisation serveur spécifique aux opérateurs Suppernote pour l’administration globale ; contrôle d’appartenance sur chaque ressource tenant ; séparation propriétaire/employé pour les opérations sensibles. Ne pas se limiter à masquer les pages du dashboard.

**Critère de sortie :** matrice anonyme / membre A / propriétaire A / propriétaire B / opérateur. Toute lecture ou mutation interdite doit être rejetée, sans effet DB ou Telnyx. Ajouter ces scénarios à la CI.

Sources : [guard Clerk][clerk], [provisioning][provisioning], [santé restaurant][admin-health].

### P0-02 — La création publique de réservation permet une fuite par rejeu

**Preuve :** `POST /reservations` est volontairement public, accepte `restaurantId` et `callId`, puis renvoie l’objet de réservation. Le service recherche d’abord une réservation par `callId` seul et la retourne avant toute vérification du restaurant. La reproduction, sans authentification, obtient le nom et le téléphone fictifs de B en soumettant un `restaurantId` A avec un `callId` B connu.

**Condition d’exploitation de la fuite :** connaître un identifiant d’appel associé à une réservation. L’audit ne démontre pas que cet identifiant est devinable ou exposé à un visiteur quelconque. En revanche, l’absence de contrôle du restaurant est reproduite. La route permet également de solliciter la création sans passer par les protections spécifiques du parcours public Connect.

**À faire :** définir le contrat de chaque canal : authentification de service pour un appel interne ou capacité signée et bornée pour un parcours public ; vérifier le restaurant avant chaque rejeu ; contrôler les relations appel/réservation/restaurant ; ne renvoyer que les champs nécessaires. Préserver les clients légitimes lors de la migration de cette route.

**Critère de sortie :** rejet des appels sans autorisation requise et des identifiants croisés ; aucun retour de données d’un autre restaurant ; rejouer un appel légitime ne crée ni réservation ni SMS supplémentaire.

Sources : [route publique][reservation-route], [rejeu du service][reservation-service].

### P1-03 — Le client peut s’attribuer un plan payant

**Preuve :** le schéma de mise à jour restaurant hérite de `plan: STARTER | PRO | PREMIUM`. Le handler applique directement ce champ en base. Un membre de son organisation peut envoyer `plan: PREMIUM` et obtenir HTTP 200 sans Stripe. Reproduction locale confirmée.

La recherche des usages de `subscriptionStatus` ne révèle pas de contrôle d’accès au service fondé sur l’état de paiement hors du module Billing. La rétrogradation d’un abonnement supprimé vers `STARTER` remet en outre le restaurant sur le nom technique de l’offre Essential payante, sans état explicite de suspension.

**À faire :** retirer les droits payants des champs modifiables par le client ; calculer les droits à partir d’une source Billing contrôlée côté serveur ; définir essai, actif, délai de grâce, impayé et résilié. Un plan et un statut de paiement doivent rester distincts.

**Critère de sortie :** impossible de modifier ses droits via une requête directe ; tests de chaque état d’abonnement sur les fonctions facturées.

Sources : [schéma restaurant][restaurant-schema], [mise à jour restaurant][restaurant-update], [Billing][billing].

### P1-04 — Le cycle d’abonnement n’est pas suffisamment robuste

**Preuves :**

- Deux demandes Checkout créent deux sessions : pas de session en attente réutilisée, ni d’option d’idempotence sur l’appel Stripe. La vérification actuelle ne bloque que les abonnements déjà enregistrés.
- Un événement `subscription.updated` ancien, traité après `subscription.deleted`, rétablit le statut actif et le plan Pro. Reproduction confirmée. Aucun événement reçu n’est mémorisé par ID dans ce traitement.
- Aucun parcours de portail client, changement de moyen de paiement ou résiliation n’a été trouvé dans le module Billing inspecté.
- Aucun abonnement Stripe existant : le cycle réel jusqu’au paiement et à la résiliation n’est pas prouvé par les données disponibles.

**À faire :** une souscription en attente par restaurant, traitement rejouable des événements et relecture de l’état courant Stripe, mises à jour cohérentes du restaurant et de Billing, parcours factures/résiliation/impayés. Pour dix clients, un traitement accompagné est acceptable si la procédure est explicite et testée.

Ne pas résoudre l’ordre des événements uniquement avec `event.created` : Stripe indique que l’ordre de livraison n’est pas garanti et recommande de dédupliquer par ID d’événement et de récupérer les objets courants si nécessaire. [Documentation Stripe](https://docs.stripe.com/webhooks#event-ordering).

**Critère de sortie :** tests Stripe en mode test : double clic, deux onglets, retries, événements inversés, paiement refusé, paiement différé si accepté, résiliation et reprise. Un restaurant ne doit jamais avoir deux abonnements actifs involontaires.

Source : [création Checkout et webhooks][billing].

### P1-05 — Les confirmations SMS ne sont pas prêtes

**Preuves serveur et fournisseur :**

- L’expéditeur de `TELNYX_FROM_NUMBER` est bien un numéro actif de l’inventaire Telnyx.
- Sa configuration de messagerie retourne HTTP 200, sans `messaging_profile_id`, avec `features.sms = null` et `features.mms = null`.
- La base Redis de queues de production contient 4 jobs `sms-client` échoués, 1 job `confirmation-sms` échoué avec refus fournisseur et 5 entrées en dead-letter. Ces compteurs peuvent représenter les mêmes incidents, il ne faut pas les additionner pour calculer un taux d’échec.
- Le journal du 04/09 mentionnait déjà le refus Telnyx `40305` sur l’adresse d’expédition. Aucun nouvel envoi n’a été effectué pendant cet audit.

**Impact :** la promesse « réservation confirmée par SMS » n’est pas démontrée et la configuration actuelle doit être corrigée avant commercialisation.

**À faire :** choisir et configurer un expéditeur compatible SMS pour les destinations visées, éventuellement distinct du numéro vocal ; vérifier profil, callbacks de livraison et réponses attendues ; traiter les échecs et la dead-letter. Une réponse « accepté » du fournisseur ne suffit pas à prouver la réception.

**Critère de sortie :** réception réelle d’une confirmation, d’un rappel et, si proposée, d’une réponse client ; scénario fournisseur indisponible avec alerte, reprise contrôlée et absence de doublon.

Source : [expéditeur SMS dans le code][sms-client].

### P1-06 — Les pannes peuvent rester dans les logs

**Preuve :** après combinaison du fichier `.env` et de l’environnement PM2 effectif, `SENTRY_DSN`, `ALERT_EMAIL_TO`, `ALERT_WEBHOOK_URL` et `ALERT_SMS_TO` sont absents. Le watchdog tourne toutes les cinq minutes, mais son fichier `/etc/sokar/watchdog.env` est absent ; son cron n’injecte aucun canal. L’échantillon du log API contient 43 messages signalant l’absence de canal d’alerte.

Le mécanisme heartbeat existe dans le code, mais aucune configuration de supervision externe n’est démontrée dans le périmètre inspecté. Un outil externe indépendant, configuré ailleurs, reste à vérifier.

**À faire :** configurer au moins un canal effectivement reçu, une surveillance extérieure au VPS, des alertes métier voix/SMS/queues et une procédure d’incident avec responsable identifié. Vérifier aussi la santé du LLM et les échecs de livraison, qui ne sont pas attestés par `/health`.

**Critère de sortie :** panne simulée en staging → notification reçue en moins de cinq minutes → procédure suivie → notification de rétablissement. Inclure indisponibilité complète du VPS, SMS rejeté et tâche en dead-letter.

Sources : [dispatcher][alerts], [watchdog][watchdog], [health checks][health].

### P1-07 — L’effacement et la conservation des données sont incomplets

**Preuves dans le code :**

- `ErasureService` anonymise certains champs de réservation et de message, mais ne traite pas `Reservation.customerEmail`, le profil `Customer`, `Call.transcript` ou l’audio associé. Le compteur `callsAnonymized` correspond à des messages, pas à des lignes `Call`.
- `scheduleAnonymizationCron` et `runAnonymization` existent mais ne sont appelés par aucun worker de production trouvé. Aucun scheduler d’anonymisation RGPD n’apparaît parmi les schedulers inspectés. La purge audio à 30 jours est, elle, bien programmée.
- Trois textes de confidentialité coexistent : API à deux ans, dashboard avec durées différentes et champs société « À REMPLIR », Connect avec durée de réservation non chiffrée. L’API cite encore Twilio/Brevo/Postmark ; Groq et Resend, employés actuellement, ne figurent pas dans ces listes.
- Le footer d’accueil renvoie les liens légaux à `#`. `/privacy` renvoie bien HTTP 200 avec le texte Connect ; ce n’est donc pas la page détaillée du dashboard contenant les placeholders qui est servie sur cette URL.

**À faire :** cartographier les données et la portée d’un effacement, inclure leurs copies et exports applicatifs, brancher la rétention, unifier les textes et vérifier les pièces contractuelles. Aucun contrat client ou DPA signé n’a été examiné ; la mention « DPA à formaliser » dans le code n’est pas une preuve de l’état juridique réel. La CNIL rappelle que les traitements confiés à un sous-traitant doivent être encadrés par contrat. [Référence CNIL](https://www.cnil.fr/fr/sous-traitant).

**Critère de sortie :** client fictif présent dans réservations, profil, messages, transcript et audio → export conforme au périmètre annoncé → effacement vérifié dans chaque emplacement ; politique de sauvegarde et de réapplication des effacements documentée. Identité légale et contrat de sous-traitance disponibles avant collecte de données clients réels.

Sources : [effacement][erasure], [anonymisation][anonymization], [politique API][privacy-api], [politique dashboard][privacy-dashboard], [politique Connect][privacy-connect].

### P1-08 — La qualité vocale et l’onboarding ne sont pas qualifiés pour dix clients

**Instantané production, avant navigation Checkout :** 14 restaurants en base ; 12 `PENDING`, 2 `PHONE_ASSIGNED`, aucun `ACTIVE`, aucun `onboardingDone`, aucun `testCallValidatedAt`. Dix fiches sont publiées, ce qui ne constitue pas dix clients activés.

Sur les sept jours précédents : 10 appels observés sur deux restaurants, 10 transcripts, 4 réservations associées. Tous les champs `outcome` et `intent` sont nuls. **Ce n’est pas un taux de conversion de 40 % :** on ne sait pas classer chaque intention, ni confirmer qu’une réservation était attendue pour chaque appel.

Le dernier appel observé date du 04/09 à 13:28 UTC ; le correctif `b7d14da` a été déployé ensuite. Il n’existe donc pas, dans ces données, de validation téléphonique après ce correctif. Dans le code, le webhook `call.hangup` ne renseigne pas `outcome` ; le traitement enrichi est dans une autre route `/voice/telnyx/end`. Le worker de réconciliation des appels incomplets les journalise, sans les réparer.

**À faire :** raccorder et tester la finalisation de l’appel, mesurer des résultats métier vérifiables, puis exécuter une campagne téléphonique représentative : noms rares, épellation, bruit, correction de date/heure, fermeture, complet, transfert, absence de réponse du gérant, abandon et panne fournisseur.

**Critère de sortie proposé :** sur au moins 100 scénarios contrôlés, zéro réservation annoncée à tort, zéro doublon et zéro surbooking ; au moins 95 % des intentions couvertes aboutissent à la bonne action ou au transfert/message prévu. Mesurer les dénominateurs et faire valider les erreurs par un humain. Ce seuil est une proposition de lancement, pas un résultat acquis.

Sources : [raccroché][hangup], [route de finalisation][call-end], [réconciliation][reconciliation].

### P1-09 — La CI peut être verte malgré un parcours métier cassé

**Preuve :** les 22 tests de concurrence PostgreSQL nécessitent `AGENTIC_INT_TESTS=1`, absent de la CI examinée. Les E2E dashboard de CI utilisent un mode démo et des réponses simulées. Le test fonctionnel contre le staging termine par `|| true`. Les E2E Connect existent mais ne sont pas exécutés par le job Connect de cette CI.

**À faire :** bloquer la livraison sur un petit parcours de bout en bout avec vraie base de test : authentification/organisation, configuration capacité, réservation, confirmation, annulation et libération de table ; ajouter les refus inter-restaurants et les événements Billing. Exécuter les tests de concurrence avec PostgreSQL et Redis isolés.

**Critère de sortie :** un échec intentionnel dans ce parcours empêche la promotion vers la production. Tester ensuite la dernière table disputée simultanément par widget et voix, puis dix restaurants en parallèle.

Sources : [CI][ci], [E2E staging non bloquant][staging-e2e], [tests de concurrence][concurrency].

## Écarts commerciaux et risques complémentaires

1. **Prix cohérents dans le snapshot.** Le site affichait Pro annuel à 199 €/mois tandis que Stripe affichait 199,20 €/mois, soit 2 390,40 €/an ; le code du snapshot arrondissait `249 × 0,8`. Le catalogue produit courant est Essential 199 € / Pro 299 € ; les `price_id` Stripe doivent encore être migrés et le montant total, l’engagement et le régime HT/TTC doivent être validés avant facturation. [Source][pricing].
2. **Promesses à justifier.** « 98.4 % taux de réponse garanti », témoignage « Partenaire certifié » et « 2 étoiles Michelin » sont codés en dur dans les pages d’inscription/connexion. Aucune pièce justificative n’a été examinée. Documenter les preuves ou remplacer ces éléments. Le site présente encore « BÊTA PRIVÉE » et des liens de réseaux sociaux à `#`.
3. **Intégrations vendues.** Les clés Google Calendar ne sont pas configurées dans l’API de production inspectée alors que le site présente l’intégration comme native. Mettre en service et tester, ou qualifier la disponibilité commerciale. Le multi-site doit également être validé de bout en bout : quantité facturée, attribution des établissements, accès et facture unique. Le calcul d’add-ons Stripe seul n’en apporte pas la preuve.
4. **Coûts.** Le code alerte après 3 000 appels/mois et coupe au-delà de 200 appels/heure, mais l’alerte passe par Sentry, absent. Le benchmark historique LLM ne chiffre pas le coût complet de la stack actuelle. Avant de promettre « sans limite », mesurer téléphonie + STT + LLM + TTS + SMS + stockage + support, par restaurant et par minute, avec une politique d’usage explicite.
5. **Dépendances.** GitHub remonte 7 alertes Dependabot ouvertes : 2 hautes sur Browserslist, 4 moyennes sur Fastify/qs, 1 basse sur postcss-selector-parser. Zéro alerte CodeQL ouverte. Les alertes hautes concernent ici Browserslist et nécessitent une analyse d’exposition ; elles ne prouvent pas une exploitation distante du SaaS. Mettre à jour et tester avant ouverture. [Alertes du dépôt](https://github.com/Sshindraa/Sokar/security/dependabot).
6. **Continuité.** Le VPS unique peut convenir à dix restaurants, mais c’est un point de panne commun. Les sessions vocales sont en mémoire d’un processus API et PM2 dispose de huit secondes pour l’arrêter. Aucun test de continuité d’un appel pendant déploiement n’a été effectué. Prévoir un drainage ou une fenêtre de maintenance et un renvoi téléphonique de secours réellement testé.
7. **Restauration.** Les sauvegardes sont un point fort ; il reste à mesurer une reprise complète sur un hôte vierge. Choisir explicitement une perte maximale de données et un délai de reprise acceptables. Proposition de cible initiale : perte ≤ 15 minutes et reprise ≤ 60 minutes, à valider techniquement et commercialement ; la sauvegarde quotidienne actuelle ne prouve pas ces objectifs.

## Passage concret aux dix premiers restaurants

| Étape                                  | Travail attendu                                                              | Condition de passage                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Fermer les risques d’accès          | P0-01, P0-02 et P1-03 ; matrice de droits                                    | Tous les refus attendus vérifiés, aucun secret ou donnée d’un autre restaurant retourné                         |
| 2. Rendre le service exploitable       | SMS, alertes, effacement/rétention, finalisation voix, procédure d’incident  | Réception SMS et alerte prouvées ; données effaçables ; appel toujours traçable ; secours téléphonique validé   |
| 3. Valider la vente                    | Billing et prix, contrat, identité légale, promesses et intégrations         | Cycle de souscription en test complet, aucun double abonnement, offre conforme au service livré                 |
| 4. Qualifier un restaurant de test     | Onboarding complet, voix, widget, dernière table, annulation, pannes, charge | Scénarios métier documentés et bloquants en CI ; dix appels simultanés testés avec limites fournisseurs connues |
| 5. Ouvrir deux restaurants accompagnés | Installation, consignes et formation, observation de services réels          | Sept jours incluant des pics de service sans incident critique ouvert ; chaque échec expliqué et traité         |
| 6. Étendre à dix                       | Même checklist signée par établissement ; support identifié                  | Indicateurs par restaurant, coût suivi, capacités et renvois vérifiés ; aucun P0/P1 de lancement restant        |

Pour ce premier périmètre, l’argumentaire inclut désormais le cœur réservation voix + web, l’agenda/plan de salle, la confirmation SMS et la reprise par le gérant, ainsi que le multi-site, les réservations ChatGPT/Claude, le domaine personnalisé, les cartes cadeaux, les fonctions prédictives, la facturation annuelle et une politique d’usage/SLA en remplacement des slogans non mesurés. L’activation manuelle des numéros et l’accompagnement sont acceptables à cette échelle s’ils sont fiables et reproductibles. Chaque module est livré derrière sa preuve de bout en bout, son contrôle d’accès et sa porte d’activation ; il peut être proposé dès la signature sans être présenté comme une garantie chiffrée tant que sa métrique n’est pas validée.

## Vérifications exécutées et preuves conservées

| Suite                                               | Résultat                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| API existante                                       | 1 823 tests recensés : 1 790 réussis, 11 initialement bloqués par `listen EPERM`, 22 ignorés         |
| Rejeu du fichier WebSocket avec port local autorisé | 12/12 réussis ; les 11 échecs environnementaux sont levés, soit 1 801 tests API distincts réussis    |
| Dashboard                                           | 157/157                                                                                              |
| Connect                                             | 104/104                                                                                              |
| Widget                                              | 20/20                                                                                                |
| Six reproductions d’audit                           | 6/6 comportements défectueux reproduits ; ce résultat vert confirme les défauts, pas leur correction |

Le lockfile de la copie auditée est identique à celui des dépendances locales utilisées. Les mocks Prisma/Redis/BullMQ/fournisseurs restent ceux du dépôt. La compilation/lint du commit déployé sont attestés par sa CI ; aucune nouvelle campagne de build complète n’a été lancée pendant cet audit.

Preuves locales : [constats de production agrégés](/Users/hamza/Projects/Sokar/docs/audits/2026-09-06-evidence/runtime-summary.json), [résumé des tests](/Users/hamza/Projects/Sokar/docs/audits/2026-09-06-evidence/test-summary.json), [reproductions sur données fictives](/Users/hamza/Projects/Sokar/docs/audits/2026-09-06-evidence/launch-audit.test.ts.txt). Pour rejouer ces reproductions, copier le fichier dans `apps/api/src/test/launch-audit.test.ts` d’une copie isolée du commit audité et lancer Vitest depuis `apps/api` ; ne pas utiliser les identifiants de vrais clients.

La production n’est pas déclarée « sécurisée » sur la base de cet audit. Les preuves établissent des blocages précis et une marche à suivre ; elles ne remplacent pas une qualification complète des parcours avec de vrais comptes isolés, des paiements de test et des appels représentatifs.

[clerk]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/plugins/clerk.ts#L31
[provisioning]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/admin/provisioning.routes.ts#L43
[admin-health]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/admin/restaurant-health.routes.ts#L12
[reservation-route]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/reservations/reservation.routes.ts#L41
[reservation-service]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/reservations/reservation.service.ts#L101
[restaurant-schema]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/restaurants/restaurant.routes.ts#L46
[restaurant-update]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/restaurants/restaurant.routes.ts#L417
[billing]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/billing/billing.service.ts#L159
[sms-client]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/shared/telnyx/client.ts#L44
[alerts]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/shared/observability/alert-dispatcher.ts#L141
[watchdog]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/scripts/ops/sokar-watchdog.sh
[health]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/shared/health/checks.ts
[erasure]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/rgpd/erasure.service.ts#L83
[anonymization]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/rgpd/anonymization.worker.ts#L123
[privacy-api]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/rgpd/privacy-policy.ts
[privacy-dashboard]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/dashboard/src/app/privacy/page.tsx#L14
[privacy-connect]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/connect/src/app/privacy/page.tsx
[hangup]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/voice/telnyx.pipeline.ts#L333
[call-end]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/voice/telnyx.pipeline.ts#L410
[reconciliation]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/shared/queue/workers/reconciliation.worker.ts#L367
[ci]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/.github/workflows/ci.yml
[staging-e2e]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/.github/workflows/deploy-staging.yml#L196
[concurrency]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/api/src/modules/agentic-reservations/__tests__/concurrency.test.ts#L46
[pricing]: https://github.com/Sshindraa/Sokar/blob/b7d14da15777e8aab074859b519387bffdc32687/apps/dashboard/src/app/pricing/page.tsx#L314
