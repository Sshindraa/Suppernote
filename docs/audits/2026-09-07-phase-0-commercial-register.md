# Registre commercial et portes d’activation — phase 0

Date du registre initial : 7 septembre 2026
Dernière réconciliation : 15 septembre 2026
Statut : **ACTIF — catalogue local 199/299, validations externes et pilotes ouverts**

> La [réconciliation courante des audits](./2026-09-15-current-state.md) est la
> source de statut. Les montants Stripe 149/249 présents dans les preuves de
> cette version sont historiques ; le catalogue à annoncer est Essential 199 €
> et Pro 299 €. Le profil scoped `core-operator-foundations` est déjà promu pour
> les fondations sûres, tandis que le gel commercial complet reste actif.
>
> Mise à jour du 16 octobre 2026 : Stripe test et live facturent la grille du 14 octobre
> (Essential 199 €, Pro 299 €, Multi-site 299 € + 99 €/site, remise annuelle 10 %). Les montants
> annuels et la base Multi-site 249 € du tableau ci-dessous sont historiques ; montants en vigueur
> dans [`runbooks/stripe-billing.md`](../runbooks/stripe-billing.md).

Ce registre fixe ce qui peut être annoncé dès le premier lancement, qui porte la preuve, le prix affiché et la condition d’activation. Une fonctionnalité peut rester dans l’offre initiale tout en étant activée avec accompagnement ou sur une cohorte pilote. Aucune ligne ne constitue une garantie avant que la preuve indiquée soit signée.

## Responsabilités

| Domaine                                   | Responsable de réalisation | Décision ou dépendance externe                                      |
| ----------------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| Produit, prix, GO/NO-GO et cohortes       | Hamza                      | Validation finale, contrats et restaurants pilotes                  |
| API, auth, isolation, Prisma, Billing     | Codex                      | Revue produit sur les changements de contrat                        |
| Dashboard, Connect et parcours navigateur | Codex                      | Validation UX et démonstration par Hamza                            |
| Voix, Telnyx, SMS et transfert humain     | Codex                      | Accès fournisseurs, appels réels et décision d’activation par Hamza |
| Infra, CI, sauvegardes et rollback        | Codex                      | Accès VPS, canal d’alerte externe et mesure RPO/RTO                 |
| RGPD, CGV, DPA et SLA                     | Hamza + conseil juridique  | Identité légale, sous-traitants et texte contractuel signé          |
| Support des dix premiers restaurants      | Hamza                      | Canal, horaires et délai d’escalade à confirmer                     |

## Catalogue annoncé au lancement

