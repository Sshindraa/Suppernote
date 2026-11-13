# Décision de fin de parole : latence, attentes réglables, essai Deepgram Flux (20/10/2026)

Étude en lecture seule. **Aucun réglage changé, ni en production ni en staging.** Aucune donnée personnelle
ci-dessous : des comptes et des durées. L'audio et les transcriptions du rejeu sont restés hors du dépôt.

## Données

- **Enregistrements** : les 61 appels enregistrés de Chez Suppernote (22/09 → 20/10, appels de test, 50,7 min de piste
  appelant). Détection de voix par énergie sur chaque piste (trames de 20 ms), écho de Léa écarté (trame plus faible
  de 6 dB que la piste agent au même instant). 283 tours où Léa répond après une prise de parole de l'appelant.
  Repère commun : `E`, fin de la dernière voix de l'appelant avant que Léa parle ; `A`, début de la voix de Léa.
  Télémétrie des tours (`voice_turn_telemetry`) rattachée par l'heure : 221 tours, décalage médian 30 ms.
- **Journaux** : `/var/log/sokar/api-out.log*` ne gardent que 14, 16, 19 et 20/10 : 52 tours avec la cause de la
  finalisation, le juge et le désaccord.
- **Rejeu** : les 61 pistes appelant renvoyées au rythme réel, en parallèle, à Nova-3 et à Flux
  (`flux-general-multi`), avec les paramètres de socket de la production, sans keyterms, trames A-law de 20 ms,
  hôte UE. Coût Deepgram ≈ 0,64 $. Aucune requête Cerebras ni OpenRouter.

Outils (dans `apps/api/scripts/voice-stt-bench/`) : `call-eot-replay.ts` (rejeu), `eot_pauses.py` (pauses
et repères `E`/`A`), `eot_evaluate.py` (comparaison), `flux-probe.ts` (sonde des finals manquants du banc).

## 1. Toutes les attentes entre la fin de parole et la voix

Valeurs de production (Chez Suppernote) ; « défaut » = variable absente du `.env`.

| Attente                                  | Réglage                                                                 | Valeur prod                      | Rôle                                      |
| ---------------------------------------- | ----------------------------------------------------------------------- | -------------------------------- | ----------------------------------------- |
| Fin de segment Deepgram (`speech_final`) | `VOICE_DEEPGRAM_ENDPOINTING_MS`                                         | 200 (défaut)                     | silence après le dernier mot              |
| `UtteranceEnd`                           | `VOICE_DEEPGRAM_UTTERANCE_END_MS`                                       | 1 000 (défaut, minimum Deepgram) | dernier recours de Deepgram               |
| Partielle figée → `Finalize`             | `VOICE_DEEPGRAM_STALL_FINALIZE_MS` / `_SHORT_STALL_` (≤ 2 mots)         | 1 200 (défaut) / **500**         | Deepgram ne clôt pas                      |
| Garde de silence avant tout `Finalize`   | `VOICE_STT_SILENCE_GUARD_MS` (plafond `_MAX_DEFER_MS`)                  | 350 (1 500)                      | ne pas finaliser pendant la parole        |
| Anticipation du tour                     | `VOICE_STRUCTURED_SPECULATION_PAUSE_MS`                                 | 150 (défaut)                     | lance le modèle à la pause                |
| Fin sémantique → `Finalize`              | `VOICE_STRUCTURED_SEMANTIC_FINALIZE_ENABLED`                            | actif                            | verdict du modèle/juge sur la partielle   |
| Épellation                               | `VOICE_DEEPGRAM_SPELLING_SILENCE_MS` − endpointing ; garde `_SPELLING_` | 800 − 200 = 600 ; garde 1 200    | pauses entre groupes de lettres           |
| Phrase inachevée (liste, dialogue V2)    | `DIALOGUE_V2_INCOMPLETE_HOLD_MS` (code)                                 | 900                              | « euh », « et », fin suspendue            |
| Juge de fin de tour                      | `VOICE_TURN_JUDGE_TIMEOUT_MS`                                           | 800 (défaut)                     | verdict séparé, en parallèle              |
| Désaccord juge/modèle                    | `VOICE_TURN_JUDGE_DISAGREEMENT_SILENCE_MS`                              | **800**                          | silence réel de l'appelant                |
| Tour jugé inachevé                       | `VOICE_INCOMPLETE_TURN_SILENCE_MS`                                      | 2 000 (défaut, depuis le final)  | répondre quand même si l'appelant se tait |

## 2. Mesures

### Où passe le temps

| Période         | Tours | Silence perçu `A − E` p50 / p90 | Fin de parole → final p50 / p90 | Fin de parole → 1er son p50 / p90 | Part du final |
| --------------- | ----- | ------------------------------- | ------------------------------- | --------------------------------- | ------------- |
| 22/09 → 20/10   | 283   | 1 440 / 2 976 ms                | 570 / 1 480 ms                  | 1 324 / 2 974 ms                  | 50 %          |
| depuis le 14/10 | 43    | 1 720 / 3 764 ms                | 480 / 916 ms                    | 1 623 / 3 388 ms                  | **28 %**      |

