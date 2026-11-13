# Marketing : repérer, cibler, mesurer

Date : 2 novembre 2026 (version 2, après revue critique)
Statut : proposé, en attente de relecture de Hamza. Aucun code écrit.

## But

Le remplissage d'un service creux (`apps/api/src/modules/marketing/fill-service.service.ts`) repose
sur trois faiblesses : le gérant doit repérer le creux, Suppernote suppose que 20 % des clients contactés
réservent (`TAUX_REPONSE`), et les « places libres » comptent aussi les places qui se seraient
remplies seules. Ce lot rend le système plus utile dès maintenant et prépare une mesure honnête,
**sans retirer la validation du gérant** : rien ne part sans lui.

Réussite :

- Le gérant voit les services qui resteront probablement vides, pas seulement ceux qui le sont
  aujourd'hui.
- Une audience ne dépasse jamais ce que le budget permet d'envoyer, et Suppernote n'écrit pas aux clients
  trop peu susceptibles de venir.
- Chaque campagne enregistre de quoi répondre plus tard à deux questions : le message a-t-il créé des
  réservations, et a-t-il seulement déplacé des clients ?

## Pourquoi cette version change de direction

La version 1 prévoyait d'apprendre un multiplicateur `k` par restaurant dès 20 clients témoins. Une
simulation de sa formule (36 envois et 4 témoins par campagne, taux de base 5 %, hypothèses non
mesurées) montre qu'elle ne tient pas :

- Pour un effet réel de +5 points, `k` varie de 0,20 à 0,60 après 5 campagnes (p10 à p90).
- Détecter +3 points demande environ 486 témoins, soit environ 120 campagnes de cette taille.
- Si le message marche mal, `k` baisse et l'audience augmente : avec un effet nul, l'audience calculée
  atteint 223 clients pour 8 réservations visées. `assertDailyEmailBudget` refuserait ce lancement.

**Décision : ce lot ne calcule aucun `k` et ne modifie jamais l'audience à partir d'une mesure.** Il
capture les données. L'apprentissage fera l'objet d'une spec séparée, une fois les conditions réunies
(voir « Plus tard »).

## Hors périmètre

- Multiplicateur `k`, recalibrage automatique, fourchettes chiffrées de couverts.
- Envoi par vagues, rédaction par modèle de langage, outil Companion, pilote automatique.
- Exploration des clients peu classés.
- Toute modification de schéma. Ce lot n'en demande aucune.

## Contraintes reprises du code et des décisions

- Consentement, opposition, fréquence : inchangés, via `buildAudience`.
- Le modèle de langage n'intervient pas.
- Aucune donnée personnelle dans les réponses d'aperçu, les suggestions ni les journaux.
- Pas de réglage par restaurant : le comportement vaut pour tous, sans drapeau.
- Suggestions et préparation réservées à la direction (capability `marketing.campaigns`,
  `role-policy.ts`).
- Les champs existants des réponses ne changent pas ; tout ajout est additif.

## Préalables à tout envoi réel

Le code de ce lot peut être livré envois coupés. `MARKETING_SENDS_ENABLED` reste à `false` tant que :

- l'effacement et l'opposition marketing, bloqués en 503 en production d'après `Context.md`, ne sont
  pas rouverts ; leur état est à revérifier au moment de l'activation ;
- le ciblage selon l'historique du client n'est pas mentionné dans la notice client
  (`privacy-client-annex.md`) et validé ; il relève probablement du profilage.

## Phase 1 : repérer les vrais creux

**Prévision.** Nouvelle fonction `forecastEmptyPlaces`, dans le module marketing, pour un service
donné :

```text
places vides probables = max(0, places libres aujourd'hui − arrivées tardives attendues)
```

- `Arrivées tardives` : pour les 8 derniers services du même jour de semaine et du même service
  ayant au moins une réservation, couverts des réservations créées après le même délai avant le
  service (`COUNTED_RESERVATION_STATES`, `isTest: false`). On prend la médiane.
- Délai = début du service visé − maintenant. Pour un service passé, le seuil de création est son
  début moins ce délai.
- Moins de 4 services comparables : arrivées tardives = 0 et `forecastSource: 'simple'` ; sinon
  `forecastSource: 'historique'`.

`shortcut: médiane sans saison ni jours fériés ni annulations ; à affiner quand des restaurants ont
plusieurs mois d'historique suivi.`

**Liste.** `GET /marketing/fill-suggestions` (direction seule). Horizon de **7 jours**, deux services
par jour. Un service est retenu s'il est ouvert, non plein, de capacité connue, sans campagne déjà
prévue pour lui, avec au moins `max(8, 30 % de la capacité)` places vides probables. Un service du
jour n'est retenu qu'à plus de 2 heures de son début.
`shortcut: seuils posés à la main ; à régler selon les suggestions réellement ignorées.`

**Classement de la phase 1.** Par places vides probables décroissantes, puis date la plus proche. On
renvoie les 3 premiers.

