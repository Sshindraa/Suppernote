# Audit cartes cadeaux — 30 septembre 2026

## Verdict

Le module est un MVP avancé en fonctionnalités, mais sa maturité opérationnelle n'est pas
démontrée. Montants libres, packs, Stripe, PDF, codes courts, cagnottes, statistiques,
notifications et rappels existent. Les principaux manques sont la cohérence financière,
l'utilisation en salle, la récupération après incident et la qualification des parcours réels.

Avis : conserver le socle, corriger les défauts financiers avant d'étendre les ventes. La mention
« LIVRÉ » de la spec signifie présence du code ; elle ne suffit pas à établir une aptitude à
vendre et servir des cartes cadeaux en autonomie.

## Périmètre et preuves

- Revue du schéma Prisma, migrations, services et routes gift-cards, intégration réservations,
  outil vocal, Connect, dashboard, workers et tests.
- Suite API existante exécutée : **300 fichiers réussis, 2 ignorés ; 3 121 tests réussis,
  27 ignorés**. La commande `pnpm --filter @suppernote/api test -- src/modules/gift-cards` a lancé
  la suite API complète, le séparateur `--` n'ayant pas appliqué le filtre attendu.
- Six sondes temporaires exécutées par `pnpm --filter @suppernote/api exec vitest run
src/modules/gift-cards/__tests__/gift-card-audit.probe.test.ts` : six reproductions réussies,
  Stripe et Prisma simulés. Les sondes constatent les comportements actuels défectueux,
  elles ne valident pas un correctif. Le fichier temporaire est supprimé après l'audit.
- Capture de référence desktop du dashboard consultée : elle montre l'état d'erreur API,
  donc elle ne permet pas de qualifier le rendu d'une liste renseignée.
- Aucun paiement réel, accès DB distant, appel téléphonique réel, modification applicative
  ou déploiement. Les défauts constatés portent sur cette version du dépôt ; leur exposition
  effective en production dépend de la version déployée, des flags et de la configuration.

## Ce qui mérite d'être conservé

- Modèle GiftCard avec montants Decimal et historique GiftCardRedemption.
- Débit protégé par verrou PostgreSQL `FOR UPDATE` : protection utile contre deux usages
  simultanés d'un même solde.
- Achat simple : validation du statut Stripe, du restaurant, de la devise, du montant payé
  et du montant reçu.
- Webhook signé ; corps brut réellement capturé dans `apps/api/src/main.ts`.
- Codes courts uniques et gestion des collisions de génération.
- Dashboard paginé avec filtres, création manuelle et confirmation avant annulation.
- Packs avec désactivation et suppression logique.
- Rappel à 30 jours : worker importé par `apps/api/src/workers/index.ts`, planification
  quotidienne à 9 h Europe/Paris et mécanisme de claim/réconciliation des notifications.
- Événements analytics de début/fin déjà présents.

## Défauts prioritaires

P0 = risque direct de création de valeur non encaissée ; P1 = blocage avant ventes autonomes ;
P2 = amélioration de fiabilité ou de produit. Ces priorités sont celles de cet audit.

### GC-01 — P0 : contributions non liées au paiement réel

`apps/api/src/modules/gift-cards/gift-card-crowdfunding.service.ts:101`

`contribute()` vérifie seulement `pi.status === 'succeeded'`. Il enregistre le montant envoyé
par le client, sans vérifier montant capturé, devise ou rattachement du paiement à la cagnotte.
Le même PaymentIntent peut être présenté plusieurs fois. Le schéma de GiftCardContribution
n'impose pas son unicité.

**Sonde confirmée :** un paiement simulé de 1 USD pour une autre carte crédite deux fois
une contribution déclarée de 1 000 EUR.

**Correction attendue :** tentative serveur rattachée à la cagnotte ; vérification des
références, devise et montant encaissé ; unicité durable du paiement ; résultat réutilisable
sur rejeu. Empêcher également la réutilisation d'un paiement d'achat simple en contribution.

