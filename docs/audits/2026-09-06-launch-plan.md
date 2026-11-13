# Plan de lancement commercial Suppernote — 10 premiers restaurants

Date du plan initial : 6 septembre 2026
Statut : **HISTORIQUE — réconcilié le 15 septembre 2026**
Référence : [audit de préparation au lancement](/Users/hamza/Projects/Sokar/docs/audits/2026-09-06-launch-readiness.md)
Backlog opérationnel : [tickets de phase 0](/Users/hamza/Projects/Sokar/docs/audits/2026-09-07-phase-0-backlog.md)

> Les phases, durées, prix et références de production de ce plan sont ceux du
> cadrage initial. Pour l'état réellement livré, le profil `core-operator-foundations`,
> le gel commercial 199/299 et les prochaines actions, consulter la
> [réconciliation courante des audits](./2026-09-15-current-state.md).

## Objectif et règle de décision

L’objectif est de transformer le socle actuel en un SaaS exploitable en production par les dix premiers restaurants, avec un lancement accompagné et une capacité de retour arrière. Le périmètre initial couvre le cœur fiable (réservation par téléphone, widget, tableau de bord, confirmation SMS et transfert humain) ainsi que les modules commerciaux que nous voulons proposer dès le premier lancement.

Le lancement commercial est autorisé seulement lorsque les critères de sortie de toutes les phases sont remplis. Une démonstration, un Checkout Stripe ouvert ou un appel de test ne valent pas validation de production. Toute fuite inter-restaurant, réservation perdue, facturation incohérente ou absence de restauration vérifiée remet le lancement en **NO-GO**.

## Périmètre des dix premiers clients

### Fonctionnalités incluses dans l’offre dès le premier lancement

- onboarding assisté d’un restaurant et vérification d’un appel réel ;
- numéro Telnyx dédié, agent vocal en français, collecte d’une réservation et transfert vers un humain ;
- widget/lien public de réservation et consultation côté restaurant ;
- gestion des créneaux, tables et statuts de réservation déjà supportés par le produit ;
- confirmation et rappel SMS lorsque le profil messagerie est validé ;
- abonnement mensuel Stripe, droits correspondant au plan acheté et support humain réactif ;
- gestion multi-site avec accès et facturation par établissement ;
- réservations depuis ChatGPT et Claude, avec parcours public, consentement et reprise humaine ;
- domaine personnalisé pour la page et le widget du restaurant ;
- cartes cadeaux avec émission, utilisation, remboursement et rapprochement ;
- fonctionnalités prédictives avancées, présentées avec leurs limites et leur niveau de confiance ;
- facturation annuelle avec prix, prorata, renouvellement et facture explicites ;
- argumentaire « sans limite » ou « taux garanti » uniquement sous la forme d’une politique d’usage/SLA mesurable et contractuelle ;
- journalisation, sauvegardes, alertes et procédure de rollback documentées.

Ces modules ne sont donc plus hors argumentaire : ils font partie du catalogue commercial dès l’ouverture. Chaque module doit toutefois être activable avec un parcours vérifié, un propriétaire et une preuve de fonctionnement ; une fiche commerciale ne doit pas transformer une capacité non testée en garantie implicite.

### Garde-fous de validation de l’offre élargie

| Module proposé dès le lancement    | Validation obligatoire avant activation client                                                                                      | Preuve attendue                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Multi-site                         | modèle établissement/organisation, rôles, isolation des données, numéros et quotas par site, tableau consolidé                      | deux sites d’un même compte + deux comptes distincts testés ; facture et droits corrects |
| ChatGPT/Claude                     | parcours public, authentification/consentement, outils idempotents, limitation de débit, refus inter-restaurant et transfert humain | réservation de bout en bout depuis chaque canal, avec rejeu et incident provider         |
| Domaine personnalisé               | DNS guidé, certificat TLS, renouvellement, suppression et fallback du domaine Suppernote                                            | domaine de test servi en HTTPS, renouvellement/erreur documentés                         |
| Cartes cadeaux                     | ledger immuable, paiement, émission, utilisation partielle, expiration, remboursement et rapprochement                              | émission → utilisation → remboursement rejoués en mode test puis contrôlés en live       |
| Prédictif avancé                   | données minimales, consentement, explicabilité, seuil de confiance, fallback manuel et mesure de précision                          | rapport sur un jeu tenu à part ; aucune décision irréversible sans validation humaine    |
| Facturation annuelle               | prix total, TVA/HT-TTC, prorata, renouvellement, annulation, facture et webhook idempotent                                          | cycle Stripe test complet, puis activation live sur un restaurant pilote                 |
| « Sans limite » / « taux garanti » | définition d’usage équitable ou SLA, métrique, exclusions, compensation et coût maximal                                             | texte contractuel, instrumentation et rapport mensuel avant toute garantie chiffrée      |