**Dashboard.** Pas de nouvelle carte : `EmptySlotsWidget` affiche la liste pour la direction. Il est
sorti du bloc replié « Prévisions sur 7 jours et absences sur 90 jours » de la page d'accueil, où il
passerait inaperçu. Il indique le service réel au lieu du `service=soir` figé dans son lien.
Pour les autres rôles, et si la route échoue, le comportement actuel de
`/dashboard/empty-slots` reste en place : cette route ne change pas.

Actions : « Préparer » ouvre `/dashboard/marketing/fill-service?date&service`, « Ignorer » appelle la
route ci-dessous. États chargement, vide, erreur et données. Libellés fr, en, es, it, vouvoiement.

**« Ignorer ».** `POST /marketing/fill-suggestions/dismiss` pose une clé Redis de 7 jours pour
(restaurant, date, service). Résultat de la liste en cache Redis 30 minutes par restaurant, invalidé
par un « Ignorer » et par la création d'un brouillon. Redis vidé : la suggestion revient, sans
conséquence. Redis indisponible : la liste est calculée sans cache, « Ignorer » renvoie une erreur
affichée.

**Coût de calcul.** L'audience et l'historique sont chargés **une seule fois** par calcul, puis
réutilisés pour les 14 services. `planServiceFill` est découpé en chargement et sélection pure.
`AUDIENCE_TOO_LARGE` n'interrompt pas la liste : les services restent affichés, sans préparation
chiffrée.

## Phase 2 : cibler simplement

**Paliers.** Calculés à partir des visites des 12 derniers mois : réservations passées confirmées,
en salle ou honorées, jamais les absences ni les annulations, car l'équipe ne marque pas toujours
« honorée ». La requête d'affinité de
`planServiceFill` les charge déjà ; on y ajoute le nombre total de visites.

| Palier        | Condition                                       | Probabilité de départ |
| ------------- | ----------------------------------------------- | --------------------- |
| `CRENEAU`     | ≥ 2 visites sur ce créneau, la dernière < 120 j | 0,30                  |
| `REGULIER`    | ≥ 3 visites, la dernière < 180 j                | 0,15                  |
| `CONNU`       | Au moins 1 visite                               | 0,08                  |
| `SANS_VISITE` | Aucune visite sur 12 mois                       | 0,03                  |

`shortcut: probabilités posées à la main, utilisées seulement pour dimensionner l'audience ; à
remplacer quand la mesure par palier existe.`

C'est une probabilité de réserver après le message, pas l'effet propre du message. Rien ne prouve
encore que les habitués sont les plus sensibles au message : ils viendraient peut-être sans lui. La
mesure par palier de la phase 3 sert à trancher.

**Choix de l'audience.**

1. Exclure, en plus des exclusions actuelles, les clients ayant une réservation active dans les
   7 jours autour du service : les relancer risquerait surtout de les déplacer.
   Compteur additif `excludedNearby`.
2. Exclure les clients sous `MIN_PROBABILITY = 0,05`. Ils ne sont donc jamais contactés dans ce lot.
3. Trier par palier, puis visites sur le créneau, puis récence.
4. S'arrêter dès que `somme des p × taille de groupe × part contactée` atteint les places vides
   probables.
5. Plafonner les **envois** : pour l'e-mail, au reste du budget du jour
   (`remainingDailyEmailBudget`) ; dans tous les cas, à `MAX_CAMPAIGN_AUDIENCE`.
6. Budget nul : aucun brouillon, champ additif `budgetExhausted: true`.

Le contrôle au lancement (`assertDailyEmailBudget`) reste en place : le budget a pu baisser entre
l'aperçu et le lancement.

**Remplacement.** Ce calcul remplace `ceil(places / groupe / TAUX_REPONSE)`. `TAUX_REPONSE` disparaît.

**Affichage.** Aucune fourchette ni aucun chiffre de couverts gagnés. Seulement des faits :

- places vides probables, et l'origine de ce chiffre (`forecastSource`) ;
- nombre d'envois et coût estimé ;
- composition de l'audience : « 9 habitués de ce créneau, 12 clients réguliers » ;
- mention « Estimation de départ, pas encore mesurée sur vos campagnes ».

Le serveur renvoie des comptes par palier. Le texte est produit à l'affichage, pour rester traduisible.

**Suggestions enrichies.** Chaque suggestion gagne `sends`, `tiers`, `costEstimate` et `canPrepare`.
Canal utilisé pour ce calcul : l'e-mail. « Préparer » transmet ce canal à la page de remplissage, dont
le défaut reste le SMS.

- `canPrepare` est faux si les envois sont coupés, si le budget est épuisé ou si aucun client n'est
  éligible. Le service reste alors affiché comme creux, sans bouton « Préparer ».
- Classement : d'abord `canPrepare`, puis couverts attendus **par envoi**, en interne seulement, puis
  date la plus proche.
- Les audiences de plusieurs suggestions peuvent se recouper : on n'additionne jamais leurs gains.

## Phase 3 : capturer et mesurer

**Témoin.** `HOLDOUT_RATE` passe de 10 % à 30 %, pour tous, tant que la mesure n'a pas abouti. Le
témoin ne consomme pas de budget (`audienceCount` ne compte que les destinataires). En contrepartie,
30 % des clients choisis ne sont pas contactés. Pour détecter +3 points : environ 1 600 envois au lieu
de 4 400.

