# Demandes de démonstration — conservation et suppression

Décision validée par Hamza le 15 octobre 2026 : une demande sans suite est
supprimée douze mois après le dernier échange avec le prospect ; sans échange,
le délai court à partir de la demande. Aucune inscription marketing n’est
créée par le formulaire. Cette règle couvre la base et les copies e-mail.

## Périmètre constaté

- `DemoRequest` : établissement, e-mail, téléphone facultatif, outil et besoin
  facultatifs, version du formulaire, identifiant anti-doublon, dates/statut.
- Notifications actuellement déployées : référence, établissement, e-mail et
  téléphone. Modification locale préparée le 16 octobre : référence et lien vers
  l'administration authentifiée seulement, sans établissement, coordonnées ni
  contenu libre de la demande. À confirmer après une livraison autorisée.
- Boîte professionnelle de réception : Google Workspace. Rechercher également
  les réponses et copies transférées, sans recopier de données personnelles ici.
- L’accès aux demandes en base est réservé aux opérateurs habilités.

## Revue manuelle mensuelle avant et après publication

Responsable : responsable de Suppernote. Première revue à effectuer avant livraison
de la nouvelle politique, puis chaque mois. Aucun effacement n’a été exécuté
pendant la préparation de ce lot et aucun automatisme n’a été créé.

1. Ouvrir le suivi privé `/dashboard/admin/demo-requests` et examiner les
   demandes marquées « À examiner ». Ce repère utilise `lastInteractionAt` ;
   pour les anciennes demandes sans cette date, il utilise prudemment
   `contactedAt` (premier contact) ou `createdAt` (demande reçue). Il peut donc
   signaler trop tôt une demande : ce n’est jamais une décision de suppression.
2. Vérifier la date du dernier échange réel dans la messagerie et les appels.
   Après vérification d’un ancien dossier, utiliser « Corriger la date » et
   saisir la date constatée. À partir de maintenant, utiliser « Enregistrer un
   échange » après chaque réponse ou conversation réelle, pas après une
   tentative sans réponse. Ne pas traiter `updatedAt` comme date d’échange : un
   changement de statut ou de notification peut le modifier.
3. Distinguer demande sans suite, client, obligation de preuve ou litige. Une
   relation client relève de sa propre durée ; toute exception à la suppression
   doit être motivée, limitée et conservée dans le suivi privé.
4. Préparer une liste restreinte d’identifiants à supprimer, sans export de
   contenu nominatif dans Git, logs, tickets publics ou documents partagés.
5. Faire approuver la sélection et l’opération distante avant toute suppression.
   Utiliser un accès opérateur autorisé ; ne pas créer de route d’effacement
   publique et ne pas modifier le schéma pour cette procédure.
6. Supprimer les demandes retenues de la base, les conversations de notification
   et copies gérées dans la messagerie, puis leurs corbeilles selon les procédures
   autorisées. Vérifier la conservation des contenus chez Resend et les mécanismes
   de suppression disponibles dans le contrat/service réellement utilisé.
7. Examiner séparément sauvegardes et archives : documenter leur cycle réel, les
   restrictions d’accès et la prévention d’une réintroduction après restauration.
   Ne pas promettre un effacement immédiat de toutes les sauvegardes sans preuve.
8. Consigner en privé date, périmètre et résultat, sans données personnelles dans
   le rapport public. En cas d’échec ou d’impossibilité fournisseur, le signaler.

Le suivi applicatif enregistre une date seulement ; il ne supprime aucune demande
et ne supprime aucune copie chez les fournisseurs. Il affiche au plus les 200
demandes les plus récentes par chargement : si le volume dépasse cette limite,
compléter la revue avec une extraction opérateur autorisée avant de conclure.

## Réserves avant livraison

- Vérifier et documenter les pays de traitement et garanties de transfert des
  services Resend et Google Workspace effectivement souscrits. L’hébergement
  OVH ne suffit pas à prouver que toutes les données restent dans l’UE.
- La politique nomme les destinataires et la règle validée ; sa publication
  suppose la mise en pratique de cette procédure et la revue des réserves.
- La minimisation des nouvelles notifications ne supprime aucune copie déjà
  envoyée, aucun échange manuel et aucune donnée en base. La référence reste
  rattachable à une demande et n'est pas présentée comme une donnée anonyme.
- L’identification légale de l’éditeur reste une réserve indépendante.
- Ne pas présenter le texte de confidentialité comme une validation générale
  RGPD des appels, comptes, réservations, contrats et fournisseurs.