### GC-02 — P0 : émission vocale sans paiement

`apps/api/src/modules/voice/stream/manager.ts:2600`

L'outil `purchaseGiftCard` appelle directement `GiftCardService.create()` avec
`createdBy: 'VOICE'` et `purchaseReference: 'test'`, puis envoie le code par SMS. Le service
crée une carte active par défaut. Aucun encaissement n'existe dans ce chemin. Le test vocal
existant attend explicitement cette référence `test`.

**Correction attendue :** le téléphone prépare une commande et envoie un lien de paiement.
Seule la confirmation financière active la carte et envoie le code utilisable. Distinguer
les cartes offertes par un membre habilité, les ventes encaissées sur place et les ventes web.
Qualifier les protections de production et les flags de ce chemin avant toute activation.

### GC-03 — P1 : clôture de cagnotte hors restaurant

`apps/api/src/modules/gift-cards/gift-card.routes.ts:810`

L'authentification est exigée, mais le contrôle compare seulement un restaurantId facultatif
de query au restaurant de la session. La carte est ensuite chargée par son id seul. Omettre
la query ou fournir le restaurant de la session ne vérifie pas le propriétaire de la carte.

**Sonde confirmée :** une session simulée du restaurant A clôture la carte du restaurant B.

**Correction attendue :** transmettre le restaurant résolu côté serveur au service et imposer
`id + restaurantId` à la lecture et à la mutation. Tester refus inter-restaurant et rôles.

### GC-04 — P1 : course navigateur/webhook et données de livraison perdues

`apps/connect/src/components/gift-card/use-gift-card-flow.ts:129`

Le PaymentIntent reçoit seulement restaurant et montant/pack. Les coordonnées, le message,
le design et les préférences sont transmis dans l'appel d'achat après paiement. Le webhook
reconstruit pourtant la carte depuis les metadata du PaymentIntent. Il peut gagner la course,
ou être le seul chemin exécuté après fermeture du navigateur.

**Sonde confirmée :** le webhook crée une carte sans emails ni message ; le retour navigateur
avec les coordonnées échoue ensuite avec « Ce paiement a déjà été utilisé » / HTTP 409.

**Correction attendue :** sauvegarder une commande complète avant paiement ; Stripe ne porte
qu'une référence opaque de commande. Un seul service finalise la commande depuis le webhook
ou le retour navigateur. Le rejeu autorisé retrouve la carte existante plutôt que d'afficher
un échec après encaissement.

### GC-05 — P1 : unicité financière insuffisante

`apps/api/src/modules/gift-cards/gift-card-payment.service.ts:74`
et `packages/database/prisma/schema.prisma:2784`

Le contrôle `findFirst` avant création n'est pas atomique. GiftCard.stripePaymentIntentId
n'est pas unique ; deux finalisations concurrentes peuvent donc créer deux cartes. La clé
Stripe de création du PaymentIntent contient un UUID neuf par requête : elle protège les
retries du SDK, mais pas le rejeu de la même commande HTTP.

**Correction attendue :** idempotence fondée sur une commande persistée ; unicité DB après
audit des doublons ; gestion de collision qui récupère le résultat existant. Le journal des
événements Stripe et le verrou métier complètent, sans remplacer, cette unicité.

### GC-06 — P1 : remboursement et carte utilisable divergent

`apps/api/src/modules/gift-cards/gift-card-payment.service.ts:455`
et `apps/api/src/modules/gift-cards/gift-card.service.ts:241`

- Le webhook de remboursement modifie seulement stripePaymentStatus, pas le solde/statut.
- Le handler `charge.refunded` passe `charge.status`, pas l'état de l'objet Refund.
- `cancel()` marque le paiement remboursé sans traiter un statut Refund pending/failed.
- Le montant à rembourser est lu avant l'appel Stripe et sans verrou partagé avec le débit.
  Un usage concurrent ou une panne après remboursement peut faire diverger les deux systèmes.
- Le remboursement n'utilise pas de clé métier stable d'idempotence.

