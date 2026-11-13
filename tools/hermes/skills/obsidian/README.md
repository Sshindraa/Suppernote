# Suppernote Auto-Logging System

## Architecture

Le système d'automatisation Suppernote élimine tout besoin de mise à jour manuelle de la documentation. Il repose sur **3 composants** qui fonctionnent en synergie :

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                SUPPERNOTE AUTO-LOGGING SYSTEM                       │
  │                                                                      │
  │  ┌──────────────────┐    ┌──────────────┐    ┌──────────────────┐   │
  │  │  mcp_serve.py    │    │ auto_sync.py │    │                  │   │
  │  │  (MCP gateway)   │───▶│ (git watcher)│    │                  │   │
  │  │                  │    │              │    │                  │   │
  │  │ Détecte le type  │    │ Surveille    │    │                  │   │
  │  │ de tâche         │    │ git diff     │    │ sync automatique │   │
  │  │ Met à jour la    │    │ Met à jour   │    │ Mapping carte    │   │
  │  │ note ciblée      │    │ les notes    │    │                   │   │
  │  └────────┬─────────┘    └──────┬───────┘    └────────┬─────────┘   │
  │           │                     │                      │            │
  │           └──────────┬──────────┴──────────┬───────────┘            │
  │                      │                     │                        │
  │              ┌───────▼──────────────────────▼────────┐              │
  │              │         OBSIDIAN VAULT                  │             │
  │              │  docs/obsidian/*.md                     │             │
  │              │                                         │             │
  │              │  Journal.md     ← log horodaté          │             │
  │              │  Context.md     ← activité courante     │             │
  │              │  API Endpoints  ← routes détectées      │             │
  │              │  Database Schema← modèles Prisma        │             │
  │              │  Voice Pipeline ← fichiers voice        │             │
  │              │  Dashboard.md   ← composants UI         │             │
  │              │  ...             ← notes auto-générées  │             │
  │              └─────────────────────────────────────────┘             │
  └─────────────────────────────────────────────────────────────────────┘
```

## Composants

### 1. `mcp_serve.py` (MCP Gateway)

**Chemin** : `~/Projects/Sokar/tools/hermes/scripts/mcp_serve.py`

Le point d'entrée unique pour toute exécution via un client MCP.

**Ce qu'il fait automatiquement après chaque tâche** :

1. **Classifie la tâche** — détecte si c'est une création de route, modification de schema, ajout de composant, pipeline vocal, job queue, etc.
2. **Log dans Journal.md** — ajoute une ligne au tableau horodaté
3. **Met à jour Context.md** — section "Dernière activité"
4. **Met à jour la note ciblée** — par exemple, si une route `reservation.routes.ts` est modifiée, `API Endpoints.md` est automatiquement mis à jour
5. **Déclenche auto_sync** — pour synchroniser les changements de code

**Carte de classification** :

| Mot-clé dans la tâche    | Type détecté     | Note mise à jour    |
| ------------------------ | ---------------- | ------------------- |
| route, endpoint, crud    | `create_route`   | API Endpoints.md    |
| prisma, schema, model    | `modify_schema`  | Database Schema.md  |
| voice, stt, tts, telnyx  | `voice_pipeline` | Voice Pipeline.md   |
| dashboard, ui, component | `add_component`  | Dashboard.md        |
| bullmq, queue, worker    | `queue_job`      | BullMQ Jobs.md      |
| hermes, agent, skill     | `agent_config`   | Hermes Agent.md     |
| auth, clerk, webhook     | `security`       | Security.md         |
| test, vitest, coverage   | `testing`        | Testing Strategy.md |

### 2. `auto_sync.py` (Git Watcher)

**Chemin** : `~/Projects/Sokar/tools/hermes/skills/obsidian/auto_sync.py`

Surveille les changements dans le code source et met à jour le vault Obsidian.

**Modes** :

- `daemon [interval]` — boucle toutes les N secondes (défaut: 30)
- `diff` — analyse git diff en une passe
- `watch` — scan filesystem (fallback sans git)
- `map` — affiche la carte fichier → note

**Carte de détection** :

| Pattern fichier                          | Note Obsidian      | Extracteur  |
| ---------------------------------------- | ------------------ | ----------- |
| `apps/api/src/modules/*.routes.ts`       | API Endpoints.md   | `routes`    |
| `packages/database/prisma/schema.prisma` | Database Schema.md | `schema`    |
| `apps/api/src/modules/voice/`            | Voice Pipeline.md  | `voice`     |
| `apps/dashboard/`                        | Dashboard.md       | `dashboard` |
| `packages/`                              | Architecture.md    | `packages`  |
| `tools/hermes/`                          | Hermes Agent.md    | `agent`     |

### Daemon complet (tout automatique)

```zsh
# Démarrer les 3 daemons (recommandé)
python3 tools/hermes/skills/obsidian/auto_sync.py daemon &
# mcp_serve.py est actif via le client MCP configuré
```

### Vérifier que tout fonctionne

```zsh
# Tester auto_sync
python3 tools/hermes/skills/obsidian/auto_sync.py diff


# Voir les logs
cat ~/.hermes/logs/auto_sync.log
cat ~/.hermes/logs/mcp_serve.log
```

## Fichiers

| Fichier                                     | Rôle                                                   |
| ------------------------------------------- | ------------------------------------------------------ |
| `tools/hermes/scripts/mcp_serve.py`         | MCP Gateway + classification + auto-logging            |
| `tools/hermes/skills/obsidian/auto_sync.py` | Git/filesystem watcher                                 |
| `tools/hermes/skills/obsidian/auto_doc.py`  | Helpers de documentation (Context.md, décisions)       |
| `tools/hermes/skills/obsidian/skill.py`     | Tools Hermes pour le vault (list, read, write, search) |
