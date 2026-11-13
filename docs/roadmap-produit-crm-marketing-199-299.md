# Plan de bataille Suppernote — offres 199/299 € et trajectoire CRM/marketing

Date de référence : 15 septembre 2026
Statut : plan directeur, blueprint technique et registre d'exécution local
Horizon indicatif : 6 à 9 mois pour une suite solide destinée aux indépendants ; 12 à 18 mois pour approcher la largeur fonctionnelle de SevenRooms
Hypothèse de capacité : un développeur principal à temps plein, Hamza disponible pour les décisions produit, les pilotes et les validations terrain

> Le catalogue local et Stripe (test et live) facturent Essential 199 € et Pro 299 € HT/mois
> (contrôle du 16 octobre 2026, voir [`runbooks/stripe-billing.md`](./runbooks/stripe-billing.md)).
> L'ouverture commerciale complète reste soumise aux portes ci-dessous. Le
> profil scoped `core-operator-foundations` a toutefois été promu pour les fondations sûres ;
> le gel de l'offre complète reste actif. La réconciliation des audits et le statut consolidé
> de la documentation se trouvent dans [`audits/2026-09-15-current-state.md`](./audits/2026-09-15-current-state.md)
> et [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).
>
> **Gel de production commerciale :** les lots décrits ici peuvent être développés et vérifiés
> localement, puis promus uniquement via un profil scoped explicite. Aucune ouverture complète
> 199/299 n'est autorisée avant la clôture de toutes les portes P0 à P9, du pilote et du gel
> explicite dans [`product-gates.json`](./release/product-gates.json). Le profil
> `core-operator-foundations` déjà promu ne déverrouille ni le checkout ni les fournisseurs.

### Registre d'exécution local — 14 septembre 2026 (snapshot ; statut courant dans la réconciliation du 15/09)

| Lot                   | État local      | Preuve actuelle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Suite / reste avant clôture                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 usage/outbox       | `LIVRÉ LOCAL`   | ledger, tarifs versionnés, import CSV/JSON dry-run avec détection de conflits/chevauchements, rapprochement facture read-only avec `reportHash`, ajustements `OPEN/APPROVED/REJECTED` idempotents, marge ajustée par corrections approuvées, export comptable CSV borné avec corrections globales `UNALLOCATED`, paquet comptable fichier séparant l'usage EUR des factures fournisseur, dispatcher, collecteurs messagerie, suivi interne optionnel 70/90/100 % et test PostgreSQL de concurrence exécuté (2/2 sur base dédiée)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | preuve Telnyx d'août et paquet MRC USD conservés ; le cockpit admin affiche le suivi par établissement, les coûts et la marge ; le raccordement comptable et l'écart Telnyx de mai sont différés comme suivis internes ; aucun quota ni donnée de coût n'est exposé au restaurateur                                                                                                                                                   |
| P1 Essential          | `PARTIEL`       | entitlements, compteurs et protections existants, catalogue local 199 € sur constantes/UI/ROI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | deux pilotes Essential et sept jours de métriques ; état Stripe et checkout : [runbook facturation](./runbooks/stripe-billing.md)                                                                                                                                                                                                                                                                                                     |
| P2 CRM                | `PARTIEL LIVRÉ` | identités, timeline, RFM, préférences/tags, backfill, dual-write, API + UI CRM, export RGPD vérifié, réparation de projection, audit de fusion et masquage des notes/métadonnées par rôle, avec surcharge configurable par établissement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | preuve PostgreSQL ; fournisseur POS métier et dépense réelle restent dans P6                                                                                                                                                                                                                                                                                                                                                          |
| P3-01 segments        | `LIVRÉ LOCAL`   | AST borné, compiler, preview/CRUD/refresh, constructeur Pro, explication UI et huit segments système seedés à la demande                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | preuve PostgreSQL concurrente du seed et campagne pilote                                                                                                                                                                                                                                                                                                                                                                              |
| P3-02/04/05 campagnes | `PARTIEL LIVRÉ` | audience snapshot, permissions, suppressions, worker, fixtures de contrat, callbacks signés Telnyx/Resend, schedule, preview, éditeur, dry-run, estimation tarifée depuis `UsageTariff` quand disponible, readiness avec diagnostic sans secrets, rapport/export CSV et inbox de réconciliation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | configuration effective provider, domaine email, templates WhatsApp, rapprochement des coûts réellement consommés                                                                                                                                                                                                                                                                                                                     |
| P3-03 automations     | `PARTIEL LIVRÉ` | config bornée, claims PostgreSQL, campagnes snapshot, scan horaire, interface dashboard, migration de la réactivation historique, transitions callbacks et worker de réconciliation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pilote et activation fournisseur                                                                                                                                                                                                                                                                                                                                                                                                      |
| P4 attribution        | `PARTIEL LIVRÉ` | liens HMAC, clic, parcours `/book`, conversions créée/honorée/annulation, rapport API et export CSV agrégé                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pilote, comparaison temporelle et preuve de revenu                                                                                                                                                                                                                                                                                                                                                                                    |
| P5–P9                 | `PARTIEL LOCAL` | fondations paiements, POS, CRM groupe, réputation, fidélité simple, expériences, événements et distribution provider-neutral livrées derrière flags : policies versionnées et transitions idempotentes ; `PosConnection`/`PosCheck`/`ReservationCheckMatch` avec import/matcher explicables ; `CustomerGroupProfile`/`CustomerGroupMembership` avec consentement, isolation compte/site, rattachement idempotent et téléphone masqué ; demandes de retour post-visite, score, tâches de récupération ; `LoyaltyBenefit`/`LoyaltyGrant` avec règles, code hashé, consommation et expiration ; `Experience`/`ExperienceSession`/`ExperienceReservation` avec snapshot prix, verrou de capacité, annulation et expiration ; `Event`/`EventSession`/`EventTicketType`/`EventOrder`/`EventTicket`/`EventWaitlistEntry` avec jauge transactionnelle, tickets hashés, check-in et traces locales ; `DistributionConnection`/`DistributionSyncRun`/`DistributionAvailabilitySnapshot`/`DistributionReservationLink`/`DistributionWebhookEvent` avec secrets référencés, hashes, idempotence et dashboard de qualification | choisir le modèle marchand et le fournisseur, secret manager, sandbox/webhooks, réconciliation 30 jours, holds/captures/remboursements réels, POS métier, preuves multi-identité Clerk, synchronisation inter-sites et exploitation groupe, fournisseurs d'avis, envoi/points fidélité, widget/téléphone, paiement et distribution événementiels, facture fiscale, adaptateur et API partenaires, workers externes et preuves terrain |

## 1. Décision produit

