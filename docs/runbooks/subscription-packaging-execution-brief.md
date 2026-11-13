# Suppernote — Brief de refonte éditoriale des abonnements

Date : 13 octobre 2026. Document de travail pour l'agent chargé de la livraison.

> Cadrage produit actualisé le 29 octobre 2026 : Suppernote est une plateforme de réservations,
> d'organisation du service et de relation client ; l'assistant vocal est une de ses fonctions.
> Les exemples et répartitions ci-dessous restent des cibles éditoriales, pas une preuve
> d'ouverture commerciale. Voir la [carte produit](../PROJECT_MAP.md#ce-quest-sokar) et les
> [portes de release](../release/product-gates.json) avant de présenter une inclusion.

## Mission

Travaillez dans `/Users/hamza/Projects/Sokar`.

Livrez une page Tarifs qui donne envie à un restaurateur de confier à Suppernote une partie de son
accueil et de son organisation. Elle doit lui permettre de comprendre l'offre, de se reconnaître
dans une formule et de savoir ce qu'il paiera.

L'ambition : plus de présence en salle, un service mieux préparé, des clients que l'on accueille
avec attention, et une équipe qui retrouve les bonnes informations au bon moment. Rendez cette
ambition concrète par les fonctions effectivement disponibles.

Exécutez le chantier : audit ciblé, rédaction, intégration, vérification et livraison. Préservez
le travail local et suivez AGENTS.md. Réutilisez les composants, les constantes de prix, les
entitlements et les parcours existants. Conservez la direction visuelle actuelle ; ajustez seulement
ce qui améliore la lecture, la comparaison ou le choix.

## 1. Partir du travail du restaurateur

La page s'adresse d'abord à un propriétaire, un gérant ou un responsable de salle. Il doit
retrouver des situations qu'il connaît : le téléphone pendant le service, une réservation prise
en salle à reporter, un créneau complet, un habitué qui revient, plusieurs équipes à coordonner.

Donnez à chaque formule une raison d'achat distincte :

| Formule    | Situation du client                                                            | Valeur à faire comprendre                                           |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Essential  | Une équipe qui veut mieux gérer les appels et les réservations d'un restaurant | Un accueil organisé et un planning commun pour préparer le service  |
| Pro        | Un restaurant qui veut mieux connaître ses clients et entretenir la relation   | Des informations utiles et des actions de fidélisation pertinentes  |
| Multi-site | Plusieurs établissements avec leurs équipes, règles et identités               | Une vue d'ensemble et un fonctionnement cohérent entre les adresses |

Le lecteur doit pouvoir expliquer la différence entre les trois offres après une lecture rapide.
Essential doit donner confiance dans le socle. Pro doit montrer une valeur supplémentaire réelle.
Multi-site doit exprimer ce que le pilotage de groupe apporte à chaque équipe.

## 2. Écrire avec précision et caractère

Adoptez une voix chaleureuse, posée et professionnelle. Écrivez pour des professionnels de
l'hospitalité avec des phrases courtes, des verbes concrets et le vouvoiement.

Évoquez la salle, le service, les réservations, les couverts, les habitués et les établissements
lorsque ces mots expliquent un usage. L'IA reste un moyen de traiter les appels ; la promesse
porte sur l'accueil et le fonctionnement du restaurant.

Une phrase attractive doit rester compréhensible sans sa mise en page. Pour chaque bénéfice,
demandez-vous : quelle situation change, pour qui, grâce à quelle fonction ?

Repères de rédaction :

| Libellé technique ou vague | Formulation plus utile, sous réserve de disponibilité                 |
| -------------------------- | --------------------------------------------------------------------- |
| Réservations multicanales  | Vos réservations téléphone et web réunies dans un même planning       |
| CRM enrichi                | Retrouvez l'historique et les préférences de vos clients              |
| Segmentation               | Préparez une invitation pour les clients concernés                    |
| Cartes cadeaux             | Permettez à vos clients d'offrir un moment dans votre restaurant      |
| Dashboard groupe           | Consultez vos établissements et leurs résultats depuis un même espace |

