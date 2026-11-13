# Diagnostics Suppernote

Scripts de diagnostic manuels pour le pipeline vocal, MCP et le dogfood QA.
Non exécutés en CI — usage développeur local uniquement.

## Scripts

| Script                          | Rôle                                                                                         | Invocation                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `test-stt-tts.mjs`              | Valide les 3 APIs vocales (ElevenLabs Scribe STT, Cartesia TTS, Cerebras LLM) indépendamment | `pnpm test:diagnostic`                                 |
| `benchmark-cartesia-voices.mjs` | Génère un corpus français/anglais pour comparer les voix Sonic 3.6                           | `node tools/diagnostics/benchmark-cartesia-voices.mjs` |
| `dogfood-sokar.sh`              | Dogfood QA du site/dashboard via Hermes CLI                                                  | `pnpm dogfood:sokar`                                   |
| `test-mcp-client.ts`            | Client de test pour les endpoints MCP de l'API (depuis le contexte `apps/api`)               | `pnpm test:mcp:client`                                 |
| `sokar-mcp-stdio.ts`            | Bridge MCP stdio pour Claude Desktop (depuis le contexte `apps/api`)                         | `pnpm test:mcp:stdio`                                  |

## Variables d'environnement

| Variable                   | Script(s)                                                | Défaut                                        | Rôle                                                      |
| -------------------------- | -------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| `ELEVENLABS_BENCH_API_KEY` | test-stt-tts, voice-stt-bench                            | obligatoire                                   | Clé ElevenLabs dédiée, différente de la clé de production |
| `CARTESIA_BENCH_API_KEY`   | test-stt-tts, voice-stt-bench, benchmark-cartesia-voices | `CARTESIA_API_KEY`                            | Clé Cartesia optionnelle ; sinon CARTESIA_API_KEY         |
| `CEREBRAS_BENCH_API_KEY`   | test-stt-tts                                             | obligatoire                                   | Clé Cerebras dédiée, différente de la clé de production   |
| `OPENROUTER_BENCH_API_KEY` | benchmark-voice-llms                                     | obligatoire                                   | Clé OpenRouter dédiée, différente de la clé de production |
| `BENCH_MAX_CREDITS`        | diagnostics et bancs                                     | entier positif obligatoire                    | Plafond estimé en unités natives par fournisseur          |
| `CEREBRAS_BASE_URL`        | test-stt-tts                                             | `https://api.cerebras.ai/v1`                  | Endpoint Cerebras OpenAI-compatible                       |
| `VOICE_LLM_MODEL`          | test-stt-tts                                             | `qwen/qwen3.8-27b`                            | Modèle LLM vocal                                          |
| `CARTESIA_VOICE_ID`        | test-stt-tts                                             | `f786b574-...`                                | ID de voix Cartesia                                       |
| `ELEVENLABS_STT_MODEL`     | test-stt-tts                                             | `scribe_v2_realtime`                          | Modèle STT                                                |
| `CARTESIA_MODEL`           | test-stt-tts                                             | `sonic-3.6`                                   | Modèle TTS                                                |
| `CARTESIA_BENCHMARK_DIR`   | benchmark-cartesia-voices                                | `/private/tmp/sokar-cartesia-voice-benchmark` | Répertoire temporaire des MP3 et du manifeste             |
| `SOKAR_API_BASE`           | test-mcp-client, sokar-mcp-stdio                         | `http://localhost:4000`                       | URL de base de l'API                                      |
| `SOKAR_MCP_KEY`            | test-mcp-client, sokar-mcp-stdio                         | obligatoire                                   | Clé MCP locale générée par le dashboard                   |
| `SOKAR_DOGFOOD_URL`        | dogfood-sokar                                            | `https://suppernote.com`                      | URL cible dogfood                                         |
| `SOKAR_DOGFOOD_OUTPUT`     | dogfood-sokar                                            | `$REPO_ROOT/.hermes/dogfood`                  | Répertoire de sortie                                      |

## Notes

- Les scripts MCP (`test-mcp-client.ts`, `sokar-mcp-stdio.ts`) nécessitent le contexte `apps/api` pour résoudre `@modelcontextprotocol/sdk`. Les commandes `pnpm test:mcp:*` gèrent cela automatiquement via `pnpm --filter @suppernote/api exec`.
- Voir `docs/sokar-mcp-integrator-guide.md` pour le guide d'intégration MCP complet.
- `test-stt-tts.mjs` charge `.env.local` via `node --env-file` (Node 20+), et utilise
  les clés `*_BENCH_API_KEY`, avec repli Cartesia sur `CARTESIA_API_KEY`. Il refuse
  les clés absentes et les estimations dépassant `BENCH_MAX_CREDITS` ; ElevenLabs et
  Cerebras exigent encore des clés distinctes du runtime. Les unités du plafond sont affichées
  séparément pour ElevenLabs (caractères), Cartesia (caractères) et Cerebras (tokens).
