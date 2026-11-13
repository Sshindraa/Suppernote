# Décisions archivées — 2026-05 → 2026-07

> Extraites de `Context.md` le 2026-09-21 (cf. [[Journal]]). `Context.md` ne garde que les décisions du mois courant.

- **2026-07-25** — Durcissement voice : 8 lots mergés sur `main` (`a805c65`). Validation Zod source unique pour les 8 outils, annulation ambiguë avec cascade de résolution (téléphone → nom sûr → temps → transfert gérant), création replay-safe via `callId`, reconstruction des tool calls du stream (élimine le double LLM call), timeout 8s + circuit breaker (3 échecs → 30s skip) + fallback réseau, fallback mid-stream avec distinction session abort vs timeout, harness de régression déterministe (10 scénarios E2E), audit PII global (Sentry extra nettoyés, `redactPii()` sur debug logs). 1509 tests, 0 régression. Non déployé.
- **2026-07-24** — Voice LLM : Gemma 4 31B sur Cerebras devient le primaire (intelligence privilégiée sur la latence, TTFT ~403 ms), Llama 3.3 70B sur Groq via OpenRouter en fallback automatique (429/5xx, TTFT ~151 ms). Architecture bidirectionnelle via `VOICE_LLM_PROVIDER` (« cerebras » défaut, « openrouter » alternative). Remplace Gemini 3.5 Flash-Lite (google-vertex, ~696 ms). Benchmarks éliminés : Qwen3.6-27B (0/6 tool calls), GPT-OSS-120B (6/6 mais 563 ms avg). Commit `8be510b` sur `migration/frankfurt`.
- **2026-07-21** — Floor-plan : la liste d’attente est une vue Live service dédiée et ne permet pas de forcer une table depuis le client. La promotion utilise exclusivement l’allocation transactionnelle existante côté API ; le drag-and-drop vers une table est différé.
- **2026-07-21** — Floor-plan : l’allocation expose d’abord trois propositions explicables et read-only ; undo/redo reste volontairement borné à la géométrie réversible du canvas (50 actions locales, pas de création/suppression). La machine à états de service complète reste différée aux retours de pilotes.
- **2026-06-24** — Suppernote Connect v1.1 validée par Hamza (8 corrections v1→v1.1 intégrées : static export→standalone, suppression basePath, VPS+Caddy+Cloudflare proxy, gating corrigé, source de vérité unique, seed local/staging, audit log métier only, CORS durci). Spec : [[Sokar Connect P0|Suppernote Connect P0]]
- **2026-06-24** — Phase 0 Suppernote Connect lancée : ordre T1→T2+T3→T4 avec STOP revue entre chaque. T1 (`migrate deploy`) **fait le 2026-06-24** (backfill Chez Suppernote → Lyon/69001/FR), T2-T10 (API publique, JSON-LD, app connect, pages, analytics, sécurité) écrits et testés (38/38 tests verts). Reste : T4 app en prod + P1 pilote fermé (cf. [[Sokar Connect P0|Suppernote Connect P0]]).
- **2026-06-24** — Cleanup docs/ : `pilot/_archive/` créé, `runbook.md` extrait de `pilot/`, 3 versions agentic obsolètes archivées. Vault Obsidian re-activé après 5 semaines d'arrêt (cf. Journal).
- **2026-06-23** — Cleanup Vault Obsidian : 17 notes. Pas alimenté depuis 2026-05-21. Rétro-documentation des 5 semaines sautées : agentic-reservations P0, MCP OAuth, OpenAI Reserve, model switch Hermes, VSCode crashes. Reprise automatic à partir de T1 Suppernote Connect.
- **2026-06-23** — Model switch Hermes : `glm-5.2` → `minimax-m3` via `opencode-go`. Supervisor `glm-5.2=review`. Crof.ai supprimé (404 sur `deepseek-v4-pro`). Contrainte : `/v1/messages` exige `x-api-key` (Hermes n'envoie pas) → `api_mode: anthropic_messages` désactivé.
- **2026-06-22** — RGPD Phase 5 durci : three-token pattern (OTP → verification token → one-shot action) sur `/api/rgpd/erase` et `/api/rgpd/export`. Modèles `IdentityVerificationOtp` + `SignedTokenUsage`. Phase 7 a ajouté identity hardening.
- **2026-06-21** — Agentic-reservations P0 livré : hold/quote state machine, partial unique index `one_active_hold_per_slot`, idempotency scoped, audit log append-only, RGPD structured consents. Spec v3.2 = référence prod-safe.
- **2026-06-21** — Migration TTS ElevenLabs → Cartesia Sonic 3.5 finalisée (cf. [[Telnyx Pipeline]]). Limitation speed/volume sur sonic-3.5 (depuis avril 2026), workaround = revenir à sonic-3 si besoin.
- **2026-05-21** — Crof AI `deepseek-v4-pro` ne fonctionne pas comme provider `custom` (404). Le provider normalise le model name en `deepseek/deepseek-v4-pro` que Crof rejette. **Résolu** par switch vers `opencode-go` + `minimax-m3` (cf. 2026-06-23).
- **2026-05-21** — Clerk mocké en test via `helpers.ts` (`requireOrg` lit `Authorization` header). Telnyx webhook guard mocké dans `reservation.test.ts`.

## Archivage du 17 octobre 2026 — décisions de septembre sorties du Context

2026-09-30 — [MCP, UX] Réponse de disponibilité limitée au résultat utile ; préciser la création uniquement si demandé et rafraîchir les outils après déploiement.

2026-09-29 — [MCP, UX] Pas de surface prompts/resources sans besoin récurrent avéré.

2026-09-29 — [MCP, contrats] Retries idempotents, erreurs stables, sorties validées ; quote informatif, hold réservé à la capacité.

2026-09-29 — [MCP, observabilité] Contrats recherche/disponibilité additifs ; métriques indépendantes du client.

2026-09-25 — [Voix] Keyterms métier en opt-in par restaurant ; aucune donnée personnelle ; MIP opt-out par défaut.

2026-09-24 — [Réservations] Taille de groupe par défaut unifiée à 7 ; lignes existantes inchangées.

2026-09-23 — [Voix/observabilité] TurnPlan en shadow sans autorité ; métriques Prometheus, Grafana accessible par tunnel SSH.

2026-09-21 — [Connect] Publication refusée sans slug, avant toute écriture.

2026-09-21 — [Seed] Restaurants de démo créés uniquement en local, ou à distance avec opt-in explicite.

2026-09-21 — [Codex] Configuration plugins allégée ; raisonnement par défaut réglé sur high.
