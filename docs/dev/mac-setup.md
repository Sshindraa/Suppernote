# Mac dev setup — Suppernote

Configuration recommandée pour le développement local sur macOS, pour
éviter les `pack-objects died of signal 10` sur les pushes git.

## Symptôme

`git push` plante avec :

```
error: pack-objects died of signal 10
fatal: the remote end hung up unexpectedly
```

**Cause** : macOS swap saturé (système sous pression mémoire) +
`pack-objects` multi-thread. `signal 10` = SIGBUS, typique d'un mmap
qui touche une page swappée.

## Fix immédiat

```bash
git config --global pack.threads 1
git config --global pack.windowMemory 512m
git config --global pack.packSizeLimit 2g
```

- `pack.threads=1` : force le packing single-thread, plus économe en RAM
- `pack.windowMemory=512m` : cap la fenêtre de compression à 512 MB
- `pack.packSizeLimit=2g` : split les packs > 2 GB

## Diagnostic

```bash
bash scripts/quality/check-memory.sh
```

Affiche un warning si `swap > 50%` ou `free_ram < 500MB`. Exit code 0
toujours (warn only, on ne fail pas le push).

## Prévention

Pour les pushes longs (>10 commits ou beaucoup de fichiers), fermer les
apps lourdes (IDE, Docker Desktop, etc.) avant. La machine de dev
recommandée a 16 GB RAM minimum.

## Intégré au repo

- `scripts/quality/check-memory.sh` : le diagnostic (intégré au pre-push hook,
  affichage non-bloquant)
- `scripts/prepush-quality-gate.sh` : appelle check-memory avant le push
- Config git : non versionnée (machine-local). Chaque dev doit l'appliquer
  sur son Mac avec la commande ci-dessus.