Le catalogue est affiché et présenté dès le jour 1. Pour chaque module, le contrat et l’onboarding indiquent son niveau réel — disponible, déploiement accompagné ou pilote — ainsi que la date et le périmètre convenus. Cette distinction conserve la fonctionnalité dans l’offre initiale tout en évitant de transformer une capacité non encore mesurée en garantie implicite.

## Référence de départ

La production auditée était le commit `b7d14da15777e8aab074859b519387bffdc32687`, identique à `main` sur GitHub et au VPS au moment de l’audit. Cette phrase et le worktree `/Users/hamza/Projects/Sokar/.worktrees/sokar-billing-10` décrivent le point de départ historique. La référence actuelle, le profil scoped déjà promu et les écarts encore ouverts sont dans la [réconciliation du 15/09](./2026-09-15-current-state.md). Le checkout local conserve ses modifications non publiées et ne constitue pas une preuve de production.

Les risques et preuves de départ sont dans l’[audit détaillé](/Users/hamza/Projects/Sokar/docs/audits/2026-09-06-launch-readiness.md) et ses fichiers de preuve. Ils comprennent notamment deux défauts P0 d’isolation, une attribution de plan contournable, des SMS non opérationnels, des alertes absentes, des événements Stripe non idempotents et des contrôles CI incomplets.

## Feuille de route

| Phase | But                                                        |        Durée indicative | Statut                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ---------------------------------------------------------- | ----------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Cadrage de l’offre, périmètre et préparation de la release |              0,5–1 jour | **EN COURS**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 1     | Isolation des tenants et autorisations serveur             |               2–4 jours | En cours — garde Clerk ajoutée sur l’administration des membres ; préflight fournisseur avec deux identités distinctes effectué ; une fenêtre staging sans démo a été tentée puis rollbackée : l’appel lecture seule à l’API Clerk a renvoyé HTTP 401 pour les secrets présents et le middleware a signalé `secret-key-invalid`. Le proxy Bearer est préparé localement ; il faut fournir une clé Clerk Development valide, ouvrir un mode sans démo protégé contre la promotion et rejouer l’inter-site |
| 2     | Parcours réservation, voix, SMS et support                 |               3–5 jours | À faire                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2B    | Modules commerciaux proposés dès le lancement              |               5–8 jours | En cours — multi-site créé, quota, suspension/réactivation, sélecteur et garde de principal codés ; membre réel, transfert staging et autres modules restent ouverts                                                                                                                                                                                                                                                                                                                                     |
| 3     | Stripe, droits et cycle d’abonnement                       |               2–3 jours | En cours — portail sandbox, rejeu webhook signé et quota validés depuis staging ; quatre prix annuels actifs en live/test et Checkout annuel testé ; facture, taxes, prorata et période de grâce à fermer                                                                                                                                                                                                                                                                                                |
| 4     | Observabilité, files, sauvegardes et reprise               |               2–3 jours | À faire                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5     | RGPD, contrats et surface commerciale                      | 2–4 jours, en parallèle | À faire                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6     | Qualification, CI et release candidate                     |               2–3 jours | À faire                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7     | Dogfood interne puis deux restaurants pilotes              |  7–10 jours calendaires | À faire                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 8     | Déploiement par vagues jusqu’à dix restaurants             |  7–14 jours calendaires | À faire                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

L’estimation ajustée représente environ 25 à 40 jours de développement, auxquels s’ajoutent les dépendances fournisseurs, la validation juridique et la période pilote. En travaillant seul, compter environ six à huit semaines ; avec deux personnes disponibles, réduire surtout les temps d’attente et de support.

## Phase 0 — Cadrage du lancement (**EN COURS**)

### Actions déjà faites

