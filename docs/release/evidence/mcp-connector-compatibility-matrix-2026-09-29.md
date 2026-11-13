# Matrice de compatibilité MCP — 29–30 septembre 2026

> **Statut au 30 septembre 2026 :** PR #314, #324–#329 fusionnées. PR #329 ajoute `answer_availability` en MCP 2.4.0, avec une sortie `{ message }` seulement. CI [36717103793](https://github.com/Sshindraa/Sokar/actions/runs/36717103793), staging et smoke tests [36717697821](https://github.com/Sshindraa/Sokar/actions/runs/36717697821), et déploiement automatique en production [36718018771](https://github.com/Sshindraa/Sokar/actions/runs/36718018771) verts. Le retest naturel a réussi dans les deux clients après actualisation de la liste d’outils Claude : ChatGPT n’a pas ajouté d’heure de fin ni d’action, Claude a repris la phrase du serveur mot pour mot. Le cycle idempotent demeure validé (rejeu avec hold consommé : `reused=true`, même ID, aucun doublon). Les cinq runs sont purgés ; seuls les tombstones anonymisés et leurs audits append-only restent.
> Le consentement Claude staging couvre tous les restaurants ayant activé MCP ; l’utilisateur l’a accepté pour le staging. Les essais restent limités à Chez Suppernote sur `Suppernote Staging`. Aucun appel MCP de production ; seul le déploiement automatique de l’application a publié le code en production.
> Claude peut garder en cache sa liste d’outils : après PR #329, il a continué à proposer l’ancien outil jusqu’à **Refresh tools list** dans les réglages du connecteur. Même avec `answer_availability`, le serveur ne contrôle pas entièrement le texte final généré par le client.
> Les connecteurs de production existants n’ont servi à aucune mutation.

## Cible et isolation