| Module                                   | Prix public de référence                               | Porte d’activation                                         | Preuve attendue                                                                                      | État du worktree                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Essential                                | **199 € / mois** ; annuel cible 1 910,40 € avec remise | Stripe mensuel et annuel, droits synchronisés              | Checkout, webhook signé, facture, annulation et période de grâce                                     | Constantes et UI locales alignées sur 199 € ; les anciens prix Stripe 149 € / 1 430,40 € sont historiques. Créer/synchroniser le catalogue 199 €, rejouer le cycle sandbox et observer deux pilotes                                                                                                                                                                                                                                                                                                                                                        |
| Pro                                      | **299 € / mois** ; annuel cible 2 870,40 € avec remise | Même porte que Essential                                   | Même cycle, avec droits Pro et reprise après retry                                                   | Constantes et UI locales alignées sur 299 € ; les anciens prix Stripe 249 € / 2 390,40 € sont historiques. Créer/synchroniser le catalogue 299 € et rejouer facture, taxes, prorata et période de grâce                                                                                                                                                                                                                                                                                                                                                    |
| Multi-site                               | 249 € / mois + 99 € / établissement supplémentaire     | Compte, OWNER, quota payé et deux sites isolés             | Deux sites, membre limité, changement de site, facture `siteCount`, dépassement de quota et rollback | Staging : troisième site créé, quatrième refusé hors quota, suspension/réactivation validées, sélecteur isolé, portail sandbox 447 €/mois et rejeu webhook signé validés ; prix annuels actifs (2 390,40 €/an + 950,40 €/site supplémentaire) ; préflight Clerk confirme deux organisations distinctes. Une fenêtre réelle a été tentée puis rollbackée : l’API Clerk a renvoyé HTTP 401 pour les secrets présents sur le VPS et le middleware a signalé `secret-key-invalid` ; sessions Suppernote, refus inter-organisation et transfert restent ouverts |
| Réservations ChatGPT / Claude            | Inclus dans la formule qui l’active                    | Canal autorisé, consentement et limite de débit configurés | Réservation de bout en bout par canal, rejeu idempotent, refus inter-compte et transfert humain      | Parcours à rejouer et documenter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Domaine personnalisé                     | Selon devis ou formule retenue                         | DNS vérifié, TLS actif, fallback Suppernote disponible     | Domaine de test en HTTPS, renouvellement, suppression et erreur DNS                                  | Cloudflare SaaS et routes présentes ; preuve cohorte à rejouer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Cartes cadeaux                           | Conditions et commission affichées au contrat          | Paiement, ledger et activation restaurant                  | Émission, utilisation partielle, expiration, remboursement et concurrence sans double débit          | Module présent ; cycle complet et rapprochement à signer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Prédictif avancé                         | Inclus seulement avec limites explicites               | Données minimales, confiance et fallback manuel            | Rapport tenu à part, explication de la sortie, aucune décision irréversible automatique              | À qualifier comme pilote manuel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Politique « sans limite » / taux garanti | Aucun slogan hors texte contractuel                    | Usage équitable ou SLA instrumenté                         | Seuils, exclusions, compensation, coût maximal et rapport mensuel                                    | Contrat et métriques à définir                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Dépendances à fermer

- [ ] Profil Telnyx, numéro émetteur, callbacks de livraison et procédure d’incident ;
- [ ] Projet Sentry, uptime extérieur, destinataires et test d’alerte ; restore vierge mesuré (RPO observable 20 h 05, restauration/contrôles 4 s), RTO production complet encore à mesurer ;
- [x] Exercice de restauration vierge R2/PostgreSQL réussi sur le dernier dump (32 tables, 73 contraintes, 117 index, base temporaire supprimée) ;
- [x] Billing Portal sandbox ouvert depuis le site secondaire et quatre prix annuels Stripe actifs en live et test ; [ ] TVA/HT-TTC et procédure d’annulation ;
- [ ] Identité légale, DPA, rétention audio/transcription et contact RGPD ;
- [ ] Comptes développeur et secrets de test ChatGPT/Claude ;
- [ ] Mode staging sans démo protégé contre la promotion, clé Clerk Development valide et profils navigateur frais pour prouver l’isolation inter-tenant ;
- [ ] Injecter `RESERVATION_SERVICE_TOKEN` (≥32 caractères) dans l’API staging et production avant d'utiliser l'intégration legacy `POST /reservations` ; la route est désormais refusée sans ce secret ;
- [ ] Texte contractuel de la politique d’usage/SLA ;
- [ ] Canal support, horaires d’astreinte et délai cible.

## Cohorte initiale

Les noms, contacts, prix pilote, créneaux d’onboarding et ordre des vagues restent à renseigner par Hamza. Tant que les deux premiers restaurants pilotes ne sont pas nommés, la phase 0 reste ouverte et aucune activation commerciale autonome ne doit partir.

| Vague      | Restaurants   | Fenêtre d’observation                 | Critère de passage                            |
| ---------- | ------------- | ------------------------------------- | --------------------------------------------- |
| Dogfood    | À renseigner  | 5 jours ouvrés                        | Zéro P0, appels et réservation contrôlés      |
| Pilote 1–2 | À renseigner  | 7 jours minimum                       | Support le jour même, aucun incident critique |
| Vague 2    | 3 restaurants | 72 h avant la suite                   | Métriques stables, rollback disponible        |
| Vague 3    | 5 restaurants | Revue quotidienne la première semaine | Décision GO/NO-GO documentée                  |