- [x] périmètre initial et modules de l’offre élargie listés ;
- [x] commit de production et état du VPS relevés ;
- [x] registre des risques créé dans l’audit, avec six reproductions locales des défauts ;
- [x] critères de sortie et séquencement interne → deux pilotes → dix restaurants définis ;
- [x] tickets LAUNCH-P0-01 et LAUNCH-P0-02 créés et premier correctif codé dans le worktree de lancement ;
- [x] lots LAUNCH-P1-03 et LAUNCH-P1-04 implémentés localement : plan protégé par Billing, Checkout idempotent et ledger Stripe ordonné ;
- [x] release `main@d53916c` déployée après CI, smoke, rollback/restauration et E2E staging verts ; preuves multi-site et portail consignées.
- [x] administration membre durcie : l’identité cible doit appartenir à l’organisation Clerk avant toute écriture locale ; tests d’acceptation, refus sans écriture et indisponibilité du fournisseur ajoutés.
- [x] statut du site principal durci : suspension/archivage transfère `isPrimary` au plus ancien site actif dans une transaction ; le dernier principal reste refusé ; tests ajoutés.
- [x] quatre prix Stripe annuels actifs en live et en test ; le parcours Checkout annuel est couvert par un test de cadence et de prix.

### Actions restantes

- [x] créer un worktree dédié basé sur `b7d14da` et une branche de lancement dédiée (`.worktrees/sokar-billing-10`, `codex/phase-0-ops`) ;
- [x] convertir chaque risque P0/P1 en ticket avec propriétaire, date cible, preuve attendue et niveau de rollback (backlog phase 0 créé ; dates et pilotes restent à renseigner) ;
- [x] attribuer à chaque module commercial un propriétaire, un prix, une porte d’activation et une preuve de démonstration ([registre commercial](/Users/hamza/Projects/Sokar/docs/audits/2026-09-07-phase-0-commercial-register.md)) ; les dépendances externes et la cohorte restent ouvertes ;
- [ ] nommer les responsables produit, API, dashboard, voix/SMS, infra, juridique et support (une personne peut cumuler plusieurs rôles) ;
- [ ] confirmer les dépendances externes : profil de messagerie Telnyx et numéro émetteur, Sentry et canal d’alerte, taxes/TVA, identité légale et DPA, comptes Google nécessaires ; les prix annuels et le Billing Portal sandbox sont validés ;
- [ ] choisir les dix restaurants, leur ordre de cohorte, la date de l’appel d’onboarding et le canal de support ;
- [ ] publier une fiche de release avec commit, variables attendues, migrations, smoke tests, rollback et décisionnaire GO/NO-GO.

### Livrables et sortie de phase

Livrables : ce plan, un catalogue commercial initial, un tableau de tickets priorisés, une matrice des rôles, la liste des dépendances externes et une fiche de release candidate. La phase 0 est terminée lorsque le worktree propre existe, que chaque ticket et module a un propriétaire et que les dix restaurants ainsi que le premier pilote sont identifiés. Le worktree est prêt ; les propriétaires, dépendances et cohortes restent à renseigner. Aucun correctif ne doit partir en production avant ce point.

## Phase 1 — Sécurité et isolation des restaurants

### Objectif

Garantir qu’un utilisateur, une route publique ou un job ne peut ni lire ni modifier les données d’un autre restaurant, même s’il connaît un identifiant.

### Travaux

- définir le modèle d’autorisation : opérateur Suppernote global, propriétaire du restaurant, employé et lecture seule ;
- vérifier l’appartenance Clerk de toute identité ajoutée par l’administration avant de créer ou modifier une membership Suppernote ;
- ajouter une autorisation serveur explicite sur provisioning, santé, restaurants, réservations, appels, floor plan, exports et endpoints admin ; ne jamais considérer l’identifiant d’URL comme preuve d’appartenance ;
- retirer `plan` des mutations accessibles au client et faire des droits une projection serveur de l’abonnement Stripe ;
- rendre la création publique de réservation liée à un contexte vérifiable (restaurant, jeton public ou session) et à une clé d’idempotence ; vérifier l’appartenance du `callId` avant tout rejeu ;
- ajouter limitation de débit, journal d’audit pour les opérations sensibles et réponses qui n’exposent pas l’existence d’un tenant ;
- tester avec deux organisations Clerk réelles ou des fixtures d’autorisation équivalentes, plus tests de non-régression des six reproductions de l’audit.

### Livrables et sortie

Matrice d’autorisation, middleware réutilisable, tests négatifs inter-tenant, audit log et note de migration éventuelle. Sortie : aucun test inter-tenant ne passe, les routes publiques ne permettent ni rejeu ni énumération, et un opérateur autorisé conserve les opérations nécessaires.

## Phase 2 — Parcours cœur : voix, réservation, SMS et support

### Objectif

