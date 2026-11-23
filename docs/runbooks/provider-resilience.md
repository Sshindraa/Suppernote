# Runbook — Résilience fournisseurs

> **Statut : ACTIF — créé le 21 septembre 2026.** Primitives dans
> `apps/api/src/shared/resilience/` (timeout, retry borné, circuit breaker). Voir
> [`../roadmap-production-readiness.md`](../roadmap-production-readiness.md) (chantier R1-2).

## Pourquoi

Un `fetch` sans borne peut rester en vol jusqu'à la mort de la socket. Sur le chemin vocal, cela
signifie un appel téléphonique muet sans dégradation déclenchée ; sur un paiement ou un SMS, un job
qui ne se termine jamais. Les trois règles appliquées ici :

1. **Tout appel fournisseur a un timeout explicite.** Pas de défaut implicite du SDK.
2. **Les retries sont bornés et ne rejouent que le transitoire** (timeout, erreur réseau, 5xx, 429).
   Rejouer un 4xx ou une erreur métier consomme du quota sans rien réparer.
3. **Chaque panne a une dégradation écrite** : un message d'excuse au client, un filler ignoré, un
   job en dead-letter — jamais un silence.

## Primitives

```ts
import {
  CircuitBreaker,
  ProviderTimeoutError,
  VOICE_PROVIDER_TIMEOUT_MS,
  fetchWithTimeout,
  retry,
  withTimeout,
} from '../../shared/resilience';
```

- `withTimeout(promise, ms, label)` — borne une promesse sans annulation native (SDK).
- `fetchWithTimeout(url, init, ms)` — `fetch` avec `AbortController` ; lève `ProviderTimeoutError`.
- `retry(operation, { attempts, baseDelayMs, maxDelayMs })` — backoff exponentiel, jitter ±20 %.
- `CircuitBreaker` — états `closed` / `open` / `half-open`, avec `failureThreshold` et `cooldownMs`.

## État par fournisseur

