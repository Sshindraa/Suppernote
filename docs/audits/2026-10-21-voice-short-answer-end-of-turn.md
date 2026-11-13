# Réponses courtes : fin de parole lente quand Deepgram retient le mot (21/10/2026)

Étude + correctif désactivé par défaut. **Rien changé en production ni en staging.** Aucune donnée personnelle
ci-dessous : catégories, comptes et durées. Audio et transcriptions restés hors du dépôt.

## Cas déclencheur (appel test du 21/10, 01 h 01, Chez Suppernote)

Léa : « À quelle heure souhaitez-vous venir ? ». Appelant : « midi 30 » (0,88 s de voix). Chronologie (horloge
audio Deepgram, `E` = fin du dernier mot = 24 740 ms) :

| Instant         | Événement                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------- |
| E − 0,88 s      | début de la voix                                                                               |
| E − 0,56 s      | segment final **vide** de Deepgram (la voix est en cours, rien de reconnu)                     |
| E               | dernier mot ; notre détecteur de voix voit le silence au même moment                           |
| E + 0,5 / 1,5 s | aucune partielle (Nova-3 envoie ses résultats intermédiaires à peu près chaque seconde, vides) |
| **E + 2,06 s**  | **première et unique partielle « midi 30 »** (`partialCount: 1`) : le minuteur s'arme ici      |
| E + 2,56 s      | partielle figée 500 ms ; silence 2,66 s ≥ garde 350 ms → `Finalize`                            |
| E + 2,58 s      | segment `from_finalize` (pas de `speech_final`) → fin de tour                                  |
| E + 3,29 s      | voix de Léa (anticipation `hit`, Luna 0,6 s)                                                   |

Réponse à la question : **ni la garde de silence ni un minuteur armé en retard par erreur**. Le minuteur de
partielle figée part de l'arrivée d'une partielle ; Deepgram n'en a envoyé aucune pendant 2,06 s. Rien dans le
code ne surveillait le cas « l'appelant a parlé, s'est tu, et Deepgram n'a encore rien rendu ».

## Le phénomène sur les enregistrements

Rejeu Nova-3 de #532 (61 appels Chez Suppernote, 283 tours) et journaux de production 14 → 21/10 (56 tours) :

- Tours courts (≤ 3 mots, voix ≤ 1,5 s) : 57 avec texte. Catégories : oui/non 22, nombre 9, heure 5, autres 21.
  Texte couvrant le dernier mot après `E` : p50 420 ms, p90 670 ms ; plus d'une seconde dans 3 cas, et dans deux
  d'entre eux (un nombre, une heure de deux mots) **aucune fin naturelle de Deepgram** (ni `speech_final`, ni
  `UtteranceEnd` avant la réponse réelle) : c'est exactement « midi 30 ».
- Cas « rien en attente chez Deepgram à `E + 700 ms`, texte arrivé plus tard » : **7 tours sur 283 (2,5 %)**,
  dont 5 de deux mots au plus ; texte arrivé à `E + 1,56 s` en médiane, jusqu'à `E + 2,58 s`.
- Production (journaux) : 17 tours courts ; fin de parole → final p50 530 ms ; `stalled_finalize` 610, 800 et
  2 580 ms (« midi 30 »). Trois `speech_final` lents (1,34 à 2,86 s) avaient, eux, une partielle en attente :
  autre mécanisme (partielle figée retenue plus longtemps, sans doute la garde de silence), non traité ici.

## Ce qui débloque le mot : `Finalize`

Sonde `finalize-probe.ts` : 94 tours courts rejoués deux fois (témoin, puis `Finalize` à `E + 500 ms`),
~0,10 $ de Deepgram.