Prouver le parcours complet d’un appel jusqu’à une réservation exacte et une confirmation observable, avec transfert humain lorsque le système ne peut pas conclure.

### Travaux

- écrire le scénario de référence : appel entrant → date/heure/nombre de couverts → nom épelé et confirmé → disponibilité vérifiée → réservation idempotente → SMS ou alternative humaine ;
- valider Telnyx, ancien STT temps réel, LLM, Cartesia et les timeouts sur staging puis par appels réels ; suivre la latence par tour, les abandons et les erreurs de provider ;
- activer un profil messagerie Telnyx conforme, vérifier le numéro `from`, les statuts de livraison, les retries bornés et la dead-letter queue ; prévoir une confirmation vocale ou une tâche support si le SMS échoue ;
- contrôler fuseau horaire, horaires parlés, corrections, barge-in, double appel, annulation, no-show et transfert ;
- tester les écritures concurrentes et les rejoués webhook/outils ;
- préparer un script d’onboarding et une procédure de support en moins de quinze minutes pour les incidents courants.

### Livrables et sortie

Scénarios automatisés, rapport de dix appels internes puis appels pilotes, runbook Telnyx/SMS/voix et tableau de métriques. Sortie : aucun appel ne crée deux réservations, aucun appel ne confirme une disponibilité non vérifiée, les SMS de test sont livrés ou déclenchent le fallback, et un humain peut reprendre l’appel.

## Phase 2B — Modules commerciaux proposés dès le lancement

### Objectif

Transformer chaque promesse commerciale en parcours produit testable, observable et réversible. Les modules sont annoncés dès le lancement, mais leur activation est pilotée par un feature flag ou une configuration de cohorte tant que la preuve de sortie n’est pas signée.

### Travaux par module

- **Multi-site :** modéliser organisation → établissements, droits par site, numéros et horaires propres, vue consolidée, quotas et facturation ; tester l’ajout, la suspension, le transfert du principal et la suppression d’un site sans fuite de données.
- **ChatGPT/Claude :** stabiliser le contrat de réservation, l’authentification et le consentement, les outils idempotents, le rate limiting, les erreurs de provider et le transfert humain ; rejouer une réservation depuis chaque canal.
- **Domaine personnalisé :** automatiser la vérification DNS, le certificat TLS, le renouvellement, la suppression et le fallback vers le domaine Suppernote ; mesurer le délai de mise en service et les erreurs de configuration.
- **Cartes cadeaux :** finaliser le ledger immuable, les états émis/partiellement utilisés/épuisés/expirés, le paiement, le remboursement, les emails/SMS et le rapprochement comptable ; interdire les doubles utilisations concurrentes.
- **Prédictif avancé :** définir les sorties réellement utiles (prévision de no-show, charge ou créneau), les données minimales, le consentement, l’explication et le seuil de confiance ; garder une décision manuelle lorsque le modèle est incertain.
- **Facturation annuelle :** les quatre prix Stripe sont actifs en live et en test et Checkout sélectionne le prix annuel avec la bonne cadence ; il reste à rejouer le cycle complet avec facture, taxes, prorata, renouvellement, annulation, échec de paiement et webhooks dans le même modèle idempotent que le mensuel.
- **« Sans limite » / « taux garanti » :** remplacer le slogan générique par une politique d’usage équitable ou un SLA mesuré, instrumenté et compensable ; le texte commercial et le contrat doivent employer exactement les mêmes seuils.

### Livrables et sortie

Pour chaque module : fiche de valeur, parcours de démonstration, propriétaire, feature flag, métriques, runbook support, tests négatifs et plan de rollback. Sortie : chaque fonctionnalité annoncée peut être démontrée sur un environnement propre, les erreurs sont visibles, l’activation peut être limitée aux pilotes et aucune option ne contourne l’isolation ou les droits Stripe.

## Phase 3 — Stripe, droits et abonnement

### Objectif

Faire correspondre sans ambiguïté le paiement, l’abonnement et les droits applicatifs, y compris en cas de retry, d’événement inversé ou de paiement échoué.

### Travaux

