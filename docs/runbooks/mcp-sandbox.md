# Runbook — Sandbox MCP

> **Statut : ACTIF — 29 septembre 2026.**
> Cette sandbox réutilise le restaurant `chez-suppernote-demo`. Elle est conçue pour
> les tests de connecteurs et rejette les bases dont le nom n’indique pas un
> environnement local, staging, test ou dev.

## Prérequis

- Le seed a créé `chez-suppernote-demo` avec `agenticOptIn=true` et `mcpEnabled=true`.
- L’ancien slug `chez-sokar-demo` reste accepté pendant la migration de la fiche.
- La base cible est locale, staging, test ou dev.
- Les tests utilisent le téléphone factice `+33612345600`.
- Un seul run MCP sandbox est exécuté à la fois sur le restaurant de démo.

## Démarrer un run

```zsh
pnpm --filter @suppernote/database mcp:sandbox start
```

La commande ne crée aucune donnée. Elle affiche un manifeste à conserver :

```json
{
  "runId": "mcp-xxxxxxxx",
  "startedAt": "2026-09-29T10:00:00.000Z",
  "restaurantId": "…",
  "restaurantSlug": "chez-suppernote-demo",
  "customerPhone": "+33612345600",
  "specialRequestsMarker": "MCP-SANDBOX:mcp-xxxxxxxx"
}
```

Pour rejouer exactement le même scénario plusieurs fois, fixez le `run-id` :

```zsh
pnpm --filter @suppernote/database mcp:sandbox start --run-id=chatgpt-20260929
```

## Scénario de test

Utiliser `chez-suppernote-demo`, le téléphone du manifeste et, pour chaque
réservation créée manuellement, ajouter le marqueur dans `specialRequests` :

```text
MCP-SANDBOX:chatgpt-20260929
```

Parcours minimal :

1. Initialisation MCP et lecture de `tools/list`.
2. `search_restaurants` sur Lyon.
3. `check_availability` sur un créneau futur.
4. `create_hold`, puis `create_reservation` avec consentement explicite.
5. `get_reservation_status` avec la référence et le téléphone.
6. `modify_reservation`.
7. `cancel_reservation`.
8. Répéter les accès négatifs avec un mauvais téléphone et un autre client.

## Consulter l’état

```zsh
pnpm --filter @suppernote/database mcp:sandbox status \
  --run-id=chatgpt-20260929 \
  --started-at=2026-09-29T10:00:00.000Z
```

## Purger le run

La purge est d’abord simulée. Le résultat sépare les réservations anonymisées, les
journaux d’audit et les consentements conservés des artefacts opérationnels à retirer :

```zsh
pnpm --filter @suppernote/database mcp:sandbox reset \
  --run-id=chatgpt-20260929 \
  --started-at=2026-09-29T10:00:00.000Z
```

Vérifier les compteurs, puis ajouter `--apply` :

```zsh
pnpm --filter @suppernote/database mcp:sandbox reset \
  --run-id=chatgpt-20260929 \
  --started-at=2026-09-29T10:00:00.000Z \
  --apply
```

Le reset supprime les holds, entrées de liste d’attente et clés d’idempotence du
run. Une réservation sans journal d’audit est supprimée. Une réservation déjà
auditée reste comme tombstone : si elle bloque encore un créneau, le reset
l’annule avec un nouvel événement d’audit, puis retire son nom, téléphone, email,
lien client, texte libre et clés d’idempotence. Son marqueur devient
`MCP-SANDBOX:<run-id>:PURGED`, ce qui rend le reset répétable sans ajouter des
événements d’anonymisation en double.

Les événements `reservation_audit_log` restent intacts et append-only. Les lignes
`customer_consents` sont aussi conservées comme preuves de consentement ; elles
ne contiennent que le hash du sujet, les choix, la version de politique et des
horodatages. Le compteur `customersReferencedOutsideRun` empêche de supprimer un
client encore rattaché à une réservation d’un autre run. Après reset, des
réservations anonymisées, journaux ou consentements peuvent donc rester visibles
dans les compteurs : ce sont les preuves conservées, pas des données de test
opérationnelles encore utilisables.

Ne désactivez pas le trigger append-only pour forcer leur suppression. La
commande refuse aussi une base de production dont le nom ne contient pas
`staging`, `test`, `dev` ou `local`.

## Matrice de compatibilité

Compléter
[`../release/evidence/mcp-connector-compatibility-matrix-2026-09-29.md`](../release/evidence/mcp-connector-compatibility-matrix-2026-09-29.md)
avec les captures d’écran OAuth et les résultats observés dans ChatGPT et
Claude. Une matrice vide ou `À exécuter` ne constitue pas une preuve de
compatibilité.

Le correctif OAuth ChatGPT (propagation/audience `resource`, RFC 9207,
`securitySchemes` et challenges de scopes) doit être rejoué sur le staging après
déploiement avant de remplacer les observations précédentes. Le serveur utilise
DCR ; CIMD n’est pas annoncé.