**Sonde confirmée :** même avec refundStatus `succeeded`, la carte garde 100 EUR de solde
ACTIVE et passe encore `validateCode()`.

**Correction attendue :** demande de remboursement durable, suspension du montant concerné,
transition après résultat financier vérifié, traitement des remboursements partiels et externes,
reprise après panne et rapprochement. Réserver le montant sans conserver une transaction DB
ouverte pendant un appel réseau.

### GC-07 — P1 : cagnotte incomplète sur incident et clôture

`apps/api/src/modules/gift-cards/gift-card-crowdfunding.service.ts:194`
et `apps/api/src/modules/gift-cards/gift-card.routes.ts:869`

- Le webhook général ne traite pas `type: crowdfunding_contribution`. Ces PaymentIntents
  n'ont pas restaurantId ; le paiement est acquitté sans enregistrer de contribution.
- L'annulation d'une cagnotte financée ne rembourse pas les contributeurs : son PaymentIntent
  de carte est nul et son solde reste à zéro tant qu'elle n'est pas clôturée.
- La clôture lit le total puis écrit hors transaction/verrou commun avec les contributions.
  Une contribution tardive peut être omise ; deux clôtures concurrentes peuvent réécrire
  le solde. Une simple transaction de lecture/insert dans contribute ne suffit pas à l'éviter.
- La clôture transforme CROWDFUNDED en SINGLE : la page publique refuse ensuite cette carte
  comme « n'est pas une cagnotte ». Le frontend perd ainsi le récapitulatif partagé.
- Aucune clôture automatique à l'objectif ou à l'échéance n'a été trouvée dans les workers.
- La commission est déduite de la valeur cadeau : 100 EUR collectés deviennent 95 EUR à 5 %,
  alors que l'achat simple crée une carte de 100 EUR. La règle commerciale est incohérente.

**Deux sondes confirmées :** webhook contribution acquitté sans contribution ; annulation
de cagnotte financée sans appel de remboursement.

**Correction attendue :** identité de cagnotte conservée, états explicites, webhook spécialisé,
verrou commun de collecte/clôture, gestion des paiements en vol, annulation par contribution,
règles d'objectif/échéance et page de récapitulatif après clôture. Par défaut recommandé,
faire porter la commission au restaurant et conserver la valeur nominale offerte.

### GC-08 — P1 : confusion réservation / consommation de valeur

`apps/api/src/modules/connect/connect.routes.ts:774`
et `apps/api/src/modules/agentic-reservations/core/reservation.service.ts:544`

Connect débite la carte à la confirmation sur une estimation `priceRange × 25 × couverts`.
L'achat avec créneau débite le montant nominal de la carte. Ces montants ne représentent pas
nécessairement l'addition réelle. La création de réservation, le débit et le snapshot sont
séparés ; une erreur d'application est loguée mais la réservation reste créée. En cas de
COMPLEMENT_REQUIRED, le débit existe mais le snapshot n'est pas écrit et le complément
n'est pas persisté ici. Aucun recrédit de carte lors d'annulation de réservation n'a été trouvé.

La route publique `/public/gift-cards/apply` accepte réservation et montant fournis par le
client ; le service ne charge pas la réservation pour vérifier son restaurant, l'autorité du
demandeur ou un montant dû serveur. Il n'empêche pas le rejeu du même débit métier.

**Décision recommandée :** une carte de valeur est un moyen de règlement de l'addition.
La réservation peut l'associer ou réserver un crédit, mais ne consomme pas une estimation.
Une expérience prépayée suit une règle propre : réservation, réalisation, annulation/no-show
et éventuel complément explicites. Toute écriture financière est idempotente et auditée.

### GC-09 — P1 : parcours annoncé d'utilisation classique incomplet

`apps/connect/src/components/booking-widget.tsx`
et `apps/api/src/modules/gift-cards/gift-card-email.service.ts:113`

