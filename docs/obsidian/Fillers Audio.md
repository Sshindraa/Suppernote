# Fillers Audio — Cache RAM + Redis pour combler les silences LLM

**Statut** : ⚡ Actif en prod
**Composant** : `apps/api/src/modules/voice/stream/fillers-cache.ts`
**Constante** : `FILLER_CACHE_TTL_SECONDS = 86_400 * 30` (30 jours)
**Modèle TTS** : Cartesia Sonic 3.6 continu (`sonic-3.6`), format G.711 alaw/mulaw 8 kHz

---

## Problème résolu

Quand un client appelle et pose une question, voici la chaîne :

| Étape                              | Latence typique |
| ---------------------------------- | --------------- |
| STT (ElevenLabs capte la question) | ~300 ms         |
| LLM (Cerebras/Qwen réfléchit)      | 500-2000 ms     |
| TTS (Cartesia synthétise)          | 150-300 ms      |

Le silence entre l'étape 1 et 3 = **500 ms à 2 secondes de blanc**. Si le client
n'entend rien, il croit que ça a coupé, recommence à parler (barge-in), et
l'UX devient catastrophique.

## Solution : filler audio pré-généré

Dès qu'on détecte que le LLM met >400 ms à répondre, on **joue immédiatement
un filler audio du cache** pour signaler "je vous écoute, je réfléchis" :

| Style               | Exemples                                                            |
| ------------------- | ------------------------------------------------------------------- |
| **CASUAL** (défaut) | "Je regarde ça…", "Voyons voir…", "Un instant…"                     |
| **WARM**            | "Pas de souci, je regarde ça !", "Je m'en occupe, une seconde…"     |
| **FORMAL**          | "Veuillez patienter un instant…", "Je consulte nos disponibilités…" |

Le client entend une voix humaine immédiate → il sait que ça marche → il attend.
Quand la vraie réponse LLM arrive, **le filler s'arrête net** (barge-in
applicatif sur detection UtteranceStart ElevenLabs).

## Code de déclenchement

Dans `apps/api/src/modules/voice/stream/handler.ts` (2 sites) :

```typescript
const fillerTimer = setTimeout(() => {
  if (!firstTokenReceived && !session.ended && session.state === 'PROCESSING') {
    playFiller(session.telnyxWs, session.personality?.fillerStyle ?? 'CASUAL');
  }
}, 400);
```

→ Si le LLM n'a pas envoyé son 1er token en 400 ms, on déclenche le filler.

## Architecture cache : 2 niveaux

```
┌─────────────────────────────────────────────┐
│ playFiller()                                │
│   1. Lookup Map<text, chunks> (RAM)         │  ← O(1), 0 ms
│   2. Si miss : redisCache.get(filler:hash)  │  ← ~2 ms après restart
│   3. Si miss : log warn, fallback Telnyx    │  ← voix Telnyx native
└─────────────────────────────────────────────┘
```

| Niveau | Type                      | Survit au restart pm2 | Latence lookup |
| ------ | ------------------------- | --------------------- | -------------- |
| RAM    | `Map<string, string[]>`   | ❌                    | 0 ms           |
| Redis  | `filler:<sha256-16>` db/1 | ✅ (TTL 30 j)         | ~2 ms          |

**Clé Redis** : SHA-256 tronqué à 16 chars de `(text|voiceId|codec)` → le format
audio est inclus dans la clé, donc si on change de voice ou de codec, pas de
collision. Clé opaque (pas le français en clair dans Redis).

## Warm-up au boot

`initFillerCache()` est appelé dans `main.ts` via `setImmediate()` :

```typescript
setImmediate(() => {
  initFillerCache().catch((err) => {
    app.log.warn({ err }, 'Filler cache warmup failed (non-blocking)');
  });
});
```

**Algorithme** :

1. Charge les 13 fillers du pool (CASUAL/WARM/FORMAL)
2. Pour chaque filler : check Redis → si hit, ajoute en RAM
3. Pour les fillers manquants : génère via Cartesia en background
   - Concurrence 4 (évite 429 `concurrency_limited` qui plafonne à ~9)
   - Stocke résultat en RAM + Redis (TTL 30 j)
