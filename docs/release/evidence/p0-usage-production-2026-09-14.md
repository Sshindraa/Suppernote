# P0 Usage — preuve Telnyx production du 14 septembre 2026

Cette preuve documente un contrôle réel, exécuté en lecture seule depuis le
serveur `sokar` avec la clé déjà présente dans le secret de l'API de production.
Le code n'a pas été déployé et aucun fichier n'a été placé dans le checkout
production : les scripts ont été copiés dans `/tmp`, puis les résultats utiles
ont été récupérés dans `private/` (répertoire ignoré par Git).

## Facture fournisseur

- Période : `2026-08-01` → `2026-08-31` (dernière période clôturée).
- `invoice_id` : `e1d3f6aa-db84-43b9-87d7-6c5331a68cb1`.
- Facture marquée `paid: true` par Telnyx.
- Fichier récupéré par l'action documentée `action=link` : 32 700 octets,
  SHA-256 `684e7026b10a8001b8d522f41071f469459d5ed171ab232083585d3eb23ae4fe`.
- Le PDF est libellé en USD et contient un MRC de `1.00 USD`; les rubriques
  d'usage voix et SMS sont à `0`. Le montant MRC n'est donc pas converti ou
  injecté dans le ledger EUR par ce contrôle. Le paquet comptable fichier
  séparé est décrit dans
  `docs/release/evidence/p0-usage-accounting-package-2026-08.md`.

## Usage et ledger

Les rapports `/v2/usage_reports` ont été interrogés séparément pour `messaging`
(`parts`) et `call-control` (`billed_sec`) avec la dimension `currency`.
Telnyx a retourné `0` ligne pour chacun. Le journal PostgreSQL de production
contient également `0` `UsageEvent` sur cette fenêtre.

Le snapshot normalisé est conservé dans `private/telnyx-usage-2026-08.json` et
son manifeste dans `private/telnyx-usage-2026-08.manifest.json` :

- hash du snapshot : `456bd237d22b44b719f614698721075eee44efaae860f93fdcb18ad587371936` ;
- les deux lignes explicites (SMS et voix) portent quantité et coût d'usage à
  `0.000000 EUR` et sont produites avec l'option contrôlée `--allow-empty`.

Le rapprochement a été exécuté contre la base PostgreSQL de production avec
tolérances nulles. Le rapport est dans
`private/telnyx-reconciliation-2026-08.json` :

```text
MATCH             2
MISMATCH          0
INVOICE_ONLY      0
USAGE_ONLY        0
UNPRICED_USAGE    0
reportHash        9db94f1930d99979ee97fc538cca2d6e96faf4d7641ae41610a0d1ec79f36087
```

Un rapport sans événement n'est classé `MATCH` que lorsque les quantités et
coûts fournisseur sont explicitement nuls. Cela évite de masquer une facture
réelle sans événement Suppernote.

Ce contrôle valide donc l'absence de consommation sur un mois réel. Un mois
non nul a ensuite été sondé en mai 2026 ; son résultat et l'écart de
rattachement sont décrits dans
`docs/release/evidence/p0-usage-nonzero-2026-05.md`.

## État de la porte

La preuve fournisseur, le rapprochement d'un mois à zéro et le paquet fichier
sont maintenant disponibles pour le périmètre **usage voix/SMS**. La porte
produit P0 est considérée **CLOSED** pour la fonctionnalité livrée : le ledger,
le suivi par établissement et le cockpit opérateur `/admin/margin`
sont disponibles, sans quota ni exposition côté restaurateur.

Le raccordement à un outil comptable et le rattachement du trafic non nul de
mai restent des suivis internes documentés. Ils ne bloquent pas la
visualisation des coûts ni le fonctionnement du produit. Le manifeste du
paquet conserve `READY_FOR_IMPORT` jusqu'au choix ultérieur d'une destination
comptable.

Les alertes 70/90/100 restent internes à Suppernote et aucune donnée de coût,
quota ou facture n'est exposée au dashboard restaurateur.
