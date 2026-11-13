# Soumission du connecteur MCP aux annuaires

État au 17 octobre 2026. Le serveur `https://api.suppernote.com/mcp` remplit les exigences techniques
de l'annuaire Claude : OAuth 2.0 avec enregistrement dynamique et PKCE S256, 401 +
`WWW-Authenticate` sans jeton, `title` et `readOnlyHint` / `destructiveHint` sur chaque outil.

## Éléments de la fiche

| Champ                        | Valeur                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| URL du serveur               | `https://api.suppernote.com/mcp`                                                     |
| Documentation                | `https://suppernote.com/assistants-ia` (aussi annoncée par `resource_documentation`) |
| Politique de confidentialité | `https://suppernote.com/privacy`                                                     |
| Support                      | `hello@suppernote.com`                                                               |
| Authentification             | OAuth, enregistrement dynamique (DCR)                                                |
| Données                      | API propre à Suppernote ; nom et téléphone transmis au seul restaurant choisi        |

## Parcours de test pour les relecteurs

Les établissements fictifs (`CONNECT_DEMO_SLUGS`) sont masqués des recherches ouvertes, pour
qu'aucun vrai client ne se voie proposer un faux restaurant. Ils restent accessibles quand on les
nomme exactement. Instructions à donner aux relecteurs :

1. Ajouter le connecteur avec l'URL ci-dessus et accepter l'autorisation (lecture, réservation,
   annulation). Aucun compte Suppernote n'est nécessaire.
2. Demander : « Cherche le restaurant Chez Suppernote à Lyon pour 2 personnes demain à 19 h 30. »
3. Vérifier la disponibilité, réserver avec le nom `Review Test` et le téléphone `+33612345600`.
4. Relire, modifier puis annuler la réservation avec ce même téléphone.

Chez Suppernote est un établissement de démonstration : ses réservations n'atteignent aucun vrai
restaurant. Nettoyer les réservations de test après la revue.

## Restant hors code

- Soumission depuis un compte Claude payant : `claude.ai/directory/manage`, type « MCP connector ».
- Identité légale de l'éditeur (étape « Company » et mentions légales).
- Le Chat : connecteur personnalisé non encore testé de bout en bout.
- ChatGPT : apps annoncées indisponibles dans l'EEE ; à revérifier avant soumission.
