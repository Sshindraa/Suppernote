# Continuité des consignes et comparaison prosodique

## Changement du 26 octobre 2026

Les règles de continuité et de récapitulatif proviennent de
`apps/api/src/modules/voice/conversation-rules.ts`. Elles sont injectées une seule fois dans
le prompt final, même quand le prompt du restaurant est composé avec le tour structuré.
Un jour proche reste relatif au récapitulatif ; une date éloignée ou ambiguë est précisée.
Les valeurs clairement données dans une question sont conservées, la question est traitée
avant de demander l'information suivante. Les garde-fous de disponibilité, d'épellation,
de récapitulatif entendu et de consentement restent dans le moteur existant.

## Banc ElevenLabs

`apps/api/scripts/voice-tts-bench/early-phrase.ts` compare le découpage actuel (`early`) à
une première phrase complète (`whole`), via le vrai `PhraseSplitter` et les messages WebSocket
partagés avec le runtime. Les deux variantes reçoivent le même texte au même rythme.
Le banc conserve les deux variantes pour comparaison ; le moteur de cette branche retient désormais les phrases complètes à la suite du choix utilisateur ci-dessous.

Depuis `apps/api`, avec les secrets chargés dans l'environnement :

```sh
pnpm exec tsx scripts/voice-tts-bench/early-phrase.ts --self-check
# ELEVENLABS_TTS_VOICE_ID doit être celui effectivement configuré pour l'appel.
RUNS=1 BENCH_MAX_CREDITS=1500 BENCH_MS_PER_CHAR=5.5,15 \
  pnpm exec tsx --env-file=.env scripts/voice-tts-bench/early-phrase.ts /chemin/vers/dossier-neuf
```

Le budget estimé est contrôlé avant toute connexion. Il suppose 0,5 crédit/caractère et ne
remplace pas la facturation fournisseur. Aucun secret n'est enregistré dans les sorties.
La voix est obligatoire, sans ancienne valeur de banc implicite ; modèle `eleven_v4_turbo`,
français, A-law 8 kHz, dictionnaire de prononciation de l'environnement si configuré.
Les WAV sont décodés en PCM16 pour l'écoute, sans normalisation ni retrait du silence.

Ouvrir `listen.html`, écouter les paires A/B et remplir `scores.csv` **avant** de consulter
`decode-and-metrics.json`. L'ordre des variantes est aléatoire par paire. Les métriques
conservent chaque essai : délai depuis le début du flux texte jusqu'au premier audio,
somme/nombre/maximum des trous de sous-alimentation, et calendrier des envois.
Le temps de connexion et les 300 ms de préparation de socket sont exclus des deux bras.

## Première génération exploratoire

Le 26 octobre : voix Lucie `YxrwjAKoUKULGd0g8K9Y`, identifiant relu dans la configuration
production ; clé locale, aucun appel téléphonique ni action métier. Sept textes (question,
vérification, deux phrases, explication, récapitulatif et épellation), deux débits,
un tirage par variante : **14 paires, 28 WAV, 880 crédits estimés**.
Artefacts locaux : `/Users/hamza/.codex/voice-prosody-2026-10-26/`.

| Arrivée du texte | Variante         | Médiane premier audio | Trous de sous-alimentation |
| ---------------- | ---------------- | --------------------- | -------------------------- |
| 5,5 ms/caractère | Virgule actuelle | 178 ms                | 0 ms                       |
| 5,5 ms/caractère | Phrase complète  | 412 ms                | 0 ms                       |
| 15 ms/caractère  | Virgule actuelle | 311 ms                | 0 ms                       |
| 15 ms/caractère  | Phrase complète  | 946 ms                | 0 ms                       |

Ces médianes portent sur sept textes différents par cellule, sans répétition ; ce ne sont
pas des estimations de latence téléphonique ni une preuve de préférence. Un trou dans la
livraison audio est distinct d'une pause que la voix synthétise à l'intérieur des chunks.
À l'issue de cette génération, aucune écoute humaine notée n'avait encore départagé les variantes.
Le banc simule deux débits réguliers ; il ne reproduit pas les à-coups du LLM, les fillers,
le tampon et l'acheminement Telnyx, ni les interruptions réelles.

## Recette avant extension

Qualifier d'abord #594 sur Chez Suppernote : refus de transfert, reprise de réservation et
consentement explicite ; oui d'écoute, correction d'heure, confirmation et épellation.
La préférence audio est recueillie ci-dessous ; qualifier maintenant la variante retenue au téléphone.
La cohérence des formulations doit aussi être vérifiée sur des échanges complets : question
pratique au milieu d'une réservation, valeur fournie dans une question, jour proche ou éloigné,
nom confirmé puis récapitulatif. Les tests de prompt vérifient le contrat, pas le naturel.

## Choix utilisateur du 26 octobre

Notes reçues : P1 B, P2 A, P3 B, P4 B, P5 A, P6 égalité, P7 A, P8 B, P9 A.
Décodage : **phrase complète 6, virgule 2, égalité 1**. P10–P14 non notées ;
l'utilisateur a choisi de poursuivre sans compléter ces paires. P8 et P9 reprennent les
textes P1 et P2 à un débit différent : neuf choix ne sont pas neuf textes indépendants.

Décision explicite : appliquer la phrase complète. Le moteur n'active plus la sortie anticipée
à la virgule ; chaque phrase complète ElevenLabs conserve son flush immédiat et la première
reçoit le ton, dans le même contexte TTS. Les contrôles de fin de tour, de consentement,
d'action et d'épellation restent inchangés. Aucun délai supplémentaire fixe n'est ajouté.
Le splitter conserve son option anticipée pour le banc de comparaison.

Ce choix est une préférence exploratoire de l'utilisateur, pas une preuve de généralisation.
L'attente du premier son peut augmenter (voir mesures ci-dessus). La recette téléphonique
reste à faire avant extension ; aucune mise en production dans cette passe.
