# Recette Suppernote — inscription technique, essai et paiement Stripe test

Date : 21 octobre 2026, Europe/Paris.

**Verdict : parcours nominal de facturation vérifié en sandbox ; validation commerciale globale refusée en l’état.** Un défaut de rapprochement des webhooks a été reproduit lors d’une fin d’essai anticipée. La soumission complète du formulaire public d’inscription et l’onboarding du restaurateur n’ont pas été parcourus de bout en bout dans le navigateur.

## Périmètre réel et garde-fous

- Trois identités et organisations Clerk **test** distinctes, aucun compte client réel utilisé. Les utilisateurs de recette ont été créés par l’API de développement Clerk sans mot de passe ; cette création ne valide pas le formulaire public SignUp, son anti-abus ou sa vérification d’e-mail.
- Base staging uniquement. Clés `sk_test_` Clerk et Stripe vérifiées avant toute mutation ; objets Stripe relus avec `livemode=false`. Aucune clé ni URL privée du portail n’est incluse dans les preuves exportées.
- Le staging est en mode démonstration (`DEMO_STAGING=1`), qui force un restaurant commun. Pour vérifier un vrai nouveau tenant sans modifier le staging partagé, les routes déployées d’authentification, de facturation et de droits ont été chargées dans un processus Fastify isolé. Le mode démo y était désactivé uniquement en mémoire. Chaque requête protégée utilisait un vrai jeton de session Clerk signé, associé à l’organisation de recette ; aucun middleware d’authentification simulé.
- Les requêtes métier de ce processus ont été exécutées avec `app.inject` (routes réelles, base et fournisseurs réels en test), et non via le proxy HTTP public du dashboard. Les webhooks, eux, ont été livrés au vrai serveur HTTPS `api-staging.sokar.tech`.
- Staging au commit `50b0d3e9`, production au commit `df0e50e`. Les fichiers source d’authentification et de facturation concernés sont identiques dans les deux déploiements ; il ne s’agit pas d’une exécution sur la PR #544.
- Aucun fichier `.env`, déploiement ou réglage de production modifié. Aucun appel téléphonique réel ni moyen de paiement réel utilisé.

## Résultats

| Vérification                                                | Résultat                                                                                                                     | Preuve                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Accès non authentifié à la synchronisation                  | HTTP 401                                                                                                                     | Trois dossiers                          |
| Nouveau compte et restaurant via session Clerk authentifiée | HTTP 201, `accountId` renseigné, propriétaire OWNER, restaurant principal                                                    | Trois dossiers                          |
| Reconnexion / synchronisation répétée                       | HTTP 200, un seul restaurant par nouveau compte                                                                              | Trois dossiers                          |
| Début d’essai Essential mensuel sans carte                  | HTTP 200, `trialing`, exactement 14 jours, aucun moyen de paiement                                                           | Trois dossiers                          |
| Seconde demande d’essai                                     | HTTP 409                                                                                                                     | Trois dossiers                          |
| Droits en essai                                             | Essential ; réservations et voix autorisées, CRM avancé non accordé                                                          | Routes de droits et statut              |
| Catalogue utilisé                                           | 199,00 EUR / mois                                                                                                            | Objets Price et factures Stripe         |
| Portail de facturation                                      | URL générée par la route métier ; interface sandbox ouverte                                                                  | Capture de l’essai                      |
| Ajout d’une carte dans le portail                           | Carte fictive Visa 4242 enregistrée via l’interface Stripe                                                                   | Navigateur intégré, aucune carte réelle |
| Fin normale des 14 jours, avec carte                        | Paiement fictif 199,00 EUR, facture `paid`, Stripe `active`, projections restaurant **et compte** `active`                   | Horloge Stripe, webhooks naturels       |
| Fin normale des 14 jours, sans carte                        | Annulation automatique, aucune facture positive ; Suppernote `canceled` et `suspended=true`                                  | Deuxième horloge Stripe, webhook traité |
| Fin anticipée de l’essai avec carte                         | Paiement fictif réussi, **mais Suppernote reste `trialing`**                                                                 | Défaut reproduit ci-dessous             |
| Rejeu du webhook d’activation déjà traité                   | Deux HTTP 200 ; pas de double écriture, mais l’état erroné reste inchangé                                                    | Rejeu signé du vrai événement test      |
| Signature de webhook invalide                               | HTTP 400                                                                                                                     | Aucun changement d’état                 |
| Nettoyage                                                   | Trois abonnements annulés, trois restaurants archivés, trois sessions Clerk révoquées ; planifications des rapports retirées | Résultats de nettoyage                  |

