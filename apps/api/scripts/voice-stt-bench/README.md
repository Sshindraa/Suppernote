# Banc STT vocal

Mesure ce que la réservation vocale retient réellement d'une réponse d'appelant :
synthèse Cartesia → dégradation téléphonique → transcription STT → dialogue réel
(`recordUserTurn`). Scribe est conservé comme référence historique hors runtime ; le
parcours actuel utilise Deepgram Nova-3 avec Cartesia Ink-2 en parallèle ou en secours.

Depuis le 22/10/2026, réponses attendues et confirmation par la confiance sont actives pour tous les
restaurants, sans réglage : les colonnes « coupé » et « actif » du rapport sont identiques. Les chiffres
coupé/actif cités plus bas datent d'avant.

## Jeux de phrases

| Jeu           | Graine   | Voix                                    | Rôle                                                                                                                                             |
| ------------- | -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `calibration` | 20260924 | Henri, Josette, Fabien, Léonie          | régler `EXPECTED_ANSWER_THRESHOLDS` ; transcriptions du 24/09 réutilisées                                                                        |
| `validation`  | 20261001 | + Étienne, Inès (jamais en calibration) | seuls chiffres rapportés ; 304 phrases dont 60 hors sujet et les paires pièges six/dix, deux/douze, trois/treize, seize/six, 20 h/22 h, 8 h/20 h |

Jeux « difficiles » (phase 2) : `hard-calibration` (graine 20261101, voix de
calibration) et `hard-validation` (graine 20261115, + Mathis et Jade réservées),
344 phrases chacun dont 70 demandes à plusieurs valeurs (heure donnée en premier),
bruit 5–10 dB, 3–5 % de paquets perdus, une phrase sur deux au débit rapide. Les
transcriptions gardent les mots Scribe avec `logprob` et les partielles ; les seuils
de `SLOT_CONFIDENCE_THRESHOLDS` se règlent sur `hard-calibration` uniquement.

## Usage

```bash
cd apps/api
# 1. Phrases (local, gratuit)
pnpm exec tsx scripts/voice-stt-bench/phrases.ts validation > scripts/voice-stt-bench/.data/validation-phrases.json

# 2. Transcription (sur le serveur, consomme des crédits Cartesia et Scribe : demander l'accord)
node --env-file=.env scripts/voice-stt-bench/transcribe.cjs validation-phrases.json > validation-transcripts.json

# 3. Évaluation (local, gratuit) : tableau flag coupé / actif, IC de Wilson à 95 %
BENCH_VERBOSE=1 pnpm exec tsx scripts/voice-stt-bench/evaluate.ts \
  scripts/voice-stt-bench/.data/validation-phrases.json scripts/voice-stt-bench/.data/validation-transcripts.json
```

Tout ce que produisent les étapes 1 et 2 va dans `.data/`, ignoré par git. Seul un
résumé chiffré est commité (journal, description de PR).

## Limites

- Voix de synthèse, plus propres que de vrais appelants (accent, débit, bruit réel,
  micro de mauvaise qualité). Le banc **compare des variantes** ; il n'annonce pas le
  taux de réussite en production.
- La dégradation (bruit blanc, pertes de paquets de 20 ms, codec A-law) approxime un
  appel ; elle ne reproduit ni l'écho ni les coupures longues.
- Une seule réponse par phrase, sans le contexte d'un vrai dialogue (pas de relance).
- Au-delà de 7 personnes, la réservation vocale ne retient pas le nombre : ces phrases
  sont mesurées à part (`groupe > 7`).

## Garde-fous fournisseur

