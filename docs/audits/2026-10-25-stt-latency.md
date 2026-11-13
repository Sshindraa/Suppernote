# Latence STT — essai exploratoire du 25 octobre 2026

À la demande de Hamza, les bancs Deepgram/Cartesia acceptent les clés runtime.
Une variable `*_BENCH_API_KEY` non vide reste prioritaire ; elle peut être identique
à la clé runtime. Les plafonds de consommation restent actifs.

## Protocole

- Origine : Mac local, sockets WebSocket préouvertes avant envoi de chaque clip.
- Corpus synthétique `say` existant : c01, c05, h01, h07, n02, t02, deux passages,
  soit 12 essais par moteur. Aucun audio de client réel.
- Même signal : filtre téléphonique, sous-échantillonnage 8 kHz, encodage A-law,
  trames de 20 ms à rythme réel. Silence final du cache tronqué à 20 ms après le
  dernier échantillon dépassant le seuil d’amplitude 250.
- Deepgram Nova-3 (`api.eu.deepgram.com`) : français, endpointing 200 ms, numerals, sans ponctuation ni
  keyterms. Fin mesurée à `speech_final` ; attente limitée à 3 s de silence.
- Cartesia Ink-2 : français, `finalize` manuel après 200 ms de silence ; fin mesurée
  à `flush_done`/`done` avec transcription non vide.
- La métrique inclut les 200 ms de silence côté Ink. Le temps de connexion est exclu.
- Budget préalable : au plus 59 s par fournisseur, silence inclus ; estimation
  Cartesia 177 crédits selon le coefficient du banc (3 crédits/s), plafond 900.

## Résultats

| Mesure                              | Deepgram Nova-3     | Cartesia Ink-2 |
| ----------------------------------- | ------------------- | -------------- |
| Résultat non vide avec fin observée | 8/12                | 10/12          |
| Médiane sur les 8 paires complètes  | 390 ms              | 354 ms         |
| Maximum sur ces mêmes paires        | 588 ms              | 401 ms         |
| Essais incomplets                   | 4 sans fin sous 3 s | 2 vides        |

Les deux passages de c05 sont vides chez les deux moteurs ; t02 n’a pas de
`speech_final` observé chez Deepgram. Les erreurs ne sont pas intégrées dans les
médianes. Certaines transcriptions non vides sont incorrectes, notamment les heures.

L’écart médian de 36 ms ne suffit pas à choisir un fournisseur : seulement quatre
phrases distinctes dans les huit paires complètes, audio synthétique propre,
origine réseau locale et deux mécanismes de clôture différents. Ce test mesure la
réponse STT ; il ne reproduit pas le VAD Suppernote, ses Finalize locaux, le dialogue,
le réseau du VPS ni la latence de réponse vocale complète. Pas de p95 représentatif
ni de mesure de précision sur ce petit échantillon.

Sonde et résultats bruts locaux (ignorés par Git) :
`apps/api/scripts/voice-stt-bench/.data/latency-20261025.ts` et
`latency-20261025-results.json`. Aucun changement déployé.