Les messages demandent d'utiliser le code pendant la réservation. L'API confirm accepte
giftCardCode, mais la recherche dans les clients Connect/widget ne trouve pas de champ de
code dans le parcours de réservation classique. Le parcours avec créneaux existe après
achat, sans constituer une page bénéficiaire complète. Le mail carte cadeau ne contient pas
de lien dédié de réservation et ne transmet pas les préférences de créneau.

**Correction attendue :** page bénéficiaire stable accessible depuis email/PDF, consultation
du solde, réservation associée et instructions de règlement au restaurant.

### GC-10 — P1 : versements restaurant non démontrés

`apps/api/src/modules/gift-cards/stripe.service.ts:44`

Le PaymentIntent utilise le compte de la clé Stripe globale, sans destination restaurant,
compte connecté ni application_fee_amount. La commission est enregistrée localement ; aucun
transfert/rapprochement restaurant n'a été trouvé dans le flux cartes cadeaux. La présence
de Stripe démontre l'encaissement technique, pas le versement correct à chaque établissement.

**Décision requise :** modèle marchand, titulaire de l'encaissement, frais, responsabilité des
remboursements/litiges et circuit de versement. Pour un SaaS multi-restaurants, qualifier une
solution où le restaurant encaisse et Suppernote perçoit sa commission. Reprendre les décisions
et conventions de `docs/architecture/adr-reservation-payments-foundation.md`, qui indique
déjà que le modèle marchand reste à décider ; ne pas activer son provider par cet audit.

### GC-11 — P1 : image distante récupérée sans restriction serveur

`apps/api/src/modules/gift-cards/gift-card-pdf.service.ts:26`

Le PDF fetch une customImageUrl issue du client avec un simple timeout. Pas de restriction
d'hôte, d'adresses privées, de redirection ou de taille avant lecture du buffer. Cela crée
une surface SSRF et de consommation mémoire sur la génération publique du PDF. Aucun
appel à une adresse interne n'a été exécuté dans cet audit.

**Correction attendue :** upload sur stockage maîtrisé puis référence interne ; à défaut,
allowlist stricte, contrôles réseau/redirections/type/taille et téléchargement borné.

### GC-12 — P2 : livraison initiale sans reprise durable

`apps/api/src/modules/gift-cards/gift-card-payment.service.ts:194`

Les notifications d'achat passent par Promise.allSettled dont les résultats ne sont pas
inspectés. Si la carte existe au rejeu webhook, le service sort sans retenter sa livraison.
Un crash après insertion peut aussi perdre les envois. Le mécanisme solide du rappel
d'expiration existe, mais n'est pas branché à la livraison initiale dans ce service.

**Correction attendue :** outbox persistante dans la transaction d'émission, envoi worker
idempotent, états en attente/envoyé/échec, statut de livraison exposé et renvoi opérateur.

### GC-13 — P2 : statistiques et réglages ne correspondent pas aux opérations

`apps/api/src/modules/gift-cards/gift-card.service.ts:337`
et `apps/api/src/modules/restaurants/restaurant.routes.ts:63`

« CA total vendu » additionne les valeurs de toutes les cartes, y compris les cartes manuelles,
annulées et vocales non encaissées. Ce n'est pas une mesure fiable des encaissements nets.
Une carte expirée peut garder le statut ACTIVE stocké, car la validation vérifie la date
sans normaliser le statut ; les filtres et compteurs peuvent alors être trompeurs.

Le dashboard affiche une commission modifiable, mais le schéma de PATCH restaurant n'accepte
pas giftCardCommissionRate : Zod l'élimine. La projection RestaurantService ne l'expose pas
non plus. L'interface peut afficher une sauvegarde réussie sans appliquer ce taux.

**Correction attendue :** ventes encaissées, cartes offertes, remboursements, crédit utilisé,
encours utilisable et commissions distincts ; période et export comptable ; configuration
commerciale administrée par les rôles adéquats et contrat UI/API cohérent.

### GC-14 — P2 : promesse premium partiellement cosmétique

