# Plan d’action expert — Voix Suppernote « naturelle, fiable et transparente »

Date : 2026-07-22
Production de référence : `9ee05f7`
Statut : exécution en cours sur le canary ; tout déploiement production reste soumis à confirmation explicite

## 0. Avancement au 23 juillet 2026

Le commit canari local `479ee6b` traite les défauts révélés par le second appel contrôlé :

- suppression de l'exemple statique qui faisait inventer « 19 h 30 ou 20 h 30 » ;
- mémorisation du dernier résultat réel de disponibilité et interdiction de proposer un horaire non renvoyé par l'outil ;
- choix des deux alternatives vérifiées les plus proches de l'heure demandée ;
- questions simples de réservation produites par le contrôleur sans appel LLM (`date`, `partySize`, `time`) afin de réduire le délai perçu ;
- reconnaissance déterministe de « on arrête », « laissez tomber » et formulations équivalentes ;
- télémétrie de chaque tour : chemin de réponse, premier token LLM, premier octet TTS et premier audio.

Validation locale : 174 tests voix, typecheck API, lint API et `git diff --check` verts. Le commit est déployé en production sur la branche canari depuis le 23 juillet 2026 ; Context V2 reste désactivé. Le prochain appel contrôlé doit valider les réponses déterministes et fournir la latence complète de chaque tour.

Passe locale suivante, non déployée :

- accueil réduit à « Bonjour, ici [restaurant]. Je vous écoute. » selon la décision produit ;
- enregistrement conservé uniquement pour les restaurants de test explicitement autorisés par `CALL_RECORDING_TEST_RESTAURANT_IDS` ;
- génération de réponse invalidée dès que l'appelant reprend la parole pendant `PROCESSING` ou `SPEAKING` ;
- propagation du signal d'annulation aux deux requêtes LLM, y compris la requête non-streaming après détection d'outil ;
- une réponse périmée ne peut plus parler, modifier l'état du nouveau tour, réutiliser un transcript spéculatif ou effacer son contrôleur d'annulation.

Validation de cette passe : suite voix complète 263/263, typecheck et lint API verts.

## 1. Résultat recherché

Construire un assistant téléphonique que l’appelant trouve fluide, attentif et compétent, tout en l’identifiant brièvement comme assistant virtuel au début de l’appel. Le but n’est pas d’imiter un humain de manière trompeuse : le naturel doit venir du rythme, de la compréhension, de la continuité et de la pertinence des actions.

Les quatre qualités à optimiser ensemble sont :

1. **Fiabilité métier** — aucune date, heure, disponibilité ou réservation inventée.
2. **Continuité** — l’assistant se souvient de ce qui vient d’être dit et reprend exactement où il en était.
3. **Tour de parole naturel** — silences, interruptions et acquiescements ne deviennent pas des « nouveaux tours » artificiels.
4. **Prosodie cohérente** — une réponse sonne comme une seule intention, pas comme des fragments TTS assemblés.

## 2. Diagnostic factuel des appels observés

Pipeline actuel : Telnyx Media Stream → ElevenLabs Scribe Realtime → Cerebras/Qwen 3.8 27B → Cartesia Sonic 3.6 (`sonic-3.6`) → Telnyx.

### Points déjà corrigés en production

- Les paquets audio sortants sont regroupés en trames G.711 de 100 ms avec prébuffer de 200 ms ; les fortes saccades RTP ont nettement diminué.
- Un « allô ? » en cours de conversation reprend désormais la dernière question au lieu de relancer l’accueil générique.
- Les phrases TTS issues d’un même stream LLM sont jouées séquentiellement, sans superposition.

### Signaux robotiques encore mesurés

