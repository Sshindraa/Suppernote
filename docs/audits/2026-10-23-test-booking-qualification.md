# Qualification de la réservation test — 23 octobre 2026

Statut : recette staging validée le 24 octobre 2026 ; mode test activé en production après CI, staging et smoke production verts. Correctifs livrés par la PR #573 (`90f941362`).
Périmètre : Chez Suppernote de staging uniquement, destinataire de test fourni par Hamza (non conservé ici).

## Défaut découvert par la recette navigateur

Le bouton de la page en ligne ouvre correctement Connect avec `testBooking`, mais Nginx sert `/book/[slug]` et `/widget/[slug]` depuis le dashboard. Le widget dashboard utilisait encore la création historique `/reservations`, sans transmettre le jeton. Les tests Connect de #509 ne couvraient donc pas le composant réellement servi.

Correction : le widget dashboard utilise exclusivement les routes publiques `hold` puis `confirm` avec le jeton pour le mode test, conserve les retours vers la page publique et affiche le statut test / purge sous 24 h. Aucun clic d’attribution marketing ni accord WhatsApp n’est transmis dans ce mode. Le parcours normal est conservé. Un jeton présent mais invalide, vide ou trop long doit être refusé sans revenir à une réservation réelle ; Connect conserve un marqueur invalide pour les valeurs hors contrat.

## Défaut de contrainte PostgreSQL

La première réservation test a été confirmée sans SMS (option SMS du restaurant démo initialement coupée), avec `isTest=true`, `customerId=null` et aucun client ajouté. Un deuxième test au même créneau a révélé un rejet PostgreSQL `23P01` : la contrainte historique `reservations_no_overlap_active` ne filtrait pas `is_test`. L’exclusion applicative seule ne suffisait donc pas.

La migration `20261023180000_reservation_test_overlap_exclusion` installe d’abord une contrainte équivalente limitée aux réservations normales, puis remplace l’ancienne dans la même transaction (verrou borné à 5 secondes). Aucune donnée n’est modifiée ou supprimée ; les réservations normales gardent la même protection. Le test PostgreSQL réel vérifie deux tests superposés, la modification d’une réservation normale sur leur table et le refus d’un vrai doublon. Les 10 tests de modification sur une base locale isolée passent après application de toutes les migrations.

## Défaut de purge du journal d’audit

La purge réelle d’un test vieilli de 25 h a échoué sur le trigger append-only du journal, avant toute suppression (transaction annulée). La migration `20261023181000_test_reservation_audit_purge` garde toutes les mises à jour interdites et n’autorise une suppression d’audit que si sa réservation existe encore, est marquée test et a plus de 24 h. Les audits normaux, récents et sans réservation restent protégés. La migration ne supprime aucune donnée.

Un test PostgreSQL réel couvre la suppression de la réservation test expirée avec son audit et son outbox, la conservation d’une réservation normale ancienne et d’un test récent, et le refus de modifier un audit même pour un test expiré. Les deux suites de modification et purge passent : 11 tests.

## Matrice de recette

| Contrôle                                  | Preuve / état                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Bouton page en ligne → page publique test | Observé en staging, bandeau et jeton conservés                                                                                           |
| Jeton invalide                            | POST hold retourne 403, sans réservation                                                                                                 |
| Widget réellement servi par /book         | Confirmation navigateur après déploiement ; isTest=true, customerId=null                                                                 |
| Bouton onboarding                         | Tests automatisés verts ; accès navigateur gardé par les étapes incomplètes de la démo, aucune donnée fictive ajoutée pour le contourner |
| SMS reçu et lien ouvert sur téléphone     | Telnyx delivered, 1 segment ; Hamza confirme réception et ouverture du lien                                                              |
| Page Ma réservation : mention test        | Observée avec confirmation puis annulation                                                                                               |
| Modification et annulation                | 12 h / 2 → 13 h 30 / 3 après confirmation explicite ; conserver le dialogue ne change rien, puis annulation confirmée                    |
| Planning / CRM                            | Aucun test visible dans le planning ; 18 réservations normales et 4 clients inchangés avant contrôle normal                              |
| Réservation normale voisine modifiable    | Coexistence sur table/créneau du test, modification réelle à 19 h 30 ; vrai doublon toujours refusé                                      |
| Purge après 24 h avec audit et outbox     | Helper déployé : 4 tests, 12 audits et 2 événements supprimés, aucun reste                                                               |

Le contrôle normal est conservé annulé et explicitement nommé comme recette staging : 19 lignes normales après ce contrôle volontaire, dont les 18 lignes initiales inchangées (empreinte comparée). Toujours 4 clients. Les options SMS et conditions de la démo sont restaurées aux valeurs initiales. Un seul SMS a été envoyé pendant toute la recette. Les preuves détaillées sont privées dans `releases/reservation-test-20261023/` sur le staging ; aucun numéro ni jeton n’est copié ici.