Évitez les formules interchangeables : « révolutionnez », « boostez », « maximisez votre potentiel »,
« expérience augmentée », « solution ultime », « performance décuplée ». Évitez aussi les superlatifs
et les mots anglais inutiles. Une formulation précise peut être ambitieuse sans annoncer un gain garanti.

N'inventez aucun témoignage, résultat, label, volume d'appels ou pourcentage. Les preuves réelles
doivent être datées et utilisées avec le périmètre et les autorisations nécessaires.

## 3. Vérifier l'offre avant de la rédiger

Faites un inventaire court à partir du code courant, des preuves de production et des droits d'accès.
Une permission technique ne suffit pas à démontrer qu'une fonction est disponible au client.

Inspectez notamment :

- les cartes, FAQ, liens de choix d'offre et affichages de prix ;
- `packages/config/src/entitlements.ts` et les constantes partagées ;
- les conditions d'activation des fonctions et les preuves récentes ;
- la facturation Multi-site, ses quantités et le catalogue correspondant ;
- la page `/demo` et le parcours inscription/onboarding existant.

Classez les fonctions dans le rapport interne : disponible, à qualifier, prévue. Réutilisez les
preuves existantes. Résolvez les contradictions entre sources avant de modifier un libellé commercial.

Les cartes et la comparaison présentent les inclusions réellement accessibles dans l'offre vendue.
Les fonctions futures peuvent figurer dans un espace distinct si cela aide le choix, avec un statut
clair et sans date inventée. Les termes internes « provider », « entitlement », « gate », « staging »
ou « à qualifier » restent dans les documents de travail.

Les accès manquants à la téléphonie ou à l'e-mail staging ne bloquent pas la rédaction, l'intégration
et la vérification des tarifs. Ils limitent les preuves que l'on peut utiliser.

## 4. Répartition cible et direction des cartes

Les exemples suivants donnent une direction éditoriale. Adaptez-les aux fonctions vérifiées et
aux longueurs de la mise en page ; ne publiez pas automatiquement tous les éléments proposés.

### Essential — 199 € HT/mois

**Direction : « Vos appels et vos réservations, au même endroit. »**

Accroche possible : « Pour préparer le service et garder votre attention en salle. »

Socle cible : assistant téléphonique, numéro dédié, réservations téléphone/web/en salle, page
Connect et widget, planning, plan de salle, liste d'attente, fichier client de base, confirmations,
rappels, suivi simple des no-shows, rapport quotidien et statistiques essentielles.

Exemple de sélection pour la carte :

- Un assistant pour les réservations par téléphone.
- Un planning commun à la salle et au web.
- Votre page de réservation et votre widget.
- Plan de salle, liste d'attente et fichier client.
- Confirmations et rappels selon votre configuration.
- Un numéro dédié et une mise en service accompagnée.

Vérifiez les modalités de mise en service et l'inclusion du numéro. Détaillez les rapports et le
support dans la comparaison plutôt que d'allonger la carte.

### Pro — 299 € HT/mois

**Direction : « Donnez à vos clients l'envie de revenir. »**

Accroche possible : « Pour mieux connaître vos habitués et entretenir la relation après leur visite. »

Tout Essential, puis CRM avancé, profils VIP, segments, réactivation, campagnes de fidélisation,
cartes cadeaux après qualification financière, rapports avancés et support prioritaire défini.

Pour la carte, retenez les différences utiles et disponibles : historique et préférences clients,
repérage des habitués/VIP, invitations ciblées, suivi des actions et possibilité d'offrir une visite
par carte cadeau. Rattachez chaque ligne à un fonctionnement réel.

Pro doit justifier son supplément par une évolution du travail du restaurateur. Le suivi simple
des no-shows reste dans le socle ; il ne suffit pas à expliquer la montée en gamme.

