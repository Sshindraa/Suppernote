# Suivi commercial minimal — METRIC-01

État au 15 octobre 2026 : **préparé et vérifié localement, non commité, non déployé**.
Mode opératoire pour les premiers contacts et les deux places de pilote, sans nouveau dashboard.
Aucune donnée distante consultée ou modifiée pour cette préparation ; aucune conversion constatée.

## 1. Sources existantes et limites vérifiées dans le code

| Étape                        | Source de vérité existante                                                                                                                           | Rapprochement et limite                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source → demande             | `DemoRequest.id`, `createdAt`, `pageVersion` ; formulaire `/demo`                                                                                    | `demo-assistant-tel-v1` identifie le paramètre historique `source=assistant-telephonique`, conservé pour les anciens liens. L’accueil actuel mène à `/demo` sans ce paramètre : sa demande est générique, pas attribuable automatiquement à l’accueil ni au SEO. `demo-<formule>-<cadence>[-<sites>]-2026-10` identifie la sélection tarifaire ; `demo-2026-10` (formulaire) et `demo-v1` (défaut API) identifient seulement le parcours générique. Ce champ client n'est pas une preuve de trafic SEO, de campagne ou de premier contact. |
| Demande → démo réalisée      | Même `DemoRequest.id`, `demoDoneAt`                                                                                                                  | L'opérateur confirme `DEMO_DONE` après la démo ; `contactedAt` indique seulement une prise de contact. `notifiedAt` n'est ni une démo ni une réception humaine garantie. Une simulation publique vue n'est pas une démo commerciale réalisée.                                                                                                                                                                                                                                                                                              |
| Démo → inscription           | Compte utilisateur Clerk, identifiant et date de création vérifiés dans l'outil d'identité existant                                                  | Aucun lien persistant entre `DemoRequest` et Clerk. Rapprochement manuel confirmé avec le prospect ; conserver la preuve restreinte. Un nom similaire ou le même e-mail ne suffisent pas seuls. Si le compte existait, noter `EXISTING_ACCOUNT`, sans nouvelle inscription attribuée.                                                                                                                                                                                                                                                      |
| Inscription → établissement  | `RestaurantAccountMembership.clerkUserId` → `accountId` → `Restaurant.accountId` ; `RestaurantAccount.clerkOrganizationId`                           | Vérifier le propriétaire et l'établissement concernés, sans modifier les rôles. `Restaurant.createdAt` et la date d'adhésion ne prouvent pas la création du compte Clerk. Pour un ancien restaurant sans `accountId`, vérifier la liaison dans le contexte d'authentification existant ; ne pas inventer un ID de compte.                                                                                                                                                                                                                  |
| Établissement → activation   | `Restaurant.onboardingActivatedAt`, `onboardingDone`, `onboardingCompletedAt`, `provisioningStatus`, `testCallValidatedAt`, `forwardingConfiguredAt` | Distinguer activation technique et mise en service client : VOICE-01 et OPS-01 doivent aussi avoir leurs preuves. L'événement `onboarding_activated` seul ne couvre pas tous les chemins : le provisioning écrit directement le timestamp.                                                                                                                                                                                                                                                                                                 |
| Compte/restaurant → paiement | `RestaurantAccountBilling` et projection compatible `RestaurantBilling` : `stripeCustomerId`, `stripeSubscriptionId` ; facture Stripe correspondante | `GET /billing/status` confirme les droits/état courant, pas l'encaissement. Vérifier la facture d'abonnement, le mode live, le montant réellement encaissé et sa date. Compter par facture, pas par événement webhook.                                                                                                                                                                                                                                                                                                                     |

Références : [schéma](../../packages/database/prisma/schema.prisma),
[formulaire](../../apps/dashboard/src/app/demo/DemoRequestForm.tsx),
[demandes](../../apps/api/src/modules/demo-requests/demo-request.service.ts),
[onboarding](../../apps/api/src/modules/restaurants/restaurant.routes.ts),
[provisioning](../../apps/api/src/modules/admin/provisioning.service.ts),
[billing](../../apps/api/src/modules/billing/billing.service.ts).

Le statut `CLOSED` n'indique pas un échec ou un test : les timestamps de contact et démo restent
conservés. Ne pas déduire le résultat commercial du seul statut courant.

## 2. Relevé à tenir dans un espace restreint

Hamza tient le relevé et confirme chaque rapprochement. Copier ce modèle dans l'outil de suivi
à accès restreint déjà utilisé pour les contacts ; aucune fiche réelle ni coordonnée dans Git.
Si aucun espace n'est encore choisi, conserver ce modèle vide et ne pas y saisir de prospect réel.
Une ligne par opportunité commerciale, plusieurs demandes rattachées si c'est le même projet.
Les références d'identité et de preuve restent restreintes, même lorsqu'elles sont opaques.

