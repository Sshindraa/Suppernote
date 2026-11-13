# Espace « Mon abonnement »

## Phases livrées

1. **Consultation dans Suppernote** : `/dashboard/billing`, liens depuis Réglages et le menu du compte. Formule, statut, fin d’essai/période, bilan de l’essai, établissements inclus, carte masquée et 20 dernières factures. Les données Stripe sont réservées au propriétaire ; les autres rôles ne chargent pas `/billing/details`. Les données de la page sont réinitialisées au changement de site/compte. Le résumé Suppernote reste lisible pendant un chargement Stripe lent.
2. **Gestion sécurisée** : comparaison du catalogue commun avec les cadences mensuelle/annuelle et remise issue de `ANNUAL_DISCOUNT_PERCENT`. Un compte sans abonnement actif peut préparer Checkout pour la formule choisie. Pour un abonnement existant, les boutons ouvrent le parcours Stripe de modification ; le choix final reste dans Stripe et respecte la configuration du portail. Ajout/mise à jour de carte et résiliation ouvrent leurs parcours dédiés. Aucune mutation financière depuis le chargement de la page, aucun identifiant client Stripe fourni par le navigateur. Confirmation et proratas restent dans Stripe ; retour en français vers la page Suppernote.
3. **Fiabilité et qualification** : état réel relu au retour de Stripe, cinq rafraîchissements bornés, aucune activation à partir du seul paramètre `billing=success`. La branche reprend le correctif #545 déjà fusionné : le rappel `trial_will_end` ne projette plus son ancien instantané et les événements abonnement/facture de même seconde relisent l’état courant chez Stripe. Une erreur de relecture fait échouer le traitement pour permettre le retry Stripe. Aucun second correctif parallèle n’est ajouté à ce lot.

## Contrats et limites

- `GET /billing/status` reste compatible. Nouveau `GET /billing/details`, propriétaire seulement, réponse `Cache-Control: no-store`. Le compte est déterminé par l’authentification et les relations en base ; sa ligne de facturation est prioritaire sur celle du site principal.
- `/billing/portal-session` accepte facultativement `intent` (`manage`, `payment_method`, `subscription_update`, `subscription_cancel`) et `returnTo` (`settings`, `billing`). Les appels existants sans corps conservent le retour Réglages. Schéma strict : pas d’ID Stripe ou d’URL libre accepté.
- Checkout ajoute la cible `returnTo=billing`, isolée dans sa clé d’idempotence ; les cibles historiques restent compatibles.
- Le tarif récurrent affiché vient des articles Stripe, quantités comprises. C’est le montant avant remises/taxes/ajustements, **pas** une promesse sur le prochain prélèvement. Un assemblage de devises/cadences ou un prix variable ne reçoit pas de total inventé.
- Seuls marque, quatre derniers chiffres et expiration de carte sortent du serveur. Pas de numéro complet, de nom ni d’adresse du titulaire dans la réponse. Les factures exposent uniquement numéro/date/statut/total/devise/liens ; brouillons exclus. Les liens de document sont limités aux domaines Stripe attendus.
- Une panne Stripe affiche une erreur avec retry, jamais une fausse liste vide. Pas de mutation ni de migration de base, pas de modification des prix ou des abonnements existants lors du déploiement.
- Les options de changement de formule et de résiliation dépendent de la configuration Stripe et du contrat existant. Les boutons de comparaison d’un abonnement modifiable ouvrent le même sélecteur Stripe, sans présélection de prix. Un abonnement multi-article, avec échéancier ou en envoi de facture est indiqué comme nécessitant l’équipe Suppernote ; le bouton ouvre alors la gestion générale. La mise à jour du paiement utilise également le portail général lorsqu’une carte est définie sur l’abonnement, car le parcours dédié ne modifie que le moyen par défaut du client. Voir les [parcours Stripe](https://docs.stripe.com/customer-management/portal-deep-links).

## Vérification locale

```sh
pnpm --filter @suppernote/shared build
pnpm --filter @suppernote/config build
pnpm --filter @suppernote/agent-client build
pnpm --filter @suppernote/database exec prisma generate
pnpm --filter @suppernote/api test src/modules/billing/__tests__
pnpm --filter @suppernote/dashboard test src/features/billing src/app/dashboard/settings/page.test.tsx src/features/onboarding/onboarding-plan.test.tsx
pnpm --filter @suppernote/api typecheck
pnpm --filter @suppernote/dashboard typecheck
```

`billing.sandbox.test.ts` est ignoré par défaut. Pour l’exécuter, `SOKAR_BILLING_SANDBOX_FIXTURE` doit pointer vers un JSON privé hors dépôt contenant `key` (clé sandbox), `price` (Essential mensuel sandbox), `fixture.customerId` et `fixture.subscriptionId` d’une ancienne recette payée avec 4242. Il exige une clé test et le compte sandbox Suppernote attendu. Il lit la facture payée de cette fixture, crée un client/essai jetable sans carte, vérifie le tarif et les quatre parcours du portail puis annule l’essai et supprime ce client en nettoyage. Ne jamais inclure le JSON, la clé ou les URL de session dans les journaux ou le dépôt.

## Résultats du 22 octobre 2026

- API facturation : 101 tests passés ; contrat sandbox ignoré lors de la suite standard.
- Dashboard facturation, Réglages et choix de formule onboarding : 50 tests passés.
- Contrat réel Stripe sandbox : passé, client/essai jetable nettoyés ; facture historique de 199 EUR relue. Aucun nouveau paiement ni changement de formule/résiliation d’un client réel.
- Navigateur : page réelle locale avec fixtures fictives, thèmes clair/sombre, comparaison mensuel/annuel ; tests aux petites largeurs (contenu contrôlé à environ 629 et 319 px, sans débordement horizontal du document ; tableau défilant dans son conteneur). Captures conservées dans les livrables de session.
- La recette publique complète inscription/onboarding n’a pas été rejouée pour ce lot. Cette vérification ne constitue pas à elle seule un GO commercial global.

## Mise en ligne et retour arrière

Relecture humaine de la PR, CI, puis qualification staging avec un compte propriétaire et un membre. Vérifier page, documents, parcours Stripe et retour après action. Production après les contrôles habituels du dépôt ; aucun secret ni prix à remplacer. Le nouveau point d’entrée peut être retiré par rollback applicatif, sans opération sur les abonnements Stripe.

Documentation fournisseur : [sessions de portail](https://docs.stripe.com/api/customer_portal/sessions/create), [ordre de livraison des webhooks](https://docs.stripe.com/webhooks#event-ordering).