La fin normale a été simulée avec des horloges Stripe : passage à J+11 pour le rappel, puis après J+14 et le délai de finalisation de facture. Aucun changement manuel de statut de facturation Suppernote n’a servi à faire réussir la recette. Pour ce scénario, le client Stripe lié à l’horloge a été précréé et associé au dossier de recette avant l’appel métier de début d’essai ; la création automatique d’un client Stripe sans horloge a été vérifiée séparément dans le premier dossier.

## Défaut bloquant reproduit

Dans le dossier de fin anticipée, après ajout d’une carte par le portail, l’API Stripe a été appelée avec `trial_end=now`. La facture a été finalisée et payée en test. Il s’agit d’un scénario distinct de l’écoulement naturel des 14 jours, qui a réussi.

Abonnement : `sub_1UT66dHCZZuqZF0h1fXwydpY`.
Facture : `in_1UT68tHCZZuqZF0hgc6dHZq7`, payée 19 900 centimes EUR, `livemode=false`.

Ces événements partagent tous `created=1792614589` :

| Événement                  | Identifiant                    | État contenu                 |
| -------------------------- | ------------------------------ | ---------------------------- |
| Abonnement mis à jour      | `evt_1UT68wHCZZuqZF0hDLiJAoDJ` | `active`                     |
| Paiement de facture réussi | `evt_1UT68wHCZZuqZF0hBz4dHRXt` | 19 900 centimes payés        |
| Facture payée              | `evt_1UT68wHCZZuqZF0hGTmkp9go` | 19 900 centimes payés        |
| Rappel de fin d’essai      | `evt_1UT68wHCZZuqZF0hKxDl5v5o` | Ancien instantané `trialing` |

Les quatre événements ont été reçus et marqués `processed`. Le checkpoint final de Suppernote désigne le rappel, et les projections du compte comme du restaurant restent `trialing`, avec l’ancienne échéance d’essai.

Le code `isStaleStripeEvent` dans `apps/api/src/modules/billing/billing.service.ts` compare l’horodatage, puis l’identifiant d’événement dans l’ordre lexicographique lorsque l’horodatage est égal. Le rappel a un identifiant supérieur à ceux de l’activation et des factures. De plus, `handleSubscriptionEvent` applique l’instantané du rappel aux projections de facturation comme s’il s’agissait d’un changement d’abonnement. Ces deux comportements expliquent l’état final observé ; il ne s’agit pas d’un webhook manquant.

Stripe précise que l’ordre de livraison n’est pas garanti et que plusieurs instantanés peuvent partager le même horodatage à la seconde. Les identifiants servent à reconnaître les doublons, pas à reconstruire un ordre métier. [Documentation Stripe sur l’ordre des événements](https://docs.stripe.com/webhooks#event-ordering).

Le rejeu signé de l’événement `active` renvoie HTTP 200 deux fois, mais ne répare pas la projection : cet événement est déjà enregistré comme traité. Une correction devra donc inclure une procédure de réconciliation des dossiers qui auraient déjà cet écart, en plus du traitement des futurs événements.

## Ce qui reste nécessaire avant un feu vert commercial

1. Corriger le rapprochement des événements : ne pas utiliser leur ordre alphabétique comme chronologie ; éviter qu’un rappel ancien remplace l’état actuel d’un abonnement ; gérer les traitements concurrents et les relivraisons.
2. Ajouter les tests de non-régression pour des événements distincts à la même seconde et reçus dans plusieurs ordres, puis rejouer ce scénario dans le sandbox réel.
3. Parcourir intégralement l’interface publique d’inscription et l’onboarding avec un compte Clerk test, en environnement isolé sans forçage global du restaurant démo. Le formulaire public a été affiché dans le navigateur intégré, mais sa soumission, la création d’un mot de passe, la vérification d’e-mail et l’ensemble des étapes d’onboarding n’ont pas été réalisés dans cette recette.
4. Cette recette couvre Essential mensuel. Les changements de formule, annuels, Multi-site, authentification bancaire 3DS, refus de paiement et recouvrement restent hors de cette exécution.

**Il n’y a donc pas de feu vert pour déclarer tout le parcours commercial validé.** Le paiement nominal Essential fonctionne ; la robustesse de la projection de facturation et la recette intégrale de l’interface restent à finaliser.

## Pièces conservées

- `recette-stripe-preuves.json` : résultats structurés des trois dossiers, webhooks et nettoyage ; aucun jeton ou secret de session.
- `stripe-test-essai.png` : essai sans carte dans le portail sandbox.
- `stripe-test-paiement.png` : carte fictive et facture de 199,00 EUR payée dans le portail sandbox, avant annulation de nettoyage.

Les objets de recette restent conservés dans les systèmes de test pour traçabilité. Aucun abonnement de cette recette ne reste actif.