- Serveur testé : https://api-staging.sokar.tech/mcp
- Restaurant de démonstration : chez-sokar-demo, base sokar_staging
- Identifiant du restaurant : 9587ad78-ebc0-4805-a716-41727658d5e7
- Runbook : [Sandbox MCP](../../runbooks/mcp-sandbox.md)
- Run initial, maintenant purgé : `connector-20260929-01`, commencé le 29 septembre 2026 à 00:48:18.731 UTC
- Run `connector-20260929-02`, commencé le 29 septembre 2026 à 20:01:23.879 UTC, maintenant purgé après ChatGPT et une première tentative Claude avec paramètres erronés
- Run `connector-20260929-03`, commencé le 29 septembre 2026 à 21:06:38.994 UTC, maintenant purgé après le parcours Claude exact
- Run `connector-20260929-04`, commencé le 29 septembre 2026 à 21:55:03.699 UTC, maintenant purgé après le retest Claude post-correctif
- Run `connector-20260930-05`, commencé le 29 septembre 2026 à 22:04:32.908 UTC (30 septembre à 00:04:32 CEST), maintenant purgé après le retest ChatGPT post-correctif
- Marqueur du run initial : `MCP-SANDBOX:connector-20260929-01`
- Marqueur du run 02 : `MCP-SANDBOX:connector-20260929-02`
- Marqueur du run 03 : `MCP-SANDBOX:connector-20260929-03`
- Marqueur du run 04 : `MCP-SANDBOX:connector-20260929-04`
- Marqueur du run 05 : `MCP-SANDBOX:connector-20260930-05`
- Téléphone factice du manifeste : +33612345600
- Référence OAuth OpenAI : [Authentication – Plugins](https://developers.openai.com/plugins/build/auth)

Le connecteur Suppernote déjà enregistré dans chaque client pointe vers api.sokar.tech en production. Il n’a servi qu’aux lectures précédentes de recherche et de disponibilité. Les opérations d’écriture historiques ci-dessous ont été exécutées avec le connecteur distinct Suppernote Staging et n’ont ciblé que Chez Suppernote. Le consentement Claude staging couvre les restaurants ayant activé MCP ; l’utilisateur a accepté cette portée plus large, sans l’utiliser pour tester d’autres restaurants.

## Liaison OAuth

| Vérification                                   | ChatGPT                                       | Claude                                                                | Résultat                                                                                             |
| ---------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Découverte OAuth staging                       | Réussie                                       | Réussie                                                               | Les deux clients ont trouvé le serveur d’autorisation api-staging.sokar.tech                         |
| Portée restaurant                              | Consentement ChatGPT limité à Chez Suppernote | Consentement Claude couvrant les restaurants staging ayant activé MCP | Portée Claude plus large ; les essais de cette matrice restent limités à Chez Suppernote             |
| Ressource                                      | https://api-staging.sokar.tech                | https://api-staging.sokar.tech                                        | Cohérente avec la ressource du MCP staging                                                           |
| Scopes                                         | mcp:read, mcp:reserve, mcp:cancel             | mcp:read, mcp:reserve, mcp:cancel                                     | Les accès de lecture, réservation et annulation ont été accordés                                     |
| Enregistrement client                          | DCR sélectionné                               | DCR sélectionné                                                       | La méthode d’authentification effectivement négociée n’est pas visible dans l’interface              |
| PKCE                                           | S256 observé                                  | S256 observé                                                          | Le flux OAuth a abouti dans les deux clients                                                         |
| URI de retour                                  | chatgpt.com/connector/oauth_callback          | claude.ai/api/mcp/auth_callback                                       | Retour réussi vers chaque client                                                                     |
| État de connexion                              | Suppernote Staging installé et connecté       | Suppernote Staging affiché comme connecté                             | OAuth staging complété                                                                               |
| Version MCP issue de initialize                | Non observable                                | Non observable                                                        | L’interface ne montre pas la requête/réponse JSON-RPC brute ni protocolVersion                       |
| tools/list brut                                | Non exporté                                   | Non exporté                                                           | Les appels réussis prouvent que les outils sont utilisables ; la réponse brute n’a pas été conservée |
| authorization_response_iss_parameter_supported | Absent des métadonnées lues                   | Absent des métadonnées lues                                           | Le champ ne figurait pas dans la découverte OAuth staging                                            |

### Correctif OAuth ChatGPT

Les écrans de consentement et le parcours d’écriture décrits plus haut ont été testés avant le correctif. La [PR #294](https://github.com/Sshindraa/Sokar/pull/294), commit `5e1645db9a1be92780763f2abc3b3fbc40993a0b`, a ensuite été fusionnée sur `main` et déployée sur staging puis en production.

Le correctif ajoute :

- la propagation stricte de `resource` entre autorisation, code et échange de jeton, puis sa conservation dans le jeton et son contrôle sur les appels MCP ;
- `authorization_response_iss_parameter_supported: true` et `iss` sur les redirections OAuth de succès comme de refus ;
- `securitySchemes` et leurs scopes OAuth pour chacun des outils, plus `_meta["mcp/www_authenticate"]` quand un appel manque d’un scope ;
- le callback ChatGPT stable associé à RFC 9207.

DCR reste le mode d’enregistrement pris en charge. CIMD n’est pas implémenté et `client_id_metadata_document_supported` n’est donc pas annoncé.

| Vérification après déploiement     | Résultat observé                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| CI de `main`                       | Succès ; tous les jobs requis sont verts                                                                                                       |
| Déploiement staging                | Succès ; smoke tests et E2E staging verts                                                                                                      |
| Déploiement production             | Succès ; smoke tests verts, `GET /health` renvoie 200                                                                                          |
| Métadonnées ressource protégée     | `resource=https://api-staging.sokar.tech`, serveur OAuth staging et scopes `mcp:read`, `mcp:reserve`, `mcp:cancel`                             |
| Métadonnées serveur d’autorisation | `authorization_response_iss_parameter_supported: true`; CIMD non annoncé                                                                       |
| Défi sans jeton sur `/mcp`         | HTTP 401 avec `WWW-Authenticate` pointant vers `/.well-known/oauth-protected-resource`                                                         |
| Redirections avec `iss`            | Couvertes par les tests d’intégration de la PR ; l’autorisation ChatGPT fraîche a abouti, mais l’interface a masqué les paramètres du callback |

### Retest client en lecture seule après le correctif OAuth #294

Le 29 septembre, les connecteurs staging déjà installés ont été réutilisés dans les deux clients. Aucun écran de consentement neuf n’a été accepté pendant ce retest et aucun outil d’écriture n’a été appelé.

| Vérification                                                           | ChatGPT                                                                                                           | Claude                                                                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Recherche de Chez Suppernote                                           | Réussie ; nom, slug `chez-sokar-demo`, adresse à Lyon, cuisine, gamme de prix et horaires retournés               | Réussie après précision de la ville Lyon ; nom, slug et ID retournés. L’adresse ne fait pas partie de la réponse de recherche |
| Disponibilité — 2 personnes, 1 octobre 2026, 19:30–21:00, Europe/Paris | `available: true`, aucune alternative                                                                             | `available: true`, aucune alternative                                                                                         |
| Écriture après correctif                                               | Aucune réservation ni hold créé pendant ce retest en lecture seule                                                | Aucune réservation ni hold créé                                                                                               |
| OAuth frais après correctif                                            | Réussi le 29 septembre : nouveau compte staging ; écran limité à Chez Suppernote, `resource` et 3 scopes visibles | Réussi le 29 septembre après accord utilisateur ; l’écran couvre les restaurants staging ayant activé MCP                     |

Claude a d’abord interprété la recherche sans ville comme Paris, puis a proposé une recherche à Monaco. Cette deuxième recherche a été refusée. La requête a été relancée explicitement sur Lyon et a retourné Chez Suppernote. Cela montre qu’il faut préciser la ville dans les essais de recherche.

Les interfaces des clients ne montrent toujours pas le `protocolVersion` d’`initialize` ni la réponse JSON-RPC brute de `tools/list`. Les appels réussis confirment que les outils sont utilisables après déploiement, mais ne prouvent pas les versions négociées ni le contenu brut des schémas `securitySchemes`. Le consentement ChatGPT frais a été capturé dans cette session ; les paramètres `iss` du callback restent non observables dans l’interface.

#### ChatGPT avec un nouveau consentement staging

Le 29 septembre, une deuxième connexion `Suppernote Staging` a été ajoutée sans retirer la connexion existante. L’écran affiche Chez Suppernote, `resource=https://api-staging.sokar.tech`, les scopes `mcp:read`, `mcp:reserve`, `mcp:cancel` et PKCE S256. Le retour vers `chatgpt.com/connector/oauth_callback` a abouti. L’interface ne laisse pas voir les paramètres de redirection, donc `iss` n’a pas pu être relevé manuellement.

Avec cette nouvelle connexion, la recherche à Lyon a retourné Chez Suppernote, 12 rue de la République, cuisine bistrot/française, prix `€€`, pour 2 personnes le 30 septembre de 19 h à 21 h. La recherche à 21 h–23 h le soir même n’a retourné aucun résultat. Aucun hold ni réservation n’a été créé pendant ce retest.

Un appel séparé de disponibilité pour Chez Suppernote, 2 personnes, le 30 septembre à 19 h a répondu `available=true` pour 19 h–21 h. ChatGPT a confirmé qu’aucun hold ni réservation n’avait été créé.

#### Claude avec un nouveau consentement staging

Le 29 septembre, Suppernote Staging a été reconnecté depuis Claude Desktop. Après validation explicite de l’utilisateur, l’écran a été accepté. Il affiche `resource=https://api-staging.sokar.tech`, les scopes `mcp:read`, `mcp:reserve`, `mcp:cancel`, PKCE S256 et le retour `claude.ai/api/mcp/auth_callback`. La portée annoncée est « restaurants qui ont activé MCP » sur le staging, donc plus large que Chez Suppernote. Seul Chez Suppernote a été utilisé dans les essais ci-dessous. Claude demande une approbation ponctuelle par outil ; seules les approbations nécessaires à ces lectures ont été accordées.

Avec cette nouvelle liaison, `search_restaurants` a trouvé Chez Suppernote à Lyon pour 2 personnes le 30 septembre, 19 h–21 h : 12 rue de la République, cuisine bistrot/française, gamme de prix 2. `check_availability` a répondu disponible pour la plage exacte, sans alternative, avec `create_hold` comme action recommandée. Aucun hold ni réservation n’a été créé.

### Retest des sorties MCP après la PR #299

Le 29 septembre, après fusion de la PR #299 (`02a72dc`) et les déploiements staging et production, les connecteurs staging existants ont été réutilisés dans ChatGPT et Claude. Le retest a eu lieu après le dernier redémarrage de staging. Aucun nouvel écran OAuth n’a été accepté et aucun outil d’écriture n’a été appelé.

| Vérification — 2 personnes, Lyon, 1 octobre 2026, 19:30–21:00 Europe/Paris | ChatGPT                                                                                                                                                                                                                                       | Claude                       | Conclusion                                                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `search_restaurants`                                                       | Chez Suppernote, slug `chez-sokar-demo`, adresse `12 Rue de la République, 69001 Lyon`, cuisines `Bistrot` et `Française`, `priceRange: 2`, `maxOnlinePartySize: 6`; créneau `2026-10-01T17:30:00.000Z`–`19:00:00.000Z`; `capacityLimits: []` | Mêmes champs et même créneau | Les nouvelles données publiques et le créneau exact sont rendus dans les deux clients.                         |
| `check_availability`                                                       | `available: true`, `alternativeSlots: []`, `decision: "available"`, `recommendedAction: "create_hold"`                                                                                                                                        | Même réponse                 | La recommandation est informative ; aucun hold n’a été créé.                                                   |
| Compteurs après le retest                                                  | `search_restaurants`: 2 succès ; `check_availability`: 2 succès                                                                                                                                                                               | Un appel de chaque outil     | Labels observés : `auth_type="oauth"`, `transport="mcp"`. Aucun appel d’écriture ni erreur dans ce run propre. |

Les compteurs de ce retest ont été lus sur le loopback de l’API staging après le dernier redéploiement. Les deux clients contribuent chacun un succès pour chacun des deux outils. Les interfaces confirment le contenu rendu, mais ne fournissent toujours pas le `protocolVersion` brut d’`initialize` ni la réponse brute de `tools/list`. Aucun nouveau consentement n’a été accepté pendant ce retest précis ; les consentements frais réalisés ensuite sont décrits dans « Retest client en lecture seule après le correctif OAuth #294 ».

## Parcours fonctionnel réel avant le correctif OAuth

Les mêmes paramètres ont été utilisés pour comparer les deux clients. Restaurant : Chez Suppernote. Groupe : 2 personnes. Créneau commun : 30 septembre 2026, 19 h 30–21 h 00, Europe/Paris.

| Étape                           | ChatGPT sur staging                                          | Claude sur staging                                           | Résultat                                                                                                   |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Recherche du restaurant         | Réussie ; identifiant 9587ad78-ebc0-4805-a716-41727658d5e7   | Réussie ; même identifiant, slug chez-sokar-demo             | Les deux ont utilisé Suppernote Staging                                                                    |
| Disponibilité                   | available=true de 19 h 30 à 21 h 00                          | available=true de 19 h 30 à 21 h 00                          | Le même créneau a été confirmé disponible dans les deux clients                                            |
| Hold                            | Créé puis consommé par la réservation                        | Créé puis consommé par la réservation                        | Le holdToken n’a pas été recopié dans la réponse finale                                                    |
| Création de réservation         | CONFIRMED ; réservation bb4fcbf4-31cf-43dc-8b87-30df37184e88 | CONFIRMED ; réservation c4327868-3c00-4e72-8418-6a3c89c1f876 | Marqueur MCP du run présent ; consentement de traitement vrai, SMS/email transactionnels et marketing faux |
| Statut avec téléphone correct   | CONFIRMED                                                    | CONFIRMED                                                    | Accès autorisé                                                                                             |
| Statut avec téléphone incorrect | Accès refusé                                                 | Accès refusé ; erreur NOT_FOUND                              | La réservation n’a pas été divulguée avec un autre numéro                                                  |
| Modification                    | Réussie ; 20 h 00–21 h 30                                    | Réussie ; 20 h 00–21 h 30                                    | 2 personnes conservées et statut CONFIRMED après modification                                              |
| Vérification après modification | CONFIRMED ; plage 18:00–19:30 UTC, soit 20 h–21 h 30 à Paris | CONFIRMED ; même conversion UTC/Europe-Paris                 | Fuseau appliqué correctement dans les deux clients                                                         |
| Annulation                      | cancelled=true ; état final CANCELLED                        | cancelled=true ; relecture finale CANCELLED                  | Les deux parcours d’écriture ont été terminés                                                              |

### Observation sur les heures implicites

Lors d’une première demande sans heure de fin, ChatGPT a vérifié 19 h 30–21 h 30, tandis que Claude a pris 19 h 30–21 h 00. Les deux réponses étaient disponibles, mais la comparaison n’était pas équivalente. Le test de disponibilité exacte a ensuite été rejoué avec un début et une fin explicitement identiques ; les deux ont renvoyé `available=true`. Pour tester le comportement naturel, l’heure de fin doit être omise et le serveur doit appliquer sa durée par défaut de 120 minutes.

## Parcours d’écriture post-correctif — ChatGPT

Le 29 septembre, ChatGPT a utilisé le connecteur `Suppernote Staging` sur Chez Suppernote uniquement, avec le run `connector-20260929-02`. La disponibilité du 30 septembre 2026, 19 h–21 h, Europe/Paris, pour 2 personnes était positive. Le hold puis la réservation ont été créés avec le téléphone factice `+33612345600`, le nom `MCP Sandbox`, le marqueur `MCP-SANDBOX:connector-20260929-02` et les consentements `reservationProcessing=true`, `transactionalSms=false`, `transactionalEmail=false`, `marketingOptIn=false`.

| Étape                                           | Résultat observé dans ChatGPT                                      |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Création                                        | Réservation `CONFIRMED`, ID `c237ada8-23c6-4070-b13e-39d608a2b474` |
| Lecture avec le téléphone du manifeste          | Succès : 2 personnes, 19 h–21 h                                    |
| Lecture avec le téléphone erroné `+33612345601` | Refus `NOT_FOUND`, aucune donnée révélée                           |
| Modification                                    | Réussie ; `changed=true`, statut `CONFIRMED`, 20 h–21 h 30         |
| Relecture après modification                    | Le créneau 20 h–21 h 30 est confirmé                               |
| Annulation et relecture finale                  | Annulation réussie ; état `CANCELLED`                              |

Le statut du run lu après ce parcours ChatGPT indiquait 1 réservation marquée, 1 hold, 1 client de test, 1 clé d’idempotence et 5 lignes d’audit ; liste d’attente, références client hors run et preuves de consentement : 0. La réservation avait été relue à l’état `CANCELLED`. Le run a ensuite aussi servi à une première tentative Claude incorrecte, détaillée dans « Nettoyage des runs post-correctif ».

## Parcours d’écriture post-correctif — Claude

Le 29 septembre, le connecteur `Suppernote Staging` a été utilisé sur Chez Suppernote uniquement avec le run `connector-20260929-03`. Les valeurs exactes étaient : 2 personnes, 30 septembre 2026, 19 h–21 h Europe/Paris, `MCP Sandbox`, le téléphone factice du manifeste, `specialRequests=MCP-SANDBOX:connector-20260929-03`, clé `mcp-connector-20260929-03-claude`, traitement de réservation vrai et les consentements SMS/email transactionnels et marketing faux. Chaque écriture a été inspectée dans la demande d’approbation puis autorisée une seule fois.

| Étape                                                 | Résultat observé dans Claude                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Recherche, détails et disponibilité                   | Chez Suppernote trouvé ; `available=true`, 17:00Z–19:00Z, soit 19 h–21 h à Paris                                        |
| Hold                                                  | Créé avec 2 personnes et le créneau exact                                                                               |
| Création                                              | `CONFIRMED`, ID `b652a247-52f2-47c8-b1bb-b256bf85bb95`, `reused=false`                                                  |
| Lecture initiale                                      | `CONFIRMED`, 2 personnes, créneau 19 h–21 h                                                                             |
| Rejeu identique avec la même clé et le même holdToken | Échec `INVALID_HOLD` (« Invalid or expired hold »), au lieu de `reused=true`                                            |
| Modification vers 20 h–21 h 30                        | Réussie ; `changed=true`                                                                                                |
| Relecture après modification                          | Réussie ; 18:00Z–19:30Z, soit 20 h–21 h 30 à Paris. Une première lecture a eu une erreur transport et a réussi au retry |
| Annulation et relecture finale                        | Réussies ; `cancelled=true`, état `CANCELLED`                                                                           |

Le rejeu du run 03 a échoué parce que le service validait le hold comme actif avant de consulter l’idempotence. Après la première création, ce hold est déjà consommé. La PR #314 consulte maintenant d’abord la clé et le hash déjà terminés lorsqu’un `holdToken` est fourni ; elle ne réexécute pas les validations et ne crée pas de réservation supplémentaire. Les retests des runs 04 et 05 ci-dessous confirment le comportement dans les deux clients.

## Retest du rejeu après le correctif — Claude et ChatGPT

La PR [#314](https://github.com/Sshindraa/Sokar/pull/314), commit `e53169b0`, a été fusionnée. La CI de `main`, le déploiement staging et ses smoke tests/E2E ont réussi. Les deux clients ont ensuite utilisé `Suppernote Staging` et Chez Suppernote exclusivement. Pour chaque client, la seconde création a repris tous les mêmes arguments, y compris le `holdToken` consommé.

| Étape                                             | Claude — run `connector-20260929-04`                                                               | ChatGPT — run `connector-20260930-05`                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Recherche, détails, disponibilité                 | Chez Suppernote trouvé ; détails OK ; `available=true`, 1er octobre 2026, 19:00–20:30 Europe/Paris | Chez Suppernote trouvé ; détails et horaires OK ; `available=true`, 2 octobre 2026, 19:00–20:30 Europe/Paris |
| Hold et première création                         | Hold créé ; `CONFIRMED`, ID `8a81494e-bbaa-486b-82da-6fba4a9f2861`, `reused=false`                 | Hold créé ; `CONFIRMED`, ID `07f035a5-a836-4dc3-8bed-769551c83463`, `reused=false`                           |
| Rejeu strictement identique avec le hold consommé | `reused=true`, même ID, aucun doublon ni erreur                                                    | `reused=true`, même ID, aucun doublon ni erreur                                                              |
| Lecture après création                            | `CONFIRMED`, 2 personnes, 19:00–20:30 Paris                                                        | `CONFIRMED`, 2 personnes, 19:00–20:30 Paris                                                                  |
| Modification et relecture                         | `changed=true`, créneau 20:00–21:30 Paris confirmé                                                 | `changed=true`, créneau 20:00–21:30 Paris confirmé                                                           |
| Annulation et relecture finale                    | `cancelled=true`, état `CANCELLED`                                                                 | `cancelled=true`, état `CANCELLED`                                                                           |
| Purge vérifiée                                    | 1 réservation anonymisée, 6 audits ; 0 hold, client, clé d’idempotence ou consentement             | 1 réservation anonymisée, 6 audits ; 0 hold, client, clé d’idempotence ou consentement                       |

Les captures des comptes rendus Claude et ChatGPT ont été prises dans les clients pendant cette session et sont visibles dans le fil. Aucun secret OAuth n’a été consigné. Les réservations de test ont été annulées avant chaque reset.

## Purge du run

Avant le correctif de reset, le run `connector-20260929-01` contenait :

| Artefact du run               | Nombre |
| ----------------------------- | -----: |
| Réservations                  |      2 |
| Holds                         |      2 |
| Entrées de liste d’attente    |      0 |
| Clients de test               |      1 |
| Enregistrements d’idempotence |      2 |
| Journaux d’audit              |     10 |

Une première tentative avant le correctif avait échoué, car elle essayait de supprimer les journaux `reservation_audit_log`, protégés par le trigger append-only. Après fusion de la PR #310 et déploiement staging avec smoke tests verts, le dry-run a de nouveau ciblé exactement les compteurs ci-dessus. L’application du reset puis une commande `status` ont confirmé le résultat suivant :

| Artefact conservé ou restant  | Nombre après reset |
| ----------------------------- | -----------------: |
| Réservations tombstones       |                  2 |
| Réservations anonymisées      |                  2 |
| Holds                         |                  0 |
| Entrées de liste d’attente    |                  0 |
| Clients de test               |                  0 |
| Références client hors run    |                  0 |
| Enregistrements d’idempotence |                  0 |
| Journaux d’audit append-only  |                 12 |
| Preuves de consentement       |                  0 |

Les réservations étaient déjà `CANCELLED`. Le reset les conserve donc comme tombstones, remplace leur marqueur par `MCP-SANDBOX:connector-20260929-01:PURGED`, retire les champs client et les clés d’idempotence, puis ajoute deux événements d’anonymisation. Les deux holds, les deux enregistrements d’idempotence et le client de test ont disparu ; les 10 audits d’origine et les 2 nouveaux restent append-only. Aucun trigger ni garde-fou n’a été désactivé et aucune migration de schéma n’a été nécessaire.

### Nettoyage des runs post-correctif

Le run 02 contenait la réservation ChatGPT et une première réservation Claude créée avec des paramètres que Claude avait inventés après un prompt tronqué. Cette dernière a été annulée, rattachée au marqueur du run après vérification de son UUID, du restaurant, du canal MCP, de l’état annulé et de l’heure de création, puis anonymisée par le reset normal. Le client factice supplémentaire, sans autre réservation, ainsi que ses deux événements de chronologie et son identité de téléphone ont été supprimés. Aucun autre client ni restaurant n’a été touché.

| Run et reset            | Réservations anonymisées | Holds | Clients | Clés d’idempotence | Audits conservés | Consentements |
| ----------------------- | -----------------------: | ----: | ------: | -----------------: | ---------------: | ------------: |
| `connector-20260929-02` |                        2 |     0 |       0 |                  0 |               11 |             0 |
| `connector-20260929-03` |                        1 |     0 |       0 |                  0 |                6 |             0 |
| `connector-20260929-04` |                        1 |     0 |       0 |                  0 |                6 |             0 |
| `connector-20260930-05` |                        1 |     0 |       0 |                  0 |                6 |             0 |

Les dry-runs correspondaient aux artefacts connus avant chaque reset. Les audits restent append-only ; les holds, clients de manifeste, clés d’idempotence et données opérationnelles ont disparu.

**Conclusion opérationnelle :** OAuth frais et lectures MCP sont validés dans les deux clients. Le cycle métier complet, y compris le rejeu avec hold consommé, est validé dans Claude et ChatGPT. Tous les runs sont nettoyés comme documenté. Après le feu vert staging, le workflow automatique du dépôt a aussi exécuté `Deploy Production` (run [36637029278](https://github.com/Sshindraa/Sokar/actions/runs/36637029278)) avec smoke tests verts ; aucun client MCP de production ni aucune réservation de production n’a été utilisé pour cette matrice. Les interfaces ne montrent toujours pas le `protocolVersion` brut d’`initialize` ni la réponse JSON-RPC brute de `tools/list`.

## Captures et limites de preuve

- Les nouveaux écrans de consentement ChatGPT et Claude après le correctif ont été capturés ; Claude affiche la portée multi-restaurants staging acceptée par l’utilisateur.
- Les captures des résultats post-correctif Claude et ChatGPT sont visibles dans le fil de cette session ; les réponses détaillées sont transcrites dans les tableaux ci-dessus. Les images n’ont pas été exportées comme fichiers dans ce dossier.
- Les clients ne montrent pas les messages JSON-RPC bruts d’initialisation MCP, la version négociée, ni le contenu brut de tools/list. Les versions de protocole sont donc indiquées comme non observables, pas comme vérifiées.
- Les identifiants OAuth, codes de retour, challenge et jetons ne sont pas consignés dans cette matrice.

## Vérification de la conversation naturelle

Après PR #318 et son déploiement staging, une demande en lecture seule a été saisie sans valeurs MCP ni consignes techniques : « Je cherche une table au restaurant Chez Suppernote, à Lyon, pour deux personnes jeudi 1er octobre vers 19 h. Est-ce qu’il y a de la place ? Ne fais pas la réservation pour l’instant. » Seul le connecteur `Suppernote Staging` était activé; aucun outil d’écriture, aucun hold et aucune réservation n’ont été appelés.

| Client  | Résultat                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT | Réponse naturelle : Chez Suppernote a une table pour 2 le 1er octobre à 19 h (créneau annoncé 19 h–21 h); précise qu’aucune réservation ni aucun blocage n’a été effectué.              |
| Claude  | A demandé des fenêtres horaires d’1 h puis 5 h; après deux résultats vides, a conclu qu’il ne pouvait pas confirmer le restaurant et a demandé son UUID. Aucun outil d’écriture appelé. |

Cause trouvée : le schéma imposait `slotEnd`, donc Claude inventait la durée au lieu d’utiliser la durée par défaut de Suppernote. La branche `codex/mcp-natural-window-guidance` rend maintenant `slotEnd` facultatif et fait compléter 120 minutes par le serveur. La réponse ajoute aussi `searchOutcome`, pour qu’un résultat vide ne soit pas interprété comme preuve que le restaurant n’existe pas. Retest naturel de Claude à faire après le déploiement staging de ce correctif; cette consigne serveur reste indicative et le client contrôle la réponse finale.

## Retest naturel après PR #320 — 30 septembre 2026

Après le déploiement staging de PR #320, un nouveau chat Claude a été utilisé en lecture seule avec le connecteur `Suppernote Staging` uniquement. Demande saisie : « Je voudrais une table pour deux chez Chez Suppernote à Lyon, jeudi 1er octobre vers 19 h. Est-ce qu'il y a de la place ? Ne réserve rien pour l'instant. » Claude a appelé `search_restaurants` avec `city=Lyon`, `partySize=2`, `slotStart=2026-10-01T18:30:00`, `slotEnd=2026-10-01T20:00:00` et `timezone=Europe/Paris`, au lieu de commencer à 19 h. La réponse staging était `searchOutcome=no_exact_slot_available`, avec `restaurants=[]` et `capacityLimits=[]`. Claude a ensuite proposé d’élargir à 17 h 30–22 h 30 et a demandé l’identifiant du restaurant; l’élargissement a été refusé. Aucun tool d’écriture, hold ou réservation n’a été appelé. Aucun autre connecteur n’a été utilisé.

searchOutcome et l’heure de fin facultative n’ont pas suffi : le serveur ne savait pas que la personne avait nommé Chez Suppernote et la réponse texte restait technique. La branche codex/mcp-named-search-guidance ajoute la recherche par nom, l’état explicite de la fiche nommée et du texte bref en français pour les protocoles avec structuredContent ; le JSON historique est conservé pour 2025-03-26. Ce paragraphe documente l’échec du retest après PR #320 ; le résultat du retest après PR #324 figure ci-dessous. La formulation finale reste sous le contrôle du client.

## Retest naturel après PR #324 — 30 septembre 2026

PR #324, commit de merge 3e2940d, est déployée sur staging. Le déploiement staging [36654446919](https://github.com/Sshindraa/Sokar/actions/runs/36654446919) et ses smoke tests ont réussi. La promotion automatique en production [36654816868](https://github.com/Sshindraa/Sokar/actions/runs/36654816868) a aussi réussi ; aucun appel MCP ni test utilisateur n’a été fait en production.

Dans un nouveau chat de chaque client, seul le connecteur Suppernote Staging était sélectionné. Dans Claude, Suppernote et Shopify étaient désactivés. Prompt naturel, identique dans les deux clients : « Tu peux vérifier s’il reste une table pour deux au restaurant Chez Suppernote à Lyon demain vers 19 h ? Je ne souhaite pas réserver pour l’instant. »

| Vérification     | Claude                                                                                                                                         | ChatGPT                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Demande comprise | Chez Suppernote, Lyon, 2 personnes, jeudi 1er octobre vers 19 h                                                                                | Même demande ; l’activité indique une recherche de disponibilité chez Chez Suppernote pour le 1er octobre                                                                    |
| Appel observé    | « Rechercher un restaurant » a transmis Lyon, 2 personnes, 1er octobre à 19:00, Europe/Paris et Chez Suppernote. Aucune heure de fin inventée. | Les arguments MCP ne sont pas visibles dans l’interface ChatGPT.                                                                                                             |
| Réponse          | « Bonne nouvelle : Chez Suppernote a de la disponibilité demain, jeudi 1er octobre, à 19 h pour 2 personnes. Rien n’est réservé de mon côté. » | Réponse naturelle : disponible demain, jeudi 1er octobre 2026, de 19 h à 19 h 30, pour 2 personnes. ChatGPT confirme qu’aucune réservation ni mise en attente n’a été faite. |
| Écriture         | Aucune ; aucun hold ni réservation                                                                                                             | Aucune ; aucun hold ni réservation                                                                                                                                           |

Claude a respecté l’heure de début, gardé la fin implicite et répondu sans UUID ni JSON. ChatGPT a répondu en langage courant, mais a avancé une durée de 30 minutes non demandée. Comme son interface masque les paramètres MCP, il est impossible de savoir si le modèle a envoyé une fin à 19 h 30 ou l’a ajoutée dans sa réponse. Le contrat de check_availability exigeait encore slotEnd, contrairement à search_restaurants : le correctif en cours rend slotEnd facultatif pour la vérification seule et applique le défaut de 120 minutes. Les outils de création de hold, devis ou réservation gardent une heure de fin explicite.

Ce test confirme l’absence de retour technique visible dans les réponses finales, mais pas encore un résultat cohérent sur la durée. Le retest après le correctif est requis. Les captures d’écran sont visibles dans le fil de cette tâche, sans export dans le dépôt.

## Retest naturel après PR #325 — 30 septembre 2026

PR #325 a été fusionnée dans `bc5445c` et déployée sur staging par le workflow [36703090404](https://github.com/Sshindraa/Sokar/actions/runs/36703090404). Le déploiement et les smoke tests sont verts.

Dans deux nouvelles conversations, seul le connecteur `Suppernote Staging` était actif. La requête, identique dans les deux clients, était : « Tu peux me dire s’il y a encore une table pour deux demain vers 19 h au restaurant Chez Suppernote à Lyon ? Je regarde juste, je ne réserve pas encore. » Elle a été utilisée en lecture seule pour Chez Suppernote uniquement.

| Vérification      | Claude                                                                                                                                                                                                                                                                                                                                 | ChatGPT                                                                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recherche         | L’appel visible à « Rechercher un restaurant » contenait Lyon, Chez Suppernote, 2 personnes, le 1er octobre à 19:00, Europe/Paris. La réponse de l’outil disait qu’une table était disponible à 19 h.                                                                                                                                  | L’activité indiquait une recherche de disponibilité à Lyon le 1er octobre. L’interface masque les arguments MCP bruts.                                                                                                                                                                            |
| Réponse au client | « Oui, il reste une table pour 2 personnes demain, jeudi 1er octobre, à 19 h chez Chez Suppernote à Lyon. Je n'ai rien réservé, c'était juste pour regarder. Si tu veux la prendre, dis-le-moi et je m'en occupe. » Réponse sans jargon, mais double « chez », tutoiement et invitation à réserver malgré la précision de la personne. | « Oui. Pour demain, jeudi 1er octobre, Chez Suppernote à Lyon a encore de la disponibilité pour 2 personnes à 19 h, ainsi qu’à 19 h 30. Je n’ai créé ni réservation ni blocage de table. » Réponse sans identifiant ni JSON, mais horaire voisin non demandé et formulation « blocage de table ». |
| Écritures         | Aucune ; aucun hold ni réservation.                                                                                                                                                                                                                                                                                                    | Aucune ; aucun hold ni réservation.                                                                                                                                                                                                                                                               |

Dans le panneau d’activité ChatGPT, le modèle expliquait qu’il vérifiait 18 h 30, 19 h et 19 h 30. Comme les arguments bruts et le résultat détaillé ne sont pas visibles, on ne peut pas établir si 19 h 30 provenait d’une alternative retournée ou d’un autre appel. Le correctif en cours dans `codex/mcp-natural-language-output` renforce les consignes serveur et les descriptions des tools : vouvoiement, noms commençant par « Chez » sans préposition redoublée, un seul horaire demandé et une réponse brève sans invitation à réserver après une demande de simple renseignement. Tests ciblés et retest staging requis avant de conclure. Aucun appel MCP de production.

## Retest naturel après PR #326 — 30 septembre 2026

PR #326 (`a47fca70`) a été fusionnée et déployée sur staging avec le workflow [36706281037](https://github.com/Sshindraa/Sokar/actions/runs/36706281037). Le déploiement automatique en production [36706769841](https://github.com/Sshindraa/Sokar/actions/runs/36706769841) est terminé ; aucun appel MCP n’a été fait en production.

Dans de nouvelles conversations Claude et ChatGPT, seul le connecteur `Suppernote Staging` était actif. Demande naturelle identique, en lecture seule et sans durée explicite : « Est-ce qu’il reste une table pour deux demain vers 19 h au restaurant Chez Suppernote à Lyon ? Je me renseigne seulement, je ne réserve pas encore. » Aucun outil d’écriture n’a été appelé.

| Vérification | Claude                                                                                                                                                                                                                                                                                                                                                  | ChatGPT                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recherche    | Rechercher un restaurant avec Lyon, Chez Suppernote, 2 personnes, le 1er octobre à 19:00, Europe/Paris ; pas d’heure de fin.                                                                                                                                                                                                                            | La recherche MCP a réussi ; l’interface ne montre pas les arguments bruts.                                                                                                                                                                                                                                              |
| Réponse      | « Oui, il reste de la place : Chez Suppernote a une table disponible pour 2 personnes demain, jeudi 1er octobre, à 19 h. Comme tu ne fais que regarder, je n'ai rien réservé ni bloqué. Dis-moi si tu veux que je m'en occupe. » Aucun identifiant ni JSON et pas d’horaire voisin ; tutoiement, « bloqué » et invitation à réserver restent inadaptés. | « Oui. Chez Suppernote à Lyon a encore de la disponibilité pour 2 personnes demain, jeudi 1er octobre, à 19 h, sur le créneau 19 h–21 h. Je n’ai posé aucune option et je n’ai rien réservé. » Aucun identifiant ni JSON et pas d’horaire voisin ; la durée de contrôle interne est présentée comme une plage demandée. |
| Écritures    | Aucune ; aucun hold ni réservation.                                                                                                                                                                                                                                                                                                                     | Aucune ; aucun hold ni réservation.                                                                                                                                                                                                                                                                                     |

Le serveur transmet `availableSlots[].endsAt` dans les données structurées, et cette borne correspond au défaut interne de 120 minutes lorsque la personne ne donne pas de durée. Le correctif en cours dans `codex/mcp-hide-internal-duration` retire la durée chiffrée des consignes model-facing et marque cette borne dans le schéma comme interne. La forme et les valeurs de la réponse restent inchangées pour préserver le contrat public. Un nouveau retest staging dans les deux clients est requis ; les instructions seules ne garantissent pas le texte final.

## Retest naturel après PR #327 — 30 septembre 2026

PR #327 (`7e71a23b`) a été fusionnée ; le déploiement staging et ses smoke tests [36709864924](https://github.com/Sshindraa/Sokar/actions/runs/36709864924) ont réussi. Le déploiement automatique en production [36710139298](https://github.com/Sshindraa/Sokar/actions/runs/36710139298) a aussi réussi, sans aucun appel MCP de production.

Deux nouveaux chats ont été utilisés avec la même question naturelle et aucun tool d’écriture : « Est-ce qu’il reste une table pour deux demain vers 19 h au restaurant Chez Suppernote à Lyon ? Je me renseigne seulement, je ne réserve pas encore. » Dans ChatGPT, le chip `Suppernote Staging` était le seul connecteur MCP sélectionné. Dans Claude, le menu affichait Shopify désactivé, Suppernote désactivé et Suppernote Staging activé. Chez Suppernote était le seul restaurant demandé.

| Vérification | Claude                                                                                                                                                                                                                                                                       | ChatGPT                                                                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recherche    | `Rechercher un restaurant` appelé une fois depuis Suppernote Staging après sélection « Allow once ».                                                                                                                                                                         | La recherche a abouti ; l’interface masque les arguments MCP bruts.                                                                                                                                                                                              |
| Réponse      | « Oui, il reste une table pour deux demain, jeudi 1er octobre, à 19 h chez Chez Suppernote à Lyon. Rien n'est réservé pour l'instant. Si vous voulez la bloquer, dites-moi et je m'en occupe. » Double « chez » et proposition de réservation malgré la précision contraire. | « Oui. Chez Suppernote à Lyon a actuellement une table pour 2 demain, jeudi 1er octobre, à 19 h, sur un créneau jusqu’à 20 h 30. Je n’ai posé aucune option et je n’ai fait aucune réservation. La disponibilité peut donc évoluer. » Heure de fin non demandée. |
| Écritures    | Aucune ; aucun hold ni réservation.                                                                                                                                                                                                                                          | Aucune ; aucun hold ni réservation.                                                                                                                                                                                                                              |

La correction en cours dans `codex/mcp-reuse-human-tool-message` remplace les indications vagues de reformulation par une consigne stricte : la phrase française de succès renvoyée par `search_restaurants` ou `check_availability` constitue la réponse complète à reprendre telle quelle. Le tool `search_restaurants` produit aussi une phrase directe du type « Oui, une table est disponible pour 2 personnes au restaurant Chez Suppernote le jeudi 1er octobre à 19 h. » Aucun changement au schéma des réponses MCP.

## Retest naturel après PR #328 — 30 septembre 2026

PR #328 (`9c8d5062`) est fusionnée. La CI de `main` a réussi, le déploiement staging et ses smoke tests [36713234354](https://github.com/Sshindraa/Sokar/actions/runs/36713234354) ont réussi, puis le déploiement automatique en production [36713712357](https://github.com/Sshindraa/Sokar/actions/runs/36713712357) a réussi sans test MCP de production.

Dans deux nouveaux chats, la demande était : « Vous auriez une table pour deux demain soir vers 19 h au restaurant Chez Suppernote à Lyon ? Je regarde juste la disponibilité, sans réserver pour l’instant. » ChatGPT n’avait sélectionné que `Suppernote Staging`. Dans Claude, Shopify, Suppernote, la recherche web et la mémoire étaient désactivés; `Suppernote Staging` était le seul connecteur actif. Claude a appelé seulement le tool de recherche, avec `city=Lyon`, `partySize=2`, `slotStart=2026-10-01T19:00:00`, `timezone=Europe/Paris`, `restaurantName=Chez Suppernote`. Aucun outil d’écriture, hold ou réservation n’a été appelé.

| Vérification   | Claude                                                                                                                                                                                                              | ChatGPT                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Texte brut MCP | « Oui, une table est disponible pour 2 personnes au restaurant Chez Suppernote le jeudi 1er octobre à 19 h. »                                                                                                       | Interface sans arguments MCP bruts.                                                                                                                     |
| Réponse finale | « Oui, une table pour deux est disponible chez Chez Suppernote à Lyon demain soir, le jeudi 1er octobre, à 19 h. Je n'ai rien réservé, comme vous le souhaitiez. Si vous voulez que je m'en occupe, dites-le-moi. » | « Oui. Chez Suppernote à Lyon a une table disponible pour 2 personnes demain, jeudi 1er octobre, de 19 h à 21 h. Je n’ai effectué aucune réservation. » |
| Écart constaté | Double « chez » et proposition de réservation.                                                                                                                                                                      | Borne interne de recherche 19 h–21 h présentée comme durée disponible.                                                                                  |
| Écritures      | Aucune.                                                                                                                                                                                                             | Aucune.                                                                                                                                                 |

La phrase renvoyée par `search_restaurants` est correcte; les clients la réécrivent depuis leur contexte et les données structurées. Le champ obligatoire `availableSlots[].endsAt` est la borne technique de recherche (120 min) et n’est pas une durée de réservation demandée. Une nouvelle branche ajoute l’outil additif de lecture seule `answer_availability`, dont le `structuredContent` est limité à `{ message }`; l’outil détaillé `search_restaurants` garde son contrat. Le but est de retirer l’heure de fin et les données inutiles du contexte du modèle pour une question simple. Ça réduit les extrapolations, sans permettre au serveur de garantir la formulation finale du client.

## Retest naturel après PR #329 — 30 septembre 2026

PR #329 (`699a20c9`) est fusionnée dans `18d8820d`. CI [36717103793](https://github.com/Sshindraa/Sokar/actions/runs/36717103793), déploiement staging et smoke tests [36717697821](https://github.com/Sshindraa/Sokar/actions/runs/36717697821), puis déploiement automatique en production [36718018771](https://github.com/Sshindraa/Sokar/actions/runs/36718018771) sont verts. Aucun appel MCP n’a été fait en production.

La demande, identique dans les deux clients : « Vous auriez une table pour deux demain soir vers 19 h au restaurant Chez Suppernote à Lyon ? Je regarde juste la disponibilité, sans réserver pour l’instant. » ChatGPT n’avait que `Suppernote Staging`. Dans Claude, seul `Suppernote Staging` était actif ; Shopify, Suppernote, la recherche web et la mémoire étaient désactivés. Chez Suppernote était l’unique restaurant testé. Aucun outil d’écriture, hold ou réservation n’a été appelé.

| Vérification              | Claude                                                                                                                                                                                                                                                                                                                                                             | ChatGPT                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Premier résultat Claude   | Avant actualisation, sa liste en cache ne contenait pas `answer_availability` : il a utilisé `Rechercher un restaurant`, puis ajouté « Si vous voulez la table, dites-le-moi et je m'en occupe. » Après **Settings → Customize → Connectors → Suppernote Staging → More options → Refresh tools list**, le nouvel outil apparaît parmi les cinq outils de lecture. | —                                                                                                                                                                |
| Appel après actualisation | `Répondre à une question de disponibilité` avec `city=Lyon`, `partySize=2`, `restaurantName=Chez Suppernote`, `slotStart=2026-10-01T19:00:00`, `timezone=Europe/Paris`. Autorisation ponctuelle avant l’appel.                                                                                                                                                     | L’interface masque les arguments MCP et le nom précis de l’outil.                                                                                                |
| Réponse finale            | « Oui, une table est disponible pour 2 personnes au restaurant Chez Suppernote le jeudi 1er octobre à 19 h. » Texte identique au message du serveur, sans ajout ni proposition de réservation.                                                                                                                                                                     | « Oui. Chez Suppernote à Lyon a une table disponible pour 2 personnes demain, jeudi 1er octobre, à 19 h. Je n’ai effectué aucune réservation ni aucun blocage. » |
| Écritures                 | Aucune.                                                                                                                                                                                                                                                                                                                                                            | Aucune.                                                                                                                                                          |

Le premier résultat Claude décrit le cache du client, pas le comportement de la nouvelle version du serveur. PR #331 a supprimé l’instruction qui poussait à commenter systématiquement l’absence de réservation. Après déploiement staging et actualisation des outils dans les deux clients, ChatGPT et Claude ont répondu par la même phrase courte, sans heure de fin, jargon ou proposition de réservation. Le serveur fournit la phrase lisible, mais ne contrôle pas entièrement la réponse finale du modèle.

## Retest naturel après correction du cache et PR #331 — 30 septembre 2026

PR [#331](https://github.com/Sshindraa/Sokar/pull/331), commit `5b40ff79`, corrige la consigne MCP qui ajoutait un commentaire automatique sur l’absence de réservation. La CI de `main` [36724216737](https://github.com/Sshindraa/Sokar/actions/runs/36724216737) et le déploiement staging avec smoke tests [36724958925](https://github.com/Sshindraa/Sokar/actions/runs/36724958925) ont réussi. Aucun appel MCP n’a été fait en production.

Dans un nouveau chat de chaque client, la demande était : « Est-ce qu'il reste une table pour deux demain vers 19 h au restaurant Chez Suppernote, à Lyon ? » Le serveur testé était `https://api-staging.sokar.tech/mcp` et le seul restaurant demandé était Chez Suppernote. Aucun hold ou réservation n’a été créé.

| Client  | Actualisation et appel                                                                                                                                                                                                                                                                                                                                                                                                                          | Réponse finale                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| ChatGPT | `Suppernote Staging` uniquement, puis **Settings → Plugins → Suppernote Staging → Refresh tools**. Avant l’actualisation, l’ancien outil ajoutait la plage 19 h–21 h. L’interface masque le nom précis de l’outil et ses arguments.                                                                                                                                                                                                             | « Oui, une table est disponible pour 2 personnes au restaurant Chez Suppernote le jeudi 1er octobre à 19 h. » |
| Claude  | Shopify et Suppernote désactivés; mémoire, recherche web et recherche approfondie désactivées; seul `Suppernote Staging` actif. Après **Customize → Connectors → Suppernote Staging → More options → Refresh tools list**, `answer_availability` a été appelé avec `city=Lyon`, `partySize=2`, `restaurantName=Chez Suppernote`, `slotStart=2026-10-01T19:00:00`, `timezone=Europe/Paris`. Les outils d’écriture restent soumis à autorisation. | « Oui, une table est disponible pour 2 personnes au restaurant Chez Suppernote le jeudi 1er octobre à 19 h. » |

Ce retest confirme le parcours en lecture seule dans les versions observées. Après modification ou déploiement d’un outil MCP, actualisez sa liste dans chaque client pour éviter l’usage d’une ancienne définition.