4. Log final : `"Cached 5/5 new fillers (8 from Redis, total 13/13)"`

**Important** : le warm-up est **fire-and-forget** (non-bloquant). L'API
écoute les requêtes HTTP dès `app.listen()`. Si un appel téléphonique arrive
avant la fin du warm-up, fallback `speakTelnyxNative` (voix Telnyx native,
étrangère mais l'appel continue).

## Économie Cartesia

| Métrique                    | Avant         | Après                            |
| --------------------------- | ------------- | -------------------------------- |
| Crédits warm-up / restart   | 13 × 22 = 286 | **0** (Redis hit)                |
| Restarts pm2 / jour (moyen) | 4             | 4                                |
| Crédits warm-up / mois      | ~34 320       | **~286** (1 régénération / 30 j) |
| Crédits warm-up / an        | ~411 840      | **~3 432**                       |
| **Réduction**               | —             | **~99 %**                        |

Espace Redis : 112 KB (13 fillers × ~8 KB). Négligeable.

## Codec switching

Le codec Telnyx (PCMA/PCMU) est défini par session. `setFillerCodec()` doit
être appelé **au début de chaque appel** (avant `playFiller()`) :

```typescript
import { setFillerCodec, playFiller } from './fillers-cache';

setFillerCodec(session.codec === 'PCMA' ? 'PCMA' : 'PCMU');
```

Le warm-up utilise le codec actif au boot. Si une session arrive avec
l'autre codec, le lookup Redis s'adapte automatiquement (la clé inclut le
codec). Si un filler manque pour ce codec, fallback `speakTelnyxNative`
au pire.

## Pièges connus

- **Première génération après clé/compte expiré** : 402 `quota_exceeded`.
  Vérifier que `CARTESIA_API_KEY` est valide avant de debug le code.
- **429 `concurrency_limited`** : Cartesia limite à ~9 requêtes SSE
  simultanées. Code actuel : `CONCURRENCY = 4` avec batches.
- **`FILLER_CACHE_TTL_SECONDS` undefined au runtime** : le package
  `@suppernote/config/dist/constants.js` doit être rebuildé après chaque modif
  de `packages/config/src/constants.ts`. Le deploy-vps.sh ne le fait pas
  automatiquement — toujours vérifier.
- **Multi-IDE git hang** : Kilo + Codex + Antigravity ouvrent des handles
  sur `.git/refs/*` qui laissent des `.lock` orphelins. Voir
  `git-housekeeping` skill.
- **Cold start Sonic 3.6** : le premier appel après (re)démarrage prend
  ~2× plus longtemps que les suivants (chargement du modèle vocal). Le
  warm-up sert précisément à mitiger ça.

## Test rapide

```bash
# Vérifier le cache Redis actuel
ssh pmbtc 'cd /tmp && cat > check.js << "EOF"
const IORedis = require("/opt/sokar/node_modules/.pnpm/ioredis@5.10.1/node_modules/ioredis");
(async () => {
  const r = new IORedis("redis://127.0.0.1:6379/1");
  let cursor = "0", count = 0;
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", "filler:*", "COUNT", "100");
    cursor = next;
    for (const k of keys) {
      const ttl = await r.ttl(k);
      console.log(k, "ttl=" + (ttl/86400).toFixed(1) + "d");
      count++;
    }
  } while (cursor !== "0");
  console.log("Total:", count);
  r.disconnect();
})();
EOF
node check.js'

# Vérifier que l'API a bien lu le cache au boot
ssh pmbtc 'sudo pm2 logs sokar-api --lines 50 --nostream --raw 2>/dev/null \
  | grep -iE "filler|preload|cached" | tail -5'
```

## Liens

- Code : `apps/api/src/modules/voice/stream/fillers-cache.ts`
- Constante TTL : `packages/config/src/constants.ts` (`FILLER_CACHE_TTL_SECONDS`)
- Handler caller : `apps/api/src/modules/voice/stream/handler.ts` (lignes ~533, ~609)
- Boot init : `apps/api/src/main.ts` (setImmediate dans `start()`)
- Migration 24k pcm → G.711 8kHz : voir note dédiée ou commit `906dda0`
