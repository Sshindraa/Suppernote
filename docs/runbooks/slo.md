# Runbook — SLO

> **Statut : ACTIF — créé le 21 septembre 2026.** SLO minimaux définis dans
> `apps/api/src/shared/observability/slo.ts`, mesurés par le worker `alert-evaluation` toutes les
> 5 minutes. Voir [`../roadmap-production-readiness.md`](../roadmap-production-readiness.md)
> (chantier R0-5).

## Ce que couvre ce runbook

Cinq objectifs minimaux, volontairement peu nombreux, mesurés automatiquement. Un SLO n'est pas une
alerte : il dit si le service tient sa promesse. Quand un objectif est manqué, le worker dispatche un
finding `slo_breach` (gravité `warning`, cooldown 30 min) sur les canaux configurés
(`ALERT_EMAIL_TO`, `ALERT_WEBHOOK_URL`). Aucun SMS n'est envoyé pour un SLO : le SMS reste réservé
aux pannes critiques détectées par `system-health` et le watchdog.

| SLO                                 | Objectif                                                   | Fenêtre | Signal                   |
| ----------------------------------- | ---------------------------------------------------------- | ------- | ------------------------ |
| `api_availability`                  | ≥ 99 % des requêtes API sans 5xx                           | 5 min   | compteur HTTP en mémoire |
| `connect_availability`              | ≥ 99 % des requêtes Connect sans 5xx                       | 5 min   | compteur HTTP Connect    |
| `connect_latency_p95`               | p95 ≤ 500 ms sur les routes Connect réussies               | 5 min   | histogram Connect        |
| `voice_transcript_coverage`         | ≥ 99 % des appels Telnyx avec transcription **et** outcome | 24 h    | table `Call`             |
| `reservation_confirmation_coverage` | ≥ 99 % des réservations confirmées avec trace d'envoi SMS  | 24 h    | `Reservation` + audit    |

## Où lire les valeurs

Le worker publie deux gauges à chaque tick :

- `suppernote_slo_status{slo}` — `1` objectif tenu, `0` objectif manqué, `-1` non mesuré ;
- `suppernote_slo_value{slo,unit}` — valeur mesurée (ratio ou millisecondes).

Depuis R1-1, les workers tournent dans le process `sokar-workers` : les gauges y vivent, pas dans
`dist/main.js`. Le `/metrics` de l'API ne les expose donc plus en production, et il n'existe pas
encore de cible de scraping côté worker — c'est précisément le chantier R1-6 (Prometheus/Grafana),
qui doit ajouter un petit serveur de métriques au process worker. En attendant, l'état des SLO se lit
dans les logs du worker (message `alert-evaluation`, champ `slo`) et via les alertes `slo_breach` :

```zsh
pm2 logs sokar-workers --lines 200 | grep -i slo
```

## Réagir à un SLO manqué

**`api_availability` ou `connect_availability`** — vérifier d'abord `GET /health` (base, Redis,
filles), puis les logs API (`grep 'Unhandled error'` et le `request_id` du 5xx), puis Sentry. Une
disponibilité sous 99 % sur 5 min correspond à plus d'une requête en erreur sur cent : c'est déjà
significatif à faible volume.

**`connect_latency_p95`** — regarder la route concernée dans les logs Connect (SSR) et l'état de
l'API : une latence p95 élevée vient le plus souvent d'un appel API lent (disponibilité, Google
Places) ou d'un cache froid après déploiement. Vérifier le cache Nginx/Cloudflare avant de conclure à
une régression applicative.

**`voice_transcript_coverage`** — le pipeline voix est probablement cassé : vérifier ElevenLabs STT,
le webhook `/voice/telnyx/end`, la file `telnyx-webhooks` et le worker `call-recovery`. L'alerte
`calls_without_transcript` du worker `system-health` donne des exemples d'appels.

**`reservation_confirmation_coverage`** — vérifier la file `sms-client` (jobs en échec), le solde
Telnyx et les logs `outbound-confirm`. L'alerte `reservations_without_sms` liste des exemples.

## Limites connues

- Les compteurs HTTP vivent en mémoire : un redémarrage remet la baseline à zéro et les SLO
  `api_availability`, `connect_availability` et `connect_latency_p95` passent en `unknown` le temps
  d'un tick. C'est volontaire — mieux vaut `unknown` qu'une fausse alerte.
- Une fenêtre sans trafic donne `unknown`, jamais « tenu ».
- Les deux SLO métier dépendent de la base : si elle est injoignable, ils passent en `unknown` et
  l'erreur est loggée par le worker, sans casser le tick.
- Les seuils sont volontairement larges pour un pilote. Les resserrer demande de mesurer d'abord
  plusieurs semaines de trafic réel.