Avec le pipeline actuel, la transcription finale arrive ~0,5 s après la fin de parole ; le reste (≈ 0,9 à 1,2 s en
médiane) se passe **après** le final : modèle, juge, garde-fous, TTS. Mais une partie de la _décision_ de fin de
tour est aussi là : le juge, l'attente de désaccord et l'attente du tour inachevé (ci-dessous).

### Causes de finalisation (journaux, 52 tours)

| Cause                                                                                             | Tours | Fin de parole → final p50 / p90 |
| ------------------------------------------------------------------------------------------------- | ----- | ------------------------------- |
| `speech_final` (22 seul, 7 après un `Finalize` partielle figée, 6 après un `Finalize` sémantique) | 35    | 470 / 1 316 ms                  |
| `stalled_finalize`                                                                                | 4     | 590 / 743 ms                    |
| `spelling_hold`                                                                                   | 8     | 470 / 530 ms                    |
| `semantic_hold` (phrase inachevée)                                                                | 3     | 970 / 1 594 ms                  |
| `utterance_end`                                                                                   | 2     | 2 315 / 3 231 ms                |

`Finalize` sémantique : silence de l'appelant à l'envoi 360 à 1 396 ms (9 envois). Les deux cas lents (956 et
1 396 ms, appel du 20/10 à 14 h 43) viennent de l'attente du verdict (anticipation + juge chez GPT-6 Luna), pas de la
garde de silence. Partielle figée : 359 à 1 368 ms.

### Juge, désaccord, tour inachevé

- Désaccord (juge « inachevé », modèle « fini ») : 9 tours. 8 partis au silence de 800 ms (voix 0,16 à 0,85 s après
  le final), 1 retenu à raison (l'appelant a repris). Dans 1 des 8, l'appelant a reparlé ~0,5 s après le début de
  la voix de Léa.
- Tour retenu comme inachevé (`turnComplete=false`) : 13 tours sur 52 (25 %). 7 fois l'appelant a repris (nouvelle
  parole 0,1 à 3,2 s après le final, environ 2 s en médiane) ; 6 fois il s'est tu et Léa a parlé **2,2 à 2,7 s après
  le final**. C'est la plus grosse attente unitaire mesurée.

### Pauses de l'appelant à l'intérieur d'un tour (enregistrements)

356 pauses dans 283 tours : p50 280 ms, p90 910 ms. Tours contenant au moins une pause de :

| Pause ≥ | 300 ms | 500 ms | 800 ms | 1 000 ms | 1 200 ms | 1 500 ms |
| ------- | ------ | ------ | ------ | -------- | -------- | -------- |
| Tours   | 33 %   | 21 %   | 13 %   | 10 %     | 7 %      | 4 %      |

Une règle de silence seule à 500 ms couperait un tour sur cinq : les attentes courtes ne tiennent que parce qu'une
décision sémantique (modèle, juge, Deepgram) les accompagne.

## 3. Ce qu'on peut raccourcir, ce qu'il faut garder

| Attente                         | Verdict               | Pourquoi                                                                                                                                                                                 |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpointing 200 ms              | garder                | déjà au plus bas utile ; le rejeu du 29/09 (100 à 500 ms) ne changeait pas la fin de segment.                                                                                            |
| Garde de silence 350 ms         | garder                | appel 5cebe456 : 11 fins forcées sur 17 tombaient pendant la parole sans elle ; p50 des pauses internes = 280 ms.                                                                        |
| Partielle figée 1 200 ms        | garder pour l'instant | ne décide que 4 à 8 tours sur 52 ; 13 % des tours ont une pause ≥ 800 ms. Gain ≤ 0,4 s sur ~10 % des tours, risque de final prématuré.                                                   |
| Désaccord 800 ms                | garder                | déjà abaissé (défaut 1 200) ; 1 coupure possible sur 8 départs au silence.                                                                                                               |
| Tour inachevé 2 000 ms          | garder                | les reprises réelles arrivent vers 1 à 3,2 s (médiane ~2 s, et 14 reprises mesurées au 29/09 : 1,0 à 4,4 s). À 1 500 ms, 3 des 7 reprises du 14 au 20/10 auraient été couvertes par Léa. |
| Épellation 600 ms + garde 1 200 | garder                | appels 8043662c et 3ba7c66f : lettres perdues avec moins.                                                                                                                                |
| Phrase inachevée 900 ms         | à mesurer             | 3 tours seulement ; réglage du code, pas de variable.                                                                                                                                    |
| `UtteranceEnd` 1 000 ms         | rien à faire          | minimum Deepgram ; 2 tours sur 52.                                                                                                                                                       |

Le seul gros levier restant n'est pas une durée : c'est **la justesse du verdict « inachevé »** (6 attentes de 2,2 à
2,7 s pour rien sur 52 tours). Le raccourcir à l'aveugle couperait la parole.

## 4. Deepgram Flux

### Les « 9/31 finals manquants » du banc du 25/09

