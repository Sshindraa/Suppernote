# Recette reelle du carton de reservation — 17 octobre 2026

Resultat : **validee en staging**, avec reception et actions confirmees par l’utilisateur sur son iPhone. Aucun numero client, contenu SMS, lien personnel ou secret n’est conserve dans ce compte rendu.

## Livraison

- PR [#484](https://github.com/Sshindraa/Sokar/pull/484), merge `549fb1e984335486312d1ae5d34d8663c4369499`.
- CI branche et main vertes ; deploiements/smokes staging [39051476877](https://github.com/Sshindraa/Sokar/actions/runs/39051476877) et [39051951160](https://github.com/Sshindraa/Sokar/actions/runs/39051951160) verts, dont controle rollback.
- Le circuit automatique a aussi livre le code dormant en production ; smokes [39052133919](https://github.com/Sshindraa/Sokar/actions/runs/39052133919) verts. Fonction de lien personnel **desactivee en production**, fichier et runtime controles ; activation uniquement staging.
- Staging : `/r` HTTP 200 ; API et proxy de gestion traitent une requete invalide avec HTTP 400 (route active, validation appliquee) ; `/health` et `/livez` HTTP 200.
- Cle HMAC dediee generee dans l’environnement staging, stable API/workers, jamais exportee. Retour arriere configuration disponible dans le dossier prive de recette sous `releases/reservation-sms-20261017/`.

## Reservation et preuve d’un seul SMS

- Restaurant de demonstration existant « Chez Suppernote », staging uniquement ; mardi 20 octobre 2026, 19:30 Europe/Paris, 2 personnes.
- Reservation `dd54be0d-96e3-4375-915f-43641d4cb155`, creee une seule fois par le service de reservation existant, HTTP 201. Canal historique `PHONE` : ce test ne prouve pas encore les notifications de la chaine Connect WEB/outbox locale.
- Expediteur alphanumerique `SOKAR` deja configure ; numero voix et profil Telnyx partages inchanges.
- Premier passage : arret local avant appel fournisseur (`TELNYX_API_KEY is required`). Une valeur vide heritee dans PM2 workers masquait la cle du fichier `.env` malgre `--env-file`. Reglages fournisseurs/gestion recharges explicitement dans les seuls processus staging puis sauvegardes avec PM2. Le meme job de recette a ete repris, sans nouvelle reservation ; aucune tentative fournisseur anterieure a rejouer.
- Message fournisseur `4031a14a-d10b-468e-88a8-8e78d40e8b29`, claim `success`, job termine.
- **Un audit** `reservation_confirmation_sms_sent`, **un evenement d’usage accepte**, quantite **1 segment**, identifiant fournisseur concordant. Le segment est compte par l’application ; la reception d’un seul SMS est egalement confirmee par l’utilisateur.
- Accuses signes traites par `/sms/telnyx/inbound` staging pour ce meme message : `sent` (request id `9a76fa786a6aeecf1c786c5193ddb86b`) puis `delivered` (`43bddda352a9d1512d207f4d78465ade`). Callback par message vers staging avec `use_profile_webhooks=false`, aucun changement du webhook production du profil partage.
- Distinction conservee : claim/audit d’envoi = acceptation ; `message.sent` = envoi operateur ; `message.finalized` avec `delivered` = accuse de livraison ; retour utilisateur = reception et utilisation reelles.
- Limite fournisseur constatee : le GET `/v2/messages/{id}` retourne 404/code 40303 pour ce message. Cela n’invalide pas les accuses signes ni la reception reelle. La sonde de lecture seule signale cet echec de recherche ; elle ne doit pas servir de motif de renvoi. La preuve de livraison repose ici sur les callbacks concordants et le retour utilisateur.

## Ouverture et actions

- L’utilisateur confirme : **un seul SMS recu sur iPhone**, ouverture du lien Safari, carton Chez Suppernote/date/heure/couverts corrects, ajout au calendrier et itineraire fonctionnels.
- Controle automatise sur la vraie reservation staging (sans mock des donnees) : desktop et emulation iPhone, consultation/rechargement reussis, aucun pageerror, export ICS telecharge, `DTSTART:20261020T173000Z`, adresse presente et destination Maps Chez Suppernote renseignee. Le controle automatise ne remplace pas le test physique, ici confirme par l’utilisateur.
- Les captures de preuve ont ete conservees parmi les artefacts locaux, sans URL porteuse dans la capture.

## Nettoyage et suites

- Option SMS du restaurant restauree a `false` apres le test. Reservation de recette cloturee via le service de cycle de vie (`CANCELLED`, capacite liberee), sans demander de SMS supplementaire, pour eviter tout rappel futur. Le lien affiche donc maintenant l’etat annule ; les preuves ci-dessus ont ete recueillies avant cloture.
- Les flags WhatsApp restent desactives. Aucun ancien job historique rejoue.
- Les raccordements lien web Connect/Widget, l’outbox WEB et les changements WhatsApp de l’autre lot local ne sont pas embarques dans #484. Cette recette ne vaut pas activation generale de tous les canaux ni qualification de reception en production.
- Verification locale du lot : 4190 tests API/58 ignores, 749 tests Dashboard, 9 E2E multi-formats et 9 tests de sonde ; typechecks/lint/garde-fous pre-push verts.