| Fournisseur                 | Usage                                         | Timeout                      | Retries                | Circuit breaker                              | Dégradation si panne                                       |
| --------------------------- | --------------------------------------------- | ---------------------------- | ---------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Telnyx (contrôle d'appel)   | `answer`, `speak`, `record` via `telnyxFetch` | 10 s                         | aucun (appel en cours) | non                                          | l'appel se poursuit ou se termine côté Telnyx              |
| Telnyx (SMS / WhatsApp)     | SDK + agent keep-alive                        | SDK                          | BullMQ (`attempts: 5`) | non                                          | job en dead-letter, alerte `dead_letter_backlog`           |
| Cartesia TTS (appel live)   | `/tts/bytes` streamé                          | 8 s par tentative            | 2 tentatives           | non                                          | message d'excuse parlé via `speakTelnyxNative`             |
| Cartesia TTS (fillers)      | `/tts/sse`                                    | 8 s                          | 3 tentatives           | non                                          | filler ignoré, la réponse principale continue              |
| Cartesia TTS (démo/preview) | `/tts/bytes` one-shot                         | 8 s                          | aucun                  | oui, 3 échecs / 30 s                         | erreur explicite de l'endpoint                             |
| ElevenLabs STT              | WebSocket temps réel                          | géré par le bridge           | reconnexion du bridge  | non                                          | tour sans transcription, alerte `calls_without_transcript` |
| LLM vocal (Cerebras)        | complétion vocale                             | 8 s (`VOICE_LLM_TIMEOUT_MS`) | aucun                  | oui, 3 échecs / 30 s (implémentation dédiée) | secours OpenRouter (tour structuré), puis excuse parlée    |
| Stripe                      | PaymentIntent, webhooks                       | 10 s (SDK)                   | `maxNetworkRetries: 2` | non                                          | paiement refusé proprement, job en dead-letter             |
| Resend                      | email transactionnel                          | 10 s                         | BullMQ                 | non                                          | email non envoyé, trace en base                            |
| Google Places               | recherche                                     | 10 s                         | aucun                  | non                                          | disponibilité réduite, log d'avertissement                 |

Le circuit breaker LLM vit dans `modules/voice/stream/manager.ts`. Il n'a pas été migré vers le
module partagé pour ne pas toucher le chemin vocal ; l'unification est un suivi assumé, pas un
oubli.

Depuis le 27 septembre 2026, le pipeline vocal n'a **qu'un fournisseur LLM** : Cerebras, modèle
`qwen-3.8-27b` (Groq a été retiré). Sur le tour structuré, un 402/429/5xx, une erreur réseau ou un
circuit ouvert avant le premier fragment envoie la même requête vers OpenRouter (filet d'urgence,
~2 s avant la première phrase) ; sans secours ou s'il échoue, l'appelant entend le message
d'excuse parlé. Le circuit breaker évite de marteler Cerebras pendant 30 s après trois échecs
consécutifs.

L'identité effective est enregistrée à l'ouverture du stream et dans la télémétrie :
`llmProvider=cerebras` (ou `openrouter` quand le secours a servi) et `llmModel=VOICE_LLM_MODEL` sur `VoiceTurnTelemetry` et
`VoiceCallTelemetry`. Le log de démarrage expose aussi `openrouterKeyConfigured` (présence de la
clé dans l'environnement) et `openrouterUsed` (route effectivement empruntée). La première valeur
est vraie en production (secours du tour structuré et écoute des appels) ; la seconde reste
fausse tant que Cerebras répond.

## Région du secours OpenRouter (mondial / UE)

`OPENROUTER_FALLBACK_BASE_URL` (vide = `OPENROUTER_BASE_URL`) donne au seul secours vocal sa propre adresse, pour le
router en UE sans toucher aux autres usages d'OpenRouter. Aucune valeur par défaut n'a changé : tant qu'elle est
vide, le comportement est identique à avant.

Comparaison mesurée le 01/10/2026 avec `scripts/openrouter-region-test.mjs` (même requête que le secours : modèle
`deepseek/deepseek-v4-flash-0731`, JSON Schema strict, flux, ordre `Cohere,Wafer,Baidu` ; données synthétiques,
10 appels par adresse, alternés) :

|                               | Mondial          | UE                                                         |
| ----------------------------- | ---------------- | ---------------------------------------------------------- |
| Appels réussis, JSON conforme | 10/10            | 10/10                                                      |
| Hébergeur qui répond          | Cohere           | Inceptron (le seul proposé en UE pour ce modèle)           |
| Premier fragment p50 / p95    | 293 / 1 027 ms   | 324 / 629 ms                                               |
| Durée totale p50 / p95        | 2 315 / 4 792 ms | 1 572 / 2 472 ms                                           |
| Jev (API decisions)           | 200              | **404** (« aucun hébergeur dans votre région de données ») |

À savoir avant d'activer l'UE : (1) un seul hébergeur, donc pas de second recours si Inceptron tombe ; l'ordre
d'hébergeurs configuré n'y joue aucun rôle ; (2) Jev, le juge d'évaluation et le suivi de crédit doivent rester
sur `OPENROUTER_BASE_URL` (mondial) ; (3) l'échantillon est petit (10 appels, un seul moment) et ne couvre pas le
chemin à outils ni la charge ; (4) le secours n'est pas le flux principal : la région du modèle principal et des
autres fournisseurs reste à vérifier pour toute conclusion sur la résidence des données ; (5) si l'UE échoue, rien
ne bascule sur le mondial : choisir cette politique (continuité ou résidence) avant d'activer.

Qualité des candidats en UE (même jour, bench de comportements : 15 cas clés × 12 tirages, 1 passage, prompt
actuel, sortie brute ; `VBE_PROVIDER=openrouter`, voir `testing.md`). Ce prompt est réglé pour qwen/Cerebras :

|                                                  | Cerebras (réf.) | gemini-2.5-flash-lite | mistral-small-2603 | deepseek-v4-flash (secours actuel) |
| ------------------------------------------------ | --------------- | --------------------- | ------------------ | ---------------------------------- |
| Moyenne des contrôles, brut                      | 71,4 %          | 63,6 %                | 68,0 %             | **82,5 %**                         |
| Après garde-fous du code                         | 93,4 %          | 74,1 %                | 89,0 %             | 93,4 %                             |
| Contrôles sous seuil, brut / garde-fous (sur 19) | 5 / 1           | 7 / 5                 | 6 / 2              | 5 / 3                              |
| Jour fermé : ne demande pas l'heure (2 cas)      | 92 à 100 %      | **0 %**               | **0 %**            | 100 %                              |
| N'annonce pas « c'est possible » avant le nombre | 100 %           | **8 %**               | 100 %              | 67 %                               |
| Latence totale p50 en UE (mesure ci-dessus)      | —               | 653 ms                | 1 074 ms           | 1 572 ms                           |

Lecture : le plus rapide (Gemini) est le moins fiable sur ces cas ; Mistral demande l'heure un jour fermé comme
Gemini ; DeepSeek reste le meilleur des candidats malgré une latence plus haute et un hébergeur unique. Aucun
n'est un remplaçant évident. Limites : un passage de 12 tirages par cas, bench sans la vérification de
compréhension, prompt non réglé pour ces modèles.

Rejouer : `scp apps/api/scripts/openrouter-region-test.mjs deploy@suppernote:/tmp/ && ssh deploy@suppernote 'node
--env-file=/opt/suppernote/apps/api/.env /tmp/openrouter-region-test.mjs --runs 10; rm /tmp/openrouter-region-test.mjs'`
(le staging n'a pas de clé OpenRouter). Quelques centimes d'OpenRouter, aucun crédit Cerebras.

## Ajouter un appel fournisseur

1. Utiliser `fetchWithTimeout` (ou `withTimeout` pour un SDK sans annulation) — jamais `fetch` nu.
2. Choisir la borne : `VOICE_PROVIDER_TIMEOUT_MS` (8 s) sur le chemin vocal,
   `DEFAULT_PROVIDER_TIMEOUT_MS` (10 s) ailleurs.
3. Si l'appel peut être rejoué sans effet de bord, passer par `retry` avec `attempts` ≤ 3.
4. Si le fournisseur est sur le chemin critique et peut rester indisponible, l'envelopper dans un
   `CircuitBreaker` (3 échecs / 30 s par défaut).
5. Écrire la dégradation : que voit le client, que voit l'opérateur, quelle alerte se déclenche.
6. Ajouter la ligne au tableau ci-dessus.

## Diagnostic

```zsh
# Timeouts et ouvertures de circuit côté worker
pm2 logs suppernote-workers --lines 200 | grep -Ei 'circuit-breaker|ProviderTimeoutError'

# Timeouts côté API (voice, Connect)
pm2 logs suppernote-api --lines 200 | grep -Ei 'timeout|circuit'
```

Un circuit ouvert se referme tout seul : une seule sonde est autorisée après le cooldown, et un
succès referme le circuit. Si un circuit reste ouvert en boucle, le fournisseur est réellement
indisponible — vérifier son statut avant de toucher au code.