- L’accueil fixe dure environ 8 secondes avant le premier vrai échange.
- Le filler démarre après 400 ms, alors que la première phrase utile arrive souvent entre 400 et 900 ms. Il est donc fréquemment commencé puis coupé.
- Le prompt demande encore au modèle de réciter un accueil déjà joué par le serveur. Le filtre retire une partie de cette répétition, mais une phrase isolée comme « En quoi puis-je vous aider ? » peut passer.
- Sur le dernier scénario, après date + heure + nombre, l’assistant a dit « Je vais vérifier » sans appeler immédiatement `checkAvailability`. L’outil n’a été appelé qu’après le « OK » de l’appelant.
- Le timer de fin de tour peut partir après 400 ms lorsqu’une transcription semble ponctuée. Une ponctuation STT erronée peut donc fermer trop tôt une phrase incomplète.
- Chaque phrase est synthétisée séparément. L’intonation peut repartir à zéro à chaque frontière de phrase.
- Les réponses sont grammaticalement correctes mais trop administratives et répétitives : « souhaitez-vous », « en quoi puis-je », récapitulations systématiques.
- Le prompt ne fournit pas explicitement la date courante. Un ancien smoke de fournisseur a converti « demain » en une date incorrecte avant correction expérimentale. Ce défaut doit être traité indépendamment du modèle.

## 3. Cibles mesurables

Avant généralisation, les critères suivants doivent être atteints sur un corpus anonymisé et des appels réels contrôlés :

| Indicateur                                            |                       Cible |
| ----------------------------------------------------- | --------------------------: |
| Succès des scénarios de réservation                   |                      ≥ 95 % |
| Exactitude date/heure/nombre/nom                      | 100 % sur les cas critiques |
| Appel d’outil dès que les champs requis sont présents |                       100 % |
| Accueil ou notice répété après le début               |                         0 % |
| Filler commencé puis coupé                            |             < 1 % des tours |
| Faux déclenchement de fin de parole                   |             < 2 % des tours |
| Première réponse utile hors outil, p50 / p95          |       ≤ 800 ms / ≤ 1 500 ms |
| Note humaine de naturel                               |                   ≥ 4,2 / 5 |
| Appel nécessitant une reprise « allô ? »              |                       < 3 % |
| Transfert après deux incompréhensions réelles         |                       100 % |

La note de naturel doit être évaluée séparément de la réussite métier : une voix agréable qui réserve le mauvais jour est un échec critique.

## 4. Architecture cible

### 4.1 Contrôleur conversationnel hybride

Ne pas confier toute la logique à un prompt. Introduire un état explicite par appel :

```ts
type ConversationState = {
  intent: 'reservation' | 'availability' | 'cancel' | 'delay' | 'message' | 'gift_card' | null;
  slots: {
    date?: string;
    time?: string;
    partySize?: number;
    customerName?: string;
    customerPhone?: string;
  };
  pendingQuestion?: 'date' | 'time' | 'partySize' | 'customerName' | null;
  lastAssistantQuestion?: string;
  toolInFlight?: string;
  misunderstandingCount: number;
  closing: boolean;
};
```

Le modèle comprend et formule ; le contrôleur décide si l’on doit poser une question, appeler un outil, attendre ou conclure. Cela élimine les comportements « je vais vérifier » sans vérification.

### 4.2 Classification des actes de parole

Avant tout appel LLM coûteux, classer les tours courts :

- `liveness` : « allô », « vous êtes là ? », « ça a coupé » ;
- `backchannel` : « oui », « OK », « d’accord », « hum hum » ;
- `closing` : « merci, c’est tout », « bonne soirée », « au revoir » ;
- `correction` : « non, vingt heures », « j’ai dit deux » ;
- `content` : nouvelle information métier.

Un backchannel ne doit jamais repartir à zéro. S’il confirme une question, il met à jour l’état ; si aucune confirmation n’est attendue, il ne provoque pas une longue réponse.

### 4.3 Séparer décision et formulation

Réponse interne recommandée :