## Règle de release

Chaque activation doit référencer le commit, les variables attendues, les migrations, les smoke tests, la sauvegarde et la commande de rollback. Les validations de staging et la release `main@05722a1` mentionnées dans la version initiale sont des preuves historiques. Depuis, le profil scoped `core-operator-foundations` a été promu et l'entrypoint API a été vérifié sur `35e22281` ; le gel commercial 199/299 reste toutefois actif. Le modèle account/site, le backfill et le rejeu webhook restent des fondations locales/staging ; le proxy Clerk doit encore être rejoué avec une clé Development valide et deux identités. Le catalogue Stripe 199/299, la facture annuelle, les taxes, le prorata, la période de grâce, le canal d’alerte externe, la mesure RPO/RTO complet et la cohorte pilote restent nécessaires avant l’activation commerciale autonome.

## 2026-10-13 — Page Tarifs : périmètre affiché et preuves

Audit ciblé : `constants.ts`, cartes partagées accueil/pricing, `pricing-links.ts`, inscription
Clerk, `SubscribeFromPricing`, entitlements, billing service (ligne de base + quantité
`siteCount - 1`), catalogue réconcilié du 22/09, release scoped du 15/09 et runbook multi-site.
L'ancien NO-GO global de `reservation-commercial-readiness.md` est historique : la release scoped
puis l'ouverture Essential du 22/09 autorisent le socle, sans ouvrir les chantiers avancés.
Lecture SSH de production le 13/10 : `MARKETING_FEATURES_ENABLED=true`,
`BILLING_CHECKOUT_ENABLED=true`; CRM avancé, envois et profils groupe absents du fichier lu,
avec défauts false et interdiction dans le profil produit. Aucune mutation fournisseur.

| Classe interne                                | Fonction / décision publique                                                                                                 | Preuve                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Disponible                                    | Planning téléphone/web/saisie salle, plan de salle, attente, fichier client, suivi des absences, statistiques par restaurant | Release scoped 15/09, routes et pages courantes, onboarding en salle livré #411                                                                                                      |
| Disponible sous configuration                 | Assistant téléphone, numéro dédié, Connect/widget, confirmations/rappels                                                     | Parcours onboarding, garde provisioning, ouverture Essential 22/09 ; activation après attribution et tests, aucun délai garanti                                                      |
| Disponible                                    | Pro : segments, règles, brouillons et aperçu ; aucun envoi                                                                   | Release scoped et `MARKETING_FEATURES_ENABLED=true` en production, routes marketing et guards                                                                                        |
| À qualifier                                   | Profils avancés/VIP, réactivation envoyée, campagnes envoyées, cartes cadeaux                                                | P2/P3/P5 ouverts, flags fermés, TODO Stripe/notifications ; retirés des inclusions                                                                                                   |
| Disponible avec qualification restante ciblée | Changement de site, paramètres/numéro/fichier par adresse, facture compte                                                    | Runbook Stripe : preuve staging 07/09, sélecteur et portail 447 € ; isolation par deux sessions Clerk réelles encore ouverte. Aucun argument commercial sur des rôles déjà qualifiés |
| Prévue / non disponible                       | Partage clients groupe, comparaison consolidée                                                                               | P7 et `CUSTOMER_GROUPS_ENABLED=false` ; non présentés comme inclus                                                                                                                   |
| À qualifier                                   | Support prioritaire et rapport quotidien délivré                                                                             | Droit technique insuffisant pour promettre SLA, 7j/7 ou livraison e-mail ; aucune promesse publiée                                                                                   |

