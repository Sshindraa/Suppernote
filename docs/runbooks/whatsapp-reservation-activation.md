# Activation des rappels WhatsApp

## Etat du 16 octobre 2026

Preparation locale uniquement, sans activation ni envoi reel. Les changements
concurrents du workspace sont preserves. Aucun commit ou deploiement de ce lot.

Lecture GET du compte Telnyx associe a la cle production :

- Un compte WhatsApp : `status=INACTIVE`, verification entreprise `not_verified`,
  revue de compte `APPROVED`. Ne pas deduire la cause exacte de l'inactivite.
- Un numero WhatsApp : `CONNECTED`, `enabled=true`, different de
  `TELNYX_FROM_NUMBER`. Aucun numero n'a ete modifie ou exporte.
- Aucun template retourne par la liste filtree sur le WABA.
- `WHATSAPP_ENABLED` absent des fichiers API staging/production controles.

Le parcours deploye passe par Telnyx. L'adaptateur Meta direct ajoute ensuite
reste local et desactive ; les secrets restent exclusivement dans l'environnement.

## Corrections Locales

### Assistance Telnyx du 17 octobre 2026

Demande envoyee depuis le portail authentifie a l'assistant Telnyx, avec
escalade humaine. Confirmation affichee : dossier **#800571 cree**, suivi par
e-mail a l'adresse du compte, conversation fermee et prise en charge support.
Objet : obtenir la procedure de passage a la facturation Meta directe tout en
preservant le WABA, le numero, les templates et tous les services voix/SMS.
La demande precise de ne rien modifier ni retirer pour le moment : il ne
s'agit pas d'une autorisation de suppression de ligne de credit ou partenaire.
Aucun secret, numero de client ou contenu de reservation transmis.
La reponse du support et la migration restent en attente ; aucun suivi
automatique programme. L'assistant Meta, rencontre avant cette demande,
exigeait des conditions supplementaires qui n'ont pas ete acceptees.

### Releve Meta du 17 octobre 2026

Apres authentification du proprietaire, Meta affiche le WABA Suppernote approuve,
entreprise non verifiee, devise USD, un numero connecte. Cela ne remplace pas
le statut INACTIVE retourne precedemment par Telnyx ; aucun envoi n'est qualifie.

Le template `reservation_reminder`, langue `fr`, categorie `Utility`, a ete
soumis dans WhatsApp Manager et constate `In review` (identifiant
`2027266457978853`). Texte : `Rappel {{1}} : votre reservation est prevue le
{{2}} a {{3}} pour {{4}} personnes. Pour la modifier ou l'annuler, contactez
directement le restaurant.` Le texte soumis comporte les accents francais.
Exemples fictifs uniquement : Restaurant Exemple, samedi 24 octobre, 19:30, 2.
Aucun envoi de message ou accord commercial accepte pendant cette operation.

Objectif retenu : Meta en direct pour WhatsApp, Telnyx conserve pour voix/SMS.
Le compte existant affiche cependant une ligne de credit Telnyx par defaut.
Dans Billing & payments, `Add payment method` est desactive ; `More options >
Edit` permet uniquement une reference de commande facultative. Aucun paiement,
changement de facturation, suppression de partenaire ou migration effectue.
Faire confirmer la procedure de detachement/migration par Telnyx/Meta avant
toute suppression. La qualification reelle de l'integration directe et du
parcours de consentement reste requise (implementation locale ci-dessous).

- Transport vers `POST /v2/messages/whatsapp` : le SDK installe ne fournit pas
  `messages.sendWhatsapp`. Requete unique, timeout 15 s, aucun retry HTTP local.
- Expediteur obligatoire `TELNYX_WHATSAPP_FROM`, sans repli sur le numero voix.
- Rappel WhatsApp uniquement si la reservation conserve explicitement
  `consents.transactionalWhatsapp=true` (booleen strict).
- Les reservations sans accord gardent leur confirmation SMS existante, sans rappel.
- Un succes HTTP sans identifiant de message est incertain, pas un succes.
- Les erreurs HTTP ne propagent pas le corps fournisseur (risque de donnees
  personnelles). Les claims existants bloquent les doublons et le secours SMS
  lors d'un resultat incertain.

### Suite Locale du 17 octobre

- `WHATSAPP_PROVIDER=meta` selectionne un adaptateur Cloud API direct ; defaut
  `telnyx`, aucun basculement implicite. `WHATSAPP_ENABLED=false` reste le defaut.