```text
opportunity_ref : R-__
environment : UNKNOWN | local | staging | production
population : UNREVIEWED | COMMERCIAL | TEST | INTERNAL | DUPLICATE | SPAM
exclusion_reason : UNKNOWN | technical_test | demo_fixture | internal | duplicate | spam | none
reviewed_at / reviewer_ref : UNKNOWN
source_kind : UNKNOWN | landing_cta | pricing_selection | generic_form | outbound_authorized
page_version / source_evidence_ref : UNKNOWN
outreach_authorization_ref : UNKNOWN (si contact sortant)
demo_request_ids / requested_at : UNKNOWN (si demande entrante)
contacted_at / contact_evidence_ref : UNKNOWN
demo_done_at / demo_evidence_ref : UNKNOWN
signup_kind : UNKNOWN | NEW_ACCOUNT | EXISTING_ACCOUNT
clerk_user_ref / signed_up_at / signup_evidence_ref : UNKNOWN
account_ref / restaurant_ref / identity_match_evidence_ref : UNKNOWN
match_status : UNKNOWN | CONFIRMED | AMBIGUOUS
technical_activated_at / activation_evidence_ref : UNKNOWN
voice_01_evidence_ref / ops_01_evidence_ref / client_enabled_at : UNKNOWN
stripe_customer_ref / subscription_ref : UNKNOWN
invoice_ref / payment_mode / paid_at / amount_paid_cents / currency : UNKNOWN
payment_evidence_ref / refund_or_credit_evidence_ref : UNKNOWN
plan / cadence / next_action / next_action_date : UNKNOWN
```

Les timestamps sont ISO 8601 avec fuseau ; présenter les rendez-vous en Europe/Paris.
Une date manquante reste `UNKNOWN`. Une preuve explicitement négative peut être `NO`, jamais zéro
par défaut. Les pièces contenant e-mails, noms, numéros, transcriptions ou factures restent dans
leurs systèmes restreints, sans logs, Sentry ni analytics. Le dépôt contient seulement le modèle.

## 3. Procédure de rapprochement

1. Relever la demande persistée une fois par ID. Ne pas compter double clic ou retry comme un nouveau
   prospect. Une seconde demande du même projet est attachée à la même opportunité après vérification,
   jamais supprimée. Une prise de contact sortante autorisée peut exister sans demande `/demo`.
2. Qualifier la population avant tout comptage. Conserver l'origine observée ; en cas de contact
   sortant suivi du formulaire de démo, garder `outbound_authorized` comme origine et la page
   comme point de passage. Ne pas attribuer rétrospectivement ce prospect au SEO.
3. Après la démonstration réellement tenue, utiliser le statut opérateur existant et conserver sa
   date/preuve. Un rendez-vous prévu, un message envoyé ou une animation vue n'est pas une démo faite.
4. Quand le prospect crée ou utilise son compte, confirmer son projet et son compte avec lui, puis
   vérifier la chaîne identité/adhésion/compte/restaurant via les outils autorisés existants.
   Aucune jointure automatique par coordonnées ; laisser `AMBIGUOUS` et les conversions liées à
   `UNKNOWN` tant que l'identité n'est pas confirmée. Ne jamais fabriquer une date d'inscription.
5. Relever les jalons techniques séparément de l'autorisation de mise en service client. L'appel
   d'essai peut remplir `firstCallAt` : ce champ n'est pas un premier usage commercial utile.
6. Confirmer le paiement dans Stripe en lecture seule lors du pilote, sans lancer de Checkout de
   test. Relier facture → abonnement/client → projection de billing → compte/restaurant confirmé.
   Dédupliquer `invoice.paid` et `invoice.payment_succeeded` pour une même facture. Un statut
   `active`, un retour navigateur ou un événement traité ne prouvent pas seuls un encaissement.
7. Mettre à jour le relevé après chaque fait, puis le relire avant un bilan. Ne pas imposer l'ordre
   strict des étapes : un compte peut précéder la démo, une facture peut précéder la mise en service.
   Ne jamais remplir les étapes intermédiaires par déduction.

## 4. Exclusion des essais et règles de comptage

Ne compter que les opportunités `COMMERCIAL`, revues explicitement, en production, avec preuve de
l'étape. Pour une conversion attribuée de la demande au compte/paiement, exiger `CONFIRMED`.
`UNREVIEWED`, `UNKNOWN`, `AMBIGUOUS`, local, staging, fixtures, tests internes, doublons et spam sont
exclus des conversions et de leurs dénominateurs. Un prospect refusé reste un vrai prospect ; il
n'est pas reclassé en test pour améliorer le taux. Présenter séparément volumes exclus/inconnus.

