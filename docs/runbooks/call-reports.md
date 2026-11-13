# Runbook — Rapport automatique de chaque appel

> **Statut : ACTIF en production depuis le 3 octobre 2026** (restaurants de test uniquement,
> puisqu'il suit l'enregistrement). Depuis le 23/10/2026 le drapeau `CALL_REPORT_ENABLED` n'existe plus : le rapport est
> construit pour tout appel enregistré. Validation sur les appels
> 8043662c, 935ff343, 03b19223 et 3ba7c66f : voir « Validation du 03/10/2026 ».

Après chaque appel d'un restaurant de test, le worker produit le rapport que l'on faisait à la main :
ce qui a été dit, ce que le système a compris, où il a hésité, où il s'est tu, où il s'est trompé. Les
défauts ressortent seuls. **Le rapport ne change rien au comportement de l'agent** : il tourne dans le
worker, après la fin de l'appel, et une erreur y est journalisée puis absorbée.

## Périmètre et données personnelles

- Restaurants de `CALL_RECORDING_TEST_RESTAURANT_IDS` uniquement (la tâche le recontrôle). Aucun
  restaurant client.
- L'audio reste dans le stockage privé et sur le VPS ; il n'est jamais commité. Pour la génération
  locale, l'audio et les réponses Deepgram vont dans `$TMPDIR/sokar-call-reports`, hors dépôt.
- Les transcriptions après coup partent chez Deepgram, comme le direct : même fournisseur, même clé.
- Tout texte du rapport passe par `redactPii()` (numéros, e-mails). Les identifiants (UUID, dates) y
  échappent : un UUID ressemble à un numéro. Les noms ne sont pas masqués (comme `voice_debug_turns`).
- Le rapport (JSON + Markdown) est stocké **à côté de l'enregistrement**, sous le même préfixe privé
  (`call-recordings/<restaurant>/<appel>/report.json` et `report.md`), même chiffrement, supprimé avec
  lui par `purge-expired-recordings` (30 jours au plus).
- Les journaux n'en reçoivent que des comptes (`[call-report] stored`) : jamais de texte d'appel.
- Pas de table de base dans cette phase. Proposition, non créée : `call_reports(call_id pk, version,
generated_at, issues_json, counters, storage_key)`, utile seulement si on veut interroger les
  rapports par SQL ou les afficher dans le dashboard. Le résumé quotidien liste aujourd'hui les clés
  du stockage.

## Activation