- Meta requiert `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`
  et `META_WHATSAPP_GRAPH_VERSION` explicite. Aucun secret cree ou configure,
  aucun appel reel a Meta effectue pendant les tests.
- Requete template unique, timeout 15 s, pas de retry HTTP local. Le recu
  `messages[0].id` represente une acceptation, pas une livraison au telephone.
- Les claims Redis conservent `provider=meta`, y compris si la configuration
  change ensuite. La reconciliation ne demande jamais un statut Meta a Telnyx.
  Cloud API ne proposant pas le GET de statut Telnyx, les resultats Meta
  incertains restent en revue manuelle. Les callbacks Meta signes et leur
  qualification restent a terminer avant activation client.
- `WHATSAPP_CONSENT_ENABLED=false` masque le choix dans `/book` (dashboard) et
  le widget Connect ; le serveur refuse un opt-in forge lorsque le flag est off.
- Accord facultatif non precoche, version `whatsapp-reminder-2026-10-17`,
  finalite rappel uniquement, horodatage serveur dans `reservation.consents`.
  La preuve Connect inclut le hash IP deja utilise, jamais l'IP brute.
- Le jeton de retrait genere au serveur est retourne uniquement a la creation,
  conserve en memoire dans la page de confirmation ; seul son SHA-256 est stocke
  en base. Retrait par POST sans secret en URL, verifie par reservation et tenant,
  idempotent, comparaison cryptographique et ecriture JSON optimiste.
  Il ne peut pas annuler un message deja accepte. Ce parcours historique reste
  le repli lorsque la gestion durable est off ; voir `reservation-management.md`
  pour le lien personnel SMS/web ajoute ensuite. Aucun e-mail ajoute.
- Les canaux voix/MCP et le widget ChatGPT separe ne collectent pas cet accord :
  ils restent sur SMS. Aucun accord marketing ou SMS reutilise, aucun backfill.
- Aucune migration Prisma : champs JSON existants, routes/champs API additifs.
  Aucun commit, push, deploiement ou changement de configuration distante.

Routes de retrait ajoutees : `POST /public/r/:slug/whatsapp-consent/withdraw`
(`reservationId`, `token`) et `POST /public/reservations/whatsapp-consent/withdraw`
(`restaurantId`, `reservationId`, `token`). Aucun endpoint de retrait ne permet
de redonner un accord ; celui-ci exige une nouvelle collecte explicite.

Verification du lot local : 4099 tests API passes, 58 ignores ; 22 tests Connect,
24 tests widget dashboard et 3 parcours Playwright (mobile/iPad/desktop) passes.
Typecheck des trois applications et lint cible passes. Fournisseurs simules,
aucun test de livraison reelle. Captures dans `apps/dashboard/test-results/`.

## Avant Activation

Correctifs de l'audit du 17/10 : recus SMS manquants incertains, rappels relus
et dates locales, intention confirmation WEB via outbox transactionnelle,
budget d'un segment pour le texte SMS, echecs Meta en revue manuelle sans renvoi.
Le retrait durable est implemente localement, derriere un flag off et une cle
dediee non configuree ; routage et reception du lien restent a qualifier. Voir
`reservation-management.md` et
`../audits/2026-10-17-notifications-critical-review.md` (etat apres correctifs)
et le manifest associe. Aucun correctif deploye, aucun secret distant configure.

### Politique Validee Le 17 Octobre

- Telephone : confirmation SMS uniquement, aucune question WhatsApp ajoutee
  au parcours vocal et aucun rappel.
- Web : confirmation SMS selon les reglages existants, rappel WhatsApp J-1
  uniquement avec accord explicite et configuration valide.
- Absence/retrait d'accord ou WhatsApp desactive/non configure : rappel ignore,
  pas marque comme envoye et aucun SMS de remplacement.
- Refus certain WhatsApp : retry WhatsApp possible, jamais secours SMS.
  Resultat incertain : claim conserve, pas de doublon sur un autre canal.
- Le worker verifie le canal WEB, meme si un dossier PHONE contient un accord.
  L'API historique de creation marque WEB seulement si le choix web explicite
  est present ; les integrations legacy sans ce champ gardent leur comportement.
- Les anciens claims SMS restent lisibles pour deduplication/reconciliation.
  Aucun ancien job purge ou rejoue. Les SMS gerant, recuperation d'appel ou
  marketing sont des parcours distincts, inchanges par cette politique.

