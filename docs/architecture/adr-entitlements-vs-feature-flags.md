# ADR — Entitlements commerciaux et feature flags

Date : 13 septembre 2026 (réconcilié le 15 septembre 2026)

Statut : accepté, implémentation livrée dans le profil scoped ; ouverture commerciale complète toujours gelée

## Décision

Le plan effectif du restaurant détermine ses droits commerciaux. La matrice canonique vit dans
`packages/config/src/entitlements.ts` et l'API est seule autorisée à prendre une décision d'accès.
Le dashboard peut afficher cette décision, mais ne doit jamais l'inférer à partir du nom du plan.

ConfigCat peut temporairement remplacer le plan d'un restaurant pour un essai ou un déploiement
progressif. Une fois le plan effectif calculé, la même matrice d'entitlements s'applique. Un feature
flag ne peut donc pas contourner un droit commercial.

## Ordre d'évaluation

1. Charger le plan attaché au restaurant dans Postgres.
2. Appliquer, s'il est valide, l'override `restaurant_plan` de ConfigCat.
3. Normaliser les alias historiques : `STARTER → essential`, `PREMIUM → multi-site`.
4. Résoudre les capabilities et limites depuis `PLAN_ENTITLEMENTS`.
5. Vérifier séparément les flags de rollout, la configuration fournisseur et son état de santé.

```text
plan DB → override ConfigCat → plan commercial → entitlement → flag/runtime health → action
```

## Contrats

- `GET /entitlements` expose les droits du restaurant authentifié, sans coût fournisseur ni marge.
- `requireCapability(capability)` renvoie `403 CAPABILITY_NOT_INCLUDED` avant tout accès métier.
- `reactivation.manage` protège désormais la lecture, l'envoi et le rejet des campagnes de
  réactivation.
- Les fondations `pos.connect`, `reservations.payments`, `customers.group`, `reputation.feedback`,
  `reputation.loyalty`, `experiences.manage`, `events.manage` et `distribution.manage` sont maintenant
  dans la matrice. Elles restent refusées par les flags runtime tant que le fournisseur, le
  marchand et les preuves de pilote ne sont pas qualifiés ; `customers.group` est réservé au plan
  `multi-site`.
- Une capability absente ou fausse est refusée ; aucune règle commerciale ne doit être dupliquée
  dans une page du dashboard.

## Politique de consommation client

Les champs de minutes voix et de SMS restent `null` parce que la promesse Essential/Pro est sans
quota client. Ils ne bloquent ni appel, ni message, ni réservation. Le ledger et le cockpit
`/admin/margin` mesurent séparément le coût opérationnel par restaurant pour l'équipe
Suppernote. Un éventuel budget interne ou seuil d'alerte doit vivre dans ce périmètre opérateur et ne
doit jamais devenir un entitlement client.

Les capabilities CRM avancé, campagnes, attribution et réputation sont maintenant présentes dans la
matrice et protègent les routes correspondantes. Les capacités POS, paiement de réservation, groupe,
expériences et distribution suivent
la même séparation entitlement/flag. Elles restent toutefois soumises aux flags/runtime health :
les campagnes d'envoi sont bloquées par défaut (`MARKETING_SENDS_ENABLED`), comme les connecteurs
POS (`POS_CONNECTORS_ENABLED`), la protection bancaire (`RESERVATION_PAYMENTS_ENABLED`), le
groupe CRM (`CUSTOMER_GROUPS_ENABLED`), les expériences
(`EXPERIENCES_ENABLED`), les événements
(`EVENTS_ENABLED`) et la distribution (`DISTRIBUTION_ENABLED`). Le code local peut
donc être testé sans ouvrir un effet
externe ni modifier le contrat commercial par inadvertance.

## Règle de migration

Toute nouvelle restriction sur une fonction déjà utilisée doit être déployée en trois temps :

1. décision observable sans blocage ;
2. mesure des restaurants qui seraient refusés ;
3. enforcement après correction des plans ou période de grâce.

La réactivation est directement protégée car elle est déjà définie comme une fonction Pro et ses
tests couvrent explicitement Essential refusé et Pro autorisé.

La réputation et la fidélité manuelle sont réservées à Pro/Multi-site sans flag de gel.
