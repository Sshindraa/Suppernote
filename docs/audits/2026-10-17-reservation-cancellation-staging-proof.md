# Annulation autonome — qualification du 17 octobre 2026

## Règle approuvée

Avant le délai enregistré : annulation gratuite après confirmation explicite.
À la limite exacte et après : contact restaurant, aucun frais automatique.
Paiement, garantie, carte cadeau, expérience, événement, distribution et anciennes
conditions non fiables : traitement par le restaurant.

## Livraison

PR #485 : https://github.com/Sshindraa/Sokar/pull/485
Commit main : b02e93db633e5446c24b782c494e46af400c042d.
CI de la PR et CI finale main vertes. Déploiement staging et smoke tests verts
(run 39054721191). Promotion automatique du code en production en cours
(run 39055095892), avec les fonctionnalités publiques toujours désactivées.

## Preuves locales

- API : 4208 tests réussis / 59 ignorés ; Dashboard : 751 réussis.
- Typechecks et lint verts ; aucune migration.
- PostgreSQL réel : deux demandes simultanées, une annulation/un audit ; table
  indisponible avant puis disponible après ; relecture CANCELLED.
- Playwright : 12 tests iPhone/iPad/desktop ; dialogue explicite, fermeture sans
  mutation, nom long, clavier, lecture après rechargement.

## Périmètre de la recette staging

Chez Suppernote (tenant de démonstration explicitement contrôlé), réservation
technique synthétique et condition figée de 24 heures. Pas de modification
durable des réglages restaurant, aucun SMS ni paiement appelé par cette recette.
Le restaurant démo n’a actuellement pas de condition d’annulation enregistrée ;
la fixture technique porte donc sa condition explicitement. Cela ne constitue
pas une preuve d’onboarding réel complété pour ce restaurant.

Aucun numéro réel, lien porteur ni secret n’est consigné ici.

## Résultat staging — 17 octobre, 19 h 45 (Europe/Paris)

- `RESERVATION_SELF_CANCELLATION_ENABLED=true` en fichier et dans le processus
  API staging ; PM2 sauvegardé. Liens personnels staging déjà actifs.
- Appels effectués via `https://staging.sokar.tech/api/reservation-management` :
  proxy Next public → API → PostgreSQL et invalidation de disponibilité.
- Réservation technique : `0b32191c-a46c-4df0-bbcf-0c013a3cfdf7`.
- Condition figée de 24 h ; service du 20 octobre à 19 h 30, limite gratuite
  calculée au 19 octobre à 19 h 30 (Europe/Paris).
- Première phase avec un créneau dans moins de 24 h : consultation indisponible
  pour annulation autonome, POST refusé HTTP 409, état toujours CONFIRMED.
- Puis déplacement de cette seule fixture vers le créneau du 20 octobre :
  offre disponible avec la limite attendue ; POST sans confirmation HTTP 400,
  réservation toujours confirmée.
- Deux POST concurrents explicitement confirmés : HTTP 200/200, un seul audit,
  une seule mutation canonique, state/status CANCELLED.
- Table physiquement indisponible avant puis disponible après (requête réelle
  du service d’allocation). Relecture publique : CANCELLED.
- Aucune file d’envoi de notification invoquée par la création technique ou
  l’annulation ; aucun SMS supplémentaire, aucun paiement. Fixture laissée
  annulée pour conserver l’audit.
- API staging `/health` et `/livez` HTTP 200 après activation.
- Production vérifiée : `RESERVATION_MANAGEMENT_ENABLED=false` et
  `RESERVATION_SELF_CANCELLATION_ENABLED=false`, fichier et runtime ; API online,
  `/health` HTTP 200. Aucun changement d’activation en production.

## Retour arrière

Désactiver `RESERVATION_SELF_CANCELLATION_ENABLED` dans l’environnement API
staging puis recharger PM2 avec cette valeur explicite : le lien revient au
contact restaurant. Sauvegarde privée de configuration avant activation :
`/opt/sokar-staging/releases/reservation-cancel-20261017/.env.before`.
Ne jamais copier ce fichier dans le dépôt (il contient les secrets existants).
Les annulations déjà confirmées restent annulées ; désactiver le bouton ne les
rétablit pas. Le rollback applicatif est également qualifié par le workflow.

Le calendrier personnel déjà importé ne peut pas être supprimé à distance ;
le carton serveur et le tableau des réservations restent la source d’état.