## Blocage fournisseur

Le portail Telnyx confirme que la clé dédiée `SOKAR_STAGING_VOICE01` a expiré le 21 octobre 2026. La clé de staging et les sauvegardes du 17 octobre répondent toutes 401 ; aucune n’a été restaurée. La clé de production reste intacte. Une nouvelle clé `SOKAR_STAGING_TEST_BOOKING`, sans expiration automatique, a été créée sur demande explicite de Hamza ; elle est stockée dans `TELNYX_API_KEY_STAGING` et l’environnement API staging, avec sauvegarde privée préalable. Fichier temporaire supprimé et presse-papiers nettoyé. Telnyx retourne HTTP 200. PM2 conservait la clé expirée dans son environnement : API/workers staging rechargés avec la nouvelle valeur, santé de tous les fournisseurs verte. Callback SMS staging distinct ; ne pas modifier le profil partagé.

## Validation du correctif

- API : 95 tests ciblés passent (jeton, routes Connect et génération du lien, gestion, exclusion des lectures/SQL, purge).
- Dashboard : 28 tests ciblés passent, dont transmission du jeton jusqu’à la confirmation et refus sans repli réel ; TypeScript vert, ESLint sans erreur.
- Connect : 20 tests ciblés passent, y compris les valeurs hors contrat qui restent en mode test.
- PostgreSQL réel : 11 tests de modification et purge passent sur une base locale isolée, y compris les chevauchements test/test et test/réservation normale.
- CI complète de la PR #573 verte, migrations et 11 tests PostgreSQL inclus.
- Recette réelle terminée en staging après livraison ; réglages temporaires restaurés.

## Activation et retrait

Avant activation production : prouver la réception SMS, les parcours de gestion, l’isolation et la purge. Puis installer un secret dédié `TEST_BOOKING_SECRET` (32 octets hex, key_env), activer `TEST_BOOKING_ENABLED=true` et recharger l’API. Aucune modification des drapeaux de gestion de réservations n’est incluse : leur activation production relève de leur qualification existante. Retour arrière : couper uniquement `TEST_BOOKING_ENABLED` et recharger l’API.

## Activation effective — 24 octobre 2026

Production au commit `90f941362779300aabc3e6101895f1d3db66e6ef` ; workflows staging `40035432648` et production `40035928028` réussis. Les deux migrations sont appliquées. Sauvegarde privée préalable de l’environnement, secret dédié généré côté serveur et `TEST_BOOKING_ENABLED=true` chargé dans API et workers (PM2 online et sauvegardé). Santé complète verte ; génération de lien sans authentification toujours refusée (401). Aucune réservation ni aucun SMS de recette créé en production.

Les drapeaux globaux de gestion, modification et annulation restent désactivés en production. Les parcours correspondants sont qualifiés en staging ; leur disponibilité client en production conserve la politique actuelle, distincte du mode test. Retrait : `TEST_BOOKING_ENABLED=false`, rechargement API/workers avec environnement actualisé ; sauvegarde dans `releases/test-booking-activation-*/api.env.before`.

## Parcours normal — correctif complémentaire du 24 octobre

Après la recette du mode test, Hamza a essayé le lien public sans jeton : le widget normal utilisait encore `POST /reservations`, désormais réservé aux services internes, et affichait `RESERVATION_SERVICE_AUTH_REQUIRED`. La qualification précédente du mode test ne couvrait pas cette confirmation normale.

La PR #575 (`ab1ca2f57`) fait utiliser les routes publiques `hold` puis `confirm` aux réservations normales également, en conservant attribution marketing, choix WhatsApp et retrait du consentement sur la route publique correspondante. Le slug est fourni aux anciennes URLs de widget par identifiant. La route interne reste protégée ; aucun secret de service ne passe dans le navigateur.

Validation : 30 tests widget, 2 995 tests API et 1 010 tests dashboard lors du pré-push ; 4 scénarios Playwright ciblés verts en local puis CI complète verte. Confirmation normale réellement observée en staging pour 13 h / 2 personnes, réservation vérifiée `isTest=false`, puis annulée par le parcours de gestion. SMS désactivés, conditions temporaires de la démo restaurées. Cette réservation normale de contrôle est conservée annulée, distincte des tests purgés plus tôt. Preuve privée : `releases/reservation-normal-widget-20261024/proof.json`.

Livraison finale : staging `40040057174` et production `40040560013` verts ; production au commit `ab1ca2f57d36ddc5a6bbb44ba2b589231b0ce358`, santé de tous les fournisseurs et workers verte, page /book HTTP 200. Mode test toujours actif après ce déploiement. L’option SMS de la démo production reste désactivée ; aucune réservation de recette supplémentaire en production.