- Réponse au `Finalize` : **p50 40 ms**, p90 80 ms, max 320 ms ; toujours une réponse (vide si rien n'attendait).
- Sur les trois tours où Deepgram retenait le mot : texte à `E + 0,54 / 0,56 / 0,58 s` au lieu de
  `E + 1,44 / 2,24 / 1,52 s`.
- Texte final identique au témoin dans 83/94 tours ; les 11 écarts sont des tours longs coupés en deux par la
  sonde et recollés (même nombre de mots ± 1, aucun mot perdu en fin de réponse courte).

## Options étudiées

| Option                                                         | Gain                                                | Risque de couper la parole                                                                                                    | Verdict                                          |
| -------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Conclure au silence seul après un début court                  | gros                                                | **17 tours sur 283** reprennent après une pause ≥ 900 ms suivant un début court (« oui… », « alors… »)                        | écarté                                           |
| Abaisser la partielle figée courte (< 500 ms)                  | ≤ 0,3 s                                             | même mesure que #532 : pauses internes p50 280 ms                                                                             | écarté                                           |
| `utterance_end_ms` / endpointing                               | 0 sur ce cas                                        | `UtteranceEnd` est déjà au minimum (1 000 ms) et part du dernier mot _transcrit_ : il est arrivé à `E + 3,58 s`               | rien à faire                                     |
| Réponse attendue complète (heure quand Léa demande l'heure)    | aucun sans texte                                    | —                                                                                                                             | ne s'applique pas : le texte n'existe pas encore |
| **Relève au silence** : `Finalize` au silence réel, sans texte | **6 tours sur 7 concernés, p50 0,82 s, max 1,84 s** | 356 pauses internes : déclenchée 15 fois ; 13 réponses vides (bruit) = rien ; 2 où la règle actuelle concluait déjà aussi tôt | **retenu**                                       |

Seuil 700 ms : à 500 ms la relève devance souvent un `speech_final` qui arrivait de lui-même (36 → 20 tours
concernés, gain médian négatif) ; à 700 ms elle ne sert plus qu'aux mots retenus.

## Correctif (désactivé par défaut)

`VOICE_DEEPGRAM_SILENCE_FLUSH_RESTAURANT_IDS` (vide = aucun, `*` = tous), `VOICE_DEEPGRAM_SILENCE_FLUSH_MS`
(700, bornes 300–3 000). Dans `stt-bridge.ts` :

1. À chaque trame entrante, si le restaurant est listé, Léa écoute (`LISTENING`), l'appelant a parlé
   clairement (niveau et durée d'une vraie voix, pas d'un écho) depuis le dernier texte Deepgram, se tait depuis
   700 ms, et Deepgram n'a ni partielle en attente ni `Finalize` en cours : envoi d'un `Finalize`, une fois par
   prise de parole.
2. La réponse **ne clôt pas le tour**, même marquée `speech_final` : son texte reste dans les segments finaux et
   devient la partielle en cours. Les règles actuelles décident : partielle figée (500 ms pour ≤ 2 mots), garde
   de silence et épellation, verdict du modèle sur l'anticipation. À l'échéance, le tour part tel quel
   (`finalTrigger: silence_flush`), sans second `Finalize`.
3. Si l'appelant reprend, sa vraie partielle prend le relais ; le `Finalize` qui la clôt rend tout le tour
   (texte relevé + suite). Réponse vide : rien ne change.
4. Journaux sans texte : `[stt] Caller silent with no Deepgram text, Finalize sent` (silence),
   `[stt] Silence flush returned text, held as partial` (nombre de mots).

Effet attendu sur « midi 30 » : texte à `E + 0,74 s`, fin de tour à `E + 1,24 s` au plus tard (au lieu de
2,58 s), voix de Léa vers 1,95 s au lieu de 3,29 s. Les tours où Deepgram rend le texte à temps ne changent pas.
Tests Vitest dans `stt-bridge.test.ts` (7 cas).

## Activation proposée

Chez Suppernote seul (`VOICE_DEEPGRAM_SILENCE_FLUSH_RESTAURANT_IDS=710309f4-d699-472d-a1db-f22d527fc4d0`), sur feu
vert, puis un appel test : réponses d'un ou deux mots (heure, nombre, « oui »), une épellation, un « oui… » suivi
d'une pause puis d'une précision. Suivre `finalTrigger: silence_flush` et les reprises de l'appelant juste après.

Limites : rejeu sur le MP3 de l'enregistrement (pas l'audio Telnyx débruité), sans keyterms ; sept tours
concernés seulement, d'appels de test.