Les bancs Deepgram/Cartesia utilisent en priorité `DEEPGRAM_BENCH_API_KEY` et
`CARTESIA_BENCH_API_KEY`, puis les clés runtime `DEEPGRAM_API_KEY` et `CARTESIA_API_KEY`
si les clés de banc sont absentes ou vides. Une clé identique au runtime est acceptée. Cartesia exige
`BENCH_MAX_CREDITS`; les bancs Deepgram plafonnent l'audio via `BENCH_DG_MAX_AUDIO_SECONDS`.
Au-delà de huit sessions, `BENCH_CONFIRM=1` est aussi requis. Les scripts historiques Scribe
utilisent encore la clé ElevenLabs partagée prod/dev/staging : ne pas les lancer pour une
qualification fournisseur. La synthèse et la transcription consomment des crédits ;
`evaluate.ts` reste hors ligne. Toute dépense doit rester dans le budget choisi avant le run.

## Deuxième transcription (expérience, hors production)

Question : quand Scribe batch (B) n'est pas d'accord avec Scribe Realtime (A) sur
une valeur, cette valeur est-elle fausse ? Le désaccord détecte-t-il mieux les
erreurs que la confiance ?

```bash
# Sur le serveur (crédits Cartesia + Scribe Realtime + Scribe batch : demander l'accord).
# L'audio dégradé est écrit une fois dans audio-dir puis relu pour les deux moteurs.
node --env-file=.env scripts/voice-stt-bench/second-opinion.cjs \
  scripts/voice-stt-bench/.data/hard-validation-phrases.json \
  scripts/voice-stt-bench/.data/audio/hard-validation > hard-validation-second-opinion.json

# En local (gratuit) : précision A / B, accord, rappel et fausses alertes du
# désaccord, confiance à fausses alertes égales, délai p50 / p95 du batch.
pnpm exec tsx scripts/voice-stt-bench/second-opinion-eval.ts \
  .data/hard-validation-phrases.json .data/hard-validation-second-opinion.json
```

B : `POST /v1/speech-to-text`, `model_id=scribe_v2` (`BENCH_BATCH_MODEL` pour
changer), `language_code=fr`, mêmes `keyterms` que la production
(`buildSttKeyterms('Chez Suppernote')`, +20 % sur le prix du batch), WAV PCM 8 kHz.
L'audio reste sur le serveur, jamais commité.

## Banc narrowband — ce que coûte G.711 (phase 1)

Mesure ce que la chaîne téléphonique narrowband coûte en précision de
transcription, **sans toucher à la prod**. Six conditions sur **exactement
les mêmes clips et les mêmes seeds** :

| Condition | Chaîne audio                                              | Scribe      | Chunks |
| --------- | --------------------------------------------------------- | ----------- | ------ |
| `A`       | 16 kHz PCM16 natif                                        | `pcm_16000` | 20 ms  |
| `B`       | 300–3400 Hz → 8 kHz → A-law → PCM16 8 kHz (prod actuelle) | `pcm_8000`  | 20 ms  |
| `C`       | comme `B` puis upsample 16 kHz                            | `pcm_16000` | 20 ms  |
| `D`       | comme `B`                                                 | `pcm_8000`  | 100 ms |
| `E`       | comme `B`, langue forcée `fr`                             | `pcm_8000`  | 20 ms  |
| `F`       | comme `B`, `filter_background_audio=true`                 | `pcm_8000`  | 20 ms  |

