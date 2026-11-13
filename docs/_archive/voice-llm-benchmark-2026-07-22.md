# Benchmark LLM voix — 22 juillet 2026

## Conclusion

`google/gemini-3.5-flash-lite` est le meilleur challenger mesuré pour le pipeline vocal
Suppernote. Il égale Mistral sur l'exactitude des appels d'outils et réduit surtout la latence de
queue (p95). Il ne doit toutefois être activé qu'en canary : l'échantillon reste petit et son
coût observé par scénario est environ 4,3 fois supérieur à celui de Mistral.

## Protocole

- Contrôle : `mistralai/mistral-small-3.2-24b-instruct`, fournisseur Mistral fixé, sans fallback.
- Challengers sortis dans les six derniers mois : Gemini 3.5 Flash-Lite, Gemini 3.1 Flash Lite,
  GPT-5.6 Luna, DeepSeek V4 Flash et Qwen3.6 Flash.
- Six scénarios fictifs : création, disponibilité, annulation, retard, groupe de neuf personnes
  et carte cadeau.
- Trois répétitions par scénario et par modèle, soit 108 scénarios évalués.
- Données et outils assainis : aucun prompt, paramètre restaurant ou client Suppernote n'a été envoyé.
- Raisonnement minimal, température 0,2, streaming, limite de 150 tokens.
- Validation stricte du nom de l'outil, du JSON, des types et de chaque valeur métier.
- Après un appel valide, résultat d'outil simulé puis second passage LLM afin de mesurer la
  première phrase réellement prononçable. Aucune écriture en base ni appel téléphonique.

## Résultats

| Modèle                | Exactitude | Décision p50 | Décision p95 | Phrase p50 | Phrase p95 | Coût/scénario |
| --------------------- | ---------: | -----------: | -----------: | ---------: | ---------: | ------------: |
| Gemini 3.5 Flash-Lite |      18/18 |       538 ms |     1 038 ms |   1 017 ms |   1 615 ms |     $0.000622 |
| Mistral Small 3.2     |      18/18 |       586 ms |     1 612 ms |   1 126 ms |   3 787 ms |     $0.000144 |
| Gemini 3.1 Flash Lite |      18/18 |       649 ms |     1 623 ms |   1 257 ms |   2 169 ms |     $0.000487 |
| GPT-5.6 Luna          |      18/18 |       954 ms |     1 213 ms |   2 044 ms |   2 618 ms |     $0.001533 |
| Qwen3.6 Flash         |      16/18 |     2 446 ms |     5 847 ms |   4 102 ms |   7 783 ms |     $0.000986 |
| DeepSeek V4 Flash     |      12/18 |     2 928 ms |     4 860 ms |   5 256 ms |  10 814 ms |     $0.000169 |

DeepSeek choisit parfois `checkAvailability` au lieu de `createReservation` et produit plusieurs
arguments JSON tronqués avec la limite vocale de 150 tokens. Qwen émet deux transferts sur deux
des trois essais de groupe et présente une forte variance de latence.

## Décision proposée

1. Conserver Mistral comme défaut et contrôle.
2. Tester Gemini 3.5 Flash-Lite sur un restaurant de test ou une faible fraction d'appels.
3. Comparer sur de vrais appels : succès métier, transfert humain, correction de dates, p95 du
   premier audio Cartesia et coût par appel complet.
4. Ne généraliser que si Gemini conserve au moins le taux de succès Mistral et réduit le p95
   audio sans régression sur les scénarios bruités ou multi-tours.

Le runner reproductible est `apps/api/scripts/benchmark-voice-llms.ts`. Ce panel initial se relance
avec `BENCHMARK_PANEL=premium`; le panel économique est désormais le défaut. Les résultats bruts
de ce passage sont dans `/tmp/sokar-voice-llm-benchmark-2026-07-22.json`.
