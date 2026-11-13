# Cartes cadeaux — envois durables et reprise

## Activation

Ce lot poursuit les runbooks `gift-card-financial-safety.md` et `gift-card-operations.md`.
Ce lot est intégré à la branche `codex/gift-card-operations` pour publication dans Suppernote
via PR vers main, avec les lots financiers et encaissement en salle.

Appliquer `20260930220000_gift_card_delivery` après les migrations financières et de caisse,
avant la nouvelle API et les workers. La table stocke les résultats d’envoi indépendamment
du solde. Une contrainte valide les états, canaux, compteurs et dates de début.
Aucun envoi historique n’est inventé ni déclenché automatiquement.

Déployer API, workers et dashboard ensemble. Vérifier que `outbox-dispatcher`,
`outbox-delivery` et `gift-card-finance` sont démarrés et planifiés. Les providers continuent
à utiliser les variables d’environnement existantes : Resend pour les emails et Telnyx
pour SMS/WhatsApp. Aucune clé supplémentaire n’est stockée dans le code.

## Garanties et limites

L’achat payé enregistre cinq intentions : reçu acheteur, carte destinataire par email,
notification email du restaurant, carte WhatsApp et SMS du restaurant. Les coordonnées
absentes sont identifiées au traitement, avec état SKIPPED. Chaque contribution conserve
son reçu et la notification de l’organisateur ; la clôture conserve l’email et le WhatsApp
du bénéficiaire. L’annulation confirmée conserve les notifications d’acheteurs/contributeurs
et du restaurant. Une contribution tardive remboursée notifie son acheteur lorsque les
coordonnées peuvent être retrouvées dans le checkout ou la contribution.

Toutes ces intentions et leurs événements outbox sont créés **dans la transaction
financière**. Si l’outbox ne peut pas être écrite, cette transaction est annulée et peut
être rejouée à partir du paiement confirmé. Les appels aux fournisseurs sont exécutés
ensuite par le worker, pas par la requête d’achat.

Les jobs et payloads outbox ne contiennent que l’identifiant opaque de l’envoi. Les contacts
restent dans les enregistrements métier et sont lus au traitement. Aucun email, téléphone,
code cadeau ou texte de message n’est ajouté aux jobs ou à leurs erreurs.

Un verrou atomique de l’envoi empêche deux workers de le soumettre simultanément.
Une réponse de refus certaine permet les retries BullMQ existants (cinq tentatives par job).
Une réponse perdue, un timeout ou un résultat ambigu passe en UNKNOWN et bloque tout renvoi
automatique. « Accepté par le fournisseur » ne garantit pas la réception dans la boîte email
ou sur le téléphone. Les nouveaux renvois volontaires sont des opérations distinctes.

Le worker financier, toutes les cinq minutes, passe les IN_PROGRESS de plus de quinze minutes
en UNKNOWN et réinjecte les PENDING oubliés de plus de quinze minutes dans l’outbox.
Cette récupération couvre notamment une interruption ou une perte de job en Redis ; les
reprises utilisent toujours le même enregistrement et le verrou de soumission.

## Exploitation dans le dashboard

Ouvrir une carte : la section « Envoi de la carte et des reçus » affiche les derniers
100 enregistrements, leurs canaux, états, dates et compteurs. L’équipe du site peut lire.
Le propriétaire et le responsable peuvent effectuer les actions suivantes :

- FAILED ou SKIPPED : « Réessayer cet envoi ». Vérifier les contacts et l’état de la carte
  au préalable. L’opération n’altère jamais son solde.
- UNKNOWN avec référence fournisseur : « Vérifier auprès du fournisseur » consulte Resend
  ou Telnyx. Un résultat certain actualise l’état ; un résultat encore ambigu reste bloqué.
- UNKNOWN sans résultat certain : vérifier dans la console du fournisseur ou auprès de
  son support, puis « Résoudre après vérification manuelle ». Une référence de dossier
  technique (3–128 caractères alphanumériques, tiret ou underscore) et une confirmation
  explicite sont obligatoires. Une acceptation confirmée devient SENT ; une non-acceptation
  définitive confirmée devient FAILED et autorise une reprise séparée. La résolution et
  l’acteur sont audités. Ne pas confondre absence dans une liste et refus définitif.
- Renvoi au destinataire par email ou WhatsApp : confirmation explicite, UUID stable lors
  des relances réseau, même demande dédupliquée. Un autre envoi PENDING, IN_PROGRESS,
  UNKNOWN ou FAILED du même type bloque la création d’un renvoi concurrent.

Les contacts corrigés sont utilisés lors d’un prochain traitement. Cette intervention
n’ajoute pas d’éditeur de contacts ; la route de mise à jour existante conserve son contrat.
Les dossiers fournisseur doivent rester des références techniques, sans coordonnées personnelles.
Les contrôles d’identité, rôle et établissement sont aussi appliqués côté API.

## Routes additives

Sous `/restaurants/:id/gift-cards/:giftCardId/operations` :

- `POST /resend` : `channel` email/whatsapp, UUID `idempotencyKey`.
- `POST /deliveries/:deliveryId/retry` : réinjecte un refus certain ou un envoi non effectué.
- `POST /deliveries/:deliveryId/verify` : lit le statut fournisseur lorsque sa référence est connue.
- `POST /deliveries/:deliveryId/resolve` : `resolution` accepted/not_accepted et `providerCaseReference`.

`GET /operations` de la carte expose l’historique et `canManageDeliveries`.
Les reprises, résolutions et renvois exigent OWNER/MANAGER ; les routes historiques restent présentes.

## Qualification avant ouverture

Sur staging et un restaurant pilote, vérifier un achat Connect réel en mode test jusqu’au
worker et aux providers test : reçu, email bénéficiaire, WhatsApp/SMS configurés, contribution,
clôture et remboursement. Provoquer une coupure après acceptation fournisseur, arrêter un
worker en cours, tester un refus certain et une référence inconnue. Vérifier qu’une réponse
perdue ne crée pas de copie automatique et qu’un renvoi volontaire reste idempotent.
Tester les rôles STAFF/MANAGER/OWNER et un changement d’établissement.

Les tests locaux utilisent PostgreSQL réel et des fournisseurs simulés. Ils ne remplacent
pas cette qualification de bout en bout. Le rapprochement financier Stripe avec résolution
d’incidents et l’édition des contacts dans l’interface restent des étapes distinctes.

## Retour arrière

Conserver le registre, la table des envois et l’outbox. Arrêter les nouvelles ventes avant
un retour à une version qui envoie les notifications directement : mélanger l’ancien envoi
synchrone avec la file durable risque de produire des copies. Ne pas rejouer en bloc les
UNKNOWN ou réémettre les cartes existantes. Utiliser le rollback d’artefacts documenté et
résoudre les envois un par un après vérification fournisseur.