Textes définitifs : source unique `apps/dashboard/src/app/constants.ts` (`PLANS`), comparaison
et FAQ dans `PricingDetails.tsx`. Introduction : « L’accueil commence avant le premier couvert. »
Essential : « Vos appels et vos réservations, au même endroit. » Pro : « Préparez la prochaine
invitation de vos clients. » Multi-site : « L’esprit de chaque maison. Une vue d’ensemble. »
Badge recommandé retiré. Le prix Pro est conservé, son périmètre de préparation est visible.
Pas de CRM, campagne, fonction financière ou flag ajouté/activé.

Prix : annuel sans arrondi à l’euro, totals 1 910,40 / 2 870,40 € HT ; base groupe
2 390,40 € HT/an puis 950,40 € par adresse. Premier site inclus, minimum deux sites,
maximum 100, total calculé et nombre conservé dans le lien d’inscription. Deux sites :
348 €/mois ou 3 340,80 €/an ; trois : 447 €/mois ou 4 291,20 €/an. Paiement annuel
à l’avance et engagement 12 mois ; résiliation à l’échéance, sans remboursement automatique.
Voix/SMS : limites null, aucun quota client ni mécanisme automatique de dépassement ; budgets
internes distincts, frais opérateur du renvoi séparés. Aucun changement du catalogue Stripe.

