# Runbook — Dead-letter queue

> **Statut : ACTIF — créé le 21 septembre 2026.** Outillage de triage et de rejeu livré avec
> `apps/api/src/shared/queue/dead-letter.service.ts` et le CLI `ops:dead-letter`. Voir
> [`../roadmap-production-readiness.md`](../roadmap-production-readiness.md) (chantier R0-1).

## Ce que contient la file

Tout worker qui utilise `setupWorkerListeners` déplace un job vers `dead-letter` quand ses
tentatives sont épuisées (`apps/api/src/shared/queue/workers/helper.ts`). Rien ne consomme cette
file : un job qui y arrive n'est **jamais** rejoué automatiquement.

**Exception : les jobs répétitifs.** Un job issu d'un job scheduler (`upsertJobScheduler`, id
`repeat:<scheduler>:<horodatage>`, ou `opts.repeat`) qui épuise ses tentatives n'est **pas**
déplacé en dead-letter : l'occurrence suivante le remplace, et rejouer une occurrence périmée n'a
pas de sens (ex. rafraîchissement horaire `elevenlabs-subscription`). Le worker journalise un
`warn` « Repeat job exhausted its attempts; not moved to dead-letter » et incrémente la métrique
`suppernote_repeat_job_exhausted_total{queue,job_name}`. L'exception Sentry reste envoyée à chaque
échec. Le job reste dans l'ensemble `failed` de sa file (visible via les compteurs
`suppernote_queue_jobs{state="failed"}`) ; il peut déclencher `failed_jobs` à partir de 5 échecs
cumulés dans la file.

Pour savoir si un job répétitif échoue de façon répétée : surveiller
`suppernote_repeat_job_exhausted_total` et chercher le `warn` ci-dessus dans les logs workers.

Le worker `system-health` émet une alerte critique `dead_letter_backlog` dès qu'un job y est
présent. Le détail de l'alerte pointe vers ce runbook.

> Un e-mail d'alerte staging porte le libellé `[Suppernote STAGING CRITICAL]` ; la production
> reste `[Suppernote CRITICAL]`. Staging a sa propre Redis, donc sa propre dead-letter : une entrée
> y déclenche un digest indépendant de la production. Le libellé se déduit de `API_URL` /
> `PUBLIC_API_URL` ou se force par `ALERT_ENV_LABEL`. Lancer `stats` sur **les deux**
> environnements (`/opt/sokar` et `/opt/sokar-staging`) avant de conclure que la file est vide.

## Commandes

Les commandes se lancent depuis `apps/api` (elles lisent son `.env`) :

```zsh
pnpm --filter @suppernote/api ops:dead-letter list
pnpm --filter @suppernote/api ops:dead-letter list --queue outbox-dispatcher --limit 50
pnpm --filter @suppernote/api ops:dead-letter stats
pnpm --filter @suppernote/api ops:dead-letter show <deadLetterJobId>
pnpm --filter @suppernote/api ops:dead-letter replay <deadLetterJobId> --confirm
pnpm --filter @suppernote/api ops:dead-letter discard <deadLetterJobId> --reason "<motif>" --confirm
```

Sur le VPS, la même commande fonctionne dans `/opt/suppernote/apps/api`. Si `.env` n'est pas présent,
passer le fichier explicitement :

```zsh
node --env-file=../../.env --import tsx scripts/dead-letter.ts list
```

`list`, `stats` et `show` sont en lecture seule. `replay` et `discard` modifient Redis et exigent
`--confirm` ; sans ce drapeau, la commande affiche ce qu'elle ferait et ne touche à rien.

## Triage

1. `stats` pour voir quelles files alimentent la dead-letter et depuis quand.
2. `list --queue <nom>` puis `show <jobId>` pour lire la raison d'échec et la preview du payload.
3. Décider :
   - la cause est corrigée ou transitoire → `replay <jobId> --confirm` ;
   - le job est un doublon, obsolète, ou ne doit plus s'exécuter → `discard <jobId> --reason "..." --confirm`.
4. Vérifier le résultat : le job rejoué apparaît dans sa file d'origine, et l'entrée dead-letter
   disparaît. `list` doit cesser de la montrer.

## Entrées `NOT-REPLAYABLE`

Les entrées écrites avant le 21 septembre 2026 ne contiennent qu'un payload **redacté** : le rejeu
est refusé volontairement (`status: not_replayable`), car rejouer un payload masqué enverrait des
valeurs `[REDACTED]` aux fournisseurs.

Pour ces entrées, choisir explicitement :

- reconstruire l'effet métier depuis la source (réservation, appel, paiement) avec l'outil adapté ;
- ou `discard` avec un motif.

Les nouvelles entrées stockent le payload brut sous `data` et une version masquée sous
`dataPreview`. Seule la version masquée est affichée par `list`, `show` et les logs ; le payload
brut ne quitte jamais Redis et sert uniquement au rejeu.

## Garde-fous

- Aucun rejeu automatique : la file ne fait que signaler.
- `replay` remet le job dans sa file d'origine avec son nom et son payload d'origine, puis supprime
  l'entrée dead-letter. Le nouveau job reçoit un identifiant BullMQ neuf pour ne pas entrer en
  collision avec le job échoué conservé dans la file d'origine.
- Une file d'origine inconnue fait échouer le rejeu plutôt que de créer une file fantôme.
- `discard` exige un motif, journalisé dans la sortie de commande.
- Le listing est borné à 500 entrées ; `stats` donne le total exact et précise quand la répartition
  ne couvre qu'une fenêtre.

## Escalade

Si la dead-letter grossit plus vite que le triage, ou si un même job revient après rejeu, le
problème est en amont : corriger la cause (fournisseur, configuration, bug) avant de rejouer en
masse. Un rejeu massif sur une file d'envoi peut déclencher des messages réels.
