# P0 Usage — preuve locale du 14 septembre 2026

Cette preuve couvre la partie reproductible localement de P0. Elle ne constitue
pas un rapprochement fournisseur et ne ferme pas la porte de production.

## Base de test

- Base dédiée : `sokar_test` (PostgreSQL local, aucune donnée de staging ou de production).
- Les 77 migrations Prisma ont été appliquées avant l'exécution.
- Le rôle de test disposait des extensions PostgreSQL nécessaires à la migration.
- Après les tests, les tables de fixtures contenaient `0` restaurant et `0` ajustement,
  puis la base dédiée a été supprimée.

## Commandes et résultats

```text
DATABASE_URL=postgresql://<local-test-role>@127.0.0.1:5432/sokar_test \
AGENTIC_INT_TESTS=1 \
pnpm --filter @suppernote/api exec vitest run \
  src/modules/usage/__tests__/usage-adjustment.concurrency.integration.test.ts

Test Files  1 passed (1)
Tests       2 passed (2)
```

Les deux scénarios couvrent l'insertion concurrente d'ajustements et la course
sur la décision d'un même ajustement. La suite usage complète a ensuite passé
17 fichiers et 73 tests (2 tests d'intégration volontairement ignorés en dehors
de `AGENTIC_INT_TESTS=1`), dont les routes d'export comptable et de rapprochement,
les contrôles d'accès opérateur et les sept tests du connecteur Telnyx simulé.

Le connecteur local ne contacte pas Telnyx. Il vérifie la construction des
requêtes paginées, l'authentification bearer en mémoire, le contrôle de fenêtre
de 31 jours, le refus de fuite de clé dans les erreurs, la lecture et le téléchargement
borné d'une facture, le contrôle EUR et la sérialisation vers le format du rapprochement.

## Ce qui reste ouvert

- Importer le paquet fichier dans la destination comptable retenue et conserver
  le reçu ou l'identifiant d'import. Le paquet d'août et son MRC USD séparé
  sont décrits dans
  `docs/release/evidence/p0-usage-accounting-package-2026-08.md`.
- Résoudre le rattachement du rapport non nul de mai 2026 (1 272 secondes,
  0,0424 USD) à des événements Suppernote et documenter la conversion USD/EUR ; voir
  `docs/release/evidence/p0-usage-nonzero-2026-05.md`.
- Rejouer la preuve dans l'environnement CI/staging prévu par le runbook si cette
  exigence est retenue comme condition de clôture.

Les alertes de budget 70/90/100 restent un signal interne pour l'équipe Suppernote ;
elles ne modifient aucun quota ni parcours du restaurateur.