**Snapshot.** Chaque membre garde en plus `tier` et `modelVersion: 'v1'`. La probabilité se déduit des
deux. Aucune phrase n'est stockée.

**Rapport de campagne.** La logique de `serviceFillReport` (`marketing-report.service.ts`) est
complétée par des champs additifs :

- `reservedCustomers` par groupe, destinataires et témoin ;
- `effect { difference, margin95 }` sur la part de clients ayant réservé, avec sa marge d'erreur. Le
  gérant lit par exemple « entre −3 et +14 points ». Tant que la marge contient 0 : « Pas encore de
  preuve d'effet » ;
- `byTier` : clients et réservants, destinataires et témoin, par palier ;
- `netEffect30d` : couverts par client, tous services confondus, de l'envoi à 30 jours plus tard,
  destinataires contre témoin. Il n'est calculé qu'une fois les 30 jours écoulés. C'est le chiffre qui
  révèle le déplacement ;
- `truncated: true` si la campagne a été mise en pause (`TARGET_SERVICE_FULL`). Ses destinataires
  comptent aussi des clients jamais contactés et le service plein plafonne les réservations : elle
  est signalée comme non concluante et ne sert pas de mesure.

Une campagne n'est comparée que sur un seul canal. Les agrégats futurs garderont les canaux séparés.

## Garde-fous

- Aucune suggestion ni aperçu n'écrit en base ni n'envoie quoi que ce soit, hors cache et clé
  « Ignorer » dans Redis.
- Le brouillon passe par le circuit existant (`createServiceFillDraft`) : contrôle de consentement au
  dernier moment et pause si le service se remplit.
- Aucune mesure ne modifie l'audience ni le classement dans ce lot.
- Les données cumulées d'un mauvais résultat ne peuvent donc pas augmenter le nombre d'envois.

## Tests

- `forecastEmptyPlaces` : historique suffisant et insuffisant, médiane, seuil de création, jamais
  négatif.
- Suggestions : service fermé, plein, capacité inconnue, déjà ciblé, du jour trop proche, ignoré,
  horizon de 7 jours, plafond de 3, classement.
- Paliers : chaque frontière, dont un client régulier d'un autre jour qui n'est pas traité comme un
  client sans visite.
- Audience : arrêt à l'objectif, plancher de probabilité, réservation proche exclue, plafond de
  budget, budget nul, vivier insuffisant, part contactée de 70 %.
- Rapport : marge d'erreur sur un cas calculé à la main, `byTier`, `netEffect30d` avant et après
  30 jours, campagne tronquée.
- Routes : direction seule, 403 sinon ; réponse sans nom ; Redis indisponible ;
  `AUDIENCE_TOO_LARGE` n'interrompt pas la liste.
- Dashboard : quatre états, « Ignorer » retire la ligne, rôle non-direction inchangé, `canPrepare`
  faux sans bouton « Préparer ».
- Les tests actuels de `fill-service.service.test.ts` qui supposent le taux de 20 % ou le témoin à
  10 % sont mis à jour.

## Livraison

Trois phases dans l'ordre 1, 2, 3, chacune vérifiée seule (tests, typecheck, lint). Même branche et
même PR, selon la préférence de Hamza d'une seule PR par branche. La branche exacte est à confirmer
au moment du plan.

## Plus tard (autre spec)

L'apprentissage ne s'ouvre que lorsque toutes ces conditions sont réunies :

- au moins 180 témoins **sur un même canal, tous restaurants confondus**, ce qui permet de détecter
  environ +5 points ;
- un simulateur en test, avec un effet connu, montre que le calcul retrouve la bonne valeur ;
- `byTier` et `netEffect30d` ont été lus par Hamza.

Règles déjà décidées pour cette future spec :

- Valeur commune à la plateforme d'abord, puis rapprochement de chaque restaurant selon ses données.
- Une mesure basse ne fait jamais écrire à plus de clients : elle réduit les suggestions.
- Une fourchette de couverts n'est affichée que si elle inclut l'incertitude de la mesure.

## Limites connues

- Les probabilités, seuils et la prévision sont des hypothèses, marquées `shortcut:`, non testées sur
  des données réelles. Le seed n'a aucun consentement.
- Tant que les envois sont coupés en production, rien n'est mesuré. La mesure commence avec le premier
  pilote. Avant cela, seule la prévision des creux apporte quelque chose au gérant.
- Le témoin est tiré parmi les clients choisis : la mesure ne dit rien des clients jamais choisis,
  notamment sous `MIN_PROBABILITY`.
- La capacité compte une seule rotation par service et ne voit pas les places perdues sur une table
  partiellement occupée : le chiffre peut être trop bas comme trop haut. Le moteur de disponibilité
  reste seul juge de ce qui est réservable.
- Un même client peut être destinataire d'une campagne et témoin d'une autre, et les automatisations
  marketing peuvent toucher le témoin : la mesure peut en être légèrement faussée.
- La purge marketing ne touche pas les snapshots d'audience. L'effacement RGPD supprime les membres
  concernés : la mesure perd alors ces clients, ce qui est voulu.
