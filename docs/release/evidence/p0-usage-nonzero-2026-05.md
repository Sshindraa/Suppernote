# P0 Usage — contrôle Telnyx non nul de mai 2026

Ce contrôle a été exécuté le 14 septembre 2026 en lecture seule depuis le
serveur de production. Il ne déclenche aucun appel ou SMS et n'écrit ni dans
Telnyx ni dans PostgreSQL.

## Résultat fournisseur

- Produit : `call-control`.
- Fenêtre : `2026-05-01T00:00:00Z` → `2026-06-01T00:00:00Z`.
- Rapport Telnyx avec dimension `currency` : `1 272 billed_sec`, `0,0424 USD`,
  devise `USD`.
- Facture : `65e15569-4298-40fd-bcf5-bf0bd73dba90`, période
  `2026-05-01` → `2026-05-31`, `paid: true`.
- PDF local : `private/telnyx-invoice-2026-05.pdf`, SHA-256
  `79a67a79639a540ece14a13054036db4f4f64b3ec444111bf930a4cd8ca4d942`.
- Le PDF confirme les lignes Telnyx : 21 minutes d'origination, 5 minutes de
  media streaming, 21 minutes de call control et une ligne prorated-MRC de
  `0,22581 USD`; le total de la période est `1,42 USD` après l'activation OTC
  de `1,00 USD`.

Le snapshot normalisé sans données d'identification est conservé dans
`private/telnyx-may-provider-evidence.json`, SHA-256
`8267b8db996e9fde6c9e672b39edfe44abf5e54b3a3f47e2a7c63c9e08b5f5eb`.

## Comparaison au ledger Suppernote

La requête Prisma sur `usage_events` de production pour la même fenêtre renvoie
`0` événement. La table `calls` contient `26` appels Telnyx pour `269` secondes
au total (agrégat conservé dans `private/telnyx-may-call-aggregate.json`,
SHA-256 `35ab842dd846119473e256f26ff79cebc34cce18e890b67321ee48a7db9e44af`),
soit un volume inférieur aux `1 272` secondes du rapport fournisseur. Le rapport
Telnyx ne contient qu'une agrégation par devise et aucun `restaurant_id` ; il ne
permet donc pas d'affecter les `1 003` secondes restantes à un établissement.
Le statut opérationnel est **écart de rattachement à résoudre**, équivalent à
une ligne `INVOICE_ONLY` pour le contrôle de clôture ; aucune correction n'a été
créée automatiquement.

Les unités ne sont pas interchangeables : `billed_sec` Telnyx est en USD, alors
que le ledger Suppernote et l'export comptable d'usage sont en EUR. Une prochaine
étape doit relier les identifiants d'appel aux événements Suppernote, puis documenter
le taux de change et la date de conversion avant toute écriture comptable.

## Conséquence pour P0

Le mois d'août reste rapproché à zéro et son MRC est conservé dans le paquet
interne séparé. Mai prouve qu'un trafic non nul existe dans le compte Telnyx,
mais il ne doit pas être affecté automatiquement à un restaurant tant que le
rattachement et la conversion USD/EUR ne sont pas validés. Cet écart reste un
suivi interne ; il ne retire pas la visibilité du cockpit admin et ne crée
aucun quota côté restaurateur. Le gel de production reste actif pour les autres
portes produit.