- rendre la création Checkout idempotente par restaurant et période ; ajouter des contraintes uniques sur session, abonnement et événement Stripe ;
- persister les événements traités et ignorer proprement les doublons ou événements anciens ; vérifier signature, environnement et montant/price attendu ;
- calculer les droits côté serveur à partir de l’état Stripe, sans accepter un plan dans un PATCH restaurant ;
- brancher le portail client, l’annulation, la période de grâce, l’échec de paiement et la révocation des droits ;
- tester en mode Stripe test puis en live contrôlé : activation, renouvellement, annulation, événement hors ordre et reprise après panne. Le staging a validé le rejeu signé d’un événement `customer.subscription.updated` deux fois (200 à chaque fois), ainsi que le rejet d’une signature invalide (400), sans paiement supplémentaire.

Les quatre prix annuels configurés sur le VPS sont actifs en production (mode live) et staging (mode test), et le test API dédié vérifie que `billing=annual` sélectionne le bon prix et transmet la cadence Checkout. La facture annuelle, les taxes, le prorata, le renouvellement et la période de grâce restent à rejouer.

### Livrables et sortie

Matrice plan → droits, journal des événements, runbook billing et preuve d’un abonnement test complet. Sortie : une seule souscription active par restaurant, les droits se révoquent selon la politique publiée, et aucun événement ancien ne peut restaurer un accès supprimé.

## Phase 4 — Opérations, observabilité et reprise

### Objectif

Détecter rapidement un incident et restaurer le service ou les données avec un délai connu.

### Travaux

- configurer Sentry (API, dashboard, jobs) et un canal d’alerte testé ; ajouter uptime externe pour `/livez` et `/health` sans exposer de secrets ;
- instrumenter files BullMQ, retries, dead-letter, Telnyx webhooks, SMS, Stripe et appels avec identifiants corrélables mais PII masquées ;
- compléter l’environnement watchdog et ses seuils : API, files bloquées, mémoire, disque, erreurs provider et backups ;
- documenter déploiement, smoke tests, rollback applicatif et rollback base de données ;
- réaliser un exercice de restauration à partir du dump et de la copie externe, puis mesurer RPO/RTO ;
- exécuter un test de charge borné pour dix appels simultanés et vérifier les limites du VPS.

### Livrables et sortie

Dashboard d’alertes, runbooks incident/rollback/backup, rapport de restauration et capacité mesurée. Sortie : une alerte volontaire arrive au bon canal, la restauration est reproductible, le RPO/RTO est écrit et aucun job critique ne reste silencieusement en dead-letter.

## Phase 5 — RGPD, contrats et promesse commerciale

### Objectif

Rendre l’offre vendable avec une identité légale, des obligations RGPD et des promesses cohérentes avec le comportement réellement mesuré.

### Travaux

- établir la cartographie des données, bases légales, sous-traitants, durées de conservation et accès internes ;
- compléter export/effacement pour email, profil client, transcription, audio, appels, réservations et journaux selon la politique retenue ; ajouter l’exécution planifiée et la preuve de fin ;
- finaliser mentions légales, politique de confidentialité, CGV/CGU, DPA restaurant, sous-traitants et procédure de demande ; remplacer les liens `#`, chiffres non prouvés et témoignages non validés ;
- aligner prix, périodicité et taxes entre site, Stripe, contrat et facture ;
- écrire les limites du service : langue, horaires, transfert humain, SMS dépendant du fournisseur, conservation audio et support.

### Livrables et sortie

Pack juridique publié, registre de traitements, procédure d’effacement testée et pages commerciales relues. Sortie : un restaurant peut signer et comprendre le prix, les données et les limites ; une demande RGPD laisse une preuve vérifiable sans données résiduelles hors rétention autorisée.

## Phase 6 — Qualification, CI et release candidate

### Objectif

Empêcher qu’une livraison verte masque un parcours critique absent, ignoré ou testé uniquement par mock.

### Travaux

- activer les tests d’intégration PostgreSQL dans un service CI reproductible, ou publier une justification et une vérification équivalente bloquante ;
- retirer les `|| true` des E2E staging et inclure le smoke Connect ; faire échouer la release sur migration, smoke, health, typecheck, lint et build ;
- ajouter les tests d’autorisation, idempotence, Stripe, SMS et restauration dans la suite requise ;
- traiter ou accepter explicitement les alertes Dependabot avant la release ; conserver CodeQL et les secrets hors dépôt ;
- générer une release candidate immuable avec changelog, variables, migrations, checksums et plan de rollback.

### Livrables et sortie

Pipeline obligatoire, rapport CI, release candidate et checklist signée. Sortie : aucun contrôle critique n’est ignoré, les migrations sont testées, staging reproduit le parcours de production et la release peut être restaurée.

## Phase 7 — Dogfood interne et deux restaurants pilotes

### Objectif

