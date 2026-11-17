# Gestion Publique De Reservation

## Etat Local Au 17 Octobre 2026

Apercu interactif local : `http://localhost:3101/r/demo`. La meme vue affiche
une reservation explicitement fictive ; aucun appel API/base/fournisseur,
telephone desactive. Le retrait est simule en memoire et recharger reinitialise
la demonstration. Route refusee hors NODE_ENV=development (404 en production).

Parcours unique `/r#JETON` : consulter la reservation et retirer l'accord de
rappel WhatsApp, sans compte. La modification autonome, sous son indicateur dédié, conserve la réservation initiale jusqu’à la confirmation explicite du nouveau choix ; le téléphone reste le recours hors conditions applicables. L’annulation autonome
est disponible sous un drapeau distinct, selon les conditions ci-dessous. Telephone : aucune
nouvelle question WhatsApp, aucun rappel SMS supplementaire.

Le lot de qualification ajoute le lien au SMS de confirmation existant.
Le raccordement des confirmations web Dashboard/Connect reste dans le lot local
plus large : il n’est pas inclus dans cette livraison isolee. Le texte doit tenir dans un segment selon le compteur local ;
le nom est raccourci ou retire avant de sacrifier le lien. Un budget impossible
echoue avant envoi, sans produire un deuxieme SMS. Qualifier le SMS reel et les
eventuels ajouts de l'operateur avant activation.

Pas d'e-mail de reservation ajoute, ni de changement du template WhatsApp a
quatre variables : le lien n'est pas encore distribue par ces canaux. Les routes
de retrait historiques restent compatibles lorsque le nouveau parcours est off.

## Confirmation Web Unifiee (24 Octobre 2026, Local)

Le widget Dashboard servi par `/book` et `/widget/:restaurantId` affiche
`ReservationView` directement apres le POST de confirmation, a la place de
l'ancien ecran « Table reservee ». La vue noire presente les donnees de la
reservation confirmee meme si le lien de gestion est desactive ou si sa lecture
echoue. Quand un lien signe est fourni, ses actions sont chargees dans cette
meme vue, sans redirection ni seconde confirmation. Le lien personnel reste
utilisable pour retrouver la reservation ulterieurement.

Sans lien de gestion, le retrait WhatsApp conserve son endpoint historique ;
la modification/annulation renvoie au contact restaurant. Agenda, itineraire,
nouvelle reservation, retour et carte cadeau restent disponibles selon les
informations et options du restaurant. Aucun drapeau de production active par
ce changement local.

## Presentation Et Actions Pratiques

