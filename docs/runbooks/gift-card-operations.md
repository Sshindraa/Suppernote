# Cartes cadeaux — caisse et suivi

## Mise en service

Ce parcours complète le socle financier décrit dans `gift-card-financial-safety.md`.
Appliquer les migrations additives `20260930170000_gift_card_financial_safety`, puis
`20260930210000_gift_card_operations`, avant de déployer l’API et le dashboard.
La seconde ajoute les informations du reçu aux débits existants, sans les réécrire :
les anciens reçus restent sans montant d’addition, solde après débit ou référence de ticket.
Elle ajoute des unicités par demande et par ticket d’établissement, ainsi qu’une
contrainte de cohérence sur les nouveaux reçus. Vérifier les migrations sur staging.
Aucune migration distante n’a été appliquée pendant l’implémentation locale.

## Utilisation en salle

Dans Cartes cadeaux, saisir le code présenté par le client, ou ouvrir une carte depuis
la liste. Saisir l’addition réelle et la référence unique du ticket de caisse. Si la caisse
réutilise ses numéros chaque jour, inclure la date et, si nécessaire, le terminal.
Une référence reste unique dans l’établissement. Ne pas utiliser de coordonnées client.

Choisir éventuellement une réservation déjà associée à la carte, proposée avec le nom,
la date et le nombre de couverts. Le débit fonctionne aussi sans réservation.
Une réservation annulée, marquée absente, déjà débitée ou associée à une autre carte
ne peut pas recevoir ce débit. La liste propose au maximum les 50 dernières réservations
associées non débitées ; l’API accepte aussi un identifiant de réservation du même établissement.

Vérifier le montant pris sur la carte et le complément, puis confirmer. Le reçu indique
le solde restant et le complément à **encaisser dans la caisse** : Suppernote n’encaisse pas
ce complément. L’opération utilise le minimum entre l’addition et le solde disponible.
Les cartes expirées, gelées, épuisées et les cagnottes encore ouvertes sont refusées.
Ce parcours accepte les cartes en euros.

Après une coupure réseau, utiliser « Réessayer la même demande ». Le client garde le
même identifiant et les mêmes valeurs jusqu’à une réponse définitive. Le serveur déduplique
également par ticket, même si le navigateur est fermé et qu’une nouvelle demande arrive.
Un ticket déjà utilisé avec une autre carte, un autre montant ou une autre réservation
est refusé. Une réponse 4xx permet de corriger les champs ; une réponse perdue ou 5xx
conserve la demande à rejouer. Ne pas inventer un nouveau ticket pour contourner un conflit.

## Accès et historique

Les nouvelles routes exigent authentification, correspondance avec l’établissement
actif et rôle OWNER, MANAGER ou STAFF. Le registre CSV exige OWNER ou MANAGER.
Les routes et contrats historiques restent présents.

Routes additives sous `/restaurants/:id/gift-cards` :

- `POST /operations/lookup` : code long ou court, recherche limitée à l’établissement.
- `GET /:giftCardId/operations` : carte, réservations associées, débits, paiements et remboursements.
- `POST /:giftCardId/redeem` : `billAmount`, `ticketReference`, UUID `idempotencyKey`, `reservationId` facultatif.
- `GET /operations/overview` : paiements, remboursements, soldes et éléments à vérifier.
- `GET /operations/export?from=AAAA-MM-JJ&until=AAAA-MM-JJ` : JSON contenant CSV, nom du fichier et nombre de lignes.

Un débit, son solde, son reçu, son éventuel snapshot de réservation et son audit sont
persistés dans la même transaction. Les verrous sérialisent les accès concurrents.
L’historique conserve les débits anciens sans inventer leurs informations manquantes.

## Lecture du bilan et de l’export

« Paiements enregistrés » et « Remboursements enregistrés » proviennent du registre
alimenté par les paiements et événements Stripe. Ce bilan peut attendre un webhook ;
il ne constitue pas une preuve de rapprochement en temps réel avec Stripe.
Les cartes émises manuellement sont indiquées séparément. Les anciens paiements d’achat
sans entrée de registre sont signalés et exclus des encaissements affichés.
Les anciennes contributions sans entrée de registre ne sont pas encore inventoriées
individuellement : un rapprochement historique complet reste nécessaire.

Le solde disponible exclut les cartes expirées, les cagnottes ouvertes et les cartes
bloquées ou dont le paiement n’est pas confirmé. Les soldes gelés sont présentés séparément.
La « valeur totale émise » historique ne doit pas être interprétée comme du chiffre encaissé.

L’export sélectionne les **dates UTC de création des paiements et des débits** entre les
bornes inclusives. Les remboursements indiquent le cumul actuel de chaque paiement,
indépendamment de leur date : ce n’est pas un journal des remboursements de la période.
Aucun nom, email ou téléphone n’est exporté. Les références de ticket sont neutralisées
contre les formules de tableur. Une période est limitée à 366 jours et à 5 000 paiements
et 5 000 débits ; un export trop grand est refusé entièrement, jamais tronqué silencieusement.

## Qualification et suite

Tester sur un restaurant pilote en staging : carte partiellement utilisée, addition
supérieure au solde, réservation associée, carte gelée/expirée, deux opérateurs simultanés,
réponse réseau perdue, changement de site et export propriétaire/manager/staff.
La qualification Stripe Connect en mode test du lot A reste indispensable avant vente réelle.

Les emails/SMS/WhatsApp sont désormais persistés et suivis via outbox ; voir
`gift-card-delivery.md` pour le déploiement, les reprises et la résolution des résultats
incertains. L’éditeur de contacts et l’écran de rapprochement financier Stripe restent
à implémenter. Le registre et l’export actuels ne constituent pas ce rapprochement.