Sonde `flux-probe.ts` sur les clips du banc : pour « On sera six » et « On sera douze » (1,3 s de voix synthétique
`say`), Flux ne reconnaît **aucun mot**, n'ouvre jamais de tour (`StartOfTurn` absent) ; le `ForceEndTurn` du banc
n'a rien à clore (`Warning`). Ce n'est pas un défaut de protocole. Le banc envoyait aussi l'audio sans silence
d'amorce : sur « mon numéro c'est 06… », Flux rend 2 mots sans amorce, 11 avec 1 s d'amorce. Les finals manquants
du banc mêlent donc un artefact (début de flux) et une vraie faiblesse : **les énoncés courts**.

### Rejeu des vraies pistes (283 tours, mêmes audios)

| Mesure (repère `E` = fin de voix mesurée)               | Nova-3 (brut, sans nos `Finalize`) | Flux                         |
| ------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| Fin de tour après `E`, p25 / p50 / p75 / p90            | 480 / 560 / 780 / 1 276 ms         | 300 / **380** / 500 / 660 ms |
| `EagerEndOfTurn` après `E`, p50 / p90                   | —                                  | 340 / 580 ms                 |
| Écart apparié Nova − Flux (212 tours), p25 / p50 / p75  | 40 / **180** / 425 ms              |                              |
| Tours avec une fin de tour avant que l'appelant reparle | 39                                 | 37                           |
| Tours transcrits par ce modèle seulement (fenêtre +3 s) | 20                                 | 11                           |
| … dont épellations                                      | 5 sur 39                           | 2                            |

- **Gain** : ~180 ms en médiane sur la fin de tour brute, surtout dans la queue (p90 1 276 → 660 ms). En production,
  nos `Finalize` (partielle figée, sémantique) rattrapent déjà une partie de cette queue : le gain réel attendu est
  plutôt de 100 à 200 ms en médiane.
- **Coupures** : autant de fins prématurées que Nova-3 (37 contre 39 tours) ; Flux n'est pas plus agressif avec
  `eot_threshold=0.7`.
- **Justesse** : sur les 20 tours que seul Nova-3 transcrit, Flux ne produit **aucune partielle** dans 17 et ne
  rattrape jamais les mots dans 14 : 5 épellations (lettres isolées), des réponses d'un ou deux mots (« oui »,
  « bonjour », « pas du tout ») et 5 premières phrases d'appel. Les 11 tours inverses sont surtout des réponses où
  Nova-3 arrive plus tard (hors fenêtre), pas des pertes. Une épellation ou un « oui » perdus font répéter
  l'appelant : c'est pire pour l'effet humain que 180 ms.

Limites : piste MP3 de l'enregistrement (pas l'audio Telnyx brut ni débruité par Krisp), écho de Léa présent comme en
production, test sans keyterms, appels de test de quelques voix seulement.

### Staging

Pas d'essai : le staging n'a ni le tour structuré, ni le juge, ni l'anticipation, ni Krisp (pipeline différent de la
production), et un essai demanderait un vrai appel. Le rejeu ci-dessus mesure la même chose sur 283 tours au lieu
d'une poignée. Procédure si un essai est décidé plus tard :

1. Vérifier zéro session active : `curl -s localhost:4100/health` et les métriques de sessions de `sokar-staging-api`.
2. `cp /opt/sokar-staging/apps/api/.env /opt/sokar-staging/apps/api/.env.bak-$(date +%Y%m%d%H%M)`.
3. Aligner le staging sur la production pour le restaurant de test (tour structuré, anticipation, finalisation
   sémantique, juge, désaccord 800, partielle courte 500), puis `VOICE_DEEPGRAM_MODEL=flux-general-multi` et
   `VOICE_DEEPGRAM_MODEL_RESTAURANT_IDS=<restaurant de test staging>`.
4. `pm2 reload sokar-staging-api --update-env` à zéro session ; appel de Hamza vers le numéro staging : un « oui »
   seul, une épellation, une phrase avec une pause au milieu.
5. Lire `[voice-turn] stt_final` (`finalTrigger`, `endOfSpeechToSttFinalMs`), puis restaurer la sauvegarde.

## 5. Recommandation

1. **Ne pas passer à Flux** : ~180 ms de gain médian ne valent pas la perte d'épellations et de réponses courtes.
   Garder `VOICE_DEEPGRAM_MODEL_RESTAURANT_IDS` vide. À refaire avec `call-eot-replay.ts` si Deepgram annonce un
   progrès sur les énoncés courts (coût ~0,65 $ pour les 61 pistes).
2. **Aucune attente à raccourcir** en l'état : chacune a une coupure mesurée derrière elle, et la décision STT ne
   pèse que ~0,5 s sur ~1,6 s depuis le 14/10.
3. **Piste suivante (à décider)** : le verdict « inachevé » (25 % des tours, 6 attentes de 2,2 à 2,7 s pour rien sur
   52). Mesurer sur les prochains appels, par tour retenu, si l'appelant reprend, puis améliorer le verdict plutôt
   que la durée. `EagerEndOfTurn` de Flux (p50 340 ms) reste une idée pour déclencher l'anticipation, seulement si
   la reconnaissance des énoncés courts progresse.
