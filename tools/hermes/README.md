# Hermes Agent for Suppernote

Configuration Hermes CLI pour le monorepo Suppernote.

## Configuration

Hermes lit sa configuration effective depuis `~/.hermes/config.yaml`.
Le fichier `tools/hermes/config/hermes-config.yaml` sert de template projet sans secret.
La direction courante est OpenCode Go avec `minimax-m3` en modèle principal
et un fallback plus fort quand nécessaire.

## Structure

```text
tools/hermes/
├── config/
│   ├── hermes-config.yaml      # Configuration Hermes CLI (LLM providers)
│   └── mcp-config.json         # Configuration MCP optionnelle
├── scripts/
│   ├── setup.sh                # Installation et setup initial
│   ├── start-hermes.sh         # Lancement Hermes CLI
│   └── check-hermes.sh         # Healthcheck
└── README.md                   # Ce fichier
```

## Utilisation

### Mode terminal (principal)

```zsh
hermes -z "votre tâche ici"
```

Exemples :

- "Add Zod validation to contact routes"
- "Create KPI latency component in dashboard"
- "Refactor Telnyx webhook handler with retry logic"

### Via script

```zsh
zsh tools/hermes/scripts/start-hermes.sh
```

### Via MCP

Les MCP servers configurés :

- **hermes** : Orchestrateur Suppernote
- **sokar-postgres** : PostgreSQL
- **sokar-github** : GitHub

## Configuration

### Variables d'environnement

Ne mets pas de clé en clair dans les fichiers du repo.
Le template utilise `key_env` :

- `OPENCODE_GO_API_KEY` : modèle principal Hermes.
- `GITHUB_TOKEN` : MCP GitHub, optionnel.
- `DATABASE_URL` : MCP PostgreSQL, optionnel selon la tâche.

### Fichiers de configuration

- `~/.hermes/config.yaml` : configuration live.
- `tools/hermes/config/hermes-config.yaml` : template projet.
- `tools/hermes/config/mcp-config.json` : MCP optionnel.

## Stack Suppernote reconnu

- **apps/api** : Fastify 5 + Prisma 6 + Redis + BullMQ + Telnyx
- **apps/dashboard** : Next.js 15 + React 19 + Tailwind 3
- **packages/database** : Prisma schema + client
- **packages/config** : Shared config
- **packages/shared** : Shared utilities

## Commandes utiles

```zsh
hermes -z "tâche"              # Exécuter une tâche
hermes status                  # Vérifier le status
hermes doctor                  # Diagnostics détaillés
zsh tools/hermes/scripts/check-hermes.sh  # Healthcheck
```

## Healthcheck

```zsh
zsh tools/hermes/scripts/check-hermes.sh
```

Vérifie :

- Installation Hermes
- Configuration
- Variables d'environnement
- MCP servers