Parcours : CTA « Choisir [formule] » vers `/register` avec plan, cadence et sites,
inscription vers dashboard/onboarding existant. La section `/#demo` est conservée.
Après intégration de main (#420), `/demo` recueille une demande de démonstration par e-mail,
sans annoncer une réservation de rendez-vous ; ses métadonnées et les corrections de la FAQ
accueil sont préservées.
Les erreurs Checkout existantes restent traitées par `SubscribeFromPricing`, sans changement.

Vérifications locales : tests cartes/calculs/CTA et SubscribeFromPricing (9 tests), typecheck
dashboard, stylelint, lint ; 565 tests dashboard avant synchronisation de main. Captures Playwright mobile 390, iPad 768, desktop 1440 avec préférence
claire mémorisée, contrôle de débordement et total trois sites. Surface pricing sombre explicite
pour conserver la lisibilité. Comparaison défilable sur mobile avec en-têtes sémantiques.
Limites : pas de nouvel appel réel ni envoi SMS/e-mail ; pilotes Essential sept jours et
qualification des fonctions différées restent ouverts. CI et état public à suivre dans la PR.

## 2026-10-14 — Essential complet, Pro centré sur le copilote de service

Périmètre ciblé : entitlements, routes `floor-plan`, recommandations, prévision de rotation,
simulation, analyse/application/annulation/historique des plans de retard, composants dashboard,
runbook du pilote et Tarifs. Aucun nouveau moteur métier ou fournisseur. Les scénarios existants
restent la référence ; la preuve terrain du pilote n’est pas assimilée à une preuve de code.

| Offre      | Périmètre actuel                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Essential  | Appels et numéro sous configuration, planning téléphone/web/salle, Connect/widget, plan et placement manuel, recherche de tables réellement disponibles, liste d’attente et promotion manuelle, fichier client/historique/notes, notifications configurées, suivi des absences, statistiques et rapports accessibles. Pouls du service conservé. |
| Pro        | Essential plus suggestions de retard, estimations avec fiabilité/repli, rapprochement tables/attente, simulation et analyse de réorganisation, plan appliqué après validation humaine, historique et retour arrière conditionnel. Préparation marketing maintenue en complément, sans envoi.                                                     |
| Multi-site | Périmètre Pro par adresse et fonctions de groupe existantes ; catalogue et calcul inchangés.                                                                                                                                                                                                                                                     |

Droit dédié `floorPlan.copilot` : false pour un nouvel Essential, true pour Pro/Multi-site.
L’API protège les douze routes avancées (recommandations, télémétrie/qualité, rééquilibrage,
simulation, analyse, brouillons, application, annulation, historique). `pulse`, les réservations,
le placement, l’affectation/recherche de tables réellement disponibles et l’attente restent hors
de cette restriction. Authentification, site et rôles restent résolus par `requireOrg` ;
`READ_ONLY` conserve la restriction de mutation existante. Formats de réponse et chemins inchangés.

Maintien des droits : ConfigCat peut déroger au plan entier mais ne conserve pas seulement le
copilote. La migration additive `20261013220000_service_copilot_legacy_access` ajoute un booléen
serveur false par défaut et le passe à true pour tous les restaurants présents à son exécution.
Cette cohorte reprend exactement l’ancien accès universel, y compris les restaurants non payants,
plutôt que retirer silencieusement un accès. Les nouveaux restaurants restent false. Le grant ne
change ni leur formule ni les autres capacités. Il est persistant, sans date de coupure fragile,
et n’est accepté ni à la création ni à la mise à jour REST du profil restaurant. Aucune mutation
Stripe, quota, prix ou activation fournisseur. Réduire plus tard cette cohorte nécessite une
nouvelle décision commerciale explicite ; aucune restriction rétroactive ajoutée ici.

Correction nécessaire révélée par PostgreSQL : l’annulation remettait la réservation retardée
sur la table initiale avant d’annuler la promotion, provoquant `reservations_no_overlap_active`.
Après toutes les revalidations et sous les mêmes verrous, la promotion est désormais annulée
avant la restauration. Les écritures et audits restent dans une transaction atomique. Aucune
protection de chevauchement désactivée ; aucune libération fondée sur une estimation.

Dashboard : les composants lisent le droit effectif `/entitlements`, y compris le maintien
historique ; état fermé durant chargement/erreur avec reprise, invalidation au changement de site,
aucun montage/fetch avancé pour Essential. Le plan et ses actions manuelles restent utilisables.
Les estimations conservent confiance/source/échantillon et le repli sur la durée configurée.

Textes : Essential « Vos appels et vos réservations, au même endroit. » ; Pro « Gardez la main
quand le service change. » ; description « Retards, tables bientôt disponibles, clients en
attente : Suppernote vous propose des actions, votre équipe décide. » Six inclusions Pro centrées sur
le copilote. Comparaison et FAQ distinguent organisation manuelle et recommandations validées.
Le pilote terrain restant ouvert, les CTA Pro/Multi-site passent d’abord par `/demo`. Plan,
cadence et nombre de sites restent dans l’URL ; le formulaire les affiche, les trace dans son
`pageVersion` existant et les restitue dans le lien d’inscription, y compris après une erreur.
La clé d’idempotence de demande demeure stable. Aucun faux rendez-vous ni promesse de déplacement
autonome. Badge recommandé toujours absent. Prix exacts et remise de 20 % inchangés.

Preuves locales : 4 scénarios PostgreSQL du copilote (migration de cohorte, analyse sans mutation,
acceptation humaine, application concurrente sans doublon, annulation répétée, conflit apparu,
refus après installation et isolation) ; 4 scénarios PostgreSQL du socle sans réservation ;
matrice API des douze refus Essential et accès Pro/PREMIUM/historique ; tests des rôles existants,
prédiction/repli, télémétrie, simulation et récupération réutilisés. Tests d’interface : refus,
reprise, maintien, changement de site/réponse obsolète ; salle Essential sans requêtes avancées ;
choix conservé via démo après erreur. Playwright : 13 parcours salle passés (11 skips par format),
3 captures Tarifs et comportement du choix, préférence claire mémorisée sur les trois formats.
Typage, lint, CSS, client Prisma généré et contrôle de migration non destructive vérifiés.

Limites : aucune campagne signée en conditions de salle, aucun nouvel appel Telnyx ou envoi
Resend/SMS ; le test PostgreSQL contrôlé ne ferme pas le pilote terrain. Les fonctions CRM,
paiements, cartes cadeaux, envois marketing et profils groupe restent différées. Le rendu Tarifs
reste à la requête à cause du cookie de langue du layout existant. CI, PR et déploiements suivis
sans nouvelle livraison documentaire à chaque changement d’état ; résultat public dans le rendu
final et les captures de livraison.