Si les bénéfices propres à Pro sont encore insuffisamment disponibles, retirez le badge
« Recommandé ». Proposez une présentation de l'offre avec un contenu explicite sur le périmètre
actuel. Préservez les abonnements et droits existants.

### Multi-site — base 249 € HT/mois, supplément 99 € HT

> Remplacé le 14 octobre 2026 : la base Multi-site est 299 € HT/mois (premier établissement inclus),
> voir [`stripe-billing.md`](./stripe-billing.md). Les montants 249 € ci-dessous sont historiques.

**Direction : « L'esprit de chaque maison. Une vue d'ensemble. »**

Accroche possible : « Pour coordonner vos établissements tout en gardant les règles de chaque adresse. »

Tout Pro par établissement, puis vue centralisée, changement de site, numéro et paramétrage propres
à chaque restaurant, gestion des accès, comparaison des performances et facturation de groupe.
Le partage des profils clients attend sa qualification.

La carte doit donner à voir le quotidien d'un groupe : passer d'une adresse à l'autre, retrouver
les réservations, donner à chacun les bons accès et suivre les résultats. Vérifiez chaque capacité
avant de la présenter comme une inclusion.

## 5. Organiser le choix et la conversion

Structure attendue :

1. Une introduction courte, orientée accueil et service, qui mène rapidement aux offres.
2. Le choix mensuel/annuel et sa conséquence sur la facturation.
3. Trois cartes avec une promesse, une cible, un prix, cinq ou six inclusions et un CTA.
4. Une comparaison organisée par usage : accueil téléphonique, réservations et salle, clients
   et fidélisation, pilotage de groupe, mise en service et support.
5. Une FAQ courte sur les véritables hésitations avant achat.

Direction possible pour l'introduction : **« L'accueil commence avant le premier couvert. »**
Le texte qui suit doit expliquer concrètement l'aide apportée par Suppernote aux appels, aux réservations
et à l'équipe. Évitez d'accumuler plusieurs slogans avant d'arriver aux prix.

La comparaison doit permettre une décision : une inclusion a une signification précise, une
absence est lisible, une option n'est pas présentée comme incluse. Gardez les détails secondaires
en retrait et évitez de compter plusieurs fois la même fonction.

Reliez les CTA à leur destination réelle. Pistes de libellés : « Choisir Essential »,
« Découvrir Pro », « Parlons de vos établissements ». Adaptez-les à ce que le parcours permet.
Un bouton annonçant un rendez-vous doit permettre de réserver un rendez-vous ; une demande de
présentation peut recueillir une demande. Préservez le choix d'offre et de cadence dans les
mécanismes existants d'inscription/onboarding ou de suivi commercial.

FAQ utile : conservation du numéro actuel, déroulement de la mise en service, planning utilisé,
répartition des tâches avec l'équipe, fonctions incluses, conditions de paiement et facturation
de plusieurs établissements. Répondez à partir des preuves actuelles. Aucun argument artificiel
de rareté, compteur, remise exceptionnelle ou faux avis.

## 6. Montrer le prix complet

Conservez les montants et la réduction actuelle de 20 % ; ce chantier ne change pas le catalogue Stripe.

> Historique : depuis le 14 octobre 2026, la remise annuelle est de 10 % et la base Multi-site de
> 299 €. Montants en vigueur : [`stripe-billing.md`](./stripe-billing.md).

| Élément                    | Mensuel HT | Équivalent mensuel avec paiement annuel | Total annuel HT |
| -------------------------- | ---------- | --------------------------------------- | --------------- |
| Essential                  | 199 €      | 159,20 €                                | 1 910,40 €      |
| Pro                        | 299 €      | 239,20 €                                | 2 870,40 €      |
| Multi-site, base           | 249 €      | 199,20 €                                | 2 390,40 €      |
| Supplément d'établissement | 99 €       | 79,20 €                                 | 950,40 €        |

