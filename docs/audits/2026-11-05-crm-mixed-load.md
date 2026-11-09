# CRM : comparaison locale de charge mixte — 5 novembre 2026

## Périmètre et méthode

Comparaison du code avant `d43f3726` et du correctif `f3922f80` (#659), sur le même Mac Apple M5, 16 Go de RAM, Node 22.23.2, PostgreSQL 16.14 et Redis 8.8.0. Deux bases locales jetables identiques contiennent chacune un restaurant Pro, 5 000 clients synthétiques et 100 000 réservations synthétiques (20 par client). Les données ont été créées avant la comparaison. La base « après » active le déclencheur CRM ; celle « avant » le désactive. Redis est une instance locale distincte, vidée entre les versions ; aucun test de charge n'a été lancé sur le VPS partagé avec la production.

Le schéma de base a été créé avec `prisma db push`, puis la migration CRM a été appliquée. Les autres objets SQL propres aux migrations ne sont pas nécessairement présents : cette comparaison ne reproduit donc pas exactement la base de production. PostgreSQL a été préchauffé dans les deux cas ; « froid » désigne le cache CRM Redis, pas les caches disque ou PostgreSQL.

Les deux versions sont appelées en HTTP loopback, avec le mode démo local, et non une authentification Clerk. Quatre lecteurs lancent simultanément deux listes filtrées `sort=visits365d` et deux comptages de segments ; deux autres clients effectuent des `PATCH` de réservations vers `NO_SHOW`, sur des clients distincts. Après une première vague à cache CRM vide, cette combinaison est répétée toutes les 1,5 secondes : un passage de 8 vagues dans l'ordre avant/après, puis un passage de 20 vagues dans l'ordre après/avant. Les 360 requêtes des deux passages ont renvoyé 200 ; aucune vague n'a dépassé son intervalle. Les données et serveurs de test ne comprennent aucun fournisseur externe.

Les durées des opérations Prisma sont mesurées côté application : elles incluent l'attente du client, le transfert et l'ordonnancement Node, et ne sont pas des temps d'exécution SQL purs. `pg_stat_activity` est échantillonné toutes les 40 ms environ depuis un autre client ; les blocages plus brefs peuvent ne pas être observés, en particulier lorsque le processus Node est occupé.

## Résultats HTTP

Dans le passage de 20 vagues, chaque chiffre « chaud » résume 40 requêtes par catégorie. Les valeurs sont en millisecondes, médiane / p95 ; les petits échantillons ne permettent pas d'en déduire une capacité ou un p99 robuste.

| Catégorie, cache chaud         |           Avant |       Après |
| ------------------------------ | --------------: | ----------: |
| Liste CRM filtrée              | 968,8 / 1 014,4 | 84,2 / 98,7 |
| Compteurs de segments          | 960,9 / 1 007,0 | 81,1 / 97,5 |
| Modification d'une réservation |     46,8 / 59,8 | 46,4 / 89,9 |

Dans le premier passage, les médianes étaient respectivement de 983,9 / 87,7 ms pour les listes, 974,9 / 86,5 ms pour les segments et 46,3 / 47,7 ms pour les modifications avant / après. Le p95 des modifications était de 52,5 / 91,9 ms sur seulement 16 requêtes par version. La médiane des écritures est proche ; leur p95 observé après modification est plus élevé et mérite une mesure plus large.

À froid, les listes et segments ont pris environ 1,08 à 1,19 seconde dans les deux versions, avec seulement deux requêtes par catégorie et par passage. Le correctif ne supprime donc pas la première lecture historique. Les 5 000 clients constituent toujours la limite de balayage du code.

Dans le passage long, l'opération Prisma `Reservation.findMany` a atteint 965,4 ms avant, en incluant transfert et traitement côté client ; après, les maxima observés en chaud étaient 34,0 ms pour `Customer.findMany`, 33,0 ms pour `Reservation.findUniqueOrThrow` et 30,2 ms pour la lecture des révisions client. Aucun verrou en attente n'a été vu dans l'échantillonnage du trafic mixte : 460 échantillons avant et 737 après. Cela ne prouve pas l'absence d'attentes brèves.

## Écritures simultanées sur un même client

Test PostgreSQL distinct, avec huit transactions simultanées modifiant huit réservations du même client. Chaque transaction garde volontairement son verrou 20 ms après l'écriture puis est annulée : cette pause artificielle met en évidence la contention, elle ne mesure pas la durée réelle d'un parcours HTTP.

Sur les deux répétitions après préchauffage, les huit transactions ont terminé en 22,2–22,6 ms avant et 178,2–178,9 ms après. Jusqu'à sept transactions en attente de verrou ont été observées après, contre aucune avant. Sans pause artificielle, les deux répétitions préchauffées ont pris 1,1–1,6 ms avant et 3,0–3,5 ms après ; l'échantillonnage était trop court pour quantifier correctement les attentes. Ces résultats montrent une sérialisation possible sur la révision du client, et justifient de qualifier les rafales sur un même client avant promotion.

## Authentification staging

Un processus API auxiliaire lancé en loopback sur le VPS staging utilisait le code déployé, une vraie session Clerk de développement et le mode démo désactivé. Sans session, `GET /customers` a renvoyé 401 ; avec session, la liste, le filtre CRM et les compteurs ont renvoyé 200. La session de test a été révoquée. Le site et ses données synthétiques étaient dans une transaction PostgreSQL annulée ; le client DB de ce processus était branché sur cette transaction. Ce contrôle valide l'authentification et les routes, mais pas le parcours via le domaine public ni une charge authentifiée sur staging.

Les résultats agrégés sont dans [le fichier JSON associé](./2026-11-05-crm-mixed-load-results.json). #659 reste ouverte sans fusion automatique. Aucune capacité en utilisateurs simultanés ni comportement de la production ne peut être déduit de cette comparaison locale.

## Reprise de retard — transaction englobante

Nouvelle mesure locale sur le code de #659, dans deux bases PostgreSQL jetables clonées : déclencheur de révision activé ou désactivé. Les bases ont été créées par `prisma db push` ; elles ne reproduisent pas nécessairement les objets SQL spécifiques de toutes les migrations. Chaque essai crée un restaurant et des réservations synthétiques, applique réellement le plan de reprise, rattache les deux réservations au même client, puis mesure la transaction complète de `revert`, audit compris. Les fournisseurs et Redis sont simulés par les mocks d'intégration. Douze essais séquentiels par passage, sans pause artificielle :

| Mesure                                 | Déclencheur désactivé | Déclencheur activé |
| -------------------------------------- | --------------------: | -----------------: |
| Transaction, médiane des deux passages |            7,1–7,6 ms |         7,1–7,4 ms |
| Transaction, maximum des deux passages |            8,5–9,5 ms |        9,7–10,4 ms |

Un deuxième essai déclenche une autre transition métier sur le même client dès que l'annulation de la réservation promue a obtenu sa révision, sans attendre ni suspendre la transaction de reprise. Avec déclencheur, sur deux passages de 12 essais : transaction de reprise médiane 5,9–8,4 ms, maximum 11,1–12,5 ms ; transaction concurrente médiane 2,5–3,6 ms, maximum 9,0–10,6 ms. Jusqu'à une attente de verrou a été échantillonnée. Sans déclencheur, un passage : transaction de reprise médiane 7,6 ms, maximum 8,3 ms ; concurrente médiane 2,3 ms, maximum 9,8 ms ; aucune attente échantillonnée.

Les requêtes Prisma après acquisition de la révision comprennent notamment l'autre mise à jour de réservation, la restauration de liste d'attente et les audits. Elles restent dans la transaction. La mesure ne montre pas de ralentissement important dans ce scénario local réduit ; elle ne garantit ni l'absence de blocages brefs, ni le comportement sous charge réelle. Le test concurrent pilote le début de la seconde transaction à la fin de la première écriture, ce qui crée volontairement une occasion de contention sans allonger artificiellement la transaction. L'échantillonnage toutes les 2 ms reste incomplet.

## Qualification de la migration corrective

Le commit `99c0d70c` de la PR #659 a passé la CI et le [workflow staging](https://github.com/Sshindraa/Suppernote/actions/runs/42108879284), y compris ses smoke tests et le contrôle de rollback. Sur PostgreSQL staging, dans des transactions annulées, les contrôles couvrent la création, modification et suppression d'une réservation test, les passages test ↔ réelle, la création réelle, la réaffectation entre clients réels et les changements sans incidence. Les révisions observées correspondent aux clients réellement concernés. DB, Redis et workers staging sont sains. La PR reste ouverte sans fusion automatique ; la production n'a pas été modifiée.