Observer le produit avec de vrais appels et un support rapproché avant de multiplier les incidents.

### Travaux

- faire tourner Chez Suppernote et un restaurant interne pendant au moins cinq jours ouvrés ;
- utiliser un script d’onboarding identique, enregistrer les incidents et faire une revue quotidienne des appels ;
- onboarder deux restaurants pilotes avec accord explicite, prix pilote et canal d’escalade ;
- recueillir les réservations manquées, corrections de nom, délais, SMS, transferts et compréhension du dashboard ;
- corriger seulement les défauts bloquants ou récurrents liés au périmètre gelé, puis rejouer la release candidate.

### Livrables et sortie

Journal des incidents, comptes rendus d’appels, rapport de métriques et décisions de correction. Sortie : sept jours sans P0, aucune donnée croisée, réservations vérifiées par échantillon, SMS opérationnels et support capable de traiter un incident le jour même.

## Phase 8 — Déploiement par vagues jusqu’à dix

### Objectif

Passer à dix restaurants sans perdre la capacité de support, de mesure ou de rollback.

### Séquence

1. **Vague 1 :** deux pilotes, observation 5 à 7 jours.
2. **Vague 2 :** trois restaurants supplémentaires, observation 72 heures avant la suite.
3. **Vague 3 :** cinq derniers restaurants, onboarding par créneaux et revue quotidienne la première semaine.

Chaque restaurant reçoit un compte vérifié, la configuration de ses horaires/tables, un appel de qualification, une réservation de bout en bout et la procédure de contact support. Les cohortes sont gelées si un seuil d’arrêt est atteint.

### Livrables et sortie

Fiche d’onboarding par restaurant, tableau de bord de cohorte, rapport à J+1/J+3/J+7 et décision de stabilisation. Le lancement des dix est validé après quatorze jours sans incident critique et avec des métriques au-dessus des seuils définis ci-dessous.

## Les 48 prochaines heures

1. [x] Ouvrir le worktree de lancement depuis `b7d14da` sans toucher aux modifications locales.
2. [x] Créer les tickets P0-01 et P0-02, joindre les six reproductions et définir le test de sortie de chacun.
3. [ ] Obtenir la confirmation Telnyx messagerie, Sentry/uptime, Stripe Portal et documents légaux.
4. [ ] Fixer les propriétaires, dates cibles et portes d’activation de chaque module, puis les créneaux d’appels de qualification.
5. [ ] Sélectionner les deux pilotes et envoyer la fiche d’onboarding/support.
6. [ ] Préparer la matrice d’autorisation et le scénario de référence voix → réservation → SMS.

## Définition opérationnelle de « prêt à lancer »

Le GO nécessite toutes les conditions suivantes :

- zéro fuite inter-tenant dans les tests positifs et négatifs ;
- parcours appel, disponibilité, réservation, confirmation et transfert validé sur staging et en réel ;
- SMS livré ou fallback tracé, queues sans erreur critique persistante ;
- Checkout, webhook, droits, annulation et période de grâce testés ;
- Sentry, uptime, alertes, backup restauré et rollback testés ;
- RGPD, mentions, CGV, DPA, prix et limites publiés ;
- multi-site, ChatGPT/Claude, domaine personnalisé, cartes cadeaux et prédictif démontrés avec leurs contrôles d’accès et leurs métriques ;
- facturation annuelle testée de bout en bout, et politique « sans limite »/SLA garantie mesurable et contractuelle ;
- CI bloquante sans test critique ignoré ;
- deux pilotes observés au moins sept jours et support en mesure de répondre le jour même ;
- release, variables et décisionnaire GO/NO-GO documentés.

## Indicateurs et seuils d’arrêt

Suivre par restaurant et globalement : appels répondus, réservations confirmées, taux de correction humaine, réservations dupliquées/perdues, latence du premier audio, SMS livrés, erreurs provider, jobs en dead-letter, uptime, tickets support et paiements actifs.

Arrêter la cohorte immédiatement en cas de fuite de données, réservation perdue ou dupliquée, plan accordé sans paiement, perte de webhook critique, restauration impossible ou alerte non reçue. Revoir la cohorte si le taux de SMS échoués dépasse 5 %, si un incident vocal bloque plus de 5 % des appels, si une file critique reste en échec plus de quinze minutes ou si le support ne répond pas dans la journée. Ces seuils sont les garde-fous initiaux ; les métriques réelles des deux pilotes pourront les resserrer avant la vague suivante.
