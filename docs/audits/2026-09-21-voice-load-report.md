# Rapport de charge — pipeline vocal

> **Statut : ACTIF — mesuré le 21 septembre 2026.** Chantier R1-3 de
> [`roadmap-production-readiness.md`](../roadmap-production-readiness.md). Harnais :
> `apps/api/scripts/voice-load-test.ts`.

## Ce qui a été mesuré, et ce qui ne l'a pas été

Le test répond à une question précise : **combien d'appels simultanés ce process peut-il tenir avant
de saturer sa propre CPU et sa mémoire ?** Les fournisseurs (Telnyx, ElevenLabs, Cartesia) sont
neutralisés par des clés factices, et le harnais démarre sa propre API sur un port dédié avec une
base Redis isolée.

Ce que la mesure **ne** couvre **pas** :

- la latence réelle STT/TTS/LLM : elle est externe, ne consomme pas notre CPU proportionnellement,
  et doit être mesurée en staging avec de vrais appels ;
- le coût réel du décodage audio Telnyx (le harnais envoie des trames PCMU synthétiques de 160
  octets, soit exactement le format d'un appel réel, mais sans parole) ;
- la contention avec la base Postgres et Redis sous charge réelle ;
- le matériel du VPS : ces chiffres viennent du poste de développement, pas de la production.

## Méthode

```zsh
# depuis apps/api, après `pnpm --filter @suppernote/api build`
node --import tsx scripts/voice-load-test.ts --sessions 100 --duration 15
```

Le harnais crée N sessions via la route de test (chemin réel : `CallSessionManager` + ligne `Call`),
ouvre N WebSocket sur `/voice/stream/:callId`, envoie un événement `start` puis des trames `media`
toutes les 20 ms (50 trames/s, le rythme réel d'un appel), et échantillonne `ps` sur le process
enfant toutes les 500 ms. Il supprime ensuite les lignes `Call` qu'il a créées.

Machine de mesure : **Apple M5, 10 cœurs, 16 Go**, API en build compilé (`dist/main.js`).

## Ce qu'est une « session » dans ce test, et ce qu'elle n'est pas

Une session = **un appel en cours** : une connexion WebSocket média sur `/voice/stream/:callId` plus
un objet `CallSession` en mémoire dans `CallSessionManager`. « 100 sessions », c'est donc 100 appels
simultanés, chacun envoyant 50 trames par seconde — 5 000 messages WebSocket par seconde.

Le harnais neutralise les fournisseurs par des clés factices, et c'est précisément là que la mesure
devient un **plancher** plutôt qu'une capacité. Ce que le process a réellement fait tourner :

- parsing du message WebSocket Telnyx et décodage base64 de la trame ;
- mise en tampon dans `session.audioBuffer` (`sendAudioToStt`) ;
- création, suivi et suppression de la session.

Ce qu'il n'a **pas** fait, parce que la socket STT ne s'ouvre jamais avec une clé factice :

- l'envoi de chaque trame vers ElevenLabs (`sendAudioChunk` : ré-encodage base64 + une écriture
  WebSocket toutes les 20 ms et par appel) ;
- la lecture audio TTS vers Telnyx, la partie la plus coûteuse d'un appel réel ;
- les allers-retours LLM ;
- le transcodage réel : `toSttAudio` ne convertit que le PCMA, et le harnais déclare du PCMU.

Un appel de production ajoute donc au minimum deux écritures WebSocket par tranche de 20 ms et par
appel, plus des appels HTTP LLM. **La capacité réelle est inférieure aux chiffres ci-dessous**, et ne
peut être chiffrée qu'en staging avec de vrais fournisseurs.

## Résultats

| Sessions | Connexions | p50 connexion | p95 connexion | Trames envoyées  | RSS / session | CPU pic | CPU moyen |
| -------- | ---------- | ------------- | ------------- | ---------------- | ------------- | ------- | --------- |
| 5        | 5/5        | 4 ms          | 4 ms          | 1 500 (250/s)    | 1,75 Mo       | 25 %    | 17,7 %    |
| 20       | 20/20      | 6 ms          | 6 ms          | 20 000 (1 000/s) | 2,77 Mo       | 36,9 %  | 30,6 %    |
| 50       | 49/50      | 8 ms          | 45 ms         | 49 000 (2 450/s) | 2,64 Mo       | 60,4 %  | 38 %      |
| 100      | 99/100     | 21 ms         | 67 ms         | 74 250 (4 950/s) | 2,26 Mo       | 95 %    | 50,5 %    |

## Interprétation

**Ce qui est mesuré est un plancher de coût local.** À 100 sessions, le process frôle la saturation
(pic 95 %) alors que la mémoire ne consomme que ~226 Mo supplémentaires. Avec un plafond PM2 de
500 Mo et une base d'environ 150 Mo, le mur mémoire serait atteint vers 130–140 sessions — donc après
le mur CPU. Mais comme l'acheminement STT et la lecture TTS ne sont pas exercés (voir ci-dessus), la
saturation réelle arrive **plus tôt** que ces 100 sessions.

**La dégradation est progressive, pas binaire.** La latence d'acceptation WebSocket passe de 4 ms
(5 sessions) à 67 ms en p95 (100 sessions) : le process accepte encore les connexions mais commence
à les faire attendre. C'est exactement le comportement qu'une alerte doit précéder.

**Environ 1 % des connexions échouent au-delà de 50 sessions** (1 sur 50, 1 sur 100, reproductible).
Ce point n'est pas expliqué à ce stade : il peut venir du client de test, du backlog d'acceptation du
système, ou d'un rejet applicatif. À investiguer avant de considérer 100 sessions comme une capacité
utilisable.

**Conclusion opérationnelle** : garder **70 sessions simultanées** comme seuil d'alerte provisoire —
c'est 30 % sous le plancher mesuré, ce qui laisse de la marge pour le travail non exercé (STT sortant,
TTS). Ce seuil doit être confirmé par une mesure en staging avec de vrais appels, puis ajusté au
matériel du VPS. Au-delà de la capacité réelle, il faut un second process voice derrière le même nom
de domaine, pas un réglage.

## Seuil d'alerte

La jauge `suppernote_voice_active_sessions` est publiée par `CallSessionManager` à chaque création et
suppression de session. La règle Prometheus `VoiceSessionsHigh` (`infra/prometheus/alerts.yml`)
déclenche un `warning` au-delà de 70 sessions pendant 2 minutes.

Tant que Prometheus n'est pas déployé (R1-6), la valeur se lit dans les métriques du process API.

## À refaire sur le VPS

Les chiffres ci-dessus ne sont pas transposables tels quels. La même commande, exécutée sur le VPS
après un build, donne la capacité réelle :

```zsh
cd /opt/sokar/apps/api
node --import tsx scripts/voice-load-test.ts --sessions 50 --duration 20
```

À faire hors heures de service : le harnais démarre une seconde API sur son propre port, mais
consomme la même CPU que celle qui sert les appels.

## Suites

1. **Mesurer en staging avec de vrais fournisseurs** : c'est la seule façon d'obtenir la capacité
   réelle, puisque ce rapport ne couvre que le travail local hors STT sortant et TTS.
2. Expliquer le ~1 % d'échecs de connexion à 50 et 100 sessions.
3. Rejouer la mesure sur le VPS et ajuster `VoiceSessionsHigh` au matériel réel.
