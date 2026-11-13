# Positionnement Suppernote face à Zenchef

> **Statut : ACTIF — audit code et marché du 15 septembre 2026.**
> Cette comparaison distingue la capacité présente dans le dépôt, sa preuve terrain et la cible de
> la roadmap 199/299 €. Les fonctionnalités concurrentes et tarifs peuvent évoluer ; vérifier la
> [page officielle des formules Zenchef](https://www.zenchef.com/fr/formules) avant publication. Le
> profil de production courant et les portes ouvertes sont récapitulés dans la
> [réconciliation des audits](./audits/2026-09-15-current-state.md).

> Actualisation du cadrage produit le 29 octobre 2026 : Suppernote est une plateforme de réservation,
> d'organisation du service et de relation client, dont l'IA vocale est une fonction. La matrice
> concurrentielle ci-dessous reste un instantané daté, pas une validation actuelle des offres ni
> des capacités Zenchef. Pour les capacités Suppernote développées et leurs limites d'activation, voir
> la [carte produit](./PROJECT_MAP.md#ce-quest-sokar) et les portes de release.

## Lecture commerciale honnête

Suppernote a développé des parcours de réservation, de gestion de salle et de relation client, ainsi
qu'un assistant vocal et des modules complémentaires. Leur disponibilité commerciale et leurs
preuves terrain varient selon la fonction. La comparaison concurrentielle ci-dessous doit être
revérifiée avant d'affirmer un écart avec Zenchef.

Le positionnement défendable est :

> Suppernote aide les restaurants à gérer leurs réservations, préparer leur service et mieux connaître
> leurs clients. L'assistant vocal et les parcours en ligne font partie de cette plateforme.

Il ne faut pas vendre Suppernote comme un remplacement fonctionnel total de Zenchef tant que les epics
POS, activation fournisseur des campagnes, paiements de réservation, CRM groupe et réputation ne sont pas
prouvés en conditions réelles. Le moteur de fusion, les automations bornées, le socle de groupes,
les callbacks signés et l'inbox de réconciliation existent localement, mais cela ne constitue pas
une preuve de délivrabilité, de revenu encaissé ou d'isolation multi-identité.

## Prix : actuel et cible

Contrôle du 16 octobre 2026 : le catalogue local et les huit prix Stripe actifs (test et live)
sont alignés. L'écart 149/249 € signalé précédemment est résolu depuis la grille du 14 octobre.

| Offre      | Prix HT/mois                        | Annuel HT (−10 %)            | Stripe test et live                        |
| ---------- | ----------------------------------- | ---------------------------- | ------------------------------------------ |
| Essential  | 199 €                               | 2 149,20 €                   | conforme, Checkout et facture test rejoués |
| Pro        | 299 €                               | 3 229,20 €                   | conforme, Checkout et facture test rejoués |
| Multi-site | 299 € (1er site inclus) + 99 €/site | 3 229,20 € + 1 069,20 €/site | conforme, Checkout et facture test rejoués |

Le catalogue local est codé dans `packages/shared/src/pricing-catalog.cjs`, repris par
`packages/config/src/constants.ts`, `packages/shared/src/plan.ts`,
`apps/dashboard/src/app/constants.ts` et `apps/dashboard/src/app/pricing/page.tsx`.
`scripts/ops/verify-stripe-catalog.mjs` contrôle les huit `priceId` contre ce catalogue à chaque
déploiement. Les preuves et la procédure sont dans
[`runbooks/stripe-billing.md`](./runbooks/stripe-billing.md). Le prix facturé ne vaut pas preuve
fonctionnelle : la vente de Pro reste conditionnée aux preuves CRM/marketing et à l'activation
fournisseur ci-dessous.

Au 12 septembre 2026, Zenchef affiche publiquement Reserve 129 €, Manage 169 € et Grow 249 € par
mois, avec plusieurs options payantes. Cette référence vient de la
[page tarifaire officielle](https://www.zenchef.com/fr/formules) et doit être datée dans toute
proposition commerciale.

## Matrice fonctionnelle actuelle

Légende :

- `LIVRÉ` : code et tests présents ;
- `À PROUVER` : fonction présente, mais validation terrain ou partenaire incomplète ;
- `PARTIEL` : un sous-ensemble existe ;
- `ABSENT` : pas de parcours commercial utilisable.

| Domaine                                  | Suppernote au 15/09/2026     | Preuve Suppernote                                                                                                                                                                                                                                       | Position Zenchef publique                                                      |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Réservation dashboard                    | `LIVRÉ`                      | module `reservations`, pages dashboard                                                                                                                                                                                                                  | Inclus.                                                                        |
| Widget web                               | `LIVRÉ`                      | `apps/connect`, `apps/widget`, `/embed.js`                                                                                                                                                                                                              | Inclus.                                                                        |
| Appels pris par IA                       | `LIVRÉ`, qualité à suivre    | pipeline Telnyx + ElevenLabs + Cartesia                                                                                                                                                                                                                 | AI Concierge en option selon formule.                                          |
| Réservation par ChatGPT/Claude           | `LIVRÉ`                      | MCP Streamable HTTP, OAuth, E2E réels                                                                                                                                                                                                                   | Pas une capacité différenciante à revendiquer sans test concurrent daté.       |
| Plan de salle                            | `LIVRÉ`                      | module `floor-plan`, canvas dashboard                                                                                                                                                                                                                   | Inclus par Zenchef.                                                            |
| Allocation capacitaire                   | `LIVRÉ`                      | verrouillage transactionnel et availability capacity-aware                                                                                                                                                                                              | Plan de salle et créneaux intelligents annoncés.                               |
| Liste d'attente                          | `LIVRÉ`                      | service, workers de promotion/nettoyage                                                                                                                                                                                                                 | Incluse à partir de Manage.                                                    |
| Service Copilot                          | `À PROUVER`                  | recommandations et télémétrie dans `floor-plan`                                                                                                                                                                                                         | Aucune comparaison publique suffisamment précise.                              |
| Rappels SMS                              | `LIVRÉ`                      | queue `confirmationSms`                                                                                                                                                                                                                                 | Inclus ; SMS tarifés.                                                          |
| CRM de base                              | `LIVRÉ`                      | `Customer`, consentements, VIP, historique réservation/appel                                                                                                                                                                                            | CRM annoncé.                                                                   |
| CRM enrichi par dépenses POS             | `PARTIEL / LOCAL`            | fondation `PosConnection`/`PosCheck`/matcher prête, mais aucun connecteur ni dépense réelle raccordé                                                                                                                                                    | Intégrations POS annoncées.                                                    |
| Segments avancés calculés                | `PARTIEL / LOCAL`            | AST borné, compiler, preview/CRUD/refresh dans `customers`                                                                                                                                                                                              | Segmentation et outils clients annoncés.                                       |
| Automations marketing génériques         | `PARTIEL / LOCAL`            | trois déclencheurs bornés, worker, réactivation legacy migrée et callbacks signés locaux ; activation provider ouverte                                                                                                                                  | Suite Marketing et emails annoncés.                                            |
| Attribution réservation + CA             | `PARTIEL / LOCAL`            | liens HMAC, clic, rapport, réservation créée et visite honorée ; preuve de revenu encaissé ouverte                                                                                                                                                      | Analyses et revenus par canal annoncés.                                        |
| Empreinte bancaire / acompte réservation | `PARTIEL / LOCAL`            | policies, préparation idempotente, transitions et webhook signé/hashé derrière `RESERVATION_PAYMENTS_ENABLED=false` ; aucun intent, hold, capture ou remboursement réel                                                                                 | Empreinte, prépaiement et acompte annoncés.                                    |
| Cartes cadeaux                           | `LIVRÉ`, finance à qualifier | module `gift-cards`, widget, dashboard, Stripe                                                                                                                                                                                                          | Chèques-cadeaux annoncés.                                                      |
| Avis et réputation                       | `PARTIEL / LOCAL`            | Google Places sync + fondation feedback post-visite tokenisée, scores 1–5, boîte de récupération dashboard et expiration ; providers d'envoi, publication et pilote non qualifiés                                                                       | Collecte/publication/réponse annoncées.                                        |
| Avantages fidélité opérationnels         | `PARTIEL / LOCAL`            | Catalogue Pro, règles bornées, grants à code hashé, consommation atomique, expiration et coût estimé sur `/dashboard/loyalty` ; aucun point, envoi ou POS actif                                                                                         | Fidélisation annoncée selon formule ; vérifier le périmètre avant publication. |
| Expériences et sessions                  | `PARTIEL / LOCAL`            | Catalogue Pro, sessions datées, capacité verrouillée, snapshot du prix, réservations/annulations idempotentes et expiration sur `/dashboard/experiences` ; paiement, billetterie et distribution absents                                                | Expériences, événements et suppléments à vérifier selon la formule.            |
| Événements et billetterie                | `PARTIEL / LOCAL`            | Catalogue, sessions, tarifs, jauge transactionnelle, commandes/billets hashés, check-in, liste d'attente et traces locales de facture/remboursement sur `/dashboard/events` ; paiement, facture fiscale, notifications et distribution externes absents | Billetterie et événements à vérifier selon la formule.                         |
| Distribution partenaire                  | `PARTIEL / LOCAL`            | Fondations `DistributionConnection`/snapshots/runs/liens/webhook, dashboard `/dashboard/distribution` et idempotence ; aucun adaptateur, OAuth, webhook public ou appel fournisseur                                                                     | Canaux et distribution à vérifier selon la formule.                            |
| Google Reserve                           | `PARTIEL / LOCAL`            | Contrat de connexion et snapshots préparé ; aucun connecteur Reserve with Google, compte marchand ou appel Google actif                                                                                                                                 | Inclus.                                                                        |
| Meta Reserve                             | `PARTIEL / LOCAL`            | Contrat provider-neutral préparé ; aucun connecteur de distribution Meta, compte marchand ou appel Meta actif                                                                                                                                           | Inclus/option selon formule.                                                   |
| Multi-site                               | `PARTIEL / LOCAL`            | account/site, sélection, quotas et facturation ; socle `CustomerGroupProfile`/`CustomerGroupMembership` consenti, isolé et masqué derrière `CUSTOMER_GROUPS_ENABLED=false`                                                                              | Base clients et fonctions groupes annoncées.                                   |
| API / agentic                            | `LIVRÉ`                      | routes API + MCP/OpenAI Reserve                                                                                                                                                                                                                         | Accès API annoncé sur Grow.                                                    |
| Paiement à table / QR                    | `ABSENT`                     | aucun parcours d'addition à table                                                                                                                                                                                                                       | Zenchef l'annonce dans sa plateforme.                                          |

Sources concurrentes consultées :

- [Formules et comparaison Zenchef](https://www.zenchef.com/fr/formules) ;
- [Présentation de la plateforme Zenchef](https://www.zenchef.com/fr/zenchef-landing) ;
- [Guide Zenchef sur la digitalisation](https://www.zenchef.com/fr/guides/comment-digitaliser-restaurant).

## Ce qui justifie Essential à 199 €

La formule Essential peut être défendue à 199 € si elle livre une exploitation quotidienne
cohérente, pas seulement une liste de modules :

1. réservation dashboard + Connect + widget + voice sur la même disponibilité ;
2. plan de salle et liste d'attente fiables sous concurrence ;
3. rappels, annulation et suivi du no-show ;
4. fichier client utilisable avec consentements ;
5. dashboard de valeur : appels traités, réservations captées, heures économisées ;
6. limites d'usage et dépassements visibles avant facturation ;
7. onboarding qui conduit jusqu'au premier appel et à la première réservation réelle ;
8. sauvegarde, observabilité et support exploitables.

Les fonctionnalités 1 à 4 sont largement présentes. Les points 5 à 7 demandent encore une preuve
commerciale, une instrumentation plus fiable et un packaging explicite. Les entitlements et compteurs
d'usage empêchent qu'un simple changement d'interface active par erreur une fonction Pro.

## Ce qui justifie Pro à 299 €

Pro doit produire un revenu mesurable ou un gain opérationnel supérieur. Le contrôle technique
existe désormais localement, mais l'activation commerciale attend les éléments restants :

1. identité client consolidée et fusion de doublons ;
2. données de visite et de dépense importées depuis au moins un POS ;
3. segments recalculés : nouveau, fidèle, à risque, VIP, gros dépensier, déjeuner ;
4. campagnes email/SMS avec consentement par canal, exclusions et fréquence maximale ;
5. automations déclenchées par événement avec retry, idempotence et journal d'exécution ;
6. attribution d'une réservation et du chiffre d'affaires à une campagne ;
7. rapports par segment, campagne et établissement ;
8. fonctions multi-site partagées lorsque le client possède plusieurs restaurants ;
9. collecte post-visite et récupération opérateur lorsque le pilote réputation est qualifié ;
10. avantages simples et traçables pour les clients VIP ou anniversaires, lorsque le pilote fidélité
    et la procédure en salle sont validés.
11. catalogue d'expériences et sessions à capacité contrôlée, lorsque le parcours de paiement,
    l'exploitation en salle et le pilote sont validés.
12. événements, billets et contrôle d'accès à jauge partagée, lorsque le parcours de paiement,
    l'exploitation en salle, les notifications et le pilote sont validés.
13. canaux partenaires préparés et traçables, lorsque l'adaptateur Google/Meta ou API publique,
    la signature, la réconciliation et le pilote sont validés.

Ces éléments correspondent aux epics décrits dans
[`roadmap-produit-crm-marketing-199-299.md`](./roadmap-produit-crm-marketing-199-299.md). Tant que
les items 1 à 6 ne sont pas opérationnels, Pro à 299 € repose surtout sur voice, agentic, cartes
cadeaux et Service Copilot ; la promesse CRM/marketing doit rester limitée.

## Ordre de construction recommandé

```text
USAGE + ENTITLEMENTS
  -> CRM identity + timeline + merge
  -> POS adapter + ledger + reconciliation
  -> segment engine
  -> consent/channel policy
  -> campaign delivery
  -> automation runtime
  -> attribution reservation/revenue
  -> réservation payante et protection no-show
  -> consolidation multi-site
  -> expériences, événements et distribution
```

Cet ordre évite de construire un éditeur de campagnes sur des identités non dédupliquées ou de
promettre un ROI sans transactions POS rattachables.

## Claims autorisés maintenant

- « Suppernote prend les réservations par téléphone, sur votre site et via les assistants compatibles. »
- « La disponibilité s'appuie sur votre plan de salle et vos tables. »
- « Vous gérez les réservations, la liste d'attente et les cartes cadeaux dans le même outil. »
- « L'assistant vocal est conçu pour les restaurants français et reste configurable. »

## Claims à retenir jusqu'à preuve

- parité complète avec Zenchef ou SevenRooms ;
- CRM enrichi automatiquement par la caisse ;
- attribution exacte du chiffre d'affaires marketing ;
- réduction chiffrée du no-show sans cohorte Suppernote ;
- ROI ou gain de temps non mesuré sur de vrais restaurants ;
- disponibilité sur Google Reserve ou Meta Reserve.
- distribution partenaire, réservation externe ou synchronisation bidirectionnelle certifiée.
- billetterie événementielle avec paiement, facture fiscale ou distribution partenaire.

## Règle de mise à jour

Une ligne passe de `ABSENT` ou `PARTIEL` à `LIVRÉ` uniquement après présence du code, contrôle
pertinent vert et, lorsqu'un fournisseur externe intervient, preuve datée en staging ou production.
Toute évolution de prix doit mettre à jour simultanément l'interface, les Price IDs Stripe, le
runbook billing, la matrice d'entitlements et ce document.