```json
{
  "speechAct": "ask_slot",
  "intent": "reservation",
  "slots": { "date": "2026-07-23", "partySize": 2 },
  "missing": ["time", "customerName"],
  "tool": null,
  "reply": "Très bien. Vous pensiez venir vers quelle heure ?"
}
```

Valider la structure et les slots avant TTS. Les champs critiques doivent être normalisés et contrôlés côté code, pas acceptés aveuglément depuis le texte du modèle.

## 5. Chantiers d’implémentation

### Chantier A — Base fiable et naturelle, priorité P0

1. Retirer du prompt toute instruction demandant au LLM de rejouer l’accueil.
2. Jouer l’accueil serveur minimal validé pour les tests : « Bonjour, ici [restaurant]. Je vous écoute. ». L’enregistrement temporaire reste borné à une allowlist de restaurants contrôlés et sera supprimé à terme.
3. Injecter dans chaque prompt la date courante, le jour et le fuseau du restaurant.
4. Ajouter `timezone` au contexte restaurant mis en cache.
5. Faire accepter `time` à `checkAvailability` et vérifier précisément le créneau demandé.
6. Appeler l’outil dans le même tour dès que date, heure et nombre sont présents.
7. Interdire « je vais vérifier » si aucun appel d’outil n’est produit dans le tour.
8. Retirer défensivement les secondes salutations et relances génériques avant TTS.
9. Passer le délai des fillers de 400 ms à 900–1 200 ms ; valeur initiale recommandée : 1 000 ms.
10. ~~Conserver plusieurs modèles et tester un canari par restaurant.~~ Clos le 22/09/2026 : un seul provider, Groq/Qwen, sans repli ni flag par restaurant (voir Chantier F). Depuis le 27/09/2026 : Cerebras seul, avec secours OpenRouter sur le tour structuré.

Un prototype de ces changements existe dans le worktree local `/private/tmp/sokar-liveness-deploy`, non déployé. Il doit être revu et repris proprement, pas copié aveuglément.

### Chantier B — Tour de parole humain, priorité P0/P1

1. Remplacer le timer « ponctuation = 400 ms » par une politique fondée sur :
   - `committed_transcript` et VAD Scribe ;
   - durée de silence ;
   - complétude sémantique ;
   - présence d’un slot critique incomplet.
2. Démarrer avec 650–800 ms après ponctuation et 1 200–1 800 ms sans ponctuation, puis mesurer.
3. Ne jamais finaliser rapidement après « je suis… », « au nom de… », « pour… », « demain à… » ou une correction commencée.
4. Pendant `PROCESSING`, une nouvelle parole doit annuler proprement la réponse en cours, conserver les nouveaux mots et relancer sur le tour fusionné.
5. Pendant `SPEAKING`, le barge-in doit couper Telnyx et Cartesia, mais ne pas perdre la phrase entrante.
6. Journaliser séparément vrais barge-ins, bruit, écho et backchannels.

### Chantier C — Prosodie TTS continue, priorité P1

1. Vérifier dans la version Cartesia utilisée le support d’un contexte/continuation entre segments.
2. Si disponible, conserver un contexte TTS unique par réponse complète afin que l’intonation traverse les phrases.
3. Sinon, agréger deux phrases courtes avant synthèse lorsque cela n’ajoute pas plus de 250–350 ms de latence.
4. Remplacer la pause fixe de 80 ms par des pauses dépendantes de la ponctuation et du sens.
5. Normaliser avant TTS les heures, dates, numéros de téléphone, symboles et abréviations.
6. Conserver les trames Telnyx de 100 ms et le prébuffer déjà validé.
7. Éviter de mettre en cache les réponses dynamiques longues avec une prosodie figée ; garder le cache pour les éléments réellement stables.
8. Comparer au moins deux voix Cartesia sur les mêmes enregistrements, à volume téléphonique réel.

Ne pas ajouter artificiellement des « euh ». Une hésitation simulée et répétitive est plus robotique qu’une réponse concise.

### Chantier D — Fillers et latence perçue, priorité P1