`apps/api/src/modules/gift-cards/gift-card-pdf.service.ts:49`
et `apps/api/src/modules/gift-cards/gift-card-recommender.ts:18`

templateId est sauvegardé mais n'est pas utilisé par le générateur PDF ni les emails. Le
concierge est une règle de prix avec texte prédéfini, pas une recommandation personnalisée
fondée sur les expériences du restaurant. Les packs n'ont pas de snapshot commercial vendu :
le prix est relu après paiement, une modification du pack peut bloquer l'émission d'une carte
déjà payée et les descriptifs/noms d'anciennes cartes suivent les modifications du catalogue.

Les emails interpolent aussi noms/messages dans du HTML sans échappement : corriger
l'injection de contenu/liens, sans prétendre avoir démontré une exécution JavaScript.

**Correction attendue :** rendu cohérent preview/email/PDF, snapshot de l'offre au checkout,
conditions d'utilisation explicites et personnalisation fondée sur de vraies données métier.

## Produit cible

### Restaurateur : centre d'opérations

La première action devrait être « Utiliser une carte », accessible sur téléphone/iPad en
service. Saisir ou scanner le code, voir restaurant/validité/solde, saisir le montant réel,
confirmer et obtenir une preuve. Débit partiel, complément hors carte et solde restant sont
visibles. Une correction produit une écriture inverse auditée avec motif et droits dédiés.

La fiche carte devient une chronologie : émission, paiement, livraison, réservation, usages,
remboursement et incidents. Actions : renvoyer, télécharger, prolonger selon politique,
rembourser, consulter les pièces. Les données personnelles restent dans les vues autorisées,
pas dans les logs. La recherche accepte le code court, aujourd'hui absent du filtre serveur.

Le pilotage sépare recettes et valeur restant à honorer. Une file « À traiter » affiche les
paiements sans carte, échecs de livraison, remboursements en attente et cagnottes à clôturer.

### Acheteur : offrir en quelques minutes

Choix entre crédit et expérience ; visuels du restaurant ; personnalisation prévisualisée ;
validation email avant encaissement ; envoi maintenant ou à une date choisie ; réception chez
l'acheteur pour imprimer/offrir soi-même. Présenter clairement valeur, frais éventuels,
validité, conditions et canal de livraison avant paiement. Le checkout reprend après recharge
ou fermeture, sans encourager un nouveau paiement lorsque le premier est en traitement.

### Bénéficiaire : recevoir, réserver, utiliser

Page cadeau accessible par lien opaque distinct du code de débit. Montant/expérience,
message, restaurant, validité, solde, PDF et réservation à partir des disponibilités réelles.
QR de consultation puis débit authentifié côté équipe. La page conserve son récapitulatif
après utilisation ou clôture de cagnotte ; une réservation annulée suit une politique claire.

### Commercial : transformer le module en canal de vente

Catalogue d'expériences vendables : contenu exact, nombre de personnes, restrictions de
service, suppléments et conditions versionnées. Campagnes par occasion, pages partageables,
QR au restaurant et suivi du tunnel de vente. Mesurer conversion, échecs de paiement,
livraison, délai avant utilisation, solde utilisé et dépenses supplémentaires avec données
agrégées. Le téléphone conseille puis envoie un paiement ; il accompagne ensuite la
réservation une fois l'achat validé. Les ventes entreprises viennent après le socle opérationnel.

## Plan recommandé

| Lot                          | Objectif                                                       | Livrables et sortie attendue                                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — fiabilité                | Aucun euro créé ou perdu sans trace                            | GC-01 à GC-11 ; commandes persistées, finalisation unique, droits/scopes, remboursements, règle réservation/débit et circuit marchand qualifiés ; tests DB réels de concurrence et scénarios Stripe sandbox          |
| B — exploitation             | Le restaurant utilise et dépanne sans intervention développeur | Débit en salle, historique, rôles, renvoi/livraison durable, incidents, rapprochement, exports et statistiques fiables ; équipe pilote capable de traiter une vente, un usage partiel, une annulation et un incident |
| C — expérience et croissance | Une offre attractive, mesurable et différenciante              | Page bénéficiaire, QR, rendu réel des templates, envoi programmé, packs versionnés, cagnotte complète, tunnel analysé, achat vocal par lien                                                                          |

