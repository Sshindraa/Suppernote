# Hermes Scripts — Suppernote

Scripts d'automatisation pour Hermes CLI sur le projet Suppernote.

## Scripts

| Script            | Rôle                                                                                                                                                                                              | Usage                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `setup.sh`        | Installation initiale : vérifie Hermes CLI, Docker, les vars d'env, et copie la config dans `~/.hermes/`                                                                                          | `zsh tools/hermes/scripts/setup.sh`               |
| `start-hermes.sh` | Lance Hermes CLI en interactif avec la config Suppernote (charge `.env`/`.env.local`, vérifie `OPENCODE_GO_API_KEY`)                                                                              | `zsh tools/hermes/scripts/start-hermes.sh`        |
| `check-hermes.sh` | Healthcheck : vérifie la présence de `hermes` CLI, du repo, et des vars critiques (`DATABASE_URL`, `OPENCODE_GO_API_KEY`, `GITHUB_TOKEN` optionnel)                                               | `zsh tools/hermes/scripts/check-hermes.sh`        |
| `sokar.sh`        | Wrapper one-shot : concatène les args en une tâche, exécute `hermes -z`, journalise dans `Journal.md` + `Context.md` (Obsidian)                                                                   | `zsh tools/hermes/scripts/sokar.sh "votre tâche"` |
| `mcp_serve.py`    | Serveur MCP — expose `execute_task` (exécution via Hermes) et `check_task` (vérification). Auto-détecte le type de tâche et met à jour la note Obsidian correspondante. Pas d'accès shell direct. | Démarré par Hermes, pas en CLI                    |

## Config associée

- `tools/hermes/config/hermes-config.yaml` — template de config projet (copié dans `~/.hermes/config.yaml` par `setup.sh`)
- `tools/hermes/skills/obsidian/` — skill Python pour la journalisation auto (`auto_doc.py`)

## Flux typique

```zsh
# 1. Première installation
zsh tools/hermes/scripts/setup.sh

# 2. Vérifier que tout est en place
zsh tools/hermes/scripts/check-hermes.sh

# 3a. Mode interactif
zsh tools/hermes/scripts/start-hermes.sh

# 3b. Mode one-shot avec journalisation auto
zsh tools/hermes/scripts/sokar.sh "Ajoute Zod validation aux routes API"
```

## Dépendances

- Hermes CLI installé (`~/.local/bin/hermes`)
- `OPENCODE_GO_API_KEY` dans `.env.local` ou `.env`
- `DATABASE_URL` dans `.env.local` ou `.env`
- Python 3 (pour `mcp_serve.py` et le skill Obsidian)
- Docker (optionnel, vérifié par `setup.sh`)