1. Aucun filler pour une réponse attendue sous 1 seconde.
2. Filler seulement pour une opération réellement longue : disponibilité, calendrier, transfert, paiement.
3. Choisir le filler selon l’action : « Je regarde » pour une recherche, « Un instant » pour un transfert ; jamais un filler aléatoire sans rapport.
4. Ne pas interrompre un filler après 100–300 ms. Soit il est assez court pour finir, soit il n’est pas joué.
5. Préférer un acquiescement produit dans la même réponse TTS lorsque le délai est prévisible.
6. Mesurer `filler_started`, `filler_completed`, `filler_interrupted` et la durée audible.

### Chantier E — Style et personnalité, priorité P1

1. Définir un socle commun : chaleureux, professionnel, phrases courtes, une demande utile à la fois.
2. Autoriser des variantes naturelles contrôlées : « D’accord », « Très bien », « Bien sûr », sans rotation mécanique.
3. Ne pas répéter date, heure et nombre à chaque tour ; récapituler seulement avant mutation finale ou en cas de correction.
4. Adapter le registre au restaurant via `VoicePersonality`, sans caricature d’accent.
5. Ajouter des exemples courts dans le prompt : réservation, correction, silence, indisponibilité, clôture.
6. Réponse de clôture : confirmation factuelle puis formule brève. Si l’appelant dit « merci, c’est tout », ne pas rouvrir la conversation.

### Chantier F — Modèle et routage, priorité P1

**Clos le 22 septembre 2026.** La sélection de modèle par restaurant, les canaris
de provider et le repli automatique ont été retirés : **un seul provider, Groq en
direct avec `qwen/qwen3.8-27b`, sans repli et sans flag par restaurant** (remplacé le 27/09/2026 par Cerebras `qwen-3.8-27b`, Groq retiré). Les
anciens documents de comparaison sont archivés dans
[`docs/_archive/`](../../_archive/README.md) et ne font plus partie du chemin actif.

Reste applicable de ce chantier : conserver une température modérée pour les outils, pour que la
variété de style ne dégrade pas les arguments structurés. Le tableau de suivi est
[`runbooks/provider-resilience.md`](../../runbooks/provider-resilience.md) ; toute réintroduction
d'un second modèle devra passer par un provider réellement indépendant, pas par un repli qui
repasserait par le même fournisseur.

## 6. Observabilité requise

Persister ou exporter pour chaque tour, avec données minimisées :

- transcript final et confiance STT ;
- début/fin de parole et type de finalisation ;
- état conversationnel avant/après ;
- slots extraits et corrections ;
- modèle, premier token, première phrase ;
- provider et modèle effectivement utilisés, séparés de la présence d'une clé
  OpenRouter réservée aux outils externes ;
- outil demandé, durée, résultat catégorisé ;
- filler commencé/terminé/interrompu ;
- TTS first byte, début/fin audio ;
- barge-in et audio clear ;
- réponse finale prononcée ;
- issue métier et motif de transfert.

Ajouter un identifiant de tour stable. Le `LatencyTrace` actuel agrège surtout un appel et ne suffit pas pour diagnostiquer une conversation de plusieurs tours.

## 7. Stratégie de tests

### Tests unitaires

- conversion relative des dates dans plusieurs fuseaux ;
- classification liveness/backchannel/closing/correction ;
- fusion d’un tour interrompu ;
- disponibilité exacte avec heure demandée ;
- suppression des salutations répétées ;
- règle filler 1 000 ms et absence de collision ;
- clôture sans réouverture.

### Tests conversationnels déterministes

Créer des scénarios multi-tours avec assertions sur état, outil et texte :

1. « Je voudrais réserver demain » → demande nombre/heure.
2. « Deux personnes » → conserve date et demande heure.
3. « 20 heures » → `checkAvailability` immédiatement, sans phrase d’attente fictive.
4. Outil disponible → demande uniquement le nom.
5. « allô ? » → confirme sa présence et reprend la demande du nom.
6. « Martin » → récapitulatif minimal puis création.
7. « Non, 20 h 30 » → corrige l’heure sans perdre le reste.
8. « Merci, c’est tout » → clôture naturelle.