Recommandation immédiate : suspendre les parcours cagnotte et émission vocale non payée tant
qu'ils ne sont pas corrigés et qualifiés. C'est une recommandation, aucun flag n'a été modifié.
Prioriser un parcours complet carte de valeur avant la complexité des cagnottes et expériences.

Ne pas commencer par marketplace, multi-devise, cadeau physique ou multiplication des fonctions
IA. La différenciation utile est un cadeau réellement reçu, facile à réserver et à utiliser,
avec un restaurateur qui comprend ce qu'il a encaissé et ce qu'il doit encore honorer.

## Critères avant pilote autonome

1. Achat simple et pack, paiement refusé, 3DS et état processing ; aucun code actif sans
   paiement vérifié ou émission gratuite explicitement autorisée/auditée.
2. Webhook avant/après retour navigateur, événement doublé, retardé, navigateur fermé ;
   une seule carte et une seule valeur, retrouvables par l'acheteur autorisé.
3. Concurrence réelle sur DB : émission double, débit double, débit/remboursement,
   clôture/contribution ; soldes et journaux cohérents.
4. Livraisons refusées, timeout provider et redémarrage après création ; reprise contrôlée
   et statut consultable sans envoyer aveuglément deux fois.
5. Usage partiel, usage complet, complément, annulation de réservation et carte expirée ;
   aucun débit d'une estimation non consentie, aucune valeur perdue silencieusement.
6. Remboursement total/partiel/externe/en attente/échoué et litige ; cohérence Stripe/carte
   et preuve du traitement, y compris pour chaque contributeur d'une cagnotte.
7. Isolation entre restaurants et droits de l'équipe sur émission, débit, remboursement,
   annulation et réglages.
8. Pack modifié après checkout ; conditions vendues et prix payés restent les références.
9. Échéance/objectif/clôture/annulation de cagnotte, paiement en vol et récapitulatif partagé.
10. Rapprochement des paiements, frais, commissions, remboursements et versements restaurant
    sans écart inexpliqué ; responsabilité et conditions commerciales documentées.
11. Vérification réelle mobile/iPad des parcours achat, bénéficiaire et débit en salle ;
    aujourd'hui les E2E Connect gift-card couvrent essentiellement navigation/validation.
12. Pilote limité avec montant plafonné et support défini ; exercice réel d'achat, usage et
    remboursement après la qualification sandbox, avec métriques et procédure de reprise.

## Références Stripe vérifiées

