# Modification autonome — qualification du 17 octobre 2026

## Résultat

**Active et qualifiée en staging à 20 h 53 (Europe/Paris).** Code livré en
production, fonctionnalités publiques toujours désactivées en fichier et runtime.

Parcours client : lien personnel → « Modifier ou annuler » → « Modifier la
réservation » → choix du nombre de personnes et d’une heure réelle disponible
le même jour → vérification de l’ancien/nouveau choix → confirmation explicite.

L’ancienne réservation reste allouée jusqu’au remplacement atomique. Consulter
ou fermer ne modifie rien et ne réserve pas de seconde table. Le même identifiant
et le même lien affichent les détails actualisés.

## Livraison

- Fonction : [PR #486](https://github.com/Sshindraa/Sokar/pull/486).
- Protection des confirmations anciennes : [PR #487](https://github.com/Sshindraa/Sokar/pull/487).
- Commit final : `02c8fc33e91fc64bd4859e029fde92bb25d8958b`.
- CI finale 39059292795 verte ; déploiement staging/smoke/rollback 39059788219 verts.
- Déploiement production 39060024673 vert ; API online, `/health` HTTP 200.
- Aucune migration ni changement de clé/secrets.

## Recette réelle via le proxy public

`https://staging.sokar.tech/api/reservation-management` → API → PostgreSQL.
Tenant de démonstration contrôlé Chez Suppernote ; réservation technique
`556e8072-f6eb-48c6-9184-e277e7e11bd1`. Aucun numéro réel ni lien porteur consigné.

1. Réservation initiale : **20 octobre, 19 h 30, 2 personnes**, table de deux
   physiquement occupée. Consultation des heures pour trois personnes : aucune
   écriture ni audit de modification ; détails initiaux inchangés.
2. Proposition réelle **20 h, 3 personnes**. Sans confirmation explicite : HTTP
   400, réservation initiale inchangée.
3. Des bloqueurs techniques occupent temporairement les tables compatibles avec
   la proposition. Confirmation : HTTP 409 ; ancienne heure, ancien groupe et
   ancienne table conservés en PostgreSQL.
4. Après libération des bloqueurs, deux confirmations simultanées de la même
   proposition : HTTP 200/200, **une seule modification et un seul audit**.
   Réservation toujours CONFIRMED, autre table compatible allouée. Ancienne table
   disponible, nouvelle table occupée ; même lien relu à 20 h pour trois personnes.
5. Un second choix explicitement confirmé revient à 19 h 30 pour deux personnes,
   sur l’ancienne table. Réutiliser la toute première confirmation de 20 h est
   refusé HTTP 409 : le choix le plus récent reste intact, même si les détails
   sont redevenus identiques aux détails initiaux. Deux audits de modification
   au total pour ces deux changements volontaires ; aucun troisième changement.
6. Nettoyage canonique des trois fixtures techniques : toutes annulées, aucune
   fixture active. Les audits append-only sont conservés. Aucun SMS supplémentaire,
   aucun paiement ni appel à une file de notification.

La fixture porte explicitement une condition figée de 24 heures. Les réglages
restaurant sont restés inchangés : le restaurant démo sans condition enregistrée
ne rend pas ses anciennes réservations automatiquement éligibles. La recette
ne prétend pas qualifier un nouvel onboarding réel de ce restaurant.

## Vérifications complémentaires

- Sept cas PostgreSQL réels locaux et CI : propre table exclue, cache public
  intact, conflit après proposition, double confirmation/audit unique, autre
  porteur/proposition altérée ou expirée, conditions financières, politique
  d’acompte activée entre choix et confirmation, ancienne confirmation après
  retour aux détails initiaux.
- 18 tests navigateur, profils iPhone/iPad/desktop ; six scénarios de modification
  rejoués après les dernières retouches UI. Sélection clavier, focus conservé,
  confirmation explicite, place prise, rechargement du même lien.
- Page/proxy : 21 tests, dont réponse perdue et erreur réseau en français.
- Suite API complète exécutée et CI finale verte ; contrôles prepush ciblés verts.
  Dashboard complet : 756 succès. Typechecks et lint verts.
- API staging `/health` et `/livez` HTTP 200 après activation.

## Activation et limites

Staging : gestion personnelle, annulation et modification actives ; modification
persistée dans `.env` et l’environnement API PM2, puis `pm2 save`.
Production vérifiée : `RESERVATION_MANAGEMENT_ENABLED=false`,
`RESERVATION_SELF_CANCELLATION_ENABLED=false`,
`RESERVATION_SELF_MODIFICATION_ENABLED=false`, fichier et runtime.

Première version : modification le même jour, conditions gratuites figées
respectées. Paiement/garantie, politique financière active, conditions inconnues,
absence de table et validation manuelle renvoient au restaurant. Une augmentation
du groupe ne peut pas contourner un seuil d’acompte. Aucun frais automatique.

Les propositions HMAC sont liées au porteur, aux détails, aux réglages, à la cible
et au compteur des audits append-only. Vérification sous les mêmes verrous que
l’allocation ; ancien choix obsolète refusé sans écriture. Un simple replay déjà
appliqué reste une lecture idempotente.

Un événement déjà importé manuellement dans un calendrier personnel ne se modifie
pas à distance : le carton est actualisé et permet un nouvel export. La
synchronisation Google connectée au restaurant reste celle du writer existant.

## Retour arrière

Désactiver `RESERVATION_SELF_MODIFICATION_ENABLED` dans l’environnement API
staging puis recharger PM2 avec cette valeur explicite. Le contact restaurant
reprend le relais ; les modifications déjà confirmées restent en base.
Sauvegarde privée avant activation :
`/opt/sokar-staging/releases/reservation-modify-20261017/.env.before`.
Ne pas copier ce fichier de secrets dans le dépôt. Le rollback applicatif et sa
restauration de la release courante sont qualifiés par le workflow staging.