### Smokes fournisseur

- Exécuter au moins 10 répétitions sur le même scénario et la même configuration de production.
- Refuser la livraison si une date relative est fausse, même une seule fois.
- Refuser la livraison si le modèle annonce une action sans tool call.
- Archiver uniquement les métriques et sorties anonymisées nécessaires.

### Tests audio

- détecter automatiquement les trous > 250 ms au milieu d’un mot ou d’une phrase ;
- comparer audio Cartesia brut et enregistrement Telnyx ;
- mesurer temps de silence entre utilisateur et première syllabe utile ;
- panel humain en aveugle sur naturel, clarté, chaleur et confiance ;
- test casque, mobile, haut-parleur et réseau dégradé.

## 8. Déploiement progressif

| Phase              | Portée                                         | Condition de sortie                             |
| ------------------ | ---------------------------------------------- | ----------------------------------------------- |
| 0 — Baseline       | 20 appels existants anonymisés                 | métriques calculables, causes annotées          |
| 1 — Local/staging  | scénarios automatisés + 20 appels contrôlés    | 100 % champs critiques, aucune régression audio |
| 2 — Shadow         | nouveau contrôleur sans audio envoyé au client | décisions comparées à la prod, ≥ 95 % correctes |
| 3 — Canary         | un restaurant de test, 10 % puis 50 %          | seuils de naturel et métier atteints 48 h       |
| 4 — Généralisation | restaurants volontaires                        | aucun signal de rollback                        |

Flags recommandés :

- `voice_natural_prompt_v2`
- `voice_turn_taking_v2`
- `voice_fillers_v3`
- `voice_tts_context_v2`

Chaque flag doit pouvoir être coupé sans redéploiement. Le kill switch global voix reste prioritaire.

## 9. Critères de rollback

Rollback immédiat si l’un des événements suivants apparaît :

- mauvaise date ou heure utilisée par un outil ;
- hausse des réservations erronées ou doublons ;
- baisse du succès d’appel > 3 points ;
- p95 première réponse utile > 2 secondes hors outil ;
- filler interrompu sur > 3 % des tours ;
- répétition de l’accueil > 1 % des appels ;
- erreurs fournisseur ou dégradation > 2 % ;
- coût moyen par appel dépassant le budget défini.

## 10. Passe Cartesia/Scribe livrée localement le 10 septembre 2026

- l'alias continu `sonic-3.6` est utilisé sur tous les chemins TTS ;
- Cartesia reçoit désormais `locale` (`fr-FR`, `en-US`, région Scribe si disponible), `normalization=auto` et `generation_config` pour vitesse, volume et émotion explicitement configurée ;
- la voix et le dictionnaire de prononciation peuvent être définis par restaurant (`AgentPersonality`) avec un fallback global `CARTESIA_PRONUNCIATION_DICT_ID` ;
- les caches incluent modèle, voix, locale, codec, réglages et dictionnaire ;
- Context V2 était un canary à double verrou ; le drapeau `VOICE_TTS_CONTEXT_V2_ENABLED` est retiré (23/10/2026), le chemin contexte s'active dès que la clé du fournisseur est présente ;
- les 44 langues Sonic 3.6 sont disponibles via `ELEVENLABS_STT_ALL_LANGUAGES=true`, sans modifier le ciblage fiable par défaut ; les langues autres que français/anglais repassent au LLM pour les réponses conversationnelles au lieu d'utiliser une phrase déterministe française ;
- `tools/diagnostics/benchmark-cartesia-voices.mjs` génère un corpus FR/EN pour comparer les voix dès qu'une clé Cartesia valide est disponible.