Affichez clairement que l'équivalent mensuel annuel est payé à l'année. Précisez l'engagement et
les conditions réellement applicables à chaque cadence. Évitez un « sans engagement » global si
l'offre annuelle engage douze mois.

Établissez dans le billing si la base Multi-site inclut le premier établissement. Affichez ensuite
la règle exacte, le nombre de sites et le montant total selon le mécanisme existant. Si le modèle
est bien « premier site inclus, puis supplément », les totaux mensuels pour deux et trois sites
sont respectivement 348 € et 447 € HT. Ces exemples restent conditionnés à la vérification du modèle.

Réutilisez les sources de calcul, évitez les duplications et affichez les décimales nécessaires.

Pour la voix et les SMS, vérifiez et exposez les conditions d'usage réellement appliquées. Aucun
quota, dépassement, illimité ou usage raisonnable nouveau ne doit être inventé. Les éventuels frais
supplémentaires doivent être compréhensibles avant souscription.

## 7. Garder le chantier maîtrisé

- Respectez les entitlements et les fonctionnalités actuelles. Documentez les écarts avec la cible.
- Préservez les droits des abonnés existants et les contrats externes.
- Ne développez pas un CRM, une campagne ou une intégration manquante pour remplir une carte.
- N'activez pas les fonctions financières ou fournisseurs non qualifiés pour les rendre affichables.
- Ne modifiez pas les tarifs Stripe, quotas ou politiques de facturation dans ce chantier.
- Ajustez le composant partagé lorsque l'accueil et `/pricing` utilisent les mêmes cartes.
- Employez les composants et tokens du projet. Gardez les textes lisibles sur mobile et iPad.
- Préservez la correction du thème : une préférence claire du dashboard ne doit pas rendre les
  tarifs illisibles.
- Un accès externe manquant donne une inconnue ciblée dans le rapport ; poursuivez les tâches indépendantes.

## 8. Vérifier ce qui aide la décision

Relisez les textes à voix haute. Retirez les phrases qui sonnent comme une publicité générique.
Vérifiez la cohérence entre carte, comparaison, FAQ, droits d'accès et destination du CTA.

Contrôlez les prix mensuels/annuels, les totaux Multi-site, la cadence et la conservation du choix
d'offre. Vérifiez les états d'erreur des parcours modifiés. Faites le contrôle visuel sur mobile,
iPad et desktop, avec une préférence de thème clair mémorisée.

Exécutez les vérifications techniques adaptées. Les tests doivent contrôler les calculs, choix,
liens et comportements significatifs. N'ajoutez pas une suite d'assertions qui fige chaque slogan.
Réutilisez les contrôles verts tant qu'aucun changement ou doute nouveau ne justifie leur répétition.

La livraison est prête quand :

- la valeur de chaque formule et sa différence sont compréhensibles ;
- les inclusions affichées sont accessibles dans l'offre vendue ;
- les conditions futures ne sont pas confondues avec les inclusions actuelles ;
- le visiteur comprend son montant facturé et son engagement ;
- le choix mène au bon parcours sans perdre l'offre ou la cadence ;
- l'affichage tient aux trois formats vérifiés.

## 9. Livrer en une séquence utile

Mettez à jour le rapport existant avec les textes retenus, la répartition affichée, les preuves,
les fonctions différées et les écarts restants. Suivez les règles du Journal et de Context dans AGENTS.md.

Terminez les changements et les vérifications locales avant le commit du chantier. Stagez uniquement
vos fichiers, puis exécutez `pnpm pr:submit`. Corrigez les échecs causés par la livraison et suivez
les déploiements applicables jusqu'au contrôle public. Aucun push direct sur `main`.

Rendu final : captures ou aperçu des trois cartes et de la comparaison, textes définitifs,
vérifications, limites restantes, commit, PR et état du déploiement. Signalez clairement ce qui
est livré, ce qui est vérifié et ce qui dépend encore d'une preuve externe.

**Commencez directement par l'inventaire ciblé, puis intégrez les textes et la comparaison.**