La page reprend la composition d'un carton de reservation : eventail de trois
cartes plus basses avec filet fin et surface unie, valeurs sans libelles visibles
redondants (les termes date/heure/couverts restent disponibles aux lecteurs
d'ecran), statut « Confirmee » discret et deux actions proches du carton.
« Ajouter au calendrier » exporte localement un `.ics` uniquement pour une
reservation confirmee ; « Itineraire » apparait si l'adresse est renseignee.
Les commandes calendrier/itineraire sont typographiques, sans cadre ni fond,
avec cibles de 44 px et soulignement renforce au survol.
« Modifier ou annuler », ferme par defaut, regroupe modification/contact et
preferences de rappel. Le retrait WhatsApp reste explicite dans son panneau.
La demonstration n'est signalee qu'en en-tete, et les actions distantes y
restent desactivees. Aucun texte d'envoi ne peut etre deduit du statut seul.

La reponse API est enrichie de facon additive avec `restaurantAddress`
(`formattedAddress`, nullable), `startsAt` (instant UTC) et `endsAt` (nullable).
L'export utilise ces instants sans conversion dans le fuseau du navigateur,
sans identite client ni jeton ; aucune duree n'est inventee si la fin est absente.
L'itineraire ouvre Google Maps sur action explicite, sans referent. L'apercu
fictif desactive l'itineraire et marque son export calendrier comme demonstration.
La page ne promet aucun envoi SMS/e-mail dont elle n'a pas la preuve.

## Securite Et Limites

- Jeton HMAC-SHA256, lie a la reservation, au restaurant, a sa creation et au
  telephone actuel. Aucun jeton brut ni nouvelle table en base.
- Expiration : le plus proche entre création + 90 jours et réservation + 7 jours.
  Après un report confirmé, le lien initial signé suit la nouvelle échéance de
  réservation, toujours bornée à création + 90 jours. Le décodage différé permet
  de retrouver la réservation, sans donner accès avant la vérification HMAC du
  destinataire, du restaurant et de cette échéance. Un changement de téléphone
  ou une rotation de clé invalide les anciens liens.

- URL reproductible, egalement retournee par Connect sur une reponse rejouee.
  Conserver le SMS donne l'acces apres fermeture de la confirmation web.
- Le fragment n'est pas envoye lors de l'ouverture HTTP. Le navigateur le
  transmet uniquement dans le corps POST au proxy de meme origine, puis a l'API.
  Ne jamais journaliser ces corps, liens complets ou captures contenant un jeton.
- Page privee : Sentry desactive au chargement, pas de Clerk, pas d'indexation,
  referrer no-referrer et reponses API no-store. Les liens web utilisent une
  navigation document complete pour appliquer cette exclusion des le demarrage.
- Le lien est un acces porteur : toute personne le possedant voit date, heure,
  couverts, restaurant et peut retirer cet accord. Aucun nom, numero ou e-mail
  client retourne. Ne pas partager le lien ; ce n'est pas une authentification.
- Ouvrir/recharger ne retire rien. Le retrait est explicite, idempotent, ecrit
  avec controle optimiste tenant/reservation et ne touche pas aux autres accords.
  Aucun re-opt-in par ce lien. Un message deja en cours peut encore parvenir.

## Configuration Et Recette Avant Activation

1. Revoir le lot en preservant les hunks concurrents. Aucune migration Prisma.
2. Livrer ensemble page Dashboard, proxy, API et workers compatibles. Les
   configurations nginx versionnees dirigent exactement `/r` et
   `/api/reservation-management` vers Dashboard ; les routes historiques `/r/slug`
   restent sur Connect. Aucun serveur nginx distant modifie pendant ce travail.
3. Garder `RESERVATION_MANAGEMENT_ENABLED=false` initialement. Generer une cle
   aleatoire de 32 octets hexadecimaux dans le gestionnaire de secrets, uniquement
   `RESERVATION_MANAGEMENT_SECRET` (key_env). Meme cle pour API et workers ; ne pas
   la regenerer a chaque deploiement. Aucun secret reel configure ici.
4. Verifier `DASHBOARD_URL` HTTPS, routage, absence de cache/log de corps et
   `nginx -t` sur la cible avant rechargement. Les tests locaux de configuration
   ne remplacent pas cette validation du serveur.
5. En staging, reservation de test autorisee : creation et replay web, reception
   du seul SMS, lien sur telephone, rechargement, retrait, rechargement, absence
   de rappel/repli SMS, erreur reseau, lien altere/expire et correction telephone.
6. Le flag de gestion ne declenche pas WhatsApp. Les flags WhatsApp et collecte
   restent off jusqu'a qualification fournisseur et recette complete.

Retour arriere : couper le flag ferme les acces, sans supprimer la reservation
ni retablir un accord retire. Ne pas changer la cle pour un simple rollback
applicatif ; conserver API/proxy compatibles pour les liens deja distribues.

## Qualifier La Livraison SMS

Staging doit servir `/r` et le proxy avant de creer la reservation de test.
Garder le flag production off. L’expediteur `TELNYX_SMS_FROM` conserve
`SOKAR`, deja configure dans le profil ; ne pas remplacer le numero voix.
Configurer `TELNYX_SMS_WEBHOOK_URL` vers
`https://api-staging.suppernote.com/sms/telnyx/inbound` pour isoler le callback
du webhook production du profil partage. Aucun changement du profil Telnyx.

Le claim `success` et `CONFIRMATION_SMS_SENT` signifient acceptation fournisseur,
pas livraison sur le telephone. La route signee distingue `message.sent` de
`message.finalized` avec statut `delivered`. Pour verifier le meme identifiant
fournisseur en lecture seule, utiliser `scripts/ops/reservation-sms-receipt.mjs`
avec `SOKAR_RECEIPT_MESSAGE_ID` et `TELNYX_API_KEY` charges depuis l’environnement.
Le probe expose le statut, le nombre de parties si connu et les codes d’erreur,
jamais le contenu, le lien ou les numeros. Ne jamais renvoyer un SMS sur la seule
absence d’accuse. Un statut `delivery_failed` ne libere pas le claim d’envoi.
La preuve finale ajoute la reception rapportee par la personne, puis l’ouverture
du carton, l’import calendrier et l’itineraire sur son telephone.

## Annulation autonome (drapeau desactive par defaut)

`RESERVATION_SELF_CANCELLATION_ENABLED=true` ajoute une offre d’annulation au
DTO public et le bouton « Annuler la reservation » dans « Modifier ou annuler ».
Le client voit les conditions puis confirme explicitement dans un dialogue.
La fermeture du dialogue et la lecture du lien ne modifient rien.

L’onboarding et Parametres > Annulation stockent `capacitySpecials.cancellationPolicy`
en texte. Les nouveaux snapshots de reservation figent les presets exacts 2/24/48 heures,
leur texte et la version (`source=onboarding-v1`). Les creations voix et agentic/
Connect les enregistrent. Sans regle renseignee, le snapshot fige le preset 2 heures
(`DEFAULT_CANCELLATION_POLICY`, decision du 2026-11-17). Renvoient au restaurant :
anciens snapshots sans source fiable, conditions libres, absence d’annulation gratuite, acomptes/garanties,
cartes cadeaux, experiences, evenements et distribution externe renvoient au
restaurant. Aucune condition actuelle n’est retroactive sur une ancienne resa.

Avant le delai : annulation gratuite. A la limite exacte ou apres : contact
restaurant ; aucune perception de frais ni remboursement automatique. Le texte
« gratuite jusqu’a » ne definit pas de montant ni une instruction de paiement.
Le parcours financier d’annulation tardive reste a definir avant activation.

Le POST `cancel` exige `confirmed=true` et un `confirmationToken` HMAC emis a la
lecture (10 minutes maximum, jamais au-dela du delai). Sous verrou PostgreSQL,
le serveur reverifie le porteur, le restaurant, l’etat, le creneau, les couverts,
les conditions et les liens financiers. Puis le writer canonique enregistre
CANCELLED pour state/status et un audit sans PII. La capacite derivee exclut la
reservation annulee et le cache de disponibilite est invalide. Le tableId reste
une trace historique. Les projections CRM/marketing sont rejouables.

Un replay d’annulation deja terminee ne fait pas de seconde mutation/audit.
Le carton affiche l’etat serveur, y compris apres rechargement ; le calendrier
n’est plus propose. Un evenement deja importe dans un calendrier personnel ne
peut pas etre supprime a distance. Apres une reponse perdue, le client relit
l’etat avant d’annoncer le resultat. Aucun nouveau SMS n’est envoye par ce flux.

## Modification autonome (drapeau distinct, desactive par defaut)

`RESERVATION_SELF_MODIFICATION_ENABLED=true` expose « Modifier la reservation »
dans le panneau existant. Le widget commun avec photo permet de choisir le jour,
le nombre de personnes et l’heure, puis de verifier et confirmer le changement.
Extension locale du 17/10 : sept raccourcis de jours et un champ calendrier
permettent de choisir une date dans les 90 prochains jours. Les nouvelles dates
sont bornees aussi a la creation de la reservation + 90 jours ; les conditions
gratuites et la disponibilite reelle restent requises. Le lien SMS initial suit
le report confirme sans nouveau SMS, dans cette meme limite de securite.
Aucune modification ni
hold temporaire n’est cree pendant la consultation ou la fermeture du dialogue.

Le POST `modification_options` demande un nombre de personnes borne (1..50,
limite du restaurant appliquee), et une `date` ISO facultative pour compatibilite
(omise : jour actuel de la reservation). Les heures proviennent du moteur de disponibilite
existant, des horaires/fuseau, duree, delai minimum en ligne, tables physiques et
holds actifs. Seule la reservation porteuse est exclue des conflits ; cette lecture
ignore le cache public et ne peut pas y publier une disponibilite personnelle.
L’heure actuelle est preselectionnee et conservee tant qu’elle reste disponible
apres un changement de date ou de groupe. Le bouton est inactif sans changement.
Une heure devenue indisponible est deselectionnee avec une explication.

Chaque choix porte une proposition HMAC de 10 minutes maximum, sans PII, liee
au porteur, aux details initiaux, au compteur des audits append-only, aux reglages et au nouveau creneau/groupe.
Le POST `modify` exige `confirmed=true` et cette proposition. Le service de
modification existant verrouille la capacite du restaurant puis la reservation,
reverifie la proposition et les conditions, les horaires et la capacite reelle,
alloue une table compatible puis remplace les champs dans la meme transaction.
Une place prise entre-temps produit un conflit : l’ancienne reservation/table
reste intacte. L’audit `reservation_fields_changed` conserve un digest de la
proposition pour reconnaitre un replay ; jamais le lien, le token ou l’identite.

L’identifiant et le lien initial restent valables. Le statut et les conditions
figees sont conserves ; le cache de disponibilite est invalide. Le carton est actualise apres
reponse serveur ; une reponse perdue declenche une relecture, jamais un second
envoi aveugle. Un evenement deja importe manuellement dans un calendrier
personnel n’est pas modifie a distance.

La modification respecte la limite gratuite de la reservation initiale et de la
cible. Paiement, garantie, carte cadeau, experience, evenement, distribution,
ancien snapshot non fiable, absence de table, politique financiere active au restaurant et validation manuelle renvoient au
restaurant. Il n’y a aucun nouveau SMS ni changement du parcours financier.
Desactiver le drapeau restaure le contact restaurant sans annuler les changements
confirmes. Qualification locale PostgreSQL :
`RESERVATION_MODIFICATION_INT_TESTS=1` (base loopback obligatoire) ; les memes
tests font partie de `AGENTIC_INT_TESTS=1` en CI.

## Reservation test (drapeau distinct, desactive par defaut)

Le tableau de bord (onboarding et page en ligne) ouvre la page publique avec un
lien signe pour qu'un restaurateur vive le parcours client reel sans polluer
son restaurant.

Activation, dans l'environnement de l'API (`key_env`, jamais dans le code) :

- `TEST_BOOKING_ENABLED=true` ;
- `TEST_BOOKING_SECRET` : 32 octets aleatoires en 64 caracteres hexadecimaux
  (`openssl rand -hex 32`). Sans secret valide, le drapeau reste inactif.

Desactive, les deux boutons ouvrent la page publique comme avant.
Migration `20261019120000_reservation_is_test` (colonne `is_test`, index
partiel, additive) a appliquer AVANT d'activer le drapeau.

Fonctionnement : jeton HMAC-SHA256 lie au restaurant, valable 1 h, accepte par
`hold` et `confirm` (`testBookingToken`) ; refus 403 « Ce lien de test a expiré.
Relancez-le depuis votre tableau de bord. ». Quota : 5 reservations test par
restaurant sur 24 h glissantes. La reservation suit le circuit reel (hold,
table, confirmation SMS) mais ne cree ni client, ni consentement, ni analytics,
ni attribution marketing, et reste masquee du planning, des statistiques et des
listes (extension Prisma `test-reservation-scope`). La page « Ma reservation »
affiche « Reservation test · supprimee automatiquement sous 24 h ».

Limites connues :

- restaurant en validation manuelle : la reservation test est confirmee
  directement (personne ne pourrait la valider, elle est masquee du planning) ;
  le restaurateur recoit donc le SMS de confirmation, sans l'etape « en attente »
  que vivrait un client ;
- les SMS envoyes pendant un test comptent dans la consommation de messagerie du
  restaurant.

Le tableau de bord n'annonce l'absence d'effet qu'une fois le mode test actif
(bandeau de la page publique). Drapeau coupe, l'API repond
`TEST_BOOKING_DISABLED` : la page publique s'ouvre quand meme et un avis sous le
bouton previent que la reservation sera reelle et qu'il faut l'annuler.

Purge : tache horaire `purgeTestReservations` ; supprime les reservations
`is_test` creees il y a plus de 24 h, avec leur journal d'audit et leurs
evenements outbox.

Qualification staging avant activation en production :

1. Lancer la reservation test depuis l'onboarding puis depuis la page en ligne.
2. SMS de confirmation recu sur le telephone saisi.
3. Page « Ma reservation » : mention test visible.
4. Modification, puis annulation depuis cette page.
5. Reservation absente du planning, des statistiques et du CRM.
6. Modifier une vraie reservation a cote d'une reservation test (meme creneau,
   meme table) : la modification passe, la reservation test ne bloque rien.
7. Annuler la reservation test → aucune fiche client creee.
8. Purge : apres 24 h (ou `purgeTestReservations` avec une date simulee en
   local), reservation, audit et outbox supprimes.

Retour arriere : `TEST_BOOKING_ENABLED=false` (redemarrage de l'API). Les
reservations test restantes sont purgees par la tache horaire.
