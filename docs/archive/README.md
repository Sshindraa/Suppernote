# Archives opérationnelles Suppernote

> **Statut : HISTORIQUE — réconcilié le 15 septembre 2026.**

Ce dossier conserve des scripts et procédures ponctuels qui ont servi à une
opération donnée. Il ne s'agit pas d'une deuxième source de vérité produit et
ces scripts ne doivent pas être exécutés pour un nouveau déploiement sans une
revue explicite.

## Pourquoi ce dossier est distinct de `docs/_archive/`

- [`docs/_archive/`](../_archive/README.md) conserve des specs produit et des
  briefs techniques remplacés par des documents plus récents.
- `docs/archive/` conserve des artefacts opérationnels : scripts de migration
  de machine et ancien script de déploiement de cartes cadeaux.

Les deux dossiers sont donc historiques, mais ils ne racontent pas la même
chose. Les fusionner rendrait moins visible la différence entre une décision
de conception archivée et un script qui pourrait encore être exécutable.

## Contenu

| Chemin                                 | Rôle historique                                                                                                                            | Référence actuelle                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `operations/deploy-gift-cards-prod.sh` | Déploiement ponctuel historique des cartes cadeaux ; le script refuse déjà l'usage sans confirmation et indique qu'il ne doit plus servir. | [`scripts/deploy.sh`](../../scripts/deploy.sh) et [`docs/runbooks/deployment.md`](../runbooks/deployment.md)                |
| `operations/mac-migration-2026-07-01/` | Bundle chiffré pour migrer l'ancien Mac et les profils Hermes au 01/07/2026.                                                               | Environnement courant, [runbook Environment](../runbooks/environment.md) et procédure de sauvegarde/restauration appropriée |

Ne pas ajouter de fichiers `.env`, clés, bundles générés ou sorties de migration
dans ce dossier. Les archives existantes sont conservées pour l'historique et
ne constituent pas une preuve de production actuelle.