1. Confirmer dans Telnyx/Meta la cause de l'inactivite et terminer la procedure
   requise avec le proprietaire du compte. Ne pas soumettre une future SAS.
2. Confirmer le numero WhatsApp voulu ; ne pas modifier le numero des appels.
3. Soumettre et faire approuver `reservation_reminder`, categorie `UTILITY`,
   langue `fr`, quatre variables : restaurant, date, heure, nombre de personnes.
   Proposition : `Rappel {{1}} : votre reservation est prevue le {{2}} a {{3}}
pour {{4}} personnes. Pour la modifier ou l'annuler, contactez le restaurant.`
4. Qualifier la collecte/retrait locale et sa preuve ; ne pas modifier les
   consentements des clients existants. Completer les callbacks Meta signes.
5. Qualifier la confirmation SMS separement : le diagnostic d'expediteur Telnyx
   n'est pas resolu par cette preparation. Aucun secours SMS pour les rappels.
6. Verifier les callbacks et statuts fournisseur, deployer le code qualifie,
   configurer le numero dedie et tester un destinataire de test autorise en
   staging. Aucun client historique ni rejeu d'anciens jobs.
7. Ouvrir progressivement apres reception reelle et verification anti-doublons.
   Retour arriere : `WHATSAPP_ENABLED=false` et redemarrage controle des workers.
   Cela ne resout pas un resultat deja incertain : conserver les claims.

## Verification Locale

`pnpm --filter @suppernote/api exec vitest run src/shared/messaging/__tests__/sender.test.ts src/shared/whatsapp/__tests__/client.test.ts src/shared/queue/workers/__tests__/confirmation-sms.worker.test.ts`

Resultat : 29 tests passes. Ce resultat ne prouve pas la livraison WhatsApp reelle.

## Callbacks Meta Locaux (17/10)

- Point d'entree GET/POST : `/webhooks/meta/whatsapp`, desactive par defaut
  (`META_WHATSAPP_WEBHOOK_ENABLED=false`). L'activation des callbacks ne permet
  pas les envois. Les secrets restent dans les variables d'environnement.
- GET : controle du verify token et retour du challenge. POST : signature
  `X-Hub-Signature-256` HMAC SHA-256 du corps brut, sans reconstruction JSON.
  Le compte WABA et le phone number ID doivent correspondre a la configuration.
- Statuts `sent`, `failed`, `delivered`, `read` uniquement. Pas de traitement des
  reponses entrantes dans ce parcours. Aucun telephone, texte ou corps brut
  conserve ; Redis contient une cle hashee numero-ID/message-ID et un rang,
  avec conservation de 7 jours apres progression du statut. Les doublons ne
  prolongent pas ce delai. Une erreur Redis retourne 503 pour permettre le rejeu.
- Ecriture Lua atomique : un statut ancien ou un echec tardif n'efface pas une
  preuve de livraison/lecture. Le rapprochement des claims incertains disposant
  d'un identifiant Meta utilise ces recus signes et jamais l'API Telnyx.
  `sent` prouve l'acceptation, pas la livraison. `failed` reste en revue manuelle,
  sans liberer le claim ni autoriser un nouvel envoi/SMS.
- Limites : un timeout sans identifiant fournisseur reste manuel ; aucun lien
  automatique par destinataire. Les claims deja acceptes ne sont pas convertis
  en marqueurs de livraison. Pas de tableau de bord de livraison dans ce lot.
- Avant activation : configurer l'abonnement Meta `messages`, proteger aussi les
  journaux du proxy (le GET contient le verify token), qualifier signature et
  reception reelles en staging. Aucun abonnement distant ni secret n'a ete
  configure pendant cette implementation locale.
- Verification : 14 nouveaux tests ciblant routes/signatures/filtrage/statuts ;
  4116 tests API passes, 58 ignores ; typecheck et lint cibles verts. Lua teste
  egalement sur un Redis ephemere isole (ordre, echecs, TTL), sans donnees client.

### Sources

- [Comptes WhatsApp Telnyx](https://developers.telnyx.com/api-reference/whatsapp-business-accounts/list-whatsapp-business-accounts)
- [Envoi de messages](https://developers.telnyx.com/docs/messaging/whatsapp/send-messages)
- [Templates](https://developers.telnyx.com/docs/messaging/whatsapp/manage-templates)
