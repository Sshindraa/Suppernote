# Runbook — Mac Migration

> **Statut : HISTORIQUE / PONCTUEL — audité le 12 septembre 2026.** Ce fichier n'est pas une tâche
> active. Il ne s'utilise qu'avec un bundle daté réellement présent sous
> `docs/archive/operations/`. Voir [`../DOCUMENTATION_STATUS.md`](../DOCUMENTATION_STATUS.md).

One-off procedure to clone the Suppernote environment from one Mac to another (Hermes config + profiles, SSH keys, `.env` Suppernote, `.zshrc` aliases). Not for daily use.

## Source Mac

```zsh
cd ~/Projects/Sokar/docs/archive/operations/mac-migration-<DATE>
./bundle.sh
# → produces ./out/sokar-mac-migration-<TS>.tar.gz.enc + .sha256 + PASSPHRASE-<TS>.txt
```

## Target Mac

Transport the archive + passphrase over a separate channel, then after cloning this repo (to have `install.sh`):

```zsh
cd docs/archive/operations/mac-migration-<DATE>
./install.sh /path/to/sokar-mac-migration-*.tar.gz.enc
# → decrypts, restores, verifies (config.yaml, auth.json, SSH sokar, profiles)
source ~/.zshrc
hermes doctor && ssh sokar 'hostname && pwd'
```

Details, contents, and what is **not** in the bundle (debug sessions, `node_modules`, local DBs): `docs/archive/operations/mac-migration-<DATE>/README.md`.