- [Webhooks](https://docs.stripe.com/webhooks) : doublons et ordre non garanti, ids d'événements,
  traitement asynchrone. Le serveur doit tolérer ces cas par construction.
- [Idempotence](https://docs.stripe.com/api/idempotent_requests) : réutiliser la même clé pour
  rejouer une opération, plutôt qu'en générer une neuve pour la même commande.
- [Metadata](https://docs.stripe.com/api/metadata) : maximum 500 caractères par valeur ; déplacer
  le message et les détails cadeaux dans la commande serveur évite aussi cette limite
  (le schéma actuel accepte jusqu'à 1 000 caractères de message).
- [Refund](https://docs.stripe.com/api/refunds/object) : suivre l'objet remboursement et ses
  états, notamment les motifs d'attente/échec, plutôt que le statut de la charge.

Les recommandations de politique commerciale, de produit et de lots sont des propositions
de cet audit ; aucune décision de migration, activation ou modèle marchand n'est adoptée ici.

## Suivi du lot A — implémentation locale

Le socle financier et les parcours bénéficiaire/Connect sont corrigés dans le workspace.
Les décisions marchand Connect et réservation sans débit ont été confirmées par
l’utilisateur. Les tests PostgreSQL réels couvrent dix scénarios financiers, dont
concurrence, rejeu, annulation, remboursement externe et catalogue modifié après checkout.
La suite API complète passe (3 143 tests) ainsi que Connect (115 tests) et les typechecks.
La migration additive a été appliquée sur une base locale isolée et le PDF réel inspecté.
Ce suivi ne prouve pas les encaissements ou versements réels : aucune migration distante
ni aucun déploiement effectué. La sortie opérationnelle du lot A reste conditionnée à
la qualification Stripe sandbox et au pilote décrits dans
[le runbook](../runbooks/gift-card-financial-safety.md). L’exploitation en salle, le support,
le rapprochement et les notifications durables restent au lot B.

## Suivi — caisse et registre opérationnel, 30 septembre 2026

Parcours local de débit en salle ajouté au dashboard : recherche par code, addition
réelle, ticket unique, réservation associée facultative, confirmation, complément et reçu.
Le serveur protège les relances avec un identifiant de demande et une unicité de ticket
par établissement ; solde, reçu, réservation et audit sont atomiques. Migration additive
`20260930210000_gift_card_operations`, sans réécriture des débits historiques.
Nouvelles routes réservées à l’équipe du site ; export réservé au propriétaire/manager.

Historique des débits, paiements et remboursements ; bilan distinguant paiements du
registre, cartes manuelles, solde disponible et solde bloqué. Ancien « CA total vendu »
renommé « Valeur totale émise ». Export CSV borné et protégé contre les formules de tableur,
sans coordonnées client. Son cumul de remboursements est actuel, pas daté par période.

Ce volet ne clôt pas l’industrialisation : envois best effort, rapprochement historique
incomplet et absence d’écran de résolution Stripe restent des limites. Qualification
Connect en mode test et essai de caisse en staging/pilote toujours requis avant vente réelle.
Voir `docs/runbooks/gift-card-operations.md` pour les contrats et limites de l’export.

## Suivi — envois durables, 30 septembre 2026

Les envois d’achat, contribution, clôture et remboursement sont désormais persistés
avec leurs événements outbox dans la transaction financière. Le worker conserve
l’acceptation fournisseur et bloque les résultats incertains. Le worker financier
récupère les jobs oubliés et marque les soumissions interrompues à vérifier.

Le détail dashboard expose l’historique, la reprise d’un refus certain, la vérification
provider, le renvoi volontaire avec identifiant stable et la résolution manuelle auditée.
OWNER/MANAGER gèrent les envois ; STAFF lit l’historique. Les payloads de files restent
sans coordonnées ni code cadeau. Une acceptation fournisseur ne vaut pas réception.

Vérifications locales : API complète 313 fichiers et 3 290 tests réussis ; 21 tests
PostgreSQL réels dont rollback d’outbox, deux workers simultanés, résultat réseau perdu,
reprise certaine, résolution auditée et récupération après interruption. Dashboard :
3 fichiers et 7 tests ; types API/dashboard, lint, format, Prisma et migration vérifiés.
Les tests utilisent des fournisseurs simulés, sans envoi réel.

Le dossier partagé ayant repassé sur main, la suite est conservée dans le worktree isolé
`/Users/hamza/.codex/worktrees/gift-card-delivery/Sokar`, depuis la sauvegarde WIP `02443476`.
Voir `docs/runbooks/gift-card-delivery.md`. Qualification providers/Stripe du pilote,
édition des contacts et rapprochement financier restent à effectuer ; aucun déploiement
n’a été réalisé par cette intervention.

## Intégration autorisée dans Suppernote

Les lots financiers, caisse et livraison sont repris sur main dans la branche
`codex/gift-card-operations`, sans les changements voix étrangers à ce périmètre.
Validation : 3288 tests API, 115 Connect, 7 dashboard cartes cadeaux, 21 transactions
PostgreSQL réelles et types des trois applications. Les migrations sont additives ;
la qualification des comptes Stripe et des fournisseurs reste nécessaire avant activation
des ventes pour chaque restaurant.