Tous les paramètres Scribe (langues, `keyterms`, VAD, `commit_strategy`) sont
lus depuis `scribe-url.cjs` (l'URL de production de Scribe avant son retrait, conservée ici pour que le banc continue de mesurer Scribe comme référence) : seuls `audio_format` et la
taille de chunk changent, sauf E (langue) et F (filtre), dont le nom décrit
l'unique réglage de modèle modifié. ElevenLabs interdit de combiner le filtre
avec `include_timestamps`; F omet donc ce paramètre explicite tout en gardant
`include_language_detection=true`. L'URL du chemin par défaut reste inchangée.

### Corpus

`nb-corpus.ts` : 31 phrases FR de réservation à informations critiques
normalisées (couverts, pièges six/dix et deux/douze, heures `vingt heures
trente` et `19h45`, dates, noms propres dont deux épellations, téléphones
**fictifs** 06 39 98 xx xx). Une variante propre et une variante bruitée
(souffle + ronflement + bouffées, seeds fixes à 15/10/7 dB) ; 3 répétitions par
condition et par variante.

### Usage

```bash
cd apps/api

# ELEVENLABS_API_KEY doit déjà être présent dans apps/api/.env (clé unique).
pnpm --filter api build

# F réduit : 8 phrases, propre/bruit, plus 3 contrôles bruit-seul B/F
# (54 sessions au total). Les seeds et masques de pertes sont appariés à B.
BENCH_TTS_PROVIDER=say BENCH_CONDITIONS=F BENCH_VARIANTS=clean,noisy \
BENCH_LIMIT=8 BENCH_CONCURRENCY=4 \
node --env-file=.env --import tsx scripts/voice-stt-bench/nb-run.ts \
  > scripts/voice-stt-bench/.data/nb-results-F-reduced.json

# F complet : 31 phrases, plus 3 contrôles bruit-seul pour B et F
# (192 sessions au total). L'estimation utilise le tarif API public en USD.
BENCH_TTS_PROVIDER=say BENCH_CONDITIONS=F BENCH_VARIANTS=clean,noisy \
BENCH_LIMIT=31 BENCH_CONFIRM=1 BENCH_CONCURRENCY=4 \
node --env-file=.env --import tsx scripts/voice-stt-bench/nb-run.ts \
  > scripts/voice-stt-bench/.data/nb-results-F.json

# Scoring F et faux déclenchements B/F sur bruit seul.
pnpm exec tsx scripts/voice-stt-bench/nb-score.ts \
  scripts/voice-stt-bench/.data/nb-results.json \
  scripts/voice-stt-bench/.data/nb-results-F.json

# Run historique A-D réduit : 2 clips, 4 conditions.
BENCH_LIMIT=2 BENCH_CONCURRENCY=4 \
node --env-file=.env --import tsx scripts/voice-stt-bench/nb-run.ts \
  > scripts/voice-stt-bench/.data/nb-results-reduced.json

# Run complet : 31 clips, 744 sessions (~43 min d'audio). BENCH_CONFIRM=1 obligatoire.
BENCH_CONFIRM=1 node --env-file=.env --import tsx scripts/voice-stt-bench/nb-run.ts \
  > scripts/voice-stt-bench/.data/nb-results.json

# Scoring local (gratuit) : critiques par catégorie, WER, latence, messages.
pnpm exec tsx scripts/voice-stt-bench/nb-score.ts scripts/voice-stt-bench/.data/nb-results.json

# Condition E seulement : B avec language_code=fr, TTS local say (186 sessions).
BENCH_TTS_PROVIDER=say BENCH_CONDITIONS=E BENCH_VARIANTS=clean,noisy \
  BENCH_LIMIT=31 BENCH_CONFIRM=1 BENCH_CONCURRENCY=4 \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-run.ts \
  > scripts/voice-stt-bench/.data/nb-results-E.json

# Rescore hors ligne des slots récupérables après verrou FR, sans transcript en sortie.
pnpm exec tsx scripts/voice-stt-bench/nb-language-rescore.ts \
  scripts/voice-stt-bench/.data/nb-results.json \
  scripts/voice-stt-bench/.data/nb-results-E.json
```

Leviers : `BENCH_LIMIT`, `BENCH_CONCURRENCY`, `BENCH_CONDITIONS=A,B`,
`BENCH_VARIANTS=clean,noisy`, `BENCH_STT_MODEL`, `BENCH_TTS_PROVIDER`.

Le script affiche avant tout appel les sessions, secondes d'audio, coût Scribe
indicatif en USD et caractères TTS. L'estimation utilise le tarif public de
[Scribe Realtime ($0.39/heure)](https://elevenlabs.io/pricing/api), majoré de
20 % pour les keyterms selon la [référence Realtime](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime) ;
le montant réellement facturé dépend du forfait. `say` est local et ne facture
pas de TTS. `BENCH_CONFIRM=1` est obligatoire au-delà de 8 clips.

### Sources audio

`BENCH_TTS_PROVIDER` = `cartesia` (défaut, 16 kHz) ou `elevenlabs`
(`pcm_16000`), ou `say` (voix macOS, hors ligne, plusieurs voix FR). L'audio
16 kHz est mis en cache dans `.data/audio16/` : les quatre conditions relisent
le même signal.

### Comparatif Deepgram Nova-3 (C2)

Les trois réglages sont scorés sur les mêmes 31 clips propres et bruités (seed 0), condition
B, A-law 8 kHz et keyterms de production. Le runner affiche durée et coût estimés avant le
premier envoi. Le plafond par défaut est 660 s ; `BENCH_CONFIRM=1` est obligatoire au-delà de
8 sessions. `DEEPGRAM_BENCH_API_KEY` est prioritaire, avec repli sur `DEEPGRAM_API_KEY`.

```bash
cd apps/api
BENCH_CONFIRM=1 BENCH_LIMIT=31 BENCH_CONCURRENCY=8 BENCH_DG_FORMAT=smart \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-deepgram.ts \
  > scripts/voice-stt-bench/.data/nb-deepgram-smart.json
BENCH_CONFIRM=1 BENCH_LIMIT=31 BENCH_CONCURRENCY=8 BENCH_DG_FORMAT=numerals \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-deepgram.ts \
  > scripts/voice-stt-bench/.data/nb-deepgram-numerals.json
BENCH_CONFIRM=1 BENCH_LIMIT=31 BENCH_CONCURRENCY=8 BENCH_DG_FORMAT=none \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-deepgram.ts \
  > scripts/voice-stt-bench/.data/nb-deepgram-none.json
pnpm exec tsx scripts/voice-stt-bench/nb-deepgram-score.ts \
  scripts/voice-stt-bench/.data/nb-deepgram-smart.json \
  scripts/voice-stt-bench/.data/nb-deepgram-numerals.json \
  scripts/voice-stt-bench/.data/nb-deepgram-none.json
```

### Phase A — Nova-3 versus Flux

Compare les deux modèles sur les mêmes 31 clips `say` (synthèse locale), condition B (A-law
8 kHz), les mêmes keyterms et le même bruit simulé : propre, puis bruit à seed fixe
`20260924` / 15 dB avec 2 % de pertes. Les phrases sont réparties en calibration (16) et
validation (15), stratifiées par catégorie et sans recouvrement. Les paramètres Nova suivent la
socket de production (`endpointing=300`, `utterance_end_ms=1000`) ; Flux utilise
`flux-general-multi`, `language_hint=fr`, `eot_timeout_ms=1000` et des chunks 80 ms. La latence
va de la fin des derniers octets de parole envoyés au final Nova (`speech_final`/`UtteranceEnd`)
ou au `EndOfTurn` Flux. Après 1,5 s de silence ajouté, le runner envoie `Finalize` à Nova ou
`ForceEndTurn` à Flux si aucun final naturel n'est arrivé, puis attend jusqu'à 5 s ; un final
obtenu après cette commande garde son horodatage réel. Dans le run du 25/09, 19/62 sessions Nova
ont nécessité `Finalize`, et 13/62 sessions Flux `ForceEndTurn`. Les IC 95 % sont bootstrapés
par phrase, et les sessions en erreur ou sans transcript restent des échecs de score. Les
transcriptions brutes restent uniquement dans `.data/`, ignoré par git ; le terminal n'affiche
que progression, coût et chemin du fichier.

```bash
cd apps/api

# Facultatif, gratuit : vérifie l'estimation avant l'envoi.
BENCH_DG_DRY_RUN=1 BENCH_LIMIT=31 \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-flux-bench.ts

# Run complet apparié (124 sessions, plafond fournisseur cumulé 660 s).
# DEEPGRAM_BENCH_API_KEY ou DEEPGRAM_API_KEY est requis; la synthèse audio say est locale.
BENCH_CONFIRM=1 BENCH_LIMIT=51 BENCH_CONCURRENCY=4 \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-flux-bench.ts

# Scoring hors ligne, sans texte de transcript.
pnpm exec tsx scripts/voice-stt-bench/nb-flux-score.ts \
  scripts/voice-stt-bench/.data/nb-flux-comparison.json
```

### Fin de tour sur de vraies pistes appelant (20/10)

Rejoue les pistes appelant des appels enregistrés (récupérées hors du dépôt par
`scripts/ops/voice_call_audio.py`) vers Nova-3 et Flux, au rythme réel et avec les paramètres de
socket de la production, puis compare la fin de tour à la fin de voix mesurée sur la piste.
L'audio et le JSON du rejeu (transcriptions) restent hors du dépôt. Coût : ~0,65 $ pour 51 min.

```zsh
cd apps/api
node --env-file=.env --import tsx scripts/voice-stt-bench/call-eot-replay.ts \
  --audio-dir "$TMPDIR/suppernote-call-audio" --out "$TMPDIR/eot-replay.json"
python3 -I scripts/voice-stt-bench/eot_pauses.py "$TMPDIR/suppernote-call-audio" "$TMPDIR/eot-turns.json"
python3 -I scripts/voice-stt-bench/eot_evaluate.py "$TMPDIR/eot-turns.json" "$TMPDIR/eot-replay.json" "$TMPDIR/eot-stats.json"
```

`flux-probe.ts` rejoue un clip du banc synthétique et journalise les événements Flux (sans texte).
Résultats : `docs/audits/2026-10-20-voice-end-of-turn-latency.md`.

### Phase A3 — réglages Nova-3 et PCMA contre L16

Le plan factoriel PCMA compare `numerals` vrai/faux, `punctuate` vrai/faux et
keyterms historiques/générés sur 51 phrases (31 historiques + 10 calibration
et 10 validation ciblées sur les termes business), propre et bruit seed
`20260924`. Les splits sont disjoints : 26 calibration, 25 validation. Le
contrôle L16 reprend les mêmes clips et la même variante bruitée à 16 kHz PCM16.
Les nouveaux clips manquants sont synthétisés localement avec `say`, en PCM16
16 kHz, sans coût TTS. Le profil peut venir d'une base locale (nom, adresse,
ville, cuisine) ou de variables explicites business-only (quartier et termes
menu inclus). Les transcripts sont conservés uniquement dans `.data/`; la
progression n'affiche aucun texte.

```bash
cd apps/api

# Export local read-only. Cette étape refuse tout DATABASE_URL non local.
BENCH_RESTAURANT_ID=<restaurant-id> \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-a3-profile.ts

# Alternative sans base : profil business-only explicite; valeurs jamais affichées.
BENCH_A3_PROFILE_SOURCE=env BENCH_A3_RESTAURANT_NAME='<nom public>' \
BENCH_A3_PUBLIC_ADDRESS='<adresse/quartier public>' BENCH_A3_CITY='<ville>' \
BENCH_A3_NEIGHBORHOOD='<quartier>' BENCH_A3_CUISINES='cuisine 1|cuisine 2' \
BENCH_A3_MENU_TERMS='plat 1|plat 2|terme maison' \
  node --import tsx scripts/voice-stt-bench/nb-a3-profile.ts

# Vérifier le nombre de sessions, la durée et le coût avant tout appel.
BENCH_A3_DRY_RUN=1 BENCH_LIMIT=2 \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-a3-bench.ts

# Run réduit; les 40 sessions nécessitent BENCH_CONFIRM=1.
BENCH_CONFIRM=1 BENCH_LIMIT=2 BENCH_CONCURRENCY=4 \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-a3-bench.ts

# Run complet apparié (1 020 sessions, plafond 7 200 s). DEEPGRAM_BENCH_API_KEY ou DEEPGRAM_API_KEY.
BENCH_CONFIRM=1 BENCH_LIMIT=51 BENCH_CONCURRENCY=4 \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-a3-bench.ts

# Scoring hors ligne; IC 95 % bootstrapés par phrase pour scores, WER et latences p50/p90.
pnpm exec tsx scripts/voice-stt-bench/nb-a3-score.ts \
  scripts/voice-stt-bench/.data/nb-a3-results.json
```

Le profil `nb-a3-keyterms.json` et le résultat sont ignorés par git. Le runner
refuse les runs de plus de huit sessions sans `BENCH_CONFIRM=1`, plafonne par
défaut à 7 200 secondes fournisseur et annonce l'estimation avant le premier
WebSocket. Le tarif estimé utilise le tarif PAYG affiché de Nova-3 streaming
($0.0048/min) et l'add-on keyterms ($0.0013/min); c'est indicatif, car le
fournisseur signale un impact tarifaire possible de `mip_opt_out=true` et le
compte réel peut différer.
Le profil synthétique A3 peut inclure les plats et termes maison fournis
explicitement pour le benchmark. En production, le schéma expose le nom,
l'adresse, la ville et la cuisine, mais aucun menu structuré ni personnel ; le
générateur ne lit donc pas de texte libre, de données client ou de personnel.

### Vérification hors ligne (sans crédit)

`nb-mock-scribe.ts` est un faux Scribe Realtime qui reconnaît les clips non
dégradés et renvoie un texte de repli pour les autres. Il valide la plomberie
(conditions, chunks, latence, messages, scoring) **sans consommer de crédit** ;
ce n'est pas une mesure.

```bash
# Valeur factice locale uniquement, jamais une clé fournisseur; rien ne part sur le réseau.
export ELEVENLABS_API_KEY=local-mock-key
node --import tsx scripts/voice-stt-bench/nb-mock-scribe.ts &
BENCH_TTS_PROVIDER=say BENCH_STT_URL=ws://127.0.0.1:8799 BENCH_LIMIT=2 \
  node --env-file=.env --import tsx scripts/voice-stt-bench/nb-run.ts \
  > scripts/voice-stt-bench/.data/nb-offline.json
pnpm exec tsx scripts/voice-stt-bench/nb-score.ts scripts/voice-stt-bench/.data/nb-offline.json
```

### Coût et garde-fous

Run complet A-D : 31 clips × 4 conditions × 6 sessions = **744 sessions**, ~2 600 s
d'audio streamé (~43 min) silence final compris. Au tarif observé du compte
gratuit ElevenLabs (~1 crédit/seconde), cela représente ~2 600 crédits, soit
environ un quart du quota mensuel de 10 000. Décision du 14/10/2026 : le banc utilise la clé ElevenLabs unique, partagée avec la
prod et le staging. Le 24/09, un run sur ce quota partagé l'a épuisé et a coupé la
transcription des appels réels : gardez le plafond et vérifiez le quota restant avant
un run complet.

Le run F complet envoie 186 sessions parlées et 6 contrôles bruit-seul B/F,
soit **192 sessions Scribe**. `say` est local et gratuit côté TTS. L'estimation
des secondes d'audio streamé, silence final inclus, est affichée avant le run.

### Relève `Finalize` sur les réponses courtes (21/10)

`finalize-probe.ts` rejoue les tours courts des enregistrements (`turns.json` d'`eot_pauses.py`) deux fois : sans
commande, puis avec `Finalize` à fin de voix + `--finalize-after-ms`. Mesure le délai de la réponse et compare les
textes (hors dépôt). Résultats : `docs/audits/2026-10-21-voice-short-answer-end-of-turn.md`.
