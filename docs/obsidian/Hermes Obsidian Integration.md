# Hermes × Obsidian — Intégration Suppernote

> **Dernière mise à jour** : 2026-06-24
> **Statut** : **fonctionnel** via skill `obsidian` (filesystem-first).
> Le système "auto-sync" décrit en 2025 (mcp_serve.py, auto_sync.py) **n'a jamais été livré en prod**. Cette note décrit
> l'état réel.

---

## Comment ça marche aujourd'hui

L'agent Hermes lit/écrit dans le vault via la **skill `obsidian`** :

| Opération        | Outil Hermes                                            |
| ---------------- | ------------------------------------------------------- |
| Lister les notes | `search_files` (target: files)                          |
| Lire une note    | `read_file` (path absolu résolu)                        |
| Chercher un mot  | `search_files` (target: content)                        |
| Écrire / écraser | `write_file`                                            |
| Append           | `read_file` + `patch` (ancre) ou `write_file` (rewrite) |
| Édition ciblée   | `patch` (old_string → new_string)                       |
| Wikilinks        | `[[Note Name]]` (markdown standard Obsidian)            |

**Pas de daemon**, **pas de classification auto**, **pas de sync externe
auto**. C'est l'agent qui appelle les outils à chaque modif
significative, en suivant la skill `obsidian-doc` (règle absolue :
"Ne PAS attendre qu'on te demande").

## Vault

```
Chemin : /Users/hamza/Projects/Sokar/docs/obsidian/
Format : markdown standard (.md), pas de formatting exotique
Versionné : oui (dans le monorepo git)
```

### Variable d'env

```bash
OBSIDIAN_VAULT_PATH=/Users/hamza/Projects/Sokar/docs/obsidian
```

Convention documentée dans la skill `obsidian` (skill Hermes). Si
unset, fallback `~/Documents/Obsidian Vault` (pas utilisé par Suppernote).

## Skill `obsidian-doc` — règle d'or

> **Après chaque modification significative, documenter immédiatement
> dans Obsidian. C'est automatique, pas facultatif.**

### Déclencheurs de documentation

Toute modif concernant : architecture, schema Prisma, provider,
feature flag, route API, décision technique, suppression de code
legacy.

**Ne PAS documenter** : typos, renommage de variable, cleanup
trivial, install de deps.

### Procédure

1. **Mettre à jour la note ciblée** (la plus pertinente pour le
   changement). Exemples :
   - Voice → [[Telnyx Pipeline]] ou [[Scribe Pipeline Media Stream]]
   - Schema → [[Architecture]] (vue d'ensemble) ou note dédiée
   - Route → [[API Endpoints]]
   - Spec nouvelle → nouvelle note dans le vault + lien depuis [[Context]]
2. **Logger dans [[Journal]]** — ajouter une ligne en fin de tableau
   `| YYYY-MM-DD HH:MM | Description courte | ✅/❌ | module |`
3. **Mettre à jour [[Context]]** — section `## Dernière activité`
   (ligne unique) + section `## Décisions récentes` (liste
   chronologique inverse)

### Style

- Dates `YYYY-MM-DD HH:MM`
- Préfixer les entrées Context avec `[module]` : `[voice]`, `[api]`, `[docs]`, `[agent]`
- Wikilinks entre notes existantes
- Tableaux markdown pour les logs
- Pas de formatting exotique

## Outils MCP `obsidian-vault` (optionnel)

La skill `obsidian` est la voie officielle. Un MCP server
`obsidian-vault` peut être configuré dans Hermes (basé sur
`@modelcontextprotocol/server-filesystem`) pour exposer les
opérations fichiers standard, mais la skill reste plus riche
(recherche plein texte avec snippets, daily note template, fuzzy
title lookup).

Configuration type (optionnelle) :

```json
"obsidian-vault": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem",
           "/Users/hamza/Projects/Sokar/docs/obsidian"]
}
```

## Notes principales du vault

| Note                                | Rôle                                         |
| ----------------------------------- | -------------------------------------------- | ----------------------------- |
| [[Context]]                         | Décisions récentes, TODOs, dernière activité |
| [[Journal]]                         | Log chronologique des tâches                 |
| [[Architecture]]                    | Stack globale, monorepo                      |
| [[API Endpoints]]                   | Routes Fastify exhaustives                   |
| [[Telnyx Pipeline]]                 | ai_config, machine à états, webhooks         |
| [[Scribe Pipeline Media Stream]]    | Pipeline Scribe + barge-in                   |
| [[Fillers Audio]]                   | Cache fillers LLM                            |
| [[Sokar Connect P0                  | Suppernote Connect P0]]                      | Spec phase 0 + tickets T1-T10 |
| [[Session Telnyx Debug 2026-06-10]] | Post-mortem Telnyx                           |

Notes legacy (Vapi, Sprint 1, stubs, Git Auto-Commit) : retirées du
vault lors de la migration Desktop → Projects.

## Historique du système d'auto-logging

En 2025, un système d'auto-classification a été décrit dans la
version originale de cette note :

| Composant                                          | Statut réel                                             |
| -------------------------------------------------- | ------------------------------------------------------- |
| `agent/scripts/mcp_serve.py` (gateway)             | **N'existe plus**                                       |
| `agent/skills/obsidian/auto_sync.py` (git watcher) | **N'existe plus**                                       |
| `agent/skills/obsidian/auto_doc.py` (helpers)      | **N'existe plus**                                       |
| `agent/skills/obsidian/skill.py` (tools Hermes)    | **Remplacé** par la skill `obsidian` (filesystem-first) |
| Windsurf Cascade MCP `obsidian-vault`              | **N'utilise plus Windsurf**                             |

Le système "auto-géré" décrit en 2025 n'a jamais été livré en prod.
La conséquence visible : le [[Journal]] a sauté 5 semaines
(2026-05-22 → 2026-06-23) sans aucune entrée. C'est l'agent
Hermes (skill `obsidian-doc`) qui maintient le vault maintenant,
manuellement, à chaque modif significative.

## Liens

- Skill `obsidian` (Hermes) : `~/.hermes/skills/note-taking/obsidian/SKILL.md`
- Skill `obsidian-doc` (Hermes) : `~/.hermes/skills/documentation/obsidian-doc/SKILL.md`
- [[README]] — Index du vault
- [[Context]] — État courant
- [[Journal]] — Historique
