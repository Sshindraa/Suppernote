# Import de tickets de caisse par fichier — 10 novembre 2026

## Périmètre livré

- Import de tickets de caisse par fichier CSV (`POST /pos/checks/csv-import`, mode essai par défaut), liste des tickets (`GET /pos/checks`), rapprochement automatique ticket → réservation, page `/dashboard/caisse`.
- Livré par PR [#694](https://github.com/Sshindraa/Suppernote/pull/694) (commit `15b4f36a`).
- Limite : aucun connecteur fournisseur (pas d'API caisse, pas de webhook, pas de secret fournisseur). Le fichier est la seule source.

## Essai staging

Restaurant de démonstration « Chez Suppernote » passé en `PRO` sur staging seulement (base staging, retour arrière : `update restaurants set plan='STARTER'`). Drapeau `POS_CONNECTORS_ENABLED="true"` posé sur l'API staging le même jour (sauvegarde `.env.bak-pos-20261110224315`).

Fichier de test : 10 lignes fictives dont un doublon, une date invalide et un montant invalide. Quatre réservations de test insérées pour le 11/11/2026 (T1 19 h 30 à 2 couverts, T2 20 h à 4, T3 12 h 30 à 3, T1 20 h à 6).

| Étape                    | Résultat attendu         | Résultat obtenu                                                                                        |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Essai (dry run)          | 7 à importer, 3 ignorées | 7 à importer, 3 ignorées (doublon ligne 8, date ligne 9, montant ligne 10)                             |
| Rapprochements probables | 3                        | 3 (T-0001, T-0002, T-0003)                                                                             |
| À vérifier               | 1 (T-0004)               | 3 : T-0004 (attendu), T-0006 et T-0010 (heure et couverts compatibles, pas de table commune, score 50) |
| Non rapproché            | 1 (T-0005)               | 1 (T-0005)                                                                                             |

Écart à retenir : deux tickets « à vérifier » de plus que prévu. Le matcher les classe à vérifier parce que l'heure et le nombre de couverts concordent, même sans table commune. Ce comportement est conforme aux règles de score ; il reste à décider si le seuil doit l'exclure.

Écran sans droit Pro : « La caisse n'est pas incluse dans votre formule » (restaurant « Sokar Lyon Test », formule STARTER).

## Activation production — 10 novembre 2026

Demandée et confirmée par Hamza dans la session.

- `/opt/sokar/apps/api/.env` : sauvegarde `.env.bak-pos-20261110225618`, ligne `POS_CONNECTORS_ENABLED="true"` ajoutée.
- `sokar-api` redémarré avec `pm2 restart` (sans `--update-env`) ; `sokar-workers` non redémarré.
- `/health` : 200 en local et en public. `GET https://api.suppernote.com/pos/connections` sans connexion : 401.
- Aucun import en production, aucune formule modifiée.
- La valeur chargée n'est pas observable depuis l'extérieur ; la preuve est le redémarrage après écriture de la ligne.

Retour arrière :

```bash
cp -p /opt/sokar/apps/api/.env.bak-pos-20261110225618 /opt/sokar/apps/api/.env && pm2 restart sokar-api
```

## Conséquence sur le garde-fou

`POS_CONNECTORS_ENABLED` est retiré de `productionRelease.disabledFeatureFlags` du manifeste. `P6_POS` reste `LOCAL_ONLY` (connecteurs fournisseurs ouverts) et reste hors du profil requis.