Actualisation du 29 octobre 2026 : Suppernote est une plateforme de réservations, d'organisation du
service et de relation client. Les objectifs ci-dessous décrivent des chaînes de valeur à qualifier,
pas une garantie de résultat. La [carte produit](./PROJECT_MAP.md#ce-quest-sokar) distingue les
capacités déjà développées de leur ouverture effective.

Suppernote ne doit pas attendre d'égaler SevenRooms pour facturer 199 ou 299 € par mois. Le prix doit être justifié par deux résultats simples et mesurables :

- **Essential — 199 € HT/mois/établissement** : réunir les réservations dans un planning commun et aider l'équipe à préparer le service, avec un assistant vocal pour les appels transférés après qualification.
- **Pro — 299 € HT/mois/établissement** : développer une connaissance client exploitable, des relances ciblées et leur suivi, sous réserve d'activation et de qualification des parcours.

La trajectoire comprend aussi la caisse, le revenu réel, la protection bancaire, le marketing avancé,
le CRM groupe, la réputation, la fidélité, les expériences, les événements et les intégrations.
Des fondations sont déjà développées pour plusieurs de ces domaines ; leur présence dans le code ne
signifie pas que les fournisseurs, les pilotes ou les parcours commerciaux sont ouverts.

La priorité n'est donc pas le nombre de fonctionnalités. Elle est la fermeture complète de chaînes de valeur :

```text
Essential
appel ou widget → disponibilité fiable → réservation → rappel → service → résultat visible

Pro
interaction → profil enrichi → segment → campagne → réservation → visite → résultat attribué

Avec caisse
visite → ticket de caisse → dépense client → segment de valeur → campagne → revenu encaissé attribué
```

## 2. État réel de départ

### 2.1 Ce qui existe déjà

| Domaine      | Socle existant                                                                                                       | Source principale                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Réservations | Réservation voix, web et agentique, disponibilité, holds, idempotence, états et audit                                | `apps/api/src/modules/reservations/`, `apps/api/src/modules/agentic-reservations/`                                          |
| Téléphone IA | Telnyx Media Stream, STT ElevenLabs, LLM, TTS Cartesia, transfert humain, télémétrie de latence                      | `apps/api/src/modules/voice/`                                                                                               |
| Salle        | Plan de salle, tables, allocation, walk-ins, service live et liste d'attente                                         | `apps/api/src/modules/floor-plan/`                                                                                          |
| Client       | Nom, téléphone, visites, VIP, notes, occasion, dernier appel, groupe habituel                                        | `apps/api/src/modules/customers/` et modèle `Customer`                                                                      |
| Réactivation | Détection hebdomadaire des VIP inactifs 90–180 jours, validation gérant, migration vers campagne marketing gouvernée | `apps/api/src/shared/queue/workers/reactivation.worker.ts`, `apps/api/src/modules/marketing/legacy-reactivation.service.ts` |
| Consentement | Opt-in marketing, retrait, export et effacement RGPD                                                                 | `apps/api/src/modules/rgpd/` et modèle `CustomerConsent`                                                                    |
| Analyse      | Appels, réservations, couverts, revenu estimé, latence, économie de commission estimée                               | `apps/api/src/modules/analytics/`                                                                                           |
| Multi-site   | Compte, établissements, rôles, sélection de site, quantité facturée                                                  | modèles `RestaurantAccount*` et routes associées                                                                            |
| Paiement     | Stripe Billing pour Suppernote et Stripe pour les cartes cadeaux                                                     | `apps/api/src/modules/billing/`, `apps/api/src/modules/gift-cards/`                                                         |

### 2.2 Limites à ne pas masquer commercialement

- Le noyau CRM local possède maintenant identités, chronologie, indicateurs RFM, préférences, tags,
  segments bornés et une interface de détection/preview/fusion. La fondation POS et le socle CRM
  groupe sont livrés, mais aucun fournisseur métier ni dépense réelle n'est encore raccordé et
  aucune identité inter-sites n'est encore activée.
- La réactivation historique reste un scénario unique, réservé aux VIP et semi-automatique. Le
  moteur local branche maintenant première visite, dormant et anniversaire avec claims
  PostgreSQL ; la validation legacy migre désormais vers une campagne snapshot gouvernée et le
  vieux worker ne peut plus appeler un provider directement. Les callbacks et l'activation
  fournisseur restent ouverts. Les callbacks avec identifiant provider inconnu sont conservés dans
  une inbox interne sans PII, réessayés toutes les cinq minutes et peuvent être ignorés avec une
  raison opérateur bornée.
- Le revenu affiché est souvent estimé à partir du ticket moyen. Il ne correspond pas à un encaissement observé.
- `CallQuota` compte les appels. Il ne mesure pas la durée, les coûts STT/LLM/TTS, les SMS ni les dépassements facturables.
- Aucun fournisseur de caisse métier n'est encore branché : la fondation POS reste provider-neutral
  (contrat, persistance, import local et matcher), avec `POS_CONNECTORS_ENABLED=false`.
- Les canaux partenaires ont une fondation provider-neutral (connexion, snapshots de disponibilité,
  runs idempotents, liens de réservation et inbox webhook hashée) et une page de qualification ;
  aucun adaptateur Google/Meta, secret manager, webhook public ou appel fournisseur n'est actif,
  avec `DISTRIBUTION_ENABLED=false`.
- La protection bancaire possède maintenant une fondation locale provider-neutral (policy versionnée,
  préparation idempotente, transitions, événements hashés et webhook signé), mais aucun compte
  marchand Stripe, SetupIntent/PaymentIntent réel, hold de capacité ou remboursement n'est actif ;
  `RESERVATION_PAYMENTS_ENABLED=false`.
- Stripe pour les cartes cadeaux ne constitue pas un parcours d'empreinte bancaire ou d'acompte de réservation.
- Le multi-site possède désormais un socle de groupes client explicite (consentement, liens
  idempotents, clé compte/client unique et masquage du téléphone), mais l'isolation avec plusieurs
  identités Clerk réelles, l'effacement inter-sites et les campagnes consolidées restent à valider.
- Le catalogue Essential 199 €, Pro 299 € et Multi-site 299 € + 99 €/site (remise annuelle 10 %)
  est aligné entre le code et les huit prix Stripe test et live depuis la grille du 14 octobre 2026 ;
  Checkout et facture test rejoués le 16 octobre. Les contrats restent à aligner.

## 3. Périmètre commercial cible

### 3.1 Essential — porte de mise en vente à 199 €

Essential est vendable lorsque tous les éléments suivants fonctionnent de bout en bout :

1. accueil téléphonique 24/7 avec transfert ou solution de secours ;
2. création, modification et annulation de réservation ;
3. disponibilité et capacité cohérentes sur tous les canaux ;
4. planning et plan de salle utilisables pendant un service ;
5. confirmation/rappel avec visibilité des échecs ;
6. widget direct sans commission ;
7. fichier client, notes et historique de base ;
8. onboarding reproductible ;
9. mesure des appels, minutes, réservations et coûts directs ;
10. facturation 199 € cohérente sur toutes les surfaces.

### 3.2 Pro — porte de mise en vente à 299 €

Pro devient vendable comme offre supérieure lorsque le client peut :

1. reconnaître un habitué et consulter une chronologie utile ;
2. filtrer les clients par récence, fréquence, comportement et valeur estimée ;
3. enregistrer des préférences structurées et des tags ;
4. lancer au moins trois scénarios de relance ;
5. respecter automatiquement consentement, désinscription et pression marketing ;
6. voir les messages délivrés, les réservations attribuées et les visites honorées ;
7. bénéficier d'un volume voix supérieur et d'un support prioritaire défini ;
8. distinguer revenu estimé, revenu réservé et revenu encaissé.

La connexion caisse, l'empreinte bancaire et le CRM groupe peuvent ensuite renforcer Pro ou devenir des options. Ils ne doivent pas retarder la première version cohérente de Pro.

## 4. Règles d'exécution

Chaque lot respecte les règles suivantes :

- migration Prisma additive et réversible ; aucune rupture d'API ou de schéma sans décision explicite ;
- fonctionnalité nouvelle sous feature flag par établissement ;
- écriture métier idempotente ;
- Postgres comme source de vérité, Redis uniquement pour cache, verrous courts et files ;
- événement d'audit pour toute mutation commerciale ou financière ;
- aucune PII dans les métriques, logs ou labels ;
- consentement vérifié au moment de l'envoi, même si l'audience a été calculée auparavant ;
- états explicites et relançables pour tout appel fournisseur ;
- activation sur un restaurant interne, puis deux pilotes, puis dix établissements ;
- instrumentation et critères d'acceptation livrés avec la fonction ;
- documentation de support et rollback avant production générale.

## 5. Vue d'ensemble des phases

| Phase                        | Durée indicative | Résultat commercial              | Dépendances majeures                     |
| ---------------------------- | ---------------: | -------------------------------- | ---------------------------------------- |
| 0. Mesure et contrat d'offre |     1–2 semaines | Prix et limites défendables      | Coûts fournisseurs, Stripe test          |
| 1. Essential irréprochable   |     3–5 semaines | Offre 199 € vendable             | Pilotes, appels réels, alerting          |
| 2. CRM Pro                   |     4–6 semaines | Connaissance client exploitable  | Schéma client, règles de fusion          |
| 3. Segments et campagnes     |     5–7 semaines | Offre 299 € vendable             | Consentements, délivrabilité             |
| 4. Attribution et ROI        |     3–4 semaines | Valeur Pro démontrable           | Liens suivis, états de réservation       |
| 5. Protection bancaire       |     4–6 semaines | Réduction mesurable des no-shows | Stripe Connect/merchant model, juridique |
| 6. Première caisse           |    6–10 semaines | Valeur client et revenu réels    | Partenaire POS, API et sandbox           |
| 7. Groupe et multi-site      |     4–6 semaines | Offre groupes crédible           | Isolation Clerk, identité client groupe  |
| 8. Réputation et fidélité    |     5–8 semaines | Rétention et récupération client | Sources d'avis, règles d'avantages       |
| 9. Expériences et écosystème |   8–12+ semaines | Élargissement SevenRooms         | Paiements, distribution, partenaires     |

Les durées sont des ordres de grandeur pour une personne concentrée sur le produit. Elles excluent les délais de contrat, de certification ou d'accès aux API partenaires.

---

## 6. Phase 0 — Mesurer et figer le contrat des offres

**Objectif :** savoir ce que coûte chaque restaurant et ce que chaque formule autorise avant de modifier les prix publics.

### P0-01 — Comptabilité d'usage

Créer un ledger append-only `UsageEvent` ou équivalent avec :

- `restaurantId`, `accountId`, `occurredAt`, `category`, `provider` ;
- `callId`, `messageId` ou référence métier non sensible ;
- durée téléphonique facturée ;
- secondes STT et TTS ;
- tokens LLM entrée/sortie si le fournisseur les expose ;
- SMS/WhatsApp envoyés, segments et statut ;
- stockage audio utilisé ;
- coût fournisseur estimé en millièmes d'euro ;
- clé d'idempotence fournisseur.

Construire une agrégation mensuelle `UsageMonthlyRollup`, recalculable depuis le ledger. Le dashboard doit afficher l'usage sans exposer le détail interne des marges.

**Critères d'acceptation :**

- un appel complet génère une seule ligne par catégorie facturable ;
- un webhook ou job rejoué ne double pas l'usage ;
- le total mensuel peut être recalculé ;
- le coût d'un appel de test peut être rapproché des relevés fournisseurs ;
- les métriques internes donnent coût moyen/minute et coût par réservation aboutie.

### P0-02 — Entitlements et suivi opérationnel

Créer une configuration centralisée par plan :

- fonctionnalités activées ;
- promesse de consommation sans quota client ;
- rétention des appels/transcriptions ;
- niveau de support ;
- nombre d'établissements et utilisateurs.

Le ledger et le cockpit opérateur suivent les minutes, messages et coûts par restaurant. Un budget
interne de pilotage peut être ajouté séparément si nécessaire ; il ne doit jamais limiter un appel,
un SMS ou une réservation du client.

Ne pas disperser ces règles dans le dashboard et l'API. L'API décide ; l'interface affiche la décision.

**Décisions produit à prendre avec les données pilotes :**

- définition concrète du support prioritaire ;
- remise annuelle et conditions d'engagement ;
- budget interne de suivi et destinataires opérationnels, si l'équipe en a besoin ;
- règles de packaging si le coût p90 menace la marge, sans introduire de quota client implicite.

### P0-03 — Migration commerciale 199/299 €

**État local au 14 septembre 2026 :** le catalogue applicatif et les surfaces publiques sont
alignés sur Essential 199 € et Pro 299 € ; le mapping Stripe reste volontairement ouvert. Le script
`scripts/ops/sync-env.sh stripe-prices` ne crée pas de prix et ne vérifie pas leur montant : il ne fait
que recopier des identifiants `price_...` déjà validés dans l'environnement cible.

Mettre à jour dans une seule release coordonnée :

- constantes et mapping de prix ;
- page tarifaire et parcours d'inscription ;
- prix Stripe mensuels et annuels en test puis en production ;
- mapping des `priceId` et webhooks ;
- portail client, upgrade/downgrade et prorata ;
- calcul ROI et emails qui utilisent le prix du plan ;
- CGV, devis, facture et texte HT/TTC ;
- politique pour les clients existants : maintien de prix ou migration annoncée.

**Porte de sortie :** checkout, paiement, webhook rejoué, portail, passage Essential ↔ Pro, annulation et période de grâce validés en sandbox, sans double abonnement.

### P0-04 — Tableau de bord interne de marge

Créer une vue strictement interne :

- MRR par restaurant ;
- coût voix, messages, stockage et support imputable ;
- marge brute en euros et pourcentage ;
- consommation p50/p90/p99 ;
- alertes de dérive ;
- restaurants dépassant le budget de coût du plan.

Les corrections de rapprochement ne modifient jamais `UsageEvent` ni `UsageMonthlyRollup`. Une
correction `APPROVED` avec `restaurant:<id>` est ajoutée au champ `adjustedCostEur` du site et à sa
marge ; le coût brut `estimatedCostEur` et le nombre de corrections restent visibles pour audit.
Les corrections `global` sont conservées dans la file opérateur et ne sont pas réparties sans règle
d'affectation explicite. L'endpoint opérateur `/admin/usage/accounting-export.csv` fournit un CSV
versionné qui reprend les lignes d'usage agrégées et les corrections approuvées séparément ; une
correction globale y est marquée `UNALLOCATED` pour empêcher une écriture comptable implicite.

**Cible initiale à valider :** coût direct inférieur à 50 € pour Essential et 75 € pour Pro si l'objectif de marge brute est 75 %.

---

## 7. Phase 1 — Rendre Essential irréprochable

**Objectif :** vendre 199 € pour un service qui enlève réellement du travail à l'équipe.

### P1-01 — Matrice de conversations réelles

Transformer les cas courants en scénarios E2E reproductibles :

- réserver, modifier, annuler et confirmer ;
- correction de nom, date, heure et nombre de personnes ;
- créneau complet avec alternatives ;
- groupe supérieur à la limite ;
- retard, demande spéciale, accessibilité, allergie et événement privé ;
- bruit, silence, interruption, accent et changement de langue ;
- client déjà connu, homonyme et numéro masqué ;
- panne STT, LLM, TTS, Telnyx, Redis ou base ;
- transfert gérant disponible, absent ou numéro invalide ;
- appel coupé avant et après confirmation.

Le test doit vérifier la base, la capacité, l'audit, la notification et la réponse client. Les simulations automatisées complètent les appels réels ; elles ne les remplacent pas.

### P1-02 — Filet de sécurité téléphonique

- Définir un renvoi de secours par établissement.
- Déclencher le transfert quand Suppernote ne comprend pas après un nombre borné de tentatives.
- Afficher les appels échoués et l'action requise.
- Ajouter une alerte fournisseur et une procédure d'incident.
- Préserver la réservation confirmée même si l'envoi de confirmation échoue.
- Tester un déploiement avec un appel en cours ou documenter une fenêtre de drainage.

### P1-03 — Cohérence réservation, capacité et salle

- Unifier les règles de capacité utilisées par voix, widget, dashboard et MCP.
- Vérifier les conflits de table sous concurrence réelle Postgres.
- Rendre visibles les réservations sans table et leur résolution.
- Garantir que modification et annulation libèrent correctement capacité et holds.
- Fermer le parcours walk-in → table → libération.
- Vérifier les états terminaux et la projection legacy `status/state`.

### P1-04 — Notifications opérationnelles

- Définir les notifications obligatoires : confirmation, rappel, annulation et promotion de liste d'attente.
- Modéliser `PENDING`, `SENT`, `DELIVERED`, `FAILED`, `CANCELLED`.
- Enregistrer l'identifiant fournisseur et traiter les callbacks.
- Ajouter retry borné, dead-letter et action manuelle.
- Empêcher les rappels après annulation ou déplacement.
- Afficher l'échec dans le dashboard et permettre un renvoi sûr.

### P1-05 — Onboarding reproductible

Checklist par établissement :

1. horaires, fermetures et capacité ;
2. plan de salle et grandes tables ;
3. politique d'annulation et de groupe ;
4. FAQ, ton, langues et règles de transfert ;
5. numéro, renvoi et appel de test ;
6. widget et domaine ;
7. notifications et consentements ;
8. compte équipe et permissions ;
9. simulation d'un service ;
10. signature de mise en production.

Produire un score de préparation et interdire l'activation si un blocant critique subsiste.

### Porte de sortie Essential

- deux établissements pilotes ont réalisé sept jours incluant au moins deux services de pointe ;
- taux d'appels techniquement pris en charge ≥ 99 % hors panne opérateur documentée ;
- aucune réservation confirmée sans disponibilité vérifiée ;
- 100 % des erreurs de notification sont visibles ;
- tous les appels ont durée et coût attribués ;
- aucune fuite inter-établissement dans les tests d'isolation ;
- coût direct p90 compatible avec le plan ;
- runbook d'incident et renvoi de secours testés ;
- checkout 199 € validé.

---

## 8. Phase 2 — Construire le CRM utile de Pro

**Objectif :** passer d'un carnet de contacts à une mémoire client exploitable avant, pendant et après le service.

### P2-01 — Identité et déduplication

> **État local : PARTIEL LIVRÉ.** La détection, le preview, la mutation Owner, l'audit idempotent,
> l'interface doublons/fusion et la réparation Owner d'une projection métrique sont présents et
> testés. Le POS et la preuve PostgreSQL concurrente restent ouverts.

Faire évoluer le modèle sans casser la clé actuelle :

- conserver le téléphone normalisé comme identifiant fort local ;
- ajouter email normalisé et date d'anniversaire partielle ou complète ;
- ajouter `CustomerIdentity` pour plusieurs téléphones/emails si nécessaire ;
- enregistrer la provenance et la date de vérification ;
- détecter les doublons probables ;
- proposer une fusion manuelle avec aperçu ;
- conserver un journal de fusion et permettre une réparation administrative bornée et idempotente ;
- définir la règle multi-site avant toute fusion entre établissements.

Ne jamais fusionner automatiquement sur le nom seul.

### P2-02 — Chronologie client

> **État local : PARTIEL LIVRÉ.** Les dual-writes réservation/appel et la lecture tenant-scoped
> existent ; les événements de liste d'attente, carte cadeau et POS restent à raccorder.

Créer un flux `CustomerTimelineEvent` alimenté par :

- appel reçu et motif ;
- réservation créée, modifiée, annulée ;
- visite honorée ou no-show ;
- entrée/sortie de liste d'attente ;
- message transactionnel et marketing ;
- consentement donné ou retiré ;
- carte cadeau achetée ou utilisée ;
- plus tard, commande et paiement caisse.

La chronologie doit charger par pagination, masquer les données sensibles selon le rôle et distinguer événement métier et note humaine.

### P2-03 — Préférences et tags

> **État local : PARTIEL LIVRÉ.** Les routes, l'allow-list, la confiance, l'expiration, les garde-fous
> d'écriture Owner/Manager, l'édition depuis la fiche CRM et les tests existent. La lecture des notes
> et des métadonnées de chronologie est bornée par la politique effective du site, configurable via
> `GET/PATCH /crm/privacy`, avec fallback `CRM_SENSITIVE_NOTE_ROLES` (Owner + Manager par défaut).
> La preuve PostgreSQL concurrente reste à faire.

Ajouter :

- `CustomerTag`, `CustomerTagAssignment` ;
- tags manuels et automatiques identifiables ;
- préférences structurées : salle/terrasse, table favorite, allergies déclarées, accessibilité, langue, type d'occasion ;
- source, confiance, date de collecte et dernière confirmation ;
- expiration ou revalidation pour les données sensibles ou changeantes ;
- historique des modifications.

L'IA peut suggérer un tag depuis une conversation, mais une information sensible ne doit pas devenir automatiquement une vérité permanente sans règle explicite.

### P2-04 — Indicateurs RFM et comportementaux

> **État local : PARTIEL LIVRÉ.** La projection déterministe et le backfill dry-run existent ; la
> dépense caisse réelle et la validation concurrente PostgreSQL restent ouvertes.

Calculer de manière déterministe :

- récence de la dernière visite honorée ;
- fréquence de visites sur 30/90/365 jours ;
- couverts cumulés ;
- taux d'annulation et de no-show ;
- jour, service et taille de groupe habituels ;
- valeur estimée tant que la caisse n'est pas connectée ;
- valeur encaissée séparée après intégration caisse ;
- statut nouveau, actif, habitué, à risque ou dormant.

Le `loyaltyScore` actuel doit être documenté, recalculable et explicable, ou remplacé par des dimensions séparées.

### P2-05 — Interface CRM

> **État local : PARTIEL LIVRÉ.** Les pages liste, détail et doublons/fusion sont branchées sur
> l'API Pro et le preview de fusion ; la fiche client lance l'export RGPD après code SMS et
> télécharge le JSON contrôlé. La vérification et la réparation Owner d'une projection métrique
> sont aussi disponibles avec une clé d'idempotence et un marqueur de chronologie agrégé. Le
> masquage des notes et métadonnées est appliqué selon la politique du site, configurable par
> `GET/PATCH /crm/privacy`, avec fallback `CRM_SENSITIVE_NOTE_ROLES`, et couvert par des tests ;
> la preuve PostgreSQL reste ouverte.

Écrans minimum :

- liste clients avec recherche et filtres ;
- fiche client avec identité, consentements, indicateurs, préférences, tags et chronologie ;
- édition rapide pendant le service ;
- fusion de doublons ;
- export contrôlé depuis la fiche CRM après vérification ;
- journal indiquant qui a modifié quoi.

### Porte de sortie CRM

- le profil d'un client test réunit correctement appels, réservations et visites ;
- une fusion ne perd aucune réservation, consentement ou audit ;
- les indicateurs sont recalculables depuis les événements sources ;
- une préférence saisie est visible pendant le prochain appel/service ;
- les rôles non autorisés ne voient pas les notes sensibles ;
- export et effacement RGPD couvrent les nouveaux modèles.

---

## 9. Phase 3 — Segmentation, automatisations et campagnes

**Objectif :** rendre Pro à 299 € immédiatement compréhensible et actionnable.

### P3-01 — Moteur de segments

> **État local : LIVRÉ LOCAL.** L'AST Zod borné, le compilateur, le preview, le CRUD, le refresh,
> le constructeur dashboard Pro, l'explication lisible des règles et huit segments système à clé
> stable sont testés. Le seed est paresseux, idempotent et tenant-scoped lors de la lecture ; la
> preuve PostgreSQL concurrente et la campagne pilote restent à exécuter.

Commencer avec un constructeur borné, sans langage arbitraire :

- champs autorisés ;
- opérateurs typés ;
- groupes `ET` et `OU` limités ;
- aperçu du nombre de clients ;
- segment dynamique ou snapshot ;
- explication de l'inclusion d'un client ;
- exclusions globales de consentement et de pression marketing.

Segments fournis au lancement :

- première visite honorée récemment ;
- habitués avec au moins N visites ;
- VIP manuels ;
- absents depuis 60/90/120 jours ;
- anniversaire dans les 30 jours ;
- annulation récente sans nouvelle réservation ;
- clients du déjeuner ou du dîner ;
- clients avec no-show à exclure ou à traiter séparément ;
- gros dépensiers uniquement quand la donnée caisse est réelle.

### P3-02 — Modèle de campagne

> **État local : PARTIEL LIVRÉ.** Les campagnes, audiences snapshot, messages idempotents, états
> durables, worker, callbacks signés Telnyx/Resend et inbox de réconciliation sont présents ; la
> configuration provider et les preuves terrain restent ouvertes.

Créer des entités distinctes :

- `MarketingCampaign` : objectif, canal, segment, créateur, planning, statut ;
- `CampaignAudienceMember` : snapshot et raison d'inclusion ;
- `CampaignMessage` : rendu final, provider, état et coûts ;
- `CampaignConversion` : réservation/visite attribuée ;
- `MarketingSuppression` : refus global ou par canal ;
- `MarketingFrequencyWindow` : contrôle de pression.

États recommandés : `DRAFT`, `READY`, `SCHEDULED`, `SENDING`, `SENT`, `PAUSED`, `CANCELLED`, `FAILED`.

### P3-03 — Trois automatisations initiales

> **État local : PARTIEL LIVRÉ.** Les trois déclencheurs sont validés par type, évalués par un
> worker horaire et matérialisés en campagnes snapshot. Chaque couple automation/client/événement
> possède une claim unique PostgreSQL ; le flag fournisseur reste désactivé pendant le gel.

Le contrat d'exécution local est volontairement borné :

- `AFTER_FIRST_HONORED` sélectionne la première visite honorée après un délai configurable (0–168 h) ;
- `DORMANT` sélectionne un client dont la dernière visite honorée dépasse 30–365 jours et qui
  n'a pas de réservation future ;
- `BIRTHDAY` projette une fenêtre de 0–30 jours dans le fuseau configuré et respecte une heure
  locale minimale.

Le worker recontrôle contact, permission par canal, suppression et plafond de fréquence avant de
créer la campagne. Une campagne créée pendant une panne Redis reste `READY` et est ré-enfilée au
scan suivant lorsque les envois sont autorisés. Les claims restent uniques même si deux scans
concurrents créent temporairement une campagne vide, immédiatement marquée `CANCELLED`.

La réactivation historique est maintenant migrée vers ce modèle au moment de la validation gérant :
le snapshot legacy est lié à une `MarketingCampaign` par une clé unique et les messages passent par
le worker marketing. Le vieux job `reactivation.send` est conservé uniquement pour drainer des jobs
anciens ; il bloque toute tentative d'accès provider sans migration. Le scan legacy s'efface pour
un établissement dès qu'une automation `DORMANT` est activée, et la route refuse un snapshot PENDING
dans ce cas pour éviter deux campagnes concurrentes.

1. **Après première visite** : remerciement envoyé après passage en `HONORED`, jamais après annulation/no-show.
2. **Client dormant** : relance après X jours sans visite et sans réservation future.
3. **Anniversaire** : message dans une fenêtre configurable, avec année facultative et fréquence annuelle garantie.

La migration est transactionnelle, rejouable avec un identifiant de campagne déterministe et
protégée par `MARKETING_SENDS_ENABLED`. Les clients archivés, fusionnés ou d'un autre établissement
sont exclus du snapshot matérialisé ; le worker revalide ensuite consentement, suppression, contact
et plafond de fréquence juste avant Telnyx. La campagne legacy reste consultable dans l'ancien écran
avec l'état de la campagne marketing liée.

### P3-04 — Éditeur et prévisualisation

> **État local : PARTIEL LIVRÉ.** Le rendu allow-listé, la planification, le flag d'envoi, le
> rapport API, le preview serveur, l'éditeur dashboard de brouillon et le test gérant en dry-run
> sont livrés localement. Le preview utilise maintenant `UsageTariff` pour afficher un coût
> `PRICED` lorsque le tarif couvre la date d'exécution ; sans ligne validée, il reste
> `NOT_AVAILABLE`. L'envoi de test fournisseur, le rapprochement des consommations réelles et la
> validation terrain restent ouverts.

- modèles SMS puis email ;
- variables autorisées et fallback si une donnée manque ;
- rendu sur mobile ;
- estimation du coût avant programmation ;
- envoi test au gérant ;
- date, fuseau et fenêtre horaire ;
- validation explicite avant premier envoi massif ;
- pause immédiate ;
- page d'historique et détails des erreurs.

### P3-05 — Consentement et délivrabilité

> **État local : PARTIEL LIVRÉ.** Les permissions par canal, preuve hashée, suppression, plafond,
> désinscription signée, recontrôle avant provider, transitions callback bounce/complaint, la
> route de readiness sans secret et l'inbox de réconciliation des IDs inconnus existent ; la
> configuration effective et la synchronisation des listes restent ouvertes.

- séparer opt-in email, SMS et éventuellement WhatsApp ;
- conserver preuve, source, texte, version et horodatage ;
- vérifier l'opt-in au calcul de l'audience et juste avant envoi ;
- désinscription à effet immédiat ;
- liste de suppression fournisseur synchronisée ;
- fréquence maximale par canal ;
- gestion bounce, plainte, numéro invalide et changement de propriétaire ;
- messages transactionnels strictement séparés du marketing.

### Porte de sortie Pro marketing

- les trois automatisations passent en staging puis sur deux pilotes ;
- aucun client sans consentement valide ne reçoit de marketing ;
- aucune réservation future n'est ciblée par la relance dormant ;
- un rejeu de job ne produit pas de doublon ;
- le gérant voit audience, coût, envois, échecs et désinscriptions ;
- le support peut expliquer pourquoi un client a reçu un message ;
- checkout 299 € et entitlements Pro validés.

---

## 10. Phase 4 — Attribution et marketing mesurable

**Objectif :** démontrer la valeur de Pro sans présenter une estimation comme un encaissement.

### P4-01 — Liens et codes suivis

> **État local : PARTIEL LIVRÉ.** Le worker crée un lien HMAC par destinataire ; le clic est enregistré
> à l'ouverture du widget `/book/:slug`, puis le token est résolu à la création. Les conversions
> `RESERVATION_CREATED` et `RESERVATION_HONORED` sont idempotentes et l'annulation désactive l'actif.

- créer un lien de réservation signé par campagne et destinataire ;
- préserver `campaignId` et `customerId` pseudonymisé dans le parcours ;
- attribuer création, modification, annulation et visite ;
- supporter un code offre optionnel ;
- définir une fenêtre d'attribution configurable ;
- conserver source initiale et source de conversion sans les écraser.

### P4-02 — Niveaux de revenu

Afficher quatre métriques distinctes :

1. **réservations attribuées** ;
2. **visites honorées attribuées** ;
3. **revenu estimé**, via couverts × ticket moyen ;
4. **revenu encaissé**, seulement issu d'un paiement ou de la caisse.

Le terme « revenu généré » ne doit être utilisé que si la méthode d'attribution et la nature estimée/encaissée sont visibles.

### P4-03 — Rapport campagne

> **État local : PARTIEL LIVRÉ.** Le rapport API sépare livraison, clics, conversions, revenu estimé
> et revenu confirmé ; un export CSV agrégé tenant-scoped est disponible, avec coût `NOT_AVAILABLE`
> tant que les événements d'usage ne sont pas rapprochés d'une facture. Le pilote et la comparaison
> temporelle restent ouverts.

Rapport minimum : audience, délivrés, clics si disponibles, réservations, visites, désinscriptions, coût de campagne, revenu estimé et revenu encaissé. L'export CSV agrégé reprend ces indicateurs sans PII ; une comparaison temporelle reste à ajouter, sans prétendre établir une causalité expérimentale.

### Porte de sortie attribution

- une réservation issue d'un lien de campagne est attribuée une seule fois ;
- une annulation retire la conversion active mais reste dans l'historique ;
- le passage à `HONORED` met à jour le rapport ;
- les montants estimés et encaissés ne sont jamais additionnés ;
- les résultats sont reproductibles depuis les données sources.

À ce stade, le contrôle de campagne, le moteur des trois automatisations, leur interface, la
migration de la réactivation historique et le cycle d'attribution réservation créée → visite
honorée constituent le socle technique local de Pro. La mise en vente à 299 € reste bloquée par
la configuration effective des providers, les fixtures de délivrabilité, la preuve terrain et le
rapprochement de coût.

---

## 11. Phase 5 — Empreinte bancaire, acomptes et no-show

**Objectif :** protéger les services à forte demande et les grands groupes.

**État local au 14 septembre 2026 : fondation livrée, activation externe bloquée.**
`apps/api/src/modules/reservation-payments/reservation-payment.service.ts` versionne les règles,
calcule les montants fixes/par personne, prépare une tentative idempotente en dry-run ou commit,
valide les transitions autorisées et confirme une réservation `PENDING` dans la même transaction
qu'un événement provider. `reservation-payment.routes.ts` expose les policies, la préparation, la
lecture, l'expiration et le webhook Stripe signé ; seuls le hash et les statuts sont conservés.
Le capability Pro `reservations.payments` et `RESERVATION_PAYMENTS_ENABLED` restent fermés par défaut.
Le modèle marchand, Stripe Connect, le hold de capacité, le 3DS réel, les captures, remboursements,
litiges et preuves terrain restent à qualifier.

### P5-01 — Modèle marchand et responsabilités

Décider avant développement :

- qui est marchand de référence ;
- Stripe Connect ou compte Stripe propre au restaurant ;
- qui supporte litiges, remboursements et frais ;
- quand une carte est enregistrée, autorisée ou débitée ;
- durée et renouvellement d'autorisation ;
- politique selon taille de groupe, service ou événement ;
- traitement d'un no-show partiel ;
- TVA, facture, CGV et consentement à la politique.

Cette décision conditionne l'architecture. Elle doit être validée avec Stripe et un conseil juridique/comptable.

### P5-02 — Policy et réservation

Ajouter une `ReservationPaymentPolicy` versionnée :

- type `NONE`, `CARD_GUARANTEE`, `DEPOSIT`, `PREPAYMENT` ;
- montant fixe ou par personne ;
- seuil de groupe ;
- services/dates concernés ;
- délai d'annulation gratuite ;
- règle de remboursement ;
- snapshot sur la réservation.

### P5-03 — Parcours de paiement

- créer un SetupIntent ou PaymentIntent idempotent ;
- envoyer un lien sécurisé avec expiration ;
- réserver temporairement la capacité pendant le paiement ;
- confirmer seulement après état requis ;
- traiter `requires_action`, échec, expiration, annulation et webhook en retard ;
- ne jamais stocker de carte ;
- afficher au gérant l'état et l'action possible.

### P5-04 — Frais, remboursements et litiges

- action de débit après no-show avec justification ;
- double validation au début du pilote ;
- plafond et délai ;
- remboursement total/partiel ;
- audit immuable ;
- notification client ;
- rapprochement Stripe quotidien ;
- file d'exceptions et runbook de litige.

### Porte de sortie paiement

- scénarios paiement, 3DS, expiration, remboursement et webhook rejoué validés ;
- aucune réservation simultanément confirmée et impayée si la policy exige un paiement ;
- aucune double capture ;
- politique acceptée et horodatée ;
- restauration/rollback n'altère pas le ledger financier ;
- pilote limité à un restaurant et une règle simple avant généralisation.

---

## 12. Phase 6 — Première intégration caisse

**Objectif :** connaître la dépense réelle par visite et déclencher du marketing fondé sur la valeur.

### P6-01 — Sélection du fournisseur

Interroger les dix premiers prospects et choisir le connecteur selon :

- nombre de restaurants réellement équipés ;
- disponibilité et coût de l'API ;
- sandbox et qualité documentaire ;
- webhooks ou fréquence de synchronisation ;
- identifiants disponibles pour rapprocher réservation et ticket ;
- données ligne par ligne et remboursements ;
- conditions de redistribution et DPA ;
- support partenaire.

Ne construire aucun connecteur avant d'avoir au moins deux prospects ou un client signé utilisant cette caisse.

### P6-02 — Couche d'adaptation

**État local au 14 septembre 2026 : fondation livrée, fournisseur externe non sélectionné.**
`apps/api/src/modules/pos/pos-connector.ts` définit le contrat provider-neutral ;
`pos-sync.service.ts` normalise les montants, calcule un hash SHA-256 du payload et réalise un
upsert idempotent par `(connectionId, externalId)`. Les routes `/pos/connections*` sont protégées
par `pos.connect` (Pro/Multi-site), par rôle Owner/Manager et par `POS_CONNECTORS_ENABLED` ; le
flag reste désactivé dans les exemples d'environnement. Aucun appel réseau vers un POS n'est
effectué.

Créer une interface interne stable :

```ts
interface PosConnector {
  connect(input: ConnectionInput): Promise<ConnectionResult>;
  verifyConnection(): Promise<ConnectionHealth>;
  syncChecks(cursor?: string): Promise<SyncPage<PosCheck>>;
  getCheck(id: string): Promise<PosCheck | null>;
  disconnect(): Promise<void>;
}
```

Normaliser dans des modèles internes :

- `PosConnection` et statut de santé ;
- `PosLocationMapping` ;
- `PosCheck` et montants hors taxes/taxes/pourboire/remise ;
- `PosCheckItem` optionnel ;
- `PosPayment` ou résumé de paiement ;
- `ReservationCheckMatch` avec méthode et confiance ;
- curseur de synchronisation et dead-letter.

### P6-03 — Rapprochement réservation-ticket

Le matcher local `scoreReservationCheckMatch()` est livré en mode explicable : identifiant externe
(100), table (+35), fenêtre de 45 minutes (+30), couverts compatibles (+20), téléphone/token
vérifié (+40) et conflit (-50), avec statuts `MATCHED`, `REVIEW` et `UNMATCHED`. L'import ne crée
une ligne `ReservationCheckMatch` que lorsqu'un `reservationId` est fourni explicitement ; une
suggestion sous 80/100 reste une revue et n'enrichit aucune projection CRM.

Ordre de préférence : identifiant transmis au POS, table + fenêtre horaire, téléphone/token client, puis proposition manuelle. Un rapprochement faible ne doit pas enrichir automatiquement la valeur client.

Prévoir :

- plusieurs tickets pour une réservation ;
- partage de note ;
- walk-in ;
- remboursement après fermeture ;
- ticket rouvert ;
- réservation déplacée ;
- plusieurs réservations sur une table ;
- devise et fuseau.

### P6-04 — Valeur client réelle

Après rapprochement fiable :

- dépense dernière visite ;
- dépense cumulée et moyenne ;
- dépense par couvert ;
- produits/catégories préférés si légalement et commercialement utile ;
- segment de valeur ;
- revenu encaissé attribué aux campagnes.

### Porte de sortie POS

- 30 jours de synchronisation sans trou silencieux ;
- ≥ 95 % des tickets candidats rapprochés automatiquement ou présentés à résoudre ;
- montants agrégés égaux aux rapports POS sur un échantillon signé ;
- remboursements répercutés ;
- secrets chiffrés et rotation documentée ;
- déconnexion et suppression testées ;
- tableau de santé visible au support.

---

## 13. Phase 7 — CRM groupe et multi-site

**Objectif :** rendre l'offre groupe sûre et utile, au-delà d'une facture multi-établissements.

**État local au 14 septembre 2026 : fondation livrée, activation multi-site bloquée.**
`apps/api/src/modules/customer-groups/` introduit `CustomerGroupProfile` (identité de groupe et
consentement) et `CustomerGroupMembership` (rattachement explicite d'une projection `Customer` à
un site). Les routes listent, créent, détaillent, consentent, lient et délient sous le compte/site
résolu par `requireOrg`; aucun `accountId`, `restaurantId` ou numéro complet n'est accepté depuis
le corps. La capability `customers.group` est réservée à Multi-site et
`CUSTOMER_GROUPS_ENABLED=false` par défaut. Un retrait de consentement supprime les liens du groupe
dans la même transaction ; une course d'insertion est rendue idempotente par l'index unique
`(account_id, customer_id)`. Le fournisseur d'identité, l'export/effacement inter-sites, la
déduplication assistée et les campagnes consolidées restent hors périmètre local.

### P7-01 — Fermer l'isolation actuelle

Exécuter les portes encore ouvertes de `docs/audits/2026-09-07-multisite-gap-matrix.md` :

- deux organisations et deux identités réelles ;
- propriétaire, responsable groupe et membre limité à un site ;
- refus inter-organisation sur chaque écran/API ;
- suspension, réactivation et transfert du site principal ;
- annuel, taxes, prorata et période de grâce ;
- validation iPad et sélection persistante du site.

### P7-02 — Identité client groupe

Le modèle local évite de déplacer directement `Customer.restaurantId`. Le socle livré fournit une
identité de groupe nommée et un graphe de correspondance explicite, mais chaque lien doit encore
être créé par une règle ou une revue opérateur qualifiée :

- consentement à l'usage inter-établissements ;
- `CustomerGroupMembership` unique par compte/client, source et confiance bornées ;
- retrait de consentement avec suppression transactionnelle des liens ;
- téléphone retourné sous forme des quatre derniers chiffres ;
- visibilité selon rôle ;
- préférences communes et notes privées au site ;
- statistiques groupe et locales ;
- fusion/dissociation auditée ;
- export et effacement couvrant tous les sites concernés.

### P7-03 — Exploitation groupe

- recherche de disponibilité dans les établissements frères ;
- proposition d'un autre restaurant quand le premier est complet ;
- transfert de réservation explicite ;
- segments groupe ;
- campagnes par marque/site ;
- limites de pression marketing au niveau groupe ;
- rapports consolidés et comparaison entre sites ;
- facturation par nombre de sites active.

### Porte de sortie groupe

- zéro accès à une note privée d'un autre site sans droit ;
- le client n'est contacté qu'une fois lorsqu'il appartient à plusieurs audiences ;
- une réservation croisée conserve source, consentement et responsabilité ;
- les chiffres consolidés sont égaux à la somme des sites après déduplication documentée.

---

## 14. Phase 8 — Réputation et fidélité

**Objectif :** fermer la boucle après visite sans construire immédiatement un programme de points complexe.

**Mise à jour du 28 octobre 2026 :** retour privé par e-mail à J+1 pour Pro/Multi-site, une demande par client et restaurant tous les 90 jours, désinscription, plafond global de 10 tentatives par jour UTC et tâche de récupération pour les notes ≤ 2. Aucun lien vers une plateforme d'avis.

La brique P8-03 est maintenant livrée localement dans `apps/api/src/modules/loyalty/` et sur
`/dashboard/loyalty`. Elle définit des avantages EUR bornés, des règles `ANY`, `VIP`,
`MIN_VISITS`, `BIRTHDAY_MONTH` ou `MIN_ESTIMATED_SPEND`, émet un grant avec code à usage unique
hashé, autorise une consommation atomique et expire les émissions toutes les 15 minutes. La
capability `reputation.loyalty` est réservée à Pro/Multi-site ; la version manuelle est ouverte.
Cette fondation ne contacte aucun canal et ne constitue pas encore un programme de points.

### P8-01 — Retour après visite

- demander un avis privé après une visite honorée ;
- score, commentaire et thèmes ;
- routage d'un retour négatif vers une tâche gérant ;
- délai de réponse et statut de récupération ;
- ne solliciter ni no-show ni client déjà sollicité récemment ;
- mesurer retour puis nouvelle visite.

### P8-02 — Sources d'avis externes

Ajouter les sources une par une selon accès API : Google en premier si permis, puis autres plateformes demandées par les pilotes. Centraliser la lecture et la réponse seulement si les conditions de la plateforme l'autorisent.

### P8-03 — Avantages simples

**État local au 14 septembre 2026 : fondation livrée localement ; qualification et activation
restent ouvertes.**

Le socle est provider-neutral et couvre :

- avantage manuel ou automatique ;
- règle d'éligibilité explicable ;
- validité et limites d'usage ;
- code d'émission à usage unique, conservé sous forme de hash ;
- consommation auditée et idempotente ;
- coût estimé en centimes EUR ;
- prévention des doublons et abus avec verrou transactionnel ;
- expiration planifiée et catalogue administrable.

La page `/dashboard/loyalty` permet de créer/désactiver un avantage, émettre un grant et le
marquer utilisé. Aucun SMS/email/WhatsApp, POS, paiement ou portefeuille de points n'est appelé.
Il reste à faire relire les règles par les restaurants pilotes, choisir les canaux, définir les
consentements et décider si une intégration POS est nécessaire.

Exemples : coupe offerte pour anniversaire, priorité liste d'attente, attention VIP. Éviter toute promesse qui ne peut pas être exécutée par l'équipe en salle.

### Porte de sortie fidélité

- toute récompense a une règle, un coût, un état et une trace d'utilisation ;
- un retour négatif crée une action assignée ;
- les sollicitations respectent le consentement et la fréquence ;
- le dashboard relie récupération et visite suivante sans confondre corrélation et causalité.

---

## 15. Phase 9 — Expériences, événements et écosystème

Cette phase rapproche Suppernote de la largeur de SevenRooms, mais elle ne justifie pas à elle seule 199/299 €.

### P9-01 — Expériences et suppléments

Le socle local est livré derrière `EXPERIENCES_ENABLED=false` et la capability Pro
`experiences.manage`. Il couvre le catalogue (`DRAFT/ACTIVE/ARCHIVED`), les sessions datées
(`OPEN/CLOSED/CANCELLED`), une capacité atomique protégée par advisory lock PostgreSQL, un snapshot
du prix EUR, les réservations idempotentes, l'annulation et la fermeture automatique des sessions.
L'API et `/dashboard/experiences` sont testés ; aucun paiement ni canal externe n'est contacté.

Restent à qualifier avant d'ouvrir P9 :

- menus prépayés, suppléments, inventaire partagé avec les tables ;
- achat, remboursement et transfert ;
- widget et téléphone capables de les proposer ;
- reporting séparé et attribution du revenu encaissé ;
- événements, billetterie, liste d'attente et distribution partenaire.

### P9-02 — Événements

**État local au 14 septembre 2026 : fondation livrée localement ; activation bloquée.**

Le lot couvre :

- catalogue `DRAFT/ACTIVE/ARCHIVED`, sessions `OPEN/CLOSED/CANCELLED` et tarifs EUR bornés ;
- jauge partagée par session, verrouillée par `pg_advisory_xact_lock` ;
- commandes idempotentes avec snapshot de prix et un billet opaque par unité ;
- codes billet hexadécimaux, conservation du hash et contrôle `ISSUED → CHECKED_IN` atomique ;
- liste d'attente ordonnée, promotion rejouable et expiration des sessions/entrées ;
- traces locales de facture et remboursement, explicitement `dryRun` sans Stripe ;
- rattachement facultatif au CRM, export/effacement RGPD et page `/dashboard/events` ;
- routes REST avec rôles Owner/Manager/Staff, alias check-in par code et worker toutes les 15 minutes.

Restent ouverts avant l'activation : paiement/acompte et remboursement réel, facture fiscale, widget
et voix, notifications, QR/offline, canaux Google/Meta/partenaires, campagnes liées et reporting de
revenu encaissé. Le détail contractuel se trouve dans
[`adr-events-foundation.md`](./architecture/adr-events-foundation.md).

### P9-03 — Canaux et API partenaires

**État local au 14 septembre 2026 : fondation provider-neutral livrée ; aucun adaptateur externe
activé.** Le module `apps/api/src/modules/distribution/` et la page
`/dashboard/distribution` couvrent :

- `DistributionConnection` unique par fournisseur et établissement, identifiant externe haché,
  quatre derniers caractères, référence opaque de secret et empreinte de configuration ;
- `DistributionSyncRun` avec directions `PUSH/PULL/BIDIRECTIONAL`, états finaux monotones,
  fenêtre bornée, curseurs, compteurs, hash d'acteur et idempotence scoped incluant le curseur
  source ;
- `DistributionAvailabilitySnapshot` upserté par slot, borné et explicitement non autoritaire
  pour la capacité Suppernote ;
- `DistributionReservationLink` uniquement après fourniture explicite d'une réservation existante,
  avec unicité du hash externe et de la réservation ;
- `DistributionWebhookEvent` haché avec anti-rejeu tenant/fournisseur, inbox et transition finale
  opérateur ;
- routes tenant-scoped, garde `distribution.manage`, rôles Owner/Manager/Staff et flag
  `DISTRIBUTION_ENABLED=false` ;
- tests de normalisation, secrets, concurrence logique, idempotence, conflits et UI.

Restent à construire pour un premier canal : choix contractuel et DPA, OAuth ou compte marchand,
secret manager réel, adaptateur signé, mapping capacité, webhook public, worker de synchronisation,
dead-letter, health check fournisseur, déconnexion testée, attribution, réconciliation de 30 jours
et preuve de pilote. Tant que ces éléments ne sont pas signés, une connexion ou un run affiché dans
le dashboard est une preuve locale de préparation, jamais une publication Google/Meta.

Le détail des invariants et du contrat se trouve dans
[`adr-distribution-foundation.md`](./architecture/adr-distribution-foundation.md).

## 16. Backlog transversal obligatoire

### Sécurité et RGPD

- matrice de rôles pour CRM, campagnes, paiements et groupe ;
- chiffrement des secrets POS ;
- politiques de rétention par type de donnée ;
- export/effacement étendus à chaque nouveau modèle ;
- registre des sous-traitants et DPA ;
- audit de masse pour exports et campagnes ;
- protection contre l'énumération et limitation de débit.

### Observabilité et support

- métriques par étape sans PII ;
- correlation ID appel/réservation/message/paiement/ticket ;
- dashboards fournisseurs ;
- files d'erreurs et actions de reprise ;
- alertes avec destinataire réel ;
- runbooks et modèles de communication d'incident ;
- outils support en lecture seule par défaut.

### Qualité

- tests unitaires sur règles et transitions ;
- tests Postgres sur concurrence/idempotence ;
- tests de contrat fournisseurs ;
- E2E sur les parcours critiques ;
- tests de migration sur copie anonymisée ;
- accessibilité et largeur iPad ;
- charge sur appels, réservations et envois de campagne ;
- rollback staging avant chaque promotion risquée.

### Données et analytics

Définir un dictionnaire commun : appel répondu, conversation utile, réservation créée, réservation confirmée, visite honorée, no-show, message délivré, conversion, revenu estimé, revenu encaissé. Chaque métrique doit préciser sa source, son propriétaire et son délai de fraîcheur.

## 17. Ordre de construction recommandé

### Vague A — Justifier Essential 199 €

1. P0-01 comptabilité d'usage ;
2. P0-02 entitlements ;
3. P1-01 à P1-05 fiabilité et onboarding ;
4. P0-03 migration Stripe 199/299 ;
5. P0-04 marge interne ;
6. deux pilotes, sept jours, correction des incidents ;
7. ouverture commerciale Essential.

### Vague B — Justifier Pro 299 €

1. identité, chronologie, préférences et tags ;
2. indicateurs RFM et interface CRM ;
3. segments sauvegardés ;
4. trois automatisations ;
5. consentements et délivrabilité ;
6. attribution réservations/visites ;
7. pilote Pro puis ouverture commerciale.

### Vague C — Augmenter la valeur et le revenu

Choisir selon les problèmes des pilotes :

- beaucoup de no-shows ou grands groupes → protection bancaire d'abord ;
- besoin de cibler les meilleurs clients → caisse d'abord ;
- demandes de groupes → CRM multi-site d'abord ;
- besoin de récupération client → réputation d'abord.

### Vague D — Approcher la suite SevenRooms

Étendre connecteurs POS, fidélité, expériences, événements, distribution et API partenaires à partir de ventes réelles, pas d'une checklist concurrentielle abstraite.

## 18. Découpage des 12 premiers sprints

Hypothèse : sprints de deux semaines. Le contenu sera ajusté selon les incidents pilotes.

| Sprint | Livraison principale                                    | État local au 14/09 | Démonstration attendue                               |
| ------ | ------------------------------------------------------- | ------------------- | ---------------------------------------------------- |
| S1     | Ledger d'usage et coût par appel                        | `PARTIEL LIVRÉ`     | Un appel test est rapproché de bout en bout          |
| S2     | Entitlements, alertes de consommation, marge interne    | `PARTIEL LIVRÉ`     | Essential et Pro ont des droits et budgets distincts |
| S3     | Matrice E2E voix/réservation et correction P0           | `À PROUVER`         | Dix scénarios critiques passent                      |
| S4     | Notifications avec callbacks, erreurs visibles et retry | `PARTIEL LIVRÉ`     | Une panne SMS est visible et récupérable             |
| S5     | Onboarding, renvoi de secours, readiness gate           | `PARTIEL LIVRÉ`     | Un restaurant est activé avec checklist signée       |
| S6     | Prix 199/299, Stripe sandbox et deux pilotes Essential  | `PARTIEL LIVRÉ`     | Cycle commercial complet démontré                    |
| S7     | Identité client, chronologie et migration               | `PARTIEL LIVRÉ`     | Un profil rassemble appels, réservations et visites  |
| S8     | Préférences, tags, déduplication et droits              | `PARTIEL LIVRÉ`     | Un doublon est fusionné sans perte                   |
| S9     | Indicateurs RFM et filtres CRM                          | `LIVRÉ LOCAL`       | Le gérant retrouve une audience utile                |
| S10    | Modèle campagne, segments et SMS test                   | `PARTIEL LIVRÉ`     | Une campagne est prévisualisée et estimée            |
| S11    | Trois automatisations, consentement, désinscription     | `PARTIEL LIVRÉ`     | Aucun message illégitime ou doublon au rejeu         |
| S12    | Attribution, rapport, pilote Pro                        | `PARTIEL LIVRÉ`     | Réservation et visite apparaissent dans le rapport   |

À la fin de S6, Essential doit pouvoir être vendu à 199 €. À la fin de S12, Pro doit pouvoir être vendu à 299 €. Ce calendrier n'est acceptable que si les portes de qualité passent ; un sprint de stabilisation remplace une nouvelle fonctionnalité dès qu'un incident P0/P1 reste ouvert.

## 19. Indicateurs de pilotage

### Essential

- taux d'appels décrochés ;
- taux de conversations abouties ;
- taux de réservations exactes ;
- transferts humains et raisons ;
- réservations par canal ;
- minutes et coût par appel/réservation ;
- échecs de notification ;
- temps gérant économisé, mesuré par entretien et échantillon ;
- incidents P0/P1 par établissement ;
- marge brute par restaurant.

### Pro

- profils avec identité exploitable ;
- profils enrichis et doublons ;
- taille des segments ;
- délivrés, bounces et désinscriptions ;
- réservations et visites attribuées ;
- coût par visite attribuée ;
- revenu estimé et encaissé séparés ;
- taux de retour à 30/60/90 jours ;
- adoption hebdomadaire du CRM et des campagnes.

### Seuils de décision

- **Maintenir** une fonction si elle est utilisée et apporte un résultat mesurable.
- **Corriger** si elle est utile mais génère erreurs, support ou coût excessif.
- **Simplifier** si moins de 20 % des pilotes comprennent le parcours sans aide.
- **Retirer ou différer** si aucun pilote ne l'utilise sur deux cycles pertinents.
- **Revoir le packaging ou le prix** si le p90 de coût met en danger la marge ; la consommation
  client reste sans quota.

## 20. Dépendances externes et décisions de Hamza

| Décision                                      | Échéance utile | Impact si absente                         |
| --------------------------------------------- | -------------- | ----------------------------------------- |
| Remise annuelle et maintien des anciens prix  | Phase 0        | Migration Stripe bloquée                  |
| Engagement de support Pro                     | Phase 0        | Promesse commerciale imprécise            |
| Deux restaurants pilotes Essential            | Phase 1        | Fiabilité terrain non prouvée             |
| Canal email et domaine d'envoi                | Phase 3        | Campagnes email et délivrabilité bloquées |
| Politique marketing et textes de consentement | Phase 3        | Automatisations non activables            |
| Modèle marchand Stripe                        | Phase 5        | Empreinte/acompte bloqués                 |
| Caisse prioritaire                            | Phase 6        | Connecteur POS non sélectionnable         |
| Deux clients équipés de la même caisse        | Phase 6        | ROI du connecteur insuffisant             |
| Règles de partage client groupe               | Phase 7        | CRM groupe non activable                  |

## 21. Risques majeurs et réponses

| Risque                                       | Réponse                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Construire trop large avant les ventes       | Chaque phase a une porte commerciale autonome et des pilotes nommés                             |
| Coût voix incompatible avec 199/299 €        | Ledger d'usage, p90 et marge interne par restaurant, avec ajustement du packaging si nécessaire |
| Messages marketing non conformes             | Consentement par canal, preuve, revalidation à l'envoi, suppression immédiate                   |
| Doublons client et mauvaise personnalisation | Identités vérifiées, score de rapprochement, fusion manuelle auditée                            |
| Faux ROI                                     | Séparer estimé, réservé, honoré et encaissé                                                     |
| Double envoi ou double débit                 | Idempotence Postgres et références fournisseur uniques                                          |
| Dépendance à un POS                          | Interface adaptateur, health check, sync reprenable, export des données internes                |
| Fuite multi-tenant                           | Résolution serveur du site, tests avec identités réelles, rôles minimaux                        |
| Dette créée par le legacy                    | Migrations additives, adaptateurs et plan de retrait après observation                          |
| Support ingérable                            | Onboarding bloquant, outils de diagnostic, runbooks et limites claires                          |

## 22. Définition de “Suppernote offre tout ce qui compte face à SevenRooms”

Le but ne doit pas être une égalité de cases marketing. Pour la cible des restaurants indépendants français, Suppernote atteint une position compétitive lorsque :

- les réservations voix, web et assistants sont unifiées ;
- la salle et la liste d'attente sont fiables en service ;
- chaque interaction enrichit un profil client contrôlable ;
- les segments et relances sont simples et mesurables ;
- le restaurant protège ses réservations à risque ;
- une caisse prioritaire fournit la dépense réelle ;
- les groupes partagent les données selon des droits explicites ;
- les retours négatifs deviennent des actions ;
- les coûts, marges et résultats sont visibles ;
- l'installation et le support restent nettement plus simples que ceux d'une suite enterprise.

Les intégrations nombreuses, la billetterie avancée et les fonctions spécialisées pour hôtels, clubs ou stades ne deviennent prioritaires que si Suppernote choisit ces marchés.

## 23. Prochaine action concrète

Le registre de release et la réconciliation des audits sont les autorités d'exécution : ne créer une
nouvelle tâche que pour un écart encore listé dans leur colonne « Reste ». Les fondations P0 à P4,
CRM/marketing local, POS provider-neutral et protection bancaire locale sont codées et testées ; les
prochaines actions à forte valeur sont les preuves externes, les fixtures provider et les pilotes
contrôlés.

Le prochain jalon démontrable avant l'ouverture commerciale complète est : **un restaurant pilote
exécute une réservation à risque en sandbox, reçoit un événement signé, garde sa capacité protégée,
et retrouve le statut, le remboursement et le rapprochement sans double écriture**. Le profil scoped
`core-operator-foundations` est déjà en production pour les fondations sûres ; tant que ce jalon,
les portes différées et le pilote ne sont pas clôturés, aucun déverrouillage commercial global n'est
effectué.

## 24. Documents liés

- `docs/architecture/reservation-commercial-readiness.md`
- `docs/audits/2026-09-15-current-state.md`
- `docs/audits/2026-09-06-launch-readiness.md`
- `docs/audits/2026-09-07-phase-0-commercial-register.md`
- `docs/audits/2026-09-07-multisite-gap-matrix.md`
- `docs/architecture/reservation-state-semantics.md`
- `docs/floor-plan-spec.md`
- `docs/gift-cards-spec.md`
- `docs/runbooks/stripe-billing.md`
- `docs/architecture/adr-reservation-payments-foundation.md`
- [CRM SevenRooms](https://sevenrooms.com/platform/crm/)
- [Réservations et liste d'attente SevenRooms](https://sevenrooms.com/platform/reservations-waitlist/)
- [Tarifs Zenchef](https://www.zenchef.com/fr/formules)

---

# Partie II — Blueprint technique d'implémentation

Cette partie traduit la roadmap en changements de code concrets. Elle conserve le blueprint cible
et indique désormais les lots déjà présents localement. Les migrations CRM/marketing ajoutent des
tables et colonnes compatibles ; aucun champ existant n'est supprimé pendant les phases 0 à 4.

## 25. Architecture cible dans le monorepo

### 25.1 Modules API cible et état local

Les répertoires livrés ne correspondent pas tous aux anciens noms du blueprint (`crm` et
`segments` sont regroupés dans `customers`). Cette table est la référence d'état ; une entrée
marquée `À construire` est le seul travail restant, une entrée `LOCAL` est codée et testée mais
peut rester bloquée par une preuve externe.

| Module réel            | État local au 14/09/2026     | Preuve / reste                                                                                                                                                                                                               |
| ---------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entitlements`         | `LIVRÉ LOCAL`                | matrice Essential/Pro/Multi-site, garde serveur et tests ; consommation client explicitement sans quota                                                                                                                      |
| `usage`                | `PARTIEL LOCAL`              | ledger, coûts, rapprochement, marge par restaurant, suivi interne optionnel et export ; factures réelles et preuve PostgreSQL restent ouvertes                                                                               |
| `customers`            | `LIVRÉ LOCAL`                | CRM, segments, fusion, RGPD, préférences/tags et confidentialité ; preuve PostgreSQL concurrente ouverte                                                                                                                     |
| `customer-groups`      | `LIVRÉ LOCAL`                | consentement, isolation, rattachement idempotent et masquage ; flag fermé et identités Clerk réelles à prouver                                                                                                               |
| `marketing`            | `PARTIEL LOCAL`              | campagnes, automations, callbacks, attribution et preview ; providers et pilote restent fermés                                                                                                                               |
| `reservation-payments` | `FONDATION LOCAL`            | policies, préparation, transitions et webhook hashé ; marchand, intents, holds/captures/remboursements à construire                                                                                                          |
| `pos`                  | `FONDATION LOCAL`            | contrat, import, ticket et matcher ; adaptateur fournisseur, sandbox et réconciliation à construire                                                                                                                          |
| `reputation`           | `FONDATION LOCAL + UI ADMIN` | demandes tokenisées post-visite, réponses 1–5, tâches de récupération, worker d'expiration et boîte dashboard ; fournisseurs d'avis et envoi restent à qualifier                                                             |
| `loyalty`              | `FONDATION LOCAL + UI ADMIN` | catalogue d'avantages, règles d'éligibilité, grants à code hashé, redeem atomique, expiration et coût estimé ; points, envoi, POS et pilote restent ouverts                                                                  |
| `experiences`          | `FONDATION LOCAL + UI ADMIN` | catalogue, sessions, capacité atomique, snapshot prix, réservation idempotente, annulation et expiration ; paiement, canaux externes et reporting restent ouverts                                                            |
| `events`               | `FONDATION LOCAL + UI ADMIN` | catalogue, sessions, tarifs, jauge transactionnelle, commandes/billets hashés, check-in, liste d'attente, traces locales de facture/remboursement ; paiement, facture fiscale, notifications et distribution restent ouverts |
| `distribution`         | `FONDATION LOCAL + UI ADMIN` | connexions provider-neutral, snapshots de disponibilité, runs idempotents, liens explicites, inbox webhook hachée et revue de qualification ; fournisseurs, OAuth, worker et webhooks publics restent ouverts                |

L'arborescence ci-dessous reste un blueprint de destination pour les extensions, pas une liste de
fichiers manquants à recréer. Les fichiers présents dans la table ci-dessus sont considérés comme
faits localement.

```text
apps/api/src/modules/
├── entitlements/
│   ├── entitlement.service.ts
│   ├── entitlement.routes.ts
│   ├── entitlement.types.ts
│   └── __tests__/
├── usage/
│   ├── usage.service.ts
│   ├── usage-tariff.service.ts
│   ├── usage-reconciliation.service.ts
│   ├── usage-adjustment.service.ts
│   ├── usage-alerts.service.ts
│   ├── usage-internal-margin.service.ts
│   ├── usage-accounting-export.service.ts
│   ├── usage-accounting-package.service.ts
│   ├── usage.routes.ts
│   ├── usage.types.ts
│   └── __tests__/
├── customers/
│   ├── customer.service.ts
│   ├── customer-crm.service.ts
│   ├── customer-merge.service.ts
│   ├── customer-segment.service.ts
│   ├── customer-privacy.ts
│   ├── customer.routes.ts
│   ├── customer-crm.routes.ts
│   ├── customer-segment.routes.ts
│   └── __tests__/
├── customer-groups/
│   ├── customer-group.service.ts
│   ├── customer-group.routes.ts
│   └── __tests__/
├── marketing/
│   ├── marketing-campaign.service.ts
│   ├── marketing-automation.service.ts
│   ├── marketing-permission.service.ts
│   ├── marketing-attribution.service.ts
│   ├── marketing-report.service.ts
│   ├── marketing-provider.service.ts
│   ├── marketing-provider-reconciliation.worker.ts
│   ├── marketing-campaign.worker.ts
│   ├── marketing-automation.worker.ts
│   ├── marketing.routes.ts
│   └── __tests__/
├── reservation-payments/
│   ├── reservation-payment.service.ts
│   ├── reservation-payment.routes.ts
│   └── __tests__/
├── pos/
│   ├── pos-connector.ts
│   ├── pos-connection.service.ts
│   ├── pos-sync.service.ts
│   ├── reservation-check-matcher.service.ts
│   ├── pos.routes.ts
│   └── __tests__/
├── reputation/
│   ├── reputation.service.ts
│   ├── reputation.routes.ts
│   ├── reputation-feedback-expiry.worker.ts
│   └── __tests__/
├── loyalty/
│   ├── loyalty.service.ts
│   ├── loyalty.routes.ts
│   ├── loyalty-grant-expiry.worker.ts
│   └── __tests__/
├── experiences/
│   ├── experience.service.ts
│   ├── experience.routes.ts
│   ├── experience-session-expiry.worker.ts
│   └── __tests__/
├── events/
    ├── event.service.ts
    ├── event.routes.ts
    ├── event-session-expiry.worker.ts
    └── __tests__/
└── distribution/
    ├── distribution.service.ts
    ├── distribution.routes.ts
    └── __tests__/
```

### 25.2 Infrastructure partagée à compléter

Le socle `apps/api/src/shared/outbox/outbox.service.ts` et son worker de dispatch sont déjà
présents, tout comme les adaptateurs de messagerie dans `shared/messaging` et `shared/telnyx`.
L'ancienne arborescence `authorization/` et `providers/` ci-dessous décrit uniquement les
extensions encore nécessaires ; elle ne doit pas être relue comme une liste de fichiers manquants.

```text
apps/api/src/shared/
├── outbox/
│   ├── outbox.service.ts
│   └── __tests__/
├── messaging/
│   ├── sender.ts
│   └── __tests__/
├── queue/
│   ├── notification-idempotency.ts
│   ├── notification-repair.ts
│   └── workers/outbox-dispatcher.worker.ts
└── providers/ (extension à construire si un second fournisseur est retenu)
```

Le worker marketing appelle les adaptateurs partagés Telnyx/Resend/WhatsApp, qui retournent un
résultat normalisé `success`, `failure_certain` ou `unknown`. Le worker conserve l'état durable dans
Postgres, recontrôle le consentement et bloque les claims anciens en revue manuelle afin de ne pas
réémettre aveuglément. Les routes callback Telnyx et Resend vérifient la signature puis appliquent
des transitions monotones et idempotentes sur `CampaignMessage`; les adaptateurs, la configuration
effective et la preuve sur pilote restent à qualifier, pas à recréer. Les IDs inconnus sont
persistés dans une inbox sans PII, réessayés par un worker dédié et clôturables par un opérateur.

### 25.3 Pages dashboard cibles

Les pages suivantes sont déjà présentes localement : `/admin`, `/admin/margin`, `/admin/health`,
`/admin/provisioning`, `/dashboard/customers`, `/dashboard/customers/crm/[id]`,
`/dashboard/customers/crm/duplicates`, `/dashboard/marketing`,
`/dashboard/marketing/segments`, `/dashboard/marketing/campaigns/new`, `/dashboard/reputation`,
`/dashboard/loyalty`, `/dashboard/experiences`, `/dashboard/reactivation`, `/dashboard/reservations` et `/dashboard/settings`.
Les écrans
`payments` et l'administration POS restent à construire après qualification des parcours externes ;
les expériences restent verrouillées par `EXPERIENCES_ENABLED=false` ; la réputation privée et la fidélité manuelle sont réservées à Pro/Multi-site.

```text
apps/dashboard/src/app/
├── admin/
│   ├── page.tsx
│   ├── margin/page.tsx
│   ├── health/page.tsx
│   └── provisioning/page.tsx
└── dashboard/
    ├── usage/page.tsx (alias opérateur historique)
    ├── customers/page.tsx
    ├── customers/crm/page.tsx
    ├── customers/crm/[id]/page.tsx
    ├── customers/crm/duplicates/page.tsx
    ├── marketing/page.tsx
    ├── marketing/segments/page.tsx
    ├── marketing/campaigns/new/page.tsx
    ├── reputation/page.tsx
    ├── loyalty/page.tsx
    ├── experiences/page.tsx
    ├── reservations/page.tsx
    ├── reactivation/page.tsx
    ├── settings/page.tsx
    ├── floor-plan/page.tsx
    └── (payments et POS : écrans d'administration à construire)
```

Chaque page livrée doit avoir les états loading, empty, error et data, fonctionner à largeur iPad et
utiliser les composants `@/components/ui/*` et les tokens Tailwind existants. Les écrans futurs
suivront la même règle après qualification de leur parcours externe.

## 26. Flux d'événements fiable : transactional outbox

### 26.1 Problème

Un appel peut créer une réservation dans Postgres puis échouer avant l'ajout du job BullMQ. À l'inverse, un job peut être rejoué. Pour le CRM, l'usage, le marketing, le POS et le paiement, un simple `db.write()` suivi de `queue.add()` n'offre pas de garantie atomique.

### 26.2 Modèle livré localement

`OutboxEvent`, `enqueue()`, la détection de PII, le claim PostgreSQL `SKIP LOCKED`, le lease de
cinq minutes et le dispatcher BullMQ existent dans `apps/api/src/shared/outbox/` et
`apps/api/src/shared/queue/workers/outbox-dispatcher.worker.ts`. Le schéma ci-dessous documente le
contrat réellement utilisé ; les tests de concurrence PostgreSQL et la rétention/purge restent les
preuves opérationnelles à exécuter.

```prisma
enum OutboxStatus {
  PENDING
  DISPATCHING
  DISPATCHED
  FAILED
}

model OutboxEvent {
  id             String       @id @default(uuid())
  topic          String
  aggregateType  String       @map("aggregate_type")
  aggregateId    String       @map("aggregate_id")
  eventType      String       @map("event_type")
  schemaVersion  Int          @default(1) @map("schema_version")
  payload        Json
  idempotencyKey String       @unique @map("idempotency_key")
  status         OutboxStatus @default(PENDING)
  attempts       Int          @default(0)
  availableAt    DateTime     @default(now()) @map("available_at")
  lockedAt       DateTime?    @map("locked_at")
  dispatchedAt   DateTime?    @map("dispatched_at")
  lastErrorCode  String?      @map("last_error_code")
  createdAt      DateTime     @default(now()) @map("created_at")

  @@index([status, availableAt, createdAt])
  @@index([aggregateType, aggregateId, createdAt])
  @@map("outbox_events")
}
```

### 26.3 Contrat d'émission

Toute mutation source et son événement outbox sont écrits dans la même transaction Prisma :

```ts
await db.$transaction(async (tx) => {
  const reservation = await tx.reservation.update({
    /* ... */
  });
  await OutboxService.enqueue(tx, {
    topic: 'crm-projection',
    aggregateType: 'reservation',
    aggregateId: reservation.id,
    eventType: 'reservation.honored',
    schemaVersion: 1,
    idempotencyKey: `reservation.honored:${reservation.id}:${reservation.updatedAt.toISOString()}`,
    payload: { reservationId: reservation.id, restaurantId: reservation.restaurantId },
  });
});
```

Le payload ne contient pas de téléphone, email, nom ni texte libre. Le consommateur recharge les données autorisées depuis Postgres avec `restaurantId`.

### 26.4 Dispatcher

Le dispatcher :

1. sélectionne au plus 100 événements `PENDING` avec `FOR UPDATE SKIP LOCKED` ;
2. prend un lease de 5 minutes ;
3. ajoute un job BullMQ avec `jobId = outbox_<event.id>` ;
4. marque `DISPATCHED` après acceptation par Redis ;
5. rend à nouveau disponible un lease expiré ;
6. place en `FAILED` après un nombre borné d'essais et crée une alerte ;
7. conserve l'événement au moins 30 jours avant purge.

Le consommateur utilise lui aussi une clé métier unique. La garantie visée est **at-least-once + traitement idempotent**, pas exactly-once.

## 27. Entitlements et feature flags

### 27.1 Deux systèmes séparés

- **Entitlement** : droit contractuel lié au plan. Une fonction Pro ne doit jamais être ouverte à Essential uniquement parce qu'un flag de déploiement est actif.
- **Feature flag ConfigCat** : contrôle de rollout, cohorte pilote et kill switch. Un client disposant du droit peut rester désactivé pendant un canary.

La décision finale suit :

```ts
allowed =
  entitlementService.has(restaurant, capability) &&
  featureFlagService.isEnabled(capability, restaurant);
```

### 27.2 Contrat TypeScript livré localement

La source de vérité est `packages/config/src/entitlements.ts` (`EntitlementCapability`,
`PLAN_ENTITLEMENTS` et `hasPlanCapability`). Les capabilities ajoutées pendant cette exécution sont
`pos.connect`, `reservations.payments`, `customers.group`, `reputation.feedback` et
`reputation.loyalty` ; `customers.group` est vraie uniquement pour `multi-site`. Les extraits
historiques ci-dessous servent de blueprint de migration et ne
doivent pas être recopiés tels quels dans le code.

```ts
export const CAPABILITIES = [
  'voice.basic',
  'voice.returning_customer',
  'reservations.core',
  'floor_plan.live',
  'crm.profile',
  'crm.profile.write',
  'crm.advanced',
  'crm.merge',
  'marketing.segments',
  'marketing.campaigns',
  'marketing.automations',
  'marketing.attribution',
  'reservation.card_guarantee',
  'integrations.pos',
  'group.crm',
  'reputation.feedback',
  'reputation.loyalty',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface PlanEntitlements {
  capabilities: ReadonlySet<Capability>;
  includedVoiceSeconds: number;
  includedSmsSegments: number;
  retentionDays: number;
  supportTier: 'standard' | 'priority';
}
```

Les plans par défaut restent versionnés dans `packages/config`. Une table additive `RestaurantEntitlementOverride` gère seulement les contrats particuliers, avec auteur, motif et expiration.

### 27.3 Enforcement

- Vérification serveur au début de chaque route et chaque worker.
- Les jobs stockent le plan observé, mais le worker relit le droit courant avant un effet externe.
- Un downgrade bloque les nouvelles campagnes et conserve la lecture de l'historique.
- Une campagne planifiée par un client devenu inéligible passe en `PAUSED` avec `pauseReason=ENTITLEMENT_MISSING`.
- Les réponses API utilisent `403 CAPABILITY_NOT_INCLUDED` avec `capability` et plan normalisé, sans détails Stripe.

## 28. Modèle technique de mesure des usages

### 28.1 Schéma livré localement

`UsageEvent`, `UsageMonthlyRollup` et `UsageTariff` existent dans Prisma, avec le recorder,
les rollups, l'import de tarifs, le rapprochement de facture et l'export comptable. Le schéma
ci-dessous décrit le contrat de données ; seules les lignes de facture, les tarifs validés et la
preuve PostgreSQL concurrente restent externes.

```prisma
enum UsageCategory {
  TELEPHONY_SECONDS
  STT_SECONDS
  TTS_CHARACTERS
  LLM_INPUT_TOKENS
  LLM_OUTPUT_TOKENS
  SMS_SEGMENTS
  WHATSAPP_MESSAGES
  EMAIL_MESSAGES
  RECORDING_BYTE_DAYS
}

model UsageEvent {
  id             String        @id @default(uuid())
  restaurantId   String        @map("restaurant_id")
  accountId      String?       @map("account_id")
  category       UsageCategory
  provider       String
  quantity       Decimal       @db.Decimal(18, 6)
  unit           String
  estimatedCost  Decimal       @map("estimated_cost") @db.Decimal(18, 6)
  currency       String        @default("EUR")
  sourceType     String        @map("source_type")
  sourceId       String        @map("source_id")
  sourceEventKey String        @unique @map("source_event_key")
  occurredAt     DateTime      @map("occurred_at")
  metadata       Json          @default("{}")
  createdAt      DateTime      @default(now()) @map("created_at")

  restaurant Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)

  @@index([restaurantId, occurredAt])
  @@index([restaurantId, category, occurredAt])
  @@index([accountId, occurredAt])
  @@map("usage_events")
}

model UsageMonthlyRollup {
  restaurantId  String        @map("restaurant_id")
  monthKey      String        @map("month_key")
  category      UsageCategory
  quantity      Decimal       @db.Decimal(18, 6)
  estimatedCost Decimal       @map("estimated_cost") @db.Decimal(18, 6)
  updatedAt     DateTime      @updatedAt @map("updated_at")

  @@id([restaurantId, monthKey, category])
  @@index([monthKey, category])
  @@map("usage_monthly_rollups")
}
```

### 28.2 Source des événements

| Source         | Moment d'écriture                           | Clé unique                          |
| -------------- | ------------------------------------------- | ----------------------------------- |
| Telnyx appel   | webhook final ou réconciliation             | `telnyx:call:<callControlId>:final` |
| ElevenLabs STT | clôture de session                          | `elevenlabs:stt:<callId>:final`     |
| Cartesia TTS   | réponse fournisseur agrégée                 | `cartesia:tts:<callId>:<turnId>`    |
| LLM            | réponse de chaque tour                      | `<provider>:llm:<callId>:<turnId>`  |
| SMS            | acceptation fournisseur, quantité segmentée | `telnyx:sms:<providerMessageId>`    |
| Email          | acceptation fournisseur                     | `resend:email:<providerMessageId>`  |

Si la facture fournisseur n'expose pas le coût immédiatement, `estimatedCost` est calculé avec une table tarifaire versionnée. Un job mensuel rapproche estimation et facture ; il ne modifie pas les événements bruts, mais écrit un ajustement distinct. `UsageReconciliationAdjustment` conserve le hash du rapport, la preuve, la portée, les deltas signés et la décision opérateur `OPEN`/`APPROVED`/`REJECTED`.

### 28.3 Endpoints

| Méthode | Route                                                  | Capacité             | Réponse                                    |
| ------- | ------------------------------------------------------ | -------------------- | ------------------------------------------ |
| GET     | `/usage/current`                                       | tout plan            | consommation, inclus, reste, période       |
| GET     | `/usage/history?from=&to=`                             | tout plan            | agrégats mensuels                          |
| GET     | `/internal/margins?month=`                             | admin interne        | MRR, coûts et marge par site               |
| POST    | `/internal/usage/reconcile`                            | admin interne        | déclenche un rapprochement borné           |
| GET     | `/admin/usage/reconciliation-adjustments`              | opérateur Suppernote | file des corrections avec preuve et statut |
| POST    | `/admin/usage/reconciliation-adjustments`              | opérateur Suppernote | crée une correction idempotente en `OPEN`  |
| POST    | `/admin/usage/reconciliation-adjustments/:id/decision` | opérateur Suppernote | approuve ou rejette depuis `OPEN`          |

Les coûts internes ne sont jamais retournés par `/usage/*`.

## 29. Modèle CRM détaillé

### 29.1 Extensions compatibles de `Customer`

**État local au 14 septembre 2026 : LIVRÉ LOCAL.** Les colonnes optionnelles (`emailNormalized`,
`birthMonth`, `birthDay`, `preferredLocale`, `mergedIntoId`, `archivedAt`) et les modèles CRM
associés existent dans `packages/database/prisma/schema.prisma`. `CustomerService` effectue le
dual-write des identités et des événements de réservation/appel ; le script
`apps/api/scripts/backfill-customer-crm.ts` est rejouable et borné. Le bloc ci-dessous décrit le
contrat de données et ne constitue plus une tâche de création. Restent la preuve PostgreSQL de
concurrence et la donnée POS réelle.

```prisma
model Customer {
  // Champs existants conservés.
  emailNormalized  String?   @map("email_normalized")
  birthMonth       Int?      @map("birth_month")
  birthDay         Int?      @map("birth_day")
  preferredLocale  String?   @map("preferred_locale")
  mergedIntoId     String?   @map("merged_into_id")
  archivedAt       DateTime? @map("archived_at")

  identities       CustomerIdentity[]
  timelineEvents   CustomerTimelineEvent[]
  preferences      CustomerPreference[]
  tagAssignments   CustomerTagAssignment[]
  metrics          CustomerMetricSnapshot?

  @@index([restaurantId, emailNormalized])
  @@index([restaurantId, archivedAt])
}
```

Le champ `phone` et la contrainte `(restaurantId, phone)` restent en place pendant la transition. Le service actuel `CustomerService.lookupOrCreate()` est adapté pour normaliser le téléphone avant lookup, écrire `CustomerIdentity` en dual-write et conserver la clé cache actuelle jusqu'au basculement.

### 29.2 Identités

**État local : LIVRÉ LOCAL.** `CustomerIdentity`, la normalisation téléphone/email, la détection
de collision et le retour `conflict` sont implémentés dans `customer-crm.service.ts` et couverts
par les tests CRM. Une collision d'import ne remplace pas le profil existant ; elle doit être
traitée par le flux de fusion Owner.

```prisma
enum CustomerIdentityType {
  PHONE
  EMAIL
  POS_CUSTOMER_ID
}

model CustomerIdentity {
  id              String               @id @default(uuid())
  restaurantId    String               @map("restaurant_id")
  customerId      String               @map("customer_id")
  type            CustomerIdentityType
  value           String
  normalizedValue String               @map("normalized_value")
  verifiedAt      DateTime?            @map("verified_at")
  source          String
  createdAt       DateTime             @default(now()) @map("created_at")
  updatedAt       DateTime             @updatedAt @map("updated_at")

  customer   Customer   @relation(fields: [customerId], references: [id], onDelete: Cascade)
  restaurant Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)

  @@unique([restaurantId, type, normalizedValue])
  @@index([customerId, type])
  @@map("customer_identities")
}
```

L'unicité empêche deux profils actifs de posséder la même identité dans un établissement. Une collision pendant import crée un candidat de fusion au lieu d'écraser le profil existant.

### 29.3 Chronologie durable

**État local : LIVRÉ LOCAL.** `CustomerTimelineEvent` est persisté avec une clé `dedupeKey`, les
événements réservation/appel et les réparations de projection sont branchés. Les routes CRM
masquent notes et métadonnées selon la politique du site. Les événements liste d'attente, carte
cadeau et POS restent des extensions de couverture, pas des tables à recréer.

```prisma
model CustomerTimelineEvent {
  id             String   @id @default(uuid())
  restaurantId   String   @map("restaurant_id")
  customerId     String   @map("customer_id")
  eventType      String   @map("event_type")
  sourceType     String   @map("source_type")
  sourceId       String?  @map("source_id")
  dedupeKey      String   @unique @map("dedupe_key")
  occurredAt     DateTime @map("occurred_at")
  summaryCode    String   @map("summary_code")
  metadata       Json     @default("{}")
  createdAt      DateTime @default(now()) @map("created_at")

  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@index([restaurantId, occurredAt(sort: Desc)])
  @@index([customerId, occurredAt(sort: Desc)])
  @@index([eventType, occurredAt])
  @@map("customer_timeline_events")
}
```

`summaryCode` est traduit côté dashboard. Le texte libre n'est pas recopié dans `metadata`. Une note de gérant reste une entité séparée avec auteur et permissions.

### 29.4 Préférences et tags

**État local : LIVRÉ LOCAL.** Les préférences allow-listées, leur source/confiance/expiration et
les tags manuels ou système sont disponibles via les routes CRM et la fiche dashboard. Les valeurs
sont normalisées côté serveur ; les champs sensibles ne deviennent pas une vérité permanente sans
confirmation. La preuve de concurrence PostgreSQL reste ouverte.

```prisma
enum CustomerDataSource {
  MANUAL
  RESERVATION
  VOICE_SUGGESTION
  POS
  IMPORT
}

model CustomerPreference {
  id           String             @id @default(uuid())
  customerId   String             @map("customer_id")
  restaurantId String             @map("restaurant_id")
  key          String
  value        Json
  source       CustomerDataSource
  confidence   Decimal?           @db.Decimal(4, 3)
  confirmedAt  DateTime?          @map("confirmed_at")
  expiresAt    DateTime?          @map("expires_at")
  createdAt    DateTime           @default(now()) @map("created_at")
  updatedAt    DateTime           @updatedAt @map("updated_at")

  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@unique([customerId, key])
  @@index([restaurantId, key])
  @@map("customer_preferences")
}

model CustomerTag {
  id           String   @id @default(uuid())
  restaurantId String   @map("restaurant_id")
  key          String
  label        String
  colorToken   String?  @map("color_token")
  isSystem     Boolean  @default(false) @map("is_system")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  assignments CustomerTagAssignment[]

  @@unique([restaurantId, key])
  @@map("customer_tags")
}

model CustomerTagAssignment {
  customerId String             @map("customer_id")
  tagId      String             @map("tag_id")
  source     CustomerDataSource
  ruleId     String?            @map("rule_id")
  ruleVersion Int?              @map("rule_version")
  assignedAt DateTime           @default(now()) @map("assigned_at")

  customer Customer    @relation(fields: [customerId], references: [id], onDelete: Cascade)
  tag      CustomerTag @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@id([customerId, tagId])
  @@index([tagId, assignedAt])
  @@map("customer_tag_assignments")
}
```

### 29.5 Projection métrique

**État local : LIVRÉ LOCAL.** `CustomerMetricSnapshot` est recalculé de manière déterministe depuis
les réservations, avec backfill dry-run et réparation Owner idempotente. `actualSpend365d` et
`actualLifetimeSpend` restent nuls tant qu'un ticket POS rapproché n'est pas disponible ; ils ne
doivent pas être présentés comme une dépense encaissée.

```prisma
model CustomerMetricSnapshot {
  customerId             String   @id @map("customer_id")
  restaurantId           String   @map("restaurant_id")
  lastHonoredAt          DateTime? @map("last_honored_at")
  nextReservationAt      DateTime? @map("next_reservation_at")
  honored30d             Int      @default(0) @map("honored_30d")
  honored90d             Int      @default(0) @map("honored_90d")
  honored365d            Int      @default(0) @map("honored_365d")
  cancelled365d          Int      @default(0) @map("cancelled_365d")
  noShow365d             Int      @default(0) @map("no_show_365d")
  covers365d             Int      @default(0) @map("covers_365d")
  estimatedSpend365d     Decimal  @default(0) @map("estimated_spend_365d") @db.Decimal(12, 2)
  actualSpend365d        Decimal? @map("actual_spend_365d") @db.Decimal(12, 2)
  actualLifetimeSpend    Decimal? @map("actual_lifetime_spend") @db.Decimal(12, 2)
  projectionVersion      Int      @map("projection_version")
  calculatedAt           DateTime @map("calculated_at")

  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@index([restaurantId, lastHonoredAt])
  @@index([restaurantId, honored365d])
  @@index([restaurantId, actualLifetimeSpend])
  @@map("customer_metric_snapshots")
}
```

La projection est mise à jour à chaque événement pertinent, avec un recalcul nocturne complet des profils modifiés depuis 48 heures. Une commande administrative bornée permet de reconstruire un restaurant entier.

## 30. Fusion de profils : transaction et invariants

**État local au 14 septembre 2026 : LIVRÉ LOCAL.** Le preview et la mutation
`POST /crm/customers/:targetId/merge` existent, sont protégés par `crm.merge`, idempotents et
auditables. La transaction `Serializable` déplace les relations CRM, conserve le consentement le
plus restrictif, archive les sources et écrit un événement de timeline/outbox. Les preuves avec
deux transactions PostgreSQL concurrentes et un jeu de données réel restent à exécuter ; le
snippet ci-dessous documente l'invariant attendu.

### 30.1 Endpoint

```http
POST /crm/customers/:targetId/merge-preview
Content-Type: application/json

{ "sourceCustomerIds": ["uuid"] }
```

Le preview retourne conflits d'identité, préférences, consentements, réservations, cartes cadeaux et note libre. La mutation utilise ensuite une clé d'idempotence :

```http
POST /crm/customers/:targetId/merge
Idempotency-Key: <uuid>

{
  "sourceCustomerIds": ["uuid"],
  "preferenceResolution": { "preferred_section": "target" }
}
```

### 30.2 Transaction

Dans une transaction `Serializable` avec retry borné :

1. verrouiller cible et sources dans un ordre stable ;
2. vérifier même `restaurantId`, profils actifs et capability ;
3. déplacer réservations, cartes cadeaux et événements ;
4. consolider identités et préférences selon la résolution du preview ;
5. conserver le consentement le plus restrictif par canal ;
6. recalculer tags et métriques ;
7. marquer les sources `mergedIntoId` et `archivedAt` ;
8. écrire `CustomerMergeAudit` et un événement outbox ;
9. invalider les clés cache après commit.

Une source fusionnée ne peut plus recevoir de mutation normale. Les URLs anciennes redirigent vers la cible. Aucun profil n'est supprimé physiquement par cette opération.

## 31. Moteur de segments

**État local au 14 septembre 2026 : LIVRÉ LOCAL.** L'AST Zod, le compilateur Prisma borné, le
preview, le CRUD, le refresh et les huit segments système sont dans
`apps/api/src/modules/customers/customer-segment.service.ts`. La profondeur et le nombre de
conditions sont limités côté serveur ; le seed est idempotent. Il reste à exécuter la preuve
PostgreSQL de seed concurrent et le pilote de campagne.

### 31.1 AST acceptée

Le dashboard produit un JSON validé par Zod :

```json
{
  "version": 1,
  "operator": "AND",
  "conditions": [
    { "field": "lastHonoredAt", "op": "BEFORE_DAYS_AGO", "value": 60 },
    { "field": "honored365d", "op": "GTE", "value": 2 },
    { "field": "nextReservationAt", "op": "IS_NULL" }
  ]
}
```

Champs autorisés v1 : métriques de `CustomerMetricSnapshot`, anniversaire, VIP, tags et préférences non sensibles. Profondeur maximale : deux groupes. Nombre maximal de conditions : 20. Valeurs bornées et enums fermés.

### 31.2 Compilation SQL

`SegmentCompilerService` traduit l'AST vers `Prisma.CustomerWhereInput` lorsque possible. Les calculs relatifs complexes utilisent du SQL paramétré dans un repository dédié. Il est interdit d'insérer un nom de colonne ou un opérateur venant directement du client.

Chaque champ possède un descripteur serveur :

```ts
interface SegmentFieldDescriptor<T> {
  key: string;
  type: 'number' | 'date' | 'boolean' | 'enum' | 'tag';
  allowedOperators: readonly SegmentOperator[];
  compile(condition: ValidatedCondition, now: Date): Prisma.CustomerWhereInput;
}
```

Le même compilateur sert au preview et au snapshot de campagne. Les exclusions de consentement et de fréquence sont ajoutées côté serveur après compilation ; elles ne peuvent pas être supprimées par l'utilisateur.

### 31.3 Schéma

```prisma
model CustomerSegment {
  id                String   @id @default(uuid())
  restaurantId      String   @map("restaurant_id")
  name              String
  definition        Json
  definitionVersion Int      @default(1) @map("definition_version")
  isSystem          Boolean  @default(false) @map("is_system")
  lastCount         Int?     @map("last_count")
  lastEvaluatedAt   DateTime? @map("last_evaluated_at")
  createdByHash     String   @map("created_by_hash")
  createdAt         DateTime @default(now()) @map("created_at")
  updatedAt         DateTime @updatedAt @map("updated_at")

  @@index([restaurantId, updatedAt(sort: Desc)])
  @@map("customer_segments")
}
```

## 32. Consentement marketing par canal

**État local au 14 septembre 2026 : LIVRÉ LOCAL.** `MarketingPermission` et
`MarketingPermissionEvent` sont persistés avec preuve hashée, retrait monotone et compatibilité
avec `CustomerConsent`. Les campagnes relisent la permission et les suppressions juste avant
l'appel fournisseur. La synchronisation des listes provider et les preuves terrain restent
ouvertes.

Le booléen actuel `CustomerConsent.marketingOptIn` reste lisible pendant la migration, mais ne suffit pas pour email/SMS séparés.

### 32.1 Projection courante et journal

```prisma
enum MarketingChannel {
  SMS
  EMAIL
  WHATSAPP
}

enum MarketingPermissionStatus {
  OPTED_IN
  OPTED_OUT
  UNKNOWN
}

model MarketingPermission {
  customerId    String                    @map("customer_id")
  restaurantId  String                    @map("restaurant_id")
  channel       MarketingChannel
  status        MarketingPermissionStatus
  source        String
  policyVersion String                    @map("policy_version")
  changedAt     DateTime                  @map("changed_at")
  proofEventId  String                    @map("proof_event_id")

  @@id([customerId, channel])
  @@index([restaurantId, channel, status])
  @@map("marketing_permissions")
}

model MarketingConsentEvent {
  id            String                    @id @default(uuid())
  customerId    String                    @map("customer_id")
  restaurantId  String                    @map("restaurant_id")
  channel       MarketingChannel
  status        MarketingPermissionStatus
  source        String
  context       String
  policyVersion String                    @map("policy_version")
  actorHash     String?                   @map("actor_hash")
  occurredAt    DateTime                  @default(now()) @map("occurred_at")

  @@index([customerId, channel, occurredAt(sort: Desc)])
  @@index([restaurantId, occurredAt])
  @@map("marketing_consent_events")
}
```

La projection `MarketingPermission` et l'événement sont écrits dans la même transaction. `proofEventId` pointe vers le dernier événement appliqué. Tout opt-out gagne sur un opt-in concurrent ou plus ancien.

### 32.2 Compatibilité

1. backfill `marketingOptIn=true` vers le canal dont la preuve explicite existe ;
2. absence de canal prouvé → `UNKNOWN`, jamais `OPTED_IN` par défaut ;
3. dual-write pendant un cycle ;
4. shadow comparison ;
5. bascule des campagnes sur `MarketingPermission` ;
6. conservation du champ historique jusqu'à une migration ultérieure explicitement approuvée.

## 33. Campagnes et automatisations

**État local au 14 septembre 2026 : PARTIEL LIVRÉ.** Les modèles réellement utilisés sont
`MarketingCampaign`, `CampaignAudienceMember`, `CampaignMessage`, `MarketingAutomation` et les
tables d'attribution/fréquence. Les services, workers, callbacks signés, dry-run, preview tarifé
et inbox de réconciliation sont codés derrière `MARKETING_SENDS_ENABLED=false`. Les extraits
ci-dessous restent un contrat cible ; la configuration provider, les fixtures réelles et le pilote
d'envoi sont les seuls travaux de qualification restants.

### 33.1 Modèles principaux

```prisma
enum MarketingCampaignStatus {
  DRAFT
  READY
  SCHEDULED
  SENDING
  SENT
  PAUSED
  CANCELLED
  FAILED
}

enum MarketingMessageStatus {
  PENDING
  CLAIMED
  ACCEPTED
  DELIVERED
  FAILED
  UNKNOWN
  SUPPRESSED
}

model MarketingCampaign {
  id                 String                  @id @default(uuid())
  restaurantId       String                  @map("restaurant_id")
  segmentId          String?                 @map("segment_id")
  name               String
  objective          String
  channel            MarketingChannel
  status             MarketingCampaignStatus @default(DRAFT)
  templateVersion    Int                     @map("template_version")
  subjectTemplate    String?                 @map("subject_template")
  bodyTemplate       String                  @map("body_template")
  scheduledAt        DateTime?               @map("scheduled_at")
  startedAt          DateTime?               @map("started_at")
  completedAt        DateTime?               @map("completed_at")
  pauseReason        String?                 @map("pause_reason")
  attributionDays    Int                     @default(14) @map("attribution_days")
  createdByHash      String                  @map("created_by_hash")
  createdAt          DateTime                @default(now()) @map("created_at")
  updatedAt          DateTime                @updatedAt @map("updated_at")

  audience CampaignAudienceMember[]
  messages MarketingCampaignMessage[]

  @@index([restaurantId, status, scheduledAt])
  @@map("marketing_campaigns")
}

model CampaignAudienceMember {
  campaignId      String   @map("campaign_id")
  customerId      String   @map("customer_id")
  inclusionReason Json     @map("inclusion_reason")
  permissionEventId String @map("permission_event_id")
  status          String
  createdAt       DateTime @default(now()) @map("created_at")

  campaign MarketingCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)

  @@id([campaignId, customerId])
  @@index([customerId, createdAt])
  @@map("campaign_audience_members")
}

model MarketingCampaignMessage {
  id                String                 @id @default(uuid())
  campaignId        String                 @map("campaign_id")
  customerId        String                 @map("customer_id")
  channel           MarketingChannel
  status            MarketingMessageStatus @default(PENDING)
  renderedBodyHash  String                 @map("rendered_body_hash")
  provider          String?
  providerMessageId String?                @unique @map("provider_message_id")
  idempotencyKey    String                 @unique @map("idempotency_key")
  attemptedAt       DateTime?              @map("attempted_at")
  deliveredAt       DateTime?              @map("delivered_at")
  failureCode       String?                @map("failure_code")
  cost              Decimal?               @db.Decimal(12, 6)
  createdAt         DateTime               @default(now()) @map("created_at")
  updatedAt         DateTime               @updatedAt @map("updated_at")

  campaign MarketingCampaign @relation(fields: [campaignId], references: [id], onDelete: Cascade)

  @@unique([campaignId, customerId, channel])
  @@index([campaignId, status])
  @@index([customerId, createdAt])
  @@map("marketing_campaign_messages")
}
```

Le corps rendu peut être stocké chiffré avec une rétention courte si le support doit pouvoir le consulter. À défaut, stocker uniquement son hash et les variables non sensibles utilisées.

### 33.2 Automatisations

```prisma
model MarketingAutomation {
  id                   String   @id @default(uuid())
  restaurantId         String   @map("restaurant_id")
  type                 String
  config               Json
  version              Int      @default(1)
  enabled              Boolean  @default(false)
  lastEvaluatedAt      DateTime? @map("last_evaluated_at")
  createdAt            DateTime @default(now()) @map("created_at")
  updatedAt            DateTime @updatedAt @map("updated_at")

  @@unique([restaurantId, type])
  @@index([enabled, type])
  @@map("marketing_automations")
}
```

Configurations Zod distinctes par `type`. Aucun JSON arbitraire n'atteint directement une requête ou un template.

### 33.3 Exécution d'une campagne

```mermaid
sequenceDiagram
  participant UI as Dashboard
  participant API as Marketing API
  participant DB as PostgreSQL
  participant O as Outbox Dispatcher
  participant Q as BullMQ
  participant W as Marketing Worker
  participant P as SMS/Email Provider

  UI->>API: POST /marketing/campaigns/:id/schedule
  API->>DB: transaction: status=SCHEDULED + audience snapshot + outbox
  O->>DB: claim outbox event
  O->>Q: jobId=campaign_start_<id>
  W->>DB: reload campaign + entitlement
  W->>DB: recheck permission + frequency for each member
  W->>DB: claim unique message row
  W->>P: send with provider idempotency key
  P-->>W: accepted/refused/unknown
  W->>DB: persist result + usage + audit
  P-->>API: delivery webhook
  API->>DB: idempotent delivery update
```

### 33.4 Job contracts

```ts
type CampaignStartJob = {
  kind: 'campaign.start';
  campaignId: string;
  outboxEventId: string;
};

type MarketingSendJob = {
  kind: 'marketing.send';
  campaignId: string;
  messageId: string;
};

type MarketingReconcileJob = {
  kind: 'marketing.reconcile';
  messageId: string;
  provider: 'telnyx' | 'resend';
  providerMessageId?: string;
};
```

Job IDs :

- `campaign_start_<campaignId>_<version>` ;
- `marketing_send_<messageId>` ;
- `marketing_reconcile_<messageId>_<attempt>`.

La ligne `MarketingCampaignMessage.idempotencyKey` constitue l'autorité durable. Redis évite le travail concurrent, mais sa perte ne permet pas un second envoi.

## 34. Attribution et conversion

**État local au 14 septembre 2026 : PARTIEL LIVRÉ.** Les liens HMAC opaques, clics, conversions
créées/honorées/annulées, rapport et export CSV sont implémentés dans
`marketing-attribution.service.ts` et `marketing-report.service.ts`. Le revenu encaissé POS et
la comparaison temporelle restent ouverts.

### 34.1 Modèle

```prisma
enum CampaignConversionType {
  RESERVATION_CREATED
  RESERVATION_HONORED
  REVENUE_ESTIMATED
  REVENUE_CAPTURED
  RESERVATION_CANCELLED
}

model CampaignTouch {
  id             String   @id @default(uuid())
  campaignId     String   @map("campaign_id")
  customerId     String   @map("customer_id")
  tokenHash      String   @unique @map("token_hash")
  firstOpenedAt  DateTime? @map("first_opened_at")
  expiresAt      DateTime @map("expires_at")
  createdAt      DateTime @default(now()) @map("created_at")

  @@index([customerId, createdAt])
  @@map("campaign_touches")
}

model CampaignConversion {
  id             String                 @id @default(uuid())
  campaignId     String                 @map("campaign_id")
  customerId     String                 @map("customer_id")
  reservationId  String?                @map("reservation_id")
  posCheckId     String?                @map("pos_check_id")
  type           CampaignConversionType
  amount         Decimal?               @db.Decimal(12, 2)
  currency       String                 @default("EUR")
  attribution    String
  dedupeKey      String                 @unique @map("dedupe_key")
  occurredAt     DateTime               @map("occurred_at")
  createdAt      DateTime               @default(now()) @map("created_at")

  @@index([campaignId, type, occurredAt])
  @@index([reservationId])
  @@map("campaign_conversions")
}
```

### 34.2 Règle v1

- last eligible campaign touch avant création de réservation ;
- même client et même restaurant ;
- fenêtre par campagne, 14 jours par défaut ;
- source directe sans campagne conserve l'attribution précédente uniquement si le token a été utilisé ;
- une annulation écrit une conversion compensatrice, sans supprimer l'événement initial ;
- `HONORED` produit une conversion visite ;
- `REVENUE_CAPTURED` exige un PaymentIntent encaissé ou un ticket POS rapproché.

La requête de rapport somme les événements par type ; elle ne mute pas les anciennes conversions.

## 35. API Fastify proposée

Toutes les routes dashboard utilisent `requireOrg()` puis une capability. Le `restaurantId` vient exclusivement du contexte serveur ; il n'est jamais accepté dans query/body pour déterminer le tenant.

### 35.1 CRM

| Méthode | Route                                          | Capability                   | Notes                                         |
| ------- | ---------------------------------------------- | ---------------------------- | --------------------------------------------- |
| GET     | `/crm/customers`                               | `crm.profile`                | curseur, recherche normalisée, filtres bornés |
| GET     | `/crm/customers/:id`                           | `crm.profile`                | profil, métriques et chronologie paginée      |
| PATCH   | `/crm/customers/:id`                           | `crm.profile.write`          | Zod, audit, invalidation cache                |
| GET     | `/crm/customers/:id/timeline`                  | `crm.profile`                | `cursor`, `limit<=100`                        |
| POST    | `/crm/customers/:id/tags`                      | `crm.advanced`               | assignation manuelle idempotente              |
| DELETE  | `/crm/customers/:id/tags/:tagId`               | `crm.advanced`               | retire seulement le tag manuel                |
| POST    | `/crm/customers/:id/merge-preview`             | `crm.merge`                  | lecture sans mutation                         |
| POST    | `/crm/customers/:id/merge`                     | `crm.merge`                  | `Idempotency-Key` obligatoire                 |
| GET     | `/crm/duplicates`                              | `crm.merge`                  | candidats avec score explicable               |
| GET     | `/crm/customers/:id/projection-repair-preview` | `customers.advanced`         | comparaison métriques/réservations            |
| POST    | `/crm/customers/:id/projection-repair`         | `customers.advanced` + Owner | réparation idempotente et audit agrégé        |

### 35.2 Segments

| Méthode | Route                         | Notes                                          |
| ------- | ----------------------------- | ---------------------------------------------- |
| POST    | `/marketing/segments/preview` | valide AST, retourne count + échantillon borné |
| POST    | `/marketing/segments`         | crée définition versionnée                     |
| GET     | `/marketing/segments`         | liste, count, dernière évaluation              |
| GET     | `/marketing/segments/:id`     | définition et métadonnées                      |
| PATCH   | `/marketing/segments/:id`     | incrémente `definitionVersion`                 |
| DELETE  | `/marketing/segments/:id`     | refus si campagne planifiée dépendante         |

### 35.3 Campagnes

| Méthode | Route                                 | Transition                                                        |
| ------- | ------------------------------------- | ----------------------------------------------------------------- |
| POST    | `/marketing/campaigns`                | crée `DRAFT`                                                      |
| PATCH   | `/marketing/campaigns/:id`            | modifie seulement `DRAFT`/`READY`                                 |
| POST    | `/marketing/campaigns/:id/preview`    | rendu + snapshot + unités + coût transparent                      |
| POST    | `/marketing/campaigns/:id/test`       | dry-run gérant ; provider bloqué jusqu'au pilote                  |
| POST    | `/marketing/campaigns/:id/schedule`   | `READY → SCHEDULED`                                               |
| POST    | `/marketing/campaigns/:id/pause`      | `SCHEDULED/SENDING → PAUSED`                                      |
| POST    | `/marketing/campaigns/:id/cancel`     | état terminal, messages non réclamés supprimés                    |
| GET     | `/marketing/campaigns/:id/report`     | agrégats et conversions                                           |
| GET     | `/marketing/campaigns/:id/report.csv` | export UTF-8 agrégé sans PII                                      |
| GET     | `/marketing/providers/readiness`      | flags, configuration et noms de variables manquantes, sans secret |
| GET     | `/marketing/suppressions`             | lecture des opt-out/bounces                                       |
| POST    | `/marketing/unsubscribe/:token`       | route publique signée et limitée                                  |

### 35.4 Erreurs stables

```json
{
  "error": {
    "code": "MARKETING_PERMISSION_REQUIRED",
    "message": "Ce client ne peut pas recevoir ce message.",
    "requestId": "..."
  }
}
```

Codes minimum : `FEATURE_NOT_INCLUDED`, `INVALID_SEGMENT`, `CAMPAIGN_NOT_EDITABLE`, `MARKETING_PERMISSION_REQUIRED`, `FREQUENCY_CAP_REACHED`, `IDEMPOTENCY_CONFLICT`, `PROVIDER_OUTCOME_UNKNOWN`, `CUSTOMER_MERGE_CONFLICT`, `POS_CONNECTION_UNHEALTHY`, `PAYMENT_REQUIRED`.

## 36. Protection bancaire : architecture technique

### 36.1 Schéma

```prisma
enum ReservationPaymentType {
  CARD_GUARANTEE
  DEPOSIT
  PREPAYMENT
}

enum ReservationPaymentStatus {
  REQUIRES_PAYMENT_METHOD
  REQUIRES_ACTION
  AUTHORIZED
  CAPTURED
  PARTIALLY_REFUNDED
  REFUNDED
  FAILED
  CANCELLED
  EXPIRED
}

model ReservationPaymentPolicy {
  id                 String   @id @default(uuid())
  restaurantId       String   @map("restaurant_id")
  version            Int
  type               ReservationPaymentType
  amountMode         String   @map("amount_mode")
  amount             Decimal  @db.Decimal(10, 2)
  minPartySize       Int?     @map("min_party_size")
  cancellationHours  Int      @map("cancellation_hours")
  rules              Json
  activeFrom         DateTime @map("active_from")
  activeUntil        DateTime? @map("active_until")
  createdAt          DateTime @default(now()) @map("created_at")

  @@unique([restaurantId, version])
  @@index([restaurantId, activeFrom, activeUntil])
  @@map("reservation_payment_policies")
}

model ReservationPayment {
  id                    String                   @id @default(uuid())
  restaurantId          String                   @map("restaurant_id")
  reservationId         String                   @map("reservation_id")
  policyId              String                   @map("policy_id")
  status                ReservationPaymentStatus
  amount                Decimal                  @db.Decimal(10, 2)
  currency              String                   @default("EUR")
  stripeAccountId       String                   @map("stripe_account_id")
  stripeSetupIntentId   String?                  @unique @map("stripe_setup_intent_id")
  stripePaymentIntentId String?                  @unique @map("stripe_payment_intent_id")
  idempotencyKey        String                   @unique @map("idempotency_key")
  policySnapshot        Json                     @map("policy_snapshot")
  expiresAt             DateTime?                @map("expires_at")
  createdAt             DateTime                 @default(now()) @map("created_at")
  updatedAt             DateTime                 @updatedAt @map("updated_at")

  @@index([restaurantId, status, createdAt])
  @@index([reservationId])
  @@map("reservation_payments")
}
```

### 36.2 Invariant principal

Une réservation soumise à dépôt/prépaiement reste `PENDING` et sa capacité est protégée par un hold expirant. Elle ne passe `CONFIRMED` qu'après webhook Stripe signé et traité. Le retour navigateur ne confirme jamais le paiement.

### 36.3 Webhooks

Réutiliser le registre `StripeWebhookEvent` pour idempotence, mais séparer les handlers Billing et Reservation Payments. Vérifier `account` Connect, devise, montant, metadata `restaurantId/reservationId/paymentId` et transition autorisée avant toute écriture.

## 37. Intégration POS : architecture technique

### 37.1 Schéma minimal

```prisma
enum PosConnectionStatus {
  PENDING
  ACTIVE
  DEGRADED
  REAUTH_REQUIRED
  DISCONNECTED
}

model PosConnection {
  id                   String              @id @default(uuid())
  restaurantId         String              @map("restaurant_id")
  provider             String
  externalLocationId   String              @map("external_location_id")
  credentialReference  String              @map("credential_reference")
  status               PosConnectionStatus @default(PENDING)
  cursor               String?
  lastSuccessAt        DateTime?           @map("last_success_at")
  lastAttemptAt        DateTime?           @map("last_attempt_at")
  lastErrorCode        String?             @map("last_error_code")
  createdAt            DateTime            @default(now()) @map("created_at")
  updatedAt            DateTime            @updatedAt @map("updated_at")

  @@unique([restaurantId, provider])
  @@index([status, lastSuccessAt])
  @@map("pos_connections")
}

model PosCheck {
  id                  String   @id @default(uuid())
  restaurantId        String   @map("restaurant_id")
  connectionId        String   @map("connection_id")
  externalId          String   @map("external_id")
  externalRevision    String?  @map("external_revision")
  openedAt            DateTime @map("opened_at")
  closedAt            DateTime? @map("closed_at")
  tableReference      String?  @map("table_reference")
  subtotal            Decimal  @db.Decimal(12, 2)
  tax                 Decimal  @db.Decimal(12, 2)
  tip                 Decimal  @default(0) @db.Decimal(12, 2)
  discount            Decimal  @default(0) @db.Decimal(12, 2)
  total               Decimal  @db.Decimal(12, 2)
  refundedAmount      Decimal  @default(0) @map("refunded_amount") @db.Decimal(12, 2)
  currency            String
  rawPayloadHash      String   @map("raw_payload_hash")
  importedAt          DateTime @default(now()) @map("imported_at")
  updatedAt           DateTime @updatedAt @map("updated_at")

  @@unique([connectionId, externalId])
  @@index([restaurantId, closedAt])
  @@map("pos_checks")
}

model ReservationCheckMatch {
  reservationId String   @map("reservation_id")
  posCheckId    String   @map("pos_check_id")
  method        String
  confidence    Decimal  @db.Decimal(4, 3)
  status        String
  reviewedByHash String? @map("reviewed_by_hash")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@id([reservationId, posCheckId])
  @@index([status, confidence])
  @@map("reservation_check_matches")
}
```

`credentialReference` pointe vers un secret stocké hors base ou chiffré avec une clé de chiffrement séparée. Aucun token fournisseur n'apparaît dans Prisma logs, Sentry, API ou dashboard.

### 37.2 Synchronisation

- Webhook signé si disponible, polling incrémental sinon.
- Curseur avancé seulement après commit de la page complète.
- Upsert par `(connectionId, externalId)` et révision.
- Fenêtre de recouvrement de 48 h pour corrections tardives.
- Full reconcile nocturne borné aux 7 derniers jours.
- `DEGRADED` après trois échecs consécutifs ; `REAUTH_REQUIRED` sur 401/403 stable.
- Alerte si `lastSuccessAt` dépasse deux cycles normaux.

### 37.3 Algorithme de matching v1

Score explicable sur 100 :

- ID de réservation transmis au POS : 100 ;
- même table : +35 ;
- ouverture dans une fenêtre de ±45 minutes : +30 ;
- nombre de couverts compatible : +20 ;
- même téléphone/token fournisseur vérifié : +40 ;
- conflit avec une autre réservation confirmée : −50.

`>=80` : rapprochement automatique ; `50–79` : proposition manuelle ; `<50` : non rapproché. Les seuils sont versionnés et observés en shadow mode avant automatisation.

## 38. Autorisation et isolation

### 38.1 Capabilities utilisateur

Matrice locale actuelle (la colonne « Notes sensibles » est appliquée par la politique du site,
configurable via `GET/PATCH /crm/privacy`, avec fallback `CRM_SENSITIVE_NOTE_ROLES` à
`OWNER,MANAGER`) :

| Rôle    | CRM                     | Notes sensibles | Campagnes     | Paiements       | POS     | Groupe          |
| ------- | ----------------------- | --------------- | ------------- | --------------- | ------- | --------------- |
| OWNER   | lecture/écriture/fusion | oui             | tout          | tout            | tout    | tout            |
| MANAGER | lecture/écriture        | oui             | créer/envoyer | opérationnel    | lecture | sites autorisés |
| STAFF   | lecture service limitée | non             | non           | état uniquement | non     | site courant    |

Les rôles actuels restent des chaînes et le mapping de capabilities est en TypeScript. La politique
de notes est déjà surchargeable par établissement via `Restaurant.crmSensitiveNoteRoles` et les
routes Owner `/crm/privacy`; la valeur nulle revient au fallback environnement. Une migration vers
des enums n'est pas nécessaire pour fermer la porte Pro et reste hors périmètre courant.

### 38.2 Règles de requête

- Toute requête Prisma inclut `restaurantId` ou un `accountId` résolu par le serveur.
- Toute mutation relit la ligne avec son tenant avant update/delete.
- Les identifiants dans body ne définissent jamais le scope.
- Les exports et campagnes ont une limite de volume et un audit.
- Les endpoints publics utilisent tokens signés, hashés en base, expirants et à usage borné.
- Les tests utilisent deux organisations, deux sites et trois rôles réels ou des sessions cryptographiquement valides de staging.

## 39. Stratégie de migrations et déploiement

Chaque grand domaine suit six étapes :

1. **Expand** : créer tables, enums et colonnes optionnelles ; générer Prisma ; aucun nouveau chemin actif.
2. **Dual-write** : écrire ancien et nouveau modèles sous flag ; comparer compteurs et erreurs.
3. **Backfill** : traiter par lots, checkpoint durable, dry-run, reprise et rapport.
4. **Shadow-read** : calculer l'ancienne et la nouvelle réponse, journaliser seulement les divergences agrégées.
5. **Switch** : activer lecture/worker sur un canary, puis 10 %, 50 %, 100 %.
6. **Contract différé** : supprimer l'ancien chemin seulement après au moins un cycle de rétention et une décision explicite.

### 39.1 Ordre des migrations proposées

| Migration | Contenu                                           | Backfill                                                                                                                 |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| M01       | outbox + usage events/rollups                     | aucun                                                                                                                    |
| M02       | entitlement overrides                             | plans existants restent source                                                                                           |
| M03       | identités, timeline, préférences, tags, métriques | téléphone + événements réservation/appel                                                                                 |
| M04       | segments                                          | segments système seedés                                                                                                  |
| M05       | permissions marketing par canal                   | uniquement preuves explicites                                                                                            |
| M06       | campagnes, audience, messages                     | campagne legacy conservée                                                                                                |
| M07       | touches et conversions                            | sources récentes si traçables                                                                                            |
| M07b      | automations bornées et claims                     | aucune donnée destructive ; réactivation à migrer                                                                        |
| M08       | politiques et paiements réservation               | aucun                                                                                                                    |
| M09       | connexions et tickets POS                         | aucun                                                                                                                    |
| M10       | identité groupe                                   | après validation juridique/produit                                                                                       |
| M11       | feedback, recovery et perks                       | fondation feedback/recovery matérialisée par `20260914170000_reputation_feedback_foundation` ; aucun backfill destructif |

Chaque migration contient une requête de préflight, un plan de rollback applicatif et une validation post-migration. Les migrations financières n'ont pas de rollback destructeur automatique.

Sur la branche de travail, M01/M02 et les lots CRM/marketing correspondants sont matérialisés par
les migrations `20260913170000_outbox_and_usage_tariffs`, puis
`20260913210000_customer_crm_core` à `20260913290000_customer_segment_system_keys`. Elles restent
locales : le passage staging demandera les contrôles PostgreSQL, le backfill et le plan de
rollback de chaque migration.

## 40. Plan de tests technique

### 40.1 Pyramide minimale par module

| Niveau                     | Ce qui est testé                                                            |
| -------------------------- | --------------------------------------------------------------------------- |
| Unit                       | validation Zod, transitions, compilation segment, calcul coût, matching POS |
| Service avec mocks stricts | erreurs fournisseur, permission, entitlement, idempotence                   |
| PostgreSQL réel            | contraintes uniques, transactions, locks, concurrence, backfill             |
| Queue                      | jobId stable, retry, dead-letter, lease expiré, replay                      |
| Contract provider          | payload et signature webhook sur fixtures officielles                       |
| API inject                 | auth, tenant, status HTTP, pagination, rate limit                           |
| Dashboard                  | loading/empty/error/data, permissions, formulaires                          |
| Playwright                 | création campagne, désinscription, paiement, changement de site             |
| Staging                    | envoi réel borné, Stripe test, POS sandbox, rollback                        |

### 40.2 Cas de concurrence obligatoires

- deux webhooks identiques ;
- deux workers réclament le même message ;
- opt-out pendant l'envoi ;
- annulation de campagne pendant le claim ;
- downgrade avant exécution ;
- fusion client pendant création de réservation ;
- ticket POS corrigé pendant agrégation ;
- paiement reçu après expiration du hold ;
- remboursement et rapprochement exécutés simultanément ;
- deux backfills lancés accidentellement.

### 40.3 Invariants testés en base

- un seul `UsageEvent` par `sourceEventKey` ;
- une seule identité normalisée par restaurant/type ;
- un seul message par campagne/client/canal ;
- un seul provider message ID ;
- un opt-out actif exclut toujours l'envoi ;
- une conversion a un `dedupeKey` unique ;
- un PaymentIntent ne finance qu'un `ReservationPayment` ;
- un ticket POS externe possède une seule projection locale par connexion ;
- toute ligne mutable est accessible seulement depuis son tenant.

## 41. Découpage technique des 12 sprints

### Sprint 1 — Outbox et usage voix

**Avancement au 15 septembre 2026 : PARTIEL LIVRÉ.** Le schéma additif `UsageEvent` /
`UsageMonthlyRollup`, le recorder idempotent résistant à une collision `P2002`, le recalcul mensuel,
`GET /usage/current`, `GET /usage/history`, l'outbox `PENDING → DISPATCHED`, le catalogue
`UsageTariff` et les compteurs STT/TTS/LLM sont implémentés. `call.hangup` et les clôtures de
session écrivent des intentions idempotentes ; les tarifs sans ligne restent `UNPRICED`. Le
dispatcher outbox tourne chaque minute et les rollups courant/précédent sont recalculés chaque
heure. Les adaptateurs Telnyx/Resend collectent désormais les SMS segmentés (GSM-7/UCS-2), les
messages WhatsApp et les emails dès l'acceptation fournisseur, avec contexte métier sans PII et
clé d'idempotence commune à l'outbox. La preuve PostgreSQL concurrente locale (2/2 sur une base
dédiée) est maintenant exécutée. Restent le chargement des prix validés par facture, le
rapprochement fournisseur et l'import comptable aval, suivis comme écarts internes dans la
réconciliation des audits.
Décisions d'architecture : [`architecture/adr-usage-ledger-and-costing.md`](./architecture/adr-usage-ledger-and-costing.md) et [`architecture/adr-transactional-outbox.md`](./architecture/adr-transactional-outbox.md).

**Fichiers :** migration M01, module `shared/outbox`, module `usage`, hooks dans `telnyx.pipeline.ts`, `stt-bridge.ts`, `tts-handler.ts` et `llm-handler.ts`.

**Livrables :**

- `OutboxEvent`, dispatcher et récupération de lease ;
- `UsageEvent`, recorder idempotent et rollup ;
- collecte téléphonie/STT/TTS/LLM et messagerie avec estimation explicite si le provider ne renvoie pas ses tokens ;
- route interne de comparaison avec un appel ;
- tests Postgres de rejeu et dispatcher concurrent.

**Done :** un appel réel est ventilé sans doublon et son coût estimé est rapprochable.

### Sprint 2 — Entitlements et usage dashboard

**Avancement au 14 septembre 2026 : PARTIEL LIVRÉ.** La matrice canonique, la normalisation des plans,
`GET /entitlements`, le garde serveur et l'enforcement de `reactivation.manage` sont implémentés.
Le ledger, ses lectures API (`/usage/current` et `/usage/history`), l'alias opérateur historique
`/dashboard/usage` vers `/admin/margin`, les collecteurs de messagerie et la projection de
consommation explicitement `UNLIMITED` de `GET /usage/current` sont disponibles.
L'évaluateur déterministe et le worker horaire de seuils 70/90/100 % servent uniquement à un suivi
interne optionnel et réclament chaque jalon une seule fois avec Redis ; le flag reste désactivé par
défaut. Un feed strictement interne
`GET /api/internal/usage/margin` protégé par `SOKAR_INTERNAL_USAGE_TOKEN` agrège quantité, coût et
statut `PRICED/UNPRICED/MIXED`. La projection de marge applique maintenant les corrections
`APPROVED` bornées à un établissement tout en conservant le coût source ; le cockpit permet de télécharger le suivi interne des usages et corrections approuvées. La facture
Telnyx d'août, le paquet fichier et le contrôle non nul de mai sont consignés ; le raccordement
comptable et le rattachement/conversion du trafic non nul sont différés et suivis séparément. La
preuve d'un parcours non nul de bout en bout reste liée aux validations terrain. Décision
d'architecture :
[`architecture/adr-entitlements-vs-feature-flags.md`](./architecture/adr-entitlements-vs-feature-flags.md).

**Fichiers :** `packages/config/src/entitlements.ts`, module `entitlements`, routes usage, page dashboard usage, ConfigCat wrappers.

**Livrables :**

- matrice de capabilities ;
- enforcement serveur ;
- suivi des volumes voix/SMS sans quota client ;
- suivi interne optionnel 70/90/100 % ;
- marge interne ;
- tests downgrade et job planifié.

**Done :** Essential et Pro ont des droits observables et les coûts ne fuient pas au client.

### Sprint 3 — Qualification voix/réservation

**Fichiers :** harness voix existant, tests réservation/floor-plan, fixtures appels.

**Livrables :** matrice des scénarios, corrections bloquantes, corrélation call/reservation/audit, rapport par scénario.

**Done :** aucun scénario critique ne crée une réservation différente du récapitulatif confirmé.

### Sprint 4 — Notifications durables

**Fichiers :** adapter du système `notification-idempotency`, modèle durable de résultat, callbacks Telnyx/Resend, dashboard erreurs.

**Livrables :** états, provider IDs, réconciliation, retry et renvoi manuel.

**Done :** chaque notification obligatoire a un résultat explicite ou une action support.

### Sprint 5 — Onboarding et activation

**Avancement au 14 septembre 2026 : PARTIEL LIVRÉ.** L'onboarding dashboard, le provisioning
Telnyx, l'appel test et la vue santé existent. Les preuves sont maintenant séparées : le webhook,
le renvoi opérateur et la confirmation de réception de l'appel test ont chacun leur étape et leur
mutation. Un appel déclenché reste `TEST_CALL_PENDING` jusqu'à la confirmation du `callControlId`.
La finalisation admin passe par `ProvisioningService.completeProvisioning` : elle refuse `ACTIVE`
si le numéro, le webhook, le renvoi ou la preuve d'appel test manquent et retourne
`PROVISIONING_NOT_READY` avec la liste des prérequis. Cette garde ne remplace pas un appel réel ni
la checklist signée du pilote.

**Fichiers :** onboarding API/dashboard existant, provisioning, health, runbooks.

**Livrables :** readiness score, blockers, test call, failover, checklist signée.

**Done :** un nouveau restaurant peut être activé sans intervention technique improvisée.

### Sprint 6 — Prix et pilotes Essential

**Fichiers :** constantes prix, page pricing, billing service/tests, docs contractuelles.

**Livrables locaux :** prix 199/299, prix annuels calculés, surfaces publiques, parcours
d'inscription, mapping Checkout et tests de facturation. Les nouveaux `priceId` Stripe, la facture
sandbox et les deux pilotes restent externes.

**Done local :** l'affichage, les constantes, les alias historiques, le calcul ROI et le contrat
Checkout utilisent la même grille ; la première facture Essential à 199 € reste à valider après
création des prix Stripe.

### Sprint 7 — Noyau CRM

**Fichiers :** migration M03, module CRM, dual-write dans `CustomerService`, projection depuis outbox.

**Livrables :** identité, timeline, métriques, backfill avec checkpoint.

**Done :** données historiques et nouvelles produisent le même profil attendu.

### Sprint 8 — Préférences, tags et fusion

**Fichiers :** services CRM, `customer-merge.service.ts`, routes merge, migration d'audit,
extensions RGPD et pages dashboard CRM liste/détail/doublons.

**Livrables :** tags, préférences, preview/merge et audit.

**Done local :** preview, mutation idempotente et réparation de projection testés sans croisement de
tenant ; la preuve de concurrence PostgreSQL reste à exécuter.

### Sprint 9 — Segments

**Fichiers :** migration M04, AST Zod, compiler, preview, routes CRUD/refresh, page dashboard segments.

**Livrables :** huit segments système persistés, constructeur borné et explication inclusion.

**Done :** preview et snapshot retournent le même ensemble à version identique.

### Sprint 10 — Campagnes

**Fichiers :** M05/M06, marketing services/routes/workers, interfaces providers, éditeur dashboard.

**Livrables :** campagne SMS, preview, test, schedule, pause, états durables.

**Done :** un rejeu complet n'envoie aucun doublon.

### Sprint 11 — Automatisations et conformité

**Fichiers :** automation worker, permission service, unsubscribe public route, worker de fréquence.

**Livrables locaux :** première visite, dormant, anniversaire, interface dashboard, opt-out immédiat,
claims PostgreSQL dédupliqués, transitions callback bounce/complaint et inbox de réconciliation des
IDs inconnus. La configuration provider et la suppression fournisseur restent à raccorder.

**Done local :** un rejeu complet ne crée aucun second dispatch pour un même client et déclencheur ;
le worker ré-enfile les campagnes `READY` après une panne Redis quand les envois sont autorisés.

### Sprint 12 — Attribution et pilote Pro

**Fichiers :** M07, tracking link, attribution worker, report API/dashboard.

**Livrables :** touches, conversions, rapport estimé/encaissé, export CSV, pilote Pro.

**Done :** une campagne pilote relie audience → livraison → réservation → visite avec chiffres reproductibles.

## 42. Gates CI et rollout

### 42.1 Checks requis par PR

- `pnpm node:check` ;
- typecheck du package/app modifié ;
- tests unitaires ciblés ;
- tests API avec PostgreSQL pour toute migration ou transaction ;
- lint et format ;
- build du dashboard pour toute nouvelle page ;
- `pnpm lint:css` pour les changements UI ;
- tests de contrat si un provider change ;
- scan secret sur fixtures et logs.

### 42.2 Flags proposés

- `usageLedgerV1` ;
- `planEntitlementsV1` ;
- `crmProjectionV1` ;
- `crmAdvancedV1` ;
- `marketingCampaignsV1` ;
- `marketingAutomationsV1` ;
- `campaignAttributionV1` ;
- `reservationPaymentsV1` ;
- `posIntegrationV1` ;
- `groupCrmV1`.

Chaque flag possède un défaut sûr, un owner, une date de revue et une métrique d'activation. Les kill switches ne doivent pas invalider des écritures financières déjà acceptées ; ils arrêtent les nouvelles opérations et laissent la réconciliation active.

### 42.3 Progression

```text
local/tests → staging shadow → restaurant interne → 1 pilote
→ 2 pilotes → 10 % → 50 % → 100 %
```

Passage au niveau suivant seulement si :

- zéro violation d'invariant ;
- aucune fuite tenant ;
- taux d'erreur sous le seuil du module ;
- métriques et alertes reçues ;
- rollback applicatif testé ;
- file de réconciliation vide ou expliquée.

## 43. Ordre des ADR à écrire ou compléter avant activation

1. `adr-usage-ledger-and-costing.md` : unités, arrondis, source tarifaire et rapprochement (compléter les tarifs facturés).
2. `adr-entitlements-vs-feature-flags.md` : autorité du plan, overrides et downgrade (livré, tests de migration à compléter).
3. `adr-transactional-outbox.md` : lease, dispatcher, rétention et recovery (CRM/marketing métier encore à brancher).
4. `adr-customer-identity-and-merge.md` : identifiants, conflits et règles RGPD.
5. `adr-crm-projections.md` : événements sources, reconstruction et versioning.
6. `adr-segment-ast.md` : opérateurs, compilation, limites et explication.
7. `adr-marketing-consent.md` : preuve par canal et compatibilité legacy (reprendre dans l'ADR control plane livré).
8. `adr-campaign-delivery.md` : idempotence, états provider et reconciliation (inbox provider inconnus livrée ; fixtures et pilote ouverts).
9. `adr-campaign-attribution.md` : fenêtre et hiérarchie des revenus (visite honorée et coût rapproché ouverts).
10. `adr-reservation-payment-merchant-model.md` : Stripe Connect et responsabilité financière.
11. `adr-pos-connector-contract.md` : normalisation, secrets, sync et matching.
12. `adr-group-customer-identity.md` : partage inter-sites et consentement.

## 44. Première unité de travail prête à ouvrir

### Epic : `USAGE-001 — Ledger d'usage et coût complet d'un appel`

**Sous-tâches :**

1. écrire ADR usage + outbox ;
2. créer M01 avec `OutboxEvent`, `UsageEvent`, `UsageMonthlyRollup` ;
3. implémenter `OutboxService.enqueue(tx, event)` ;
4. implémenter le dispatcher avec `SKIP LOCKED` ;
5. implémenter `UsageRecorder.record()` avec `sourceEventKey` ;
6. brancher le webhook Telnyx final ;
7. brancher clôtures STT/TTS et réponses LLM ;
8. ajouter table tarifaire versionnée ;
9. créer rollup mensuel recalculable ;
10. exposer `/usage/current` ;
11. ajouter tests de rejeu, concurrence et panne Redis ;
12. déployer en shadow sur staging ;
13. effectuer un appel réel et rapprocher le résultat ;
14. activer sur le restaurant interne ;
15. documenter l'écart estimation/facture.

**Critères techniques de clôture :**

- aucune mutation métier ne dépend de Redis pour être durable ;
- une panne Redis laisse des outbox events `PENDING` qui repartent ensuite ;
- deux dispatchers concurrents ne perdent aucun événement ;
- un même webhook crée une seule consommation ;
- les quantités conservent leur précision avant arrondi d'affichage ;
- un recalcul produit exactement les mêmes rollups ;
- les payloads et métriques ne contiennent aucune PII ;
- la suppression d'un appel selon la politique RGPD n'efface pas les agrégats financiers anonymisés nécessaires, selon la règle juridique validée.