Exclusions déjà documentées dans le rapport growth, à recopier dans le registre d'essais restreint
sans mutation des demandes :

| Environnement | ID de demande technique                | Motif                                  |
| ------------- | -------------------------------------- | -------------------------------------- |
| staging       | `9a23707f-a057-4060-86b7-9ee3b86264aa` | Essai SEO (§10.18)                     |
| production    | `f8d822c7-0cb1-4dc7-a421-628473cde0e0` | Essai SEO (§10.18)                     |
| production    | `f6ff0cb4-bc6a-45b6-8a3e-b1aa451b3ba0` | Essai notification et clôture (§10.19) |

Cette liste n'est pas réputée exhaustive ; le marquage de toute nouvelle ligne reste obligatoire.
Le suivi opérateur permet de marquer ou déclasser explicitement une demande comme test. Les tests
marqués sont masqués de la vue normale et accessibles via « Voir les tests ». Les demandes historiques
non vérifiées restent visibles : l'absence de marquage ne prouve pas qu'il s'agit d'un prospect réel.
Ne pas classer automatiquement tous les `CLOSED` comme tests, ni les `NEW` comme leads. Le compteur
de la page porte sur les lignes affichées (200 maximum), pas sur l'ensemble du funnel commercial.

Le funnel `/admin/onboarding-funnel/cohort` agrège tous les événements et toutes les réservations
sans exclusion commerciale ; sa première réservation utilise `reservedAt` (date de repas), pas
une date d'acquisition. Ce diagnostic opérationnel ne doit pas être repris comme funnel commercial.
`onboarding_first_call`, `onboarding_demo_call_played` et les réservations d'essai ne sont jamais
un usage client utile. Le relevé commercial ne remplace ni ne modifie ce diagnostic.

Un premier paiement exige une facture d'abonnement live avec montant réellement encaissé positif,
confirmée et reliée. Un paiement sandbox, une facture à zéro ou soldée uniquement par crédit ne
compte pas comme encaissement. Garder les remboursements/avoirs séparés pour ne pas annoncer du
revenu net à partir du brut. Le renouvellement nécessite une autre échéance réellement payée ;
deux notifications de la même facture ne font jamais deux paiements.

Pour un bilan : compter les demandes distinctes et les opportunités distinctes séparément. Compter
une inscription par nouveau compte propriétaire attribué, une activation client par établissement
qualifié et un premier payeur par compte facturé (restaurant legacy si pas de compte commercial).
Les invitations d'équipe et sites supplémentaires ne sont pas de nouvelles acquisitions.
Présenter la période, les unités, les preuves, les cohortes et les inconnus. Tout taux d'étape suit
les mêmes opportunités observables ; pas de division entre totaux de périodes ou populations différentes.
Aucun taux visite → demande n'est disponible avec ces seules données.

## 5. Cas de recette du relevé (synthétiques, aucune conversion réelle)

| Cas                                                                                 | Résultat attendu                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Demande technique production avec la bonne source landing                           | Exclue malgré un statut ou timestamp de démo                      |
| Prospect réel refusant l'offre                                                      | Inclus dans les prospects ; aucune conversion suivante inventée   |
| Deux demandes confirmées du même projet, puis deux notifications de la même facture | Deux demandes, une opportunité, au plus un premier paiement       |
| Animation, appel test d'onboarding ou réservation fictive                           | Aucune démo commerciale ni premier usage utile                    |
| Compte créé mais correspondance ambiguë                                             | Inscription attribuée `UNKNOWN` ; aucune jointure forcée          |
| Compte préexistant, nouveau membre invité                                           | Pas de nouvelle inscription commerciale                           |
| `subscriptionStatus=active`, sans facture vérifiée                                  | Paiement `UNKNOWN`                                                |
| Facture sandbox ou montant encaissé nul                                             | Aucun premier paiement encaissé                                   |
| Paiement confirmé avant activation client                                           | Paiement enregistré ; activation `UNKNOWN`, pas de jalon fabriqué |

## 6. Périmètre clos et suite

Les manques avérés sont compensés par le relevé : relation demande/compte, qualification test,
preuve d'encaissement et distinction activation technique/client. Pas de migration, nouveau droit,
événement analytique ou modification des routes. Les sources et cas ci-dessus sont vérifiés par
lecture du code local ; aucun vrai rapprochement prospect/compte/facture n'est encore qualifié.
La première opportunité réelle doit faire l'objet d'un rapprochement restreint avant tout bilan.
Automatiser seulement si la tenue manuelle devient insuffisante, dans un lot distinct.

Supports associés : [qualification et messages](restaurant-discovery-interview.md),
[pilote](essential-pilot-7-day.md), [rapport courant](../audits/2026-10-13-growth-execution.md).