Validation locale : 86 tests voix ciblés, typecheck API, build API, lint API (0 erreur, 8 avertissements préexistants), validation Prisma et formatage verts. La suite API complète conserve 1 849 tests passants ; 11 tests WebSocket restent limités par `listen ::1` dans le sandbox.

## 11. Ordre d’exécution recommandé pour l’agent suivant

### Passe du 11 septembre 2026 — correctif prosodie/latence

- le fallback HTTP synthétise une réponse complète dans une seule requête ; les pauses fixes inter-phrases de Suppernote sont supprimées afin que Sonic 3.6 applique sa ponctuation contextuelle ;
- le contexte WebSocket canary est ouvert pendant la génération LLM, avant le premier fragment, et accepte les deux formes de signal de fin Cartesia (`type=done` et `done=true`) ;
- le timeout d'ouverture du contexte est limité à 1,5 seconde pour revenir rapidement au chemin HTTP en cas d'incident ;
- le prébuffer Telnyx passe de deux trames à une trame de 100 ms, ce qui retire un silence fixe sans modifier le format G.711 ni le pacing réseau ;
- la suite TTS/Context/audio passe 17/17, le lint ciblé et le typecheck API passent ; le double verrou canary reste inchangé.

1. Partir de `origin/main` à `9ee05f7` ou plus récent dans un worktree propre.
2. Lire ce plan, `docs/obsidian/Context.md`, les trois dernières entrées du Journal et `docs/architecture/voice.md`.
3. Inspecter le prototype `/private/tmp/sokar-liveness-deploy` avec `git diff`, sans le déployer directement.
4. Livrer Chantier A avec tests unitaires et smoke multi-tours.
5. Ajouter l’état conversationnel minimal et les actes de parole du Chantier B.
6. Instrumenter les métriques par tour avant de modifier profondément l’endpointing.
7. Tester le contexte TTS Cartesia derrière un flag séparé.
8. Comparer les versions du pipeline uniquement dans un environnement isolé, sans canari de modèle en production.
9. Présenter au propriétaire : résultats, extraits audio, coût, risques et plan de rollback.
10. Ne pousser ni déployer en production sans confirmation explicite.

## 12. Prototype local existant

Le worktree `/private/tmp/sokar-liveness-deploy` contient actuellement une expérimentation non committée incluant :

- accueil raccourci et transparent ;
- prompt conversationnel sans accueil LLM ;
- date/fuseau injectés ;
- `checkAvailability` avec heure précise ;
- filler à 1 000 ms ;
- modèle unique : Cerebras/Qwen 3.8 27B (Groq retiré le 27/09/2026) ;
- smoke réel `apps/api/scripts/smoke-voice-naturalness.ts`.

Résultats obtenus avant cette passation :

- suite voice + cache restaurant : 235/235 ;
- ciblée finale : 98/98 ;
- WebSocket : 13/13 ;
- trois smokes consécutifs : `2026-07-23`, 2 personnes, 20:00, appel immédiat de `checkAvailability`, puis demande du nom ;
- lint ciblé et build config : verts.

Attention : le typecheck global de ce worktree emprunte le client Prisma généré du workspace principal, lequel contient des champs de provisioning non présents dans le commit propre. L’unique erreur observée vient de cette contamination de dépendances dans `availability-capacity-aware.service.test.ts`. Refaire la validation dans un environnement dépendances propre avant livraison.

## 12. Définition de « terminé »

La refonte est terminée uniquement quand :

- les décisions métier sont déterministes et auditables ;
- les dates relatives sont toujours correctes ;
- les outils partent sans tour artificiel ;
- les interruptions et backchannels ne cassent pas le contexte ;
- l’audio Telnyx final ne contient ni trou ni collision de filler ;
- un panel humain juge la conversation naturelle ;
- l’accueil et la politique d’enregistrement correspondent à la décision produit active ;
- le canary respecte les seuils pendant au moins 48 heures ;
- le rollback a été testé.
