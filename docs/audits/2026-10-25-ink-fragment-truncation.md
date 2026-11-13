# Ink-2 : troncature des fragments dans l'intégration parallèle

Diagnostic du 25 octobre 2026 sur l'appel test production `98e86c8e`.
Aucun changement runtime, de configuration ou de déploiement.

## Constat pendant l'appel

Le dernier tour contient « 16 heures 30 » côté Deepgram, « 1 » côté Ink et
`selectedSource: ink` (attente 60 ms). Les quatre tours portent
`sttProvider: cartesia-ink-2`, malgré le label historique Deepgram de l'appel.
Les messages WebSocket bruts d'Ink n'ont pas été conservés : la suite exacte des
fragments de l'appel initial n'est donc pas démontrable rétrospectivement.

## Rejeu fournisseur

Piste appelant privée de l'enregistrement, extrait 37,8–39,5 s, réencodé A-law
8 kHz, envoyé depuis le VPS à rythme réel en trames de 20 ms. Paramètres du
module déployé : `/stt/websocket`, `ink-2`, `language=fr`, version `2026-03-01`.
Trois sessions avec 0, 350 et 1 000 ms de silence ajouté après l'extrait.
Le MP3 réencodé ne restitue pas exactement les octets du flux STT original.

Dans les trois sessions, les fragments finaux sont `" 1"` puis `"6h30."`, suivis
de `flush_done`. La concaténation exacte donne `" 16h30."`.
Dans les deux premières sessions, le second fragment arrive 39–42 ms après le
premier. Dans la troisième, le premier fragment arrive avant le `finalize`.
Cela montre aussi qu'un fragment final n'est pas un acquittement de `finalize`.

## Reproduction avec le module réellement déployé

Le JavaScript compilé a été récupéré en lecture seule puis exécuté localement
dans une VM Node, avec socket simulée et imports externes neutralisés. Les
événements du premier rejeu ont été injectés dans son vrai gestionnaire :

1. Attente en cours : le premier fragment résout `resolveInkTranscript` avec
   `"1"` ; le fragment suivant reste dans `state.finals` (`"6h30."`).
2. Tous les fragments déjà reçus : le même code produit `"1 6h30."`.
3. La concaténation sans espace ajouté donne `"16h30."`.

Trois assertions passées. Ces tests reproduisent le défaut du client, pas les
conditions exactes de transport et de débruitage de l'appel initial.

## Causes et correction à prévoir

- `openInkParallel` traite le premier `transcript` non vide avec `is_final=true`
  comme une réponse complète, remet `pendingFinalize=false` et résout l'attente.
  Il ignore `flush_done`.
- `event.text.trim()` puis `finals.join(' ')` détruisent les frontières entre
  fragments et peuvent séparer un nombre ou un mot.
- Les fragments restants peuvent se retrouver dans le tampon du tour suivant.
  Le timeout/repli doit aussi vider une réponse complète, pas un seul fragment.

Priorité : respecter les frontières `flush_done`, concaténer les deltas à
l'identique, isoler les cycles de finalisation et drainer les réponses tardives
jusqu'à leur fin. Garder le repli Deepgram borné si aucune réponse complète
n'arrive. Tester fragments multiples, blancs seuls, résultat vide, timeout,
finalisation anticipée et plusieurs tours. Un garde-fou sur les heures ne
remplace pas cette correction du protocole.

Le diagnostic initial « Ink a mal reconnu l'heure » doit être corrigé : le rejeu
montre une reconnaissance complète et un défaut reproductible d'assemblage et
de clôture côté Suppernote. Sans messages bruts de l'appel initial, l'attribution à
ce mécanisme reste fortement étayée plutôt qu'une preuve réseau exhaustive.

## Sources et preuves

- Module local correspondant au déployé :
  `apps/api/src/modules/voice/stream/stt-ink-parallel.ts`, gestion des messages
  et fonctions `takeFinals`, `resolveInkTranscript`, `discardPendingReply`.
- [Exemple officiel Cartesia JS](https://github.com/cartesia-ai/cartesia-js/blob/main/examples/browser_examples.ts) : les événements sont des deltas à concaténer sans ajout/retrait d'espaces.
- [Protocole WebSocket manuel](https://docs.cartesia.ai/api-reference/stt/websocket) : événements `transcript` et `flush_done`.
- Preuves privées hors dépôt : `$TMPDIR/sokar-call-audio/98e86c8e/`, fichiers
  `ink-probe.jsonl`, `deployed-stt-ink-parallel.cjs`, `ink-handler-repro.json`.

## Latences du même appel, par tour

Mesures relatives à la fin de parole estimée par l’horloge audio Deepgram ;
arrondi à la milliseconde. Une variation de 1 ms existe entre le calcul interne
et les horodatages ISO sérialisés. Le premier fragment Ink n’a pas son propre
horodatage de réception dans les journaux ; `waitedMs` mesure l’attente du
sélecteur après la fin de tour Deepgram, pas la latence complète du fournisseur.

| Tour                      | Fin de parole → final Deepgram (télémétrie) | Attente du sélecteur Ink          | Fin de parole → dialogue (`STT + hold`) |
| ------------------------- | ------------------------------------------- | --------------------------------- | --------------------------------------- |
| 1, demande de réservation | 560 ms                                      | 0 ms, texte déjà tamponné         | 565 ms                                  |
| 2, demain / ouverture     | 350 ms                                      | 0 ms, texte déjà tamponné         | 351 ms                                  |
| 3, heure d’ouverture      | 340 ms                                      | 0 ms, texte déjà tamponné         | 341 ms                                  |
| 4, horaire                | 330 ms                                      | 60 ms, premier fragment seulement | 391 ms                                  |

Moyenne final Deepgram : 395 ms ; médiane : 345 ms. L’attente Ink ajoutée
moyenne est 15 ms, mais n’est pas une mesure de sa transcription complète.
Les finalisations locales Deepgram sont envoyées à 15:59:37.927Z,
15:59:49.146Z, 15:59:58.166Z et 16:00:07.327Z ; résultats non vides à
37.937Z, 49.217Z, 58.234Z et 07.395Z, soit 10, 71, 68 et 68 ms.
Le premier résultat est une fin naturelle (`fromFinalize=false`) : les 10 ms
ne mesurent donc pas la réponse à la commande `Finalize`.

Limite d’instrumentation : `endOfSpeechToSttFinalMs` conserve `sttFinalAt`
Deepgram même quand `sttProvider` vaut Ink. Au tour 4, ses 330 ms excluent
les 61 ms de `hold`. Aucun `flush_done` Ink initial n’est horodaté : impossible
de donner une latence de transcription complète Ink par tour ni de mesurer
son avance éventuelle sur les trois premiers tours. Le rejeu fournisseur du
tour 4 (71/110 ms après finalize) reste une mesure séparée de l’appel original.