Prérequis : `CALL_RECORDING_ENABLED=true`, `CALL_RECORDINGS_BUCKET` et ses accès,
`DEEPGRAM_API_KEY`, `VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS` contenant le restaurant (sans elle, le
dialogue par tour n'existe pas et le rapport est réduit : il le dit). Sans la clé Deepgram,
la transcription après coup échoue et le rapport est abandonné (l'appel n'est jamais touché).

```text
CALL_REPORT_LOG_DIR=/var/log/sokar  # défaut ; dossier des journaux de l'API, lu par le worker
CALL_REPORT_MAX_REPORTS=100       # plafond du nombre de rapports ; absent = illimité
```

**Plafond.** `CALL_REPORT_MAX_REPORTS` borne la dépense Deepgram : le compteur est la clé Redis
`call-report:generated` (base des files), incrémentée avant chaque rapport ; au-delà du plafond le job
ne fait rien et journalise `[call-report] limit reached`. Un rapport en échec rend sa place. Pour
repartir de zéro : `redis-cli DEL call-report:generated` ; pour relever le plafond : changer la variable
et recharger `sokar-workers --update-env`. Voir l'état : `redis-cli GET call-report:generated`.

Recharger `sokar-workers` avec `--update-env`. Retrait : remettre `false`. Les rapports déjà écrits
restent jusqu'à l'expiration de l'enregistrement.

Déclenchement : « Telnyx recording stored privately » (ou la reprise `recover-recording`) met en file
`build-call-report`, une seule tentative, identifiant stable par appel (pas de doublon).

## Ce que contient un rapport

1. **Chronologie** : par tour, le direct, ce que Nova-3 et Whisper entendent après coup, le `say` du
   modèle (un par passage), le texte réellement envoyé à la synthèse, ce que la piste agent contient, et
   le délai entre la fin de parole de l'appelant et la première voix de l'agent, **mesuré sur les
   pistes** (le délai du journal est donné entre parenthèses pour recoupement).
2. **L'oreille** : direct contre après coup, tour par tour, sur le même morceau d'audio. Trois oreilles :
   le direct, Nova-3 relancé en mode non continu (sans mots-clés), Whisper hébergé par Deepgram. Un écart
   qui touche une lettre isolée ou un chiffre est grave ; deux oreilles qui se contredisent sur une lettre
   ou un nombre sont un **signal fort** ; deux oreilles qui s'accordent contre le direct disent que le
   direct s'est probablement trompé.
3. **La bouche** : texte envoyé à la synthèse contre la piste agent. C'est ce qui trouve « deux
   secondes et deux mètres » et « H… Huey ». Une réplique coupée par une interruption est marquée.
4. **Les silences** de plus de 1,5 s (ni l'appelant ni l'agent ne parle, mesuré à l'énergie), avec leur
   cause tirée des journaux : verdict « inachevé » du juge, pause d'épellation, garde-fou, second
   passage, ou le composant de délai le plus long (fin de tour, modèle, synthèse).
5. **Les tours de parole** : chaque verdict « inachevé » et si l'appelant a repris ; chaque
   chevauchement de plus de 300 ms ; chaque interruption (réelle, écho, ou non confirmée) ; chaque
   épellation répartie sur plusieurs tours.
   **Ré-épellation identique après relecture** (gravité 97, juste sous la prononciation) : l'agent
   reprend des lettres, l'appelant ne valide pas et épelle de nouveau, et la suite de lettres transcrite
   est **identique** à celle relue. Si la transcription était juste, la relecture aurait été acceptée :
   le moteur entend deux fois la même chose, contre ce que dit l'appelant (erreur d'oreille
   systématique probable). Comparaison de suites de lettres uniquement (jetons d'un seul caractère,
   au moins trois) ; le refus se lit dans la nouvelle épellation, pas dans « non ». Sur les 4 appels de
   validation : détecté sur 3ba7c66f (« a 2 s a m » relu puis épelé trois fois), **pas sur 8043662c**,
   où les deux épellations diffèrent d'une lettre (« a 2 s 2 m » puis « a 2 s a 2 m »). Une tolérance
   d'une lettre le rattraperait mais ferait aussi remonter des épellations réellement corrigées : non
   retenue sans mesure sur de vrais rapports.
6. **Les garde-fous** : `phrase_dropped`, relecture de nom refusée, action refusée, mots retirés par le
   filtre d'écho, avec le texte concerné.
7. **L'issue** : résultat, abandon (réservation voulue sans réservation), derniers échanges.
8. **Une ligne de synthèse** : les 3 problèmes les plus graves, classés par un barème explicite
   (`summary.ts`) : prononciation (100) > compréhension (80 à 95) > épellation coupée (75) > silence après
   un verdict « inachevé » sans reprise (88) > abandon (70) > silence long (35 à 80) > chevauchement,
   écho (55 à 62).

Aucune détection n'utilise de liste de mots : alignement, lettres isolées, chiffres, durées, énergie,
événements des journaux.

## Lire un rapport

```bash
python3 scripts/ops/voice_call_audio.py report <début-de-l-id-d-appel>
python3 scripts/ops/voice_call_audio.py report <id> --json
python3 scripts/ops/voice_call_audio.py report --day 2026-10-03 --restaurant <id>
```

Ces commandes lisent le stockage privé **depuis le VPS** (code compilé déployé : elles ne marchent
qu'après le déploiement de cette phase). Pour un appel déjà enregistré, avant ou sans déclencheur :

```bash
pnpm --filter @suppernote/api exec tsx scripts/call-report-local.ts <id> [--refresh]
```

Le script lit l'enregistrement, le dialogue et les journaux par SSH ; la clé Deepgram ne quitte pas le
VPS ; les réponses Deepgram sont gardées hors dépôt (relancer est gratuit, `--refresh` les ignore).

Sans SSH (session Claude cloud), le rapport JSON se lit en HTTPS, pour les restaurants de
`VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS`. Le secret réseau de l'environnement ajoute l'en-tête
`Authorization` (voir `environment.md`) ; ailleurs, passer `-H "Authorization: Bearer <jeton>"` :

```bash
curl -sS -H "Authorization: Bearer $SOKAR_VOICE_READ_TOKEN" \
  "https://api.suppernote.com/api/internal/voice/calls/latest?restaurantId=<id>"
curl -sS -H "Authorization: Bearer $SOKAR_VOICE_READ_TOKEN" \
  "https://api.suppernote.com/api/internal/voice/calls/<début-de-l-id>/report"
```

L'audio n'est pas exposé par cette voie : l'écoute (`voice_call_audio.py --listen`) reste sur le Mac.

## Coût

Aucune requête au modèle de dialogue, rien sur le crédit Cerebras. Seules dépenses : Deepgram
pré-enregistré, Nova-3 sur la piste appelant, **Whisper** sur la piste appelant, Nova-3 sur la piste
agent (tarifs publics : 0,0043 $/min Nova-3 monolingue, 0,0048 $/min Whisper, à confirmer sur la
facture). Mesuré sur 4 appels de 47 à 96 s : **0,0097 à 0,0208 $ par appel, 0,0145 $ en moyenne**
(0,058 $ pour les 4). À 20 appels par jour : environ 0,30 $.

## Limites connues

- **Journaux : rotation à 14 jours.** Au-delà, ou si les journaux de l'API sont absents, le rapport est
  produit sans eux et le dit dans « Limites » : causes des silences (`unknown_no_logs`), verdicts du
  juge, garde-fous et interruptions manquent. Le dialogue par tour (`voice_debug_turns`) est purgé à 14
  jours aussi. L'enregistrement dure 30 jours : un rapport tardif est donc plus pauvre. Génération
  automatique juste après l'appel = rapport complet.
- **Liaison appel ↔ journaux.** Les journaux portent le `callControlId`, la base le `callSid`. La ligne
  `[voice-report] call linked` (ajoutée à l'ouverture du flux) les relie. Pour un appel d'avant cette
  ligne, on relie par l'heure de création (±15 s) ; le rapport le signale, et refuse un rattachement
  ambigu (deux appels au même instant).
- **Horloge.** Les événements des journaux sont recalés sur l'audio avec la première voix de l'agent de
  chaque tour (médiane). Sans tour exploitable, les interruptions ne sont pas classées.
- **Mots sans voix.** Un mot transcrit là où la piste n'a aucune énergie est ignoré (hallucination
  d'un moteur sur du silence, fréquente avec Whisper en fin de piste) ; le nombre est dans « Limites ».
  Une parole très basse sous le seuil d'énergie serait ignorée aussi.
- **Whisper.** Il hallucine par moments (répétitions, formules de fin de vidéo) et écrit « 20 h » : un
  « h » isolé peut passer pour une lettre. Une divergence portée par Whisper seul est un indice, pas une
  preuve. Whisper indisponible : le rapport se fait à deux oreilles et le dit.
- **Erreur commune aux moteurs.** Si le direct, Nova-3 et Whisper se trompent de la même façon, le
  rapport ne le voit pas (voir 8043662c, « A, M » entendu « a deux m » par les trois).
- **Noms propres.** « Assamm » est entendu « hassam » sur la piste agent : écart de faible gravité, pas
  une faute de prononciation avérée.
- **Décodeur MP3.** `mpg123-decoder` : l'enveloppe est MIT, mais le WASM embarque mpg123 (LGPL-2.1).
  Usage côté serveur, sans redistribution : aucune obligation de publication. À revoir si le code
  est un jour distribué.

## Validation du 03/10/2026

Rapport généré sur les appels déjà enregistrés (tous Chez Suppernote), journaux reliés par l'heure.

| Appel    | Défaut connu                                                    | Résultat                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8043662c | « deux secondes et deux mètres » dans la relecture              | **Trouvé** (bouche, 2 relectures, gravité 100). « A, M » entendu « a deux m » par les trois oreilles : **raté**.                                                                            |
| 935ff343 | « H… Huey » au récapitulatif ; relecture H, O, U, E, T correcte | **Trouvé** (« HOUET » entendu « h huey »). La relecture correcte n'est pas signalée.                                                                                                        |
| 03b19223 | 2,98 s après un verdict « inachevé » ; abandon à 7              | **Trouvés** : 2,98 s, cause `judge_incomplete`, l'appelant n'a pas repris ; abandon signalé avec « on fera 7 » → « plus de table pour 7 ».                                                  |
| 3ba7c66f | « a » perdu pendant l'interruption, segment recollé             | **Trouvés** : « m » entendu « a m » par les deux oreilles (le « a » perdu), « a » seul que personne n'a entendu (le segment recollé), épellation en 4 tours, interruption réelle à 68,27 s. |

**Mesures d'énergie.** Les segments de parole des deux pistes sont identiques à ceux de
`voice_call_audio.py` : écart maximal 0,000 s sur 70 bornes (4 appels, 8 pistes, même nombre de
segments partout). Les silences perçus sont donc les mêmes.

**Signalés à tort ou de valeur faible** (à lire avec le doute qu'ils méritent) :

- Whisper hallucine dans les zones confuses : « non a 2 f a 2 m » (8043662c, tour 8), « 2 f » pour « 2 s »
  (8043662c, tour 7), « 1 h 04 » (3ba7c66f, tour 1). Ils sortent en « signal fort » parce que deux
  oreilles se contredisent sur une lettre ou un nombre, alors qu'une seule se trompe.
- « h » après un chiffre (« 20 h ») lu comme une lettre isolée (03b19223, 3ba7c66f).
- « 3 » écrit « trois » par Whisper : « forme du nombre », gravité moyenne, sans enjeu.
- Le filtre d'écho qui retire « c'est » de « c'est parfait » (935ff343) : vrai fait, mais le sens du
  tour n'en souffre pas ; classé 62.
- 3ba7c66f : plusieurs divergences « fortes » dans la même zone d'épellation confuse (tours 1 à 3, 7 à 13),
  dont un « a » et un « lettre en b non » que ni Nova-3 ni Whisper n'entendent : soit le direct a
  halluciné, soit les deux moteurs ont raté une parole faible. À écouter, pas à conclure.
- Les silences de 1,5 à 2 s après la fin de l'agent (« l'appelant tarde ») ne sont pas des défauts de
  l'agent ; ils sont listés mais pas classés.

## Ensuite

Résumé quotidien : `report --day` (appels, silences de plus de 2 s, divergences, écarts de
prononciation, abandons, lien vers chaque rapport). Ce rapport servira de juge à la phase suivante (un
client robot qui appelle chaque soir) : non commencée.
