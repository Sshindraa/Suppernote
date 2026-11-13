# Archives documentaires Suppernote

> **Statut : HISTORIQUE — réconcilié le 15 septembre 2026.**

Ce dossier contient des spécifications et briefs conservés pour retracer les
choix de conception. Ils ne décrivent pas le schéma, les routes, les prix, les
flags ou l'état de production actuels. Ne pas créer de tâche, de migration ou
de déploiement à partir d'une instruction « GO », d'un modèle Prisma ou d'un
chemin présent dans ces fichiers.

## Fichiers archivés

| Fichier                                      | Ce qu'il conserve                                                            | Référence à utiliser aujourd'hui                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sokar-mcp-agentic-reservations.md`          | Spec agentic v2 et son audit initial du schéma                               | [`sokar-mcp-agentic-reservations-v3.2.md`](../sokar-mcp-agentic-reservations-v3.2.md), puis le code API et [`PROJECT_MAP.md`](../PROJECT_MAP.md)                            |
| `sokar-mcp-agentic-reservations-v3.md`       | Plan v3 « prod-safe » avant la version v3.2                                  | [`sokar-mcp-agentic-reservations-v3.2.md`](../sokar-mcp-agentic-reservations-v3.2.md) et les ADR actuelles                                                                  |
| `sokar-mcp-agentic-reservations-v3.1.md`     | Spec v3.1 avec les amendements Phase 0                                       | [`sokar-mcp-agentic-reservations-v3.2.md`](../sokar-mcp-agentic-reservations-v3.2.md) et [`docs/audits/2026-09-15-current-state.md`](../audits/2026-09-15-current-state.md) |
| `sokar_sprint1_brief.md`                     | Brief technique du MVP vocal de mai 2026                                     | [`runbook.md`](../runbook.md), les runbooks spécialisés et le code des modules `voice`, `reservations` et `agentic-reservations`                                            |
| `voice-llm-benchmark-2026-07-22.md`          | Comparaison qualité/latence de six modèles voix (contrôle Mistral Small 3.2) | [`runbooks/provider-resilience.md`](../runbooks/provider-resilience.md) : un seul provider, Groq/Qwen 3.8 27B, sans repli                                                   |
| `voice-llm-cost-benchmark-2026-07-22.md`     | Comparaison coût/latence de six modèles économiques                          | [`runbooks/provider-resilience.md`](../runbooks/provider-resilience.md) : un seul provider, Groq/Qwen 3.8 27B, sans repli                                                   |
| `voice-llm-balanced-benchmark-2026-07-22.md` | Comparaison à budget relevé (Gemini Flash-Lite)                              | [`runbooks/provider-resilience.md`](../runbooks/provider-resilience.md) : un seul provider, Groq/Qwen 3.8 27B, sans repli                                                   |

## Règle de maintenance

Les archives ne sont pas réécrites pour refléter les évolutions du produit :
modifier une archive détruirait la preuve de ce qui avait été décidé à sa date.
Lorsqu'un point historique doit être corrigé ou vérifié, ajouter une preuve
datée dans [`docs/audits/`](../audits/2026-09-15-current-state.md), mettre à
jour [`DOCUMENTATION_STATUS.md`](../DOCUMENTATION_STATUS.md) et pointer vers la
source active concernée.

Les sources de vérité actuelles sont l'API et le schéma Prisma, les runbooks,
les ADR et la [réconciliation courante des audits](../audits/2026-09-15-current-state.md).

`docs/_archive/` ne doit pas être confondu avec [`docs/archive/`](../archive/README.md) :
le premier contient des specs et briefs historiques, le second des artefacts
opérationnels ponctuels. Les deux restent conservés, avec des règles de lecture
différentes.
