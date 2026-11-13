# Mac Migration — 2026-07-01

Tout ce qu'il faut pour cloner l'environnement complet de l'ancien Mac (`MacBookPro.lan`) vers le nouveau, en chiffré AES-256.

## Fichiers

| Fichier      | Où          | Rôle                                       |
| ------------ | ----------- | ------------------------------------------ |
| `bundle.sh`  | ancien Mac  | Crée `sokar-mac-migration-<TS>.tar.gz.enc` |
| `install.sh` | nouveau Mac | Déchiffre, restore, vérifie                |

## Étapes

### 1. Sur l'ancien Mac (ici)

```bash
cd ~/Projects/Sokar/docs/archive/operations/mac-migration-2026-07-01
./bundle.sh
# → te demande une passphrase (12+ caractères, note-la !)
# → produit dans ./out/ :
#     sokar-mac-migration-YYYYMMDD_HHMMSS.tar.gz.enc
#     sokar-mac-migration-YYYYMMDD_HHMMSS.sha256
#     sokar-mac-migration-YYYYMMDD_HHMMSS.README.txt
#     README-LATEST.txt
```

### 2. Transfert vers le nouveau Mac

AirDrop ne gère pas bien les `.enc` à travers le Finder. Deux options :

- **Option A (recommandé)** : AirDrop le `.tar.gz` (sans le `.enc`) et le `.sha256`. Garder le chiffrement sur le nouveau Mac via install.sh qui demande la passphrase.
- **Option B** : Si tu préfères transporter l'archive chiffrée, mets-la dans une **archive zip protégée par mot de passe** (`Archive Utility` > menu `Fichier > Archiver "..."` avec mot de passe), puis AirDrop du `.zip`.

Note: macOS AirDrop ne supporte pas nativement les fichiers `.enc` chiffrés avec openssl — d'où l'astuce du conteneur zip.

### 3. Sur le nouveau Mac

```bash
# 1. Install Xcode CLT si pas déjà fait :  xcode-select --install
# 2. Install Homebrew : /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# 3. Install git, openssl (déjà là normalement)
# 4. Install pipx :  brew install pipx && pipx ensurepath
# 5. Clone le repo Sokar (pour avoir install.sh) :
gh repo clone Sshindraa/Sokar /Users/hamza/Desktop/Sokar
# ou:  git clone https://github.com/Sshindraa/Sokar.git /Users/hamza/Desktop/Sokar

# 6. Lance l'install :
cd ~/Projects/Sokar/docs/archive/operations/mac-migration-2026-07-01
./install.sh /chemin/vers/sokar-mac-migration-*.tar.gz.enc
# → te demande la passphrase
# → restore Hermes, profils, SSH, .env, alias .zshrc

# 7. Relance le terminal
source ~/.zshrc

# 8. Vérifs
hermes doctor
ssh pmbtc 'hostname && pwd'
```

## Ce qui est restauré

- **Hermes racine** : `config.yaml`, `auth.json`, `.env`, `memories/`, `kanban.db`, `cron_jobs.json`, `plugins/`, `skills/`
- **5 profils** (`default`, `backend`, `dashboard`, `database`, `supervisor`) : `config.yaml`, `auth.json`, `bin/`, `state.db`, `lsp/`, caches
- **SSH** : `config`, `known_hosts`, `sokar_ovh{,.pub}`, `mac_tunnel_key`
- **Suppernote** : `.env.local`, `packages/database/.env`
- **Shell** : `extras.zsh` injecté dans `~/.zshrc` (PATH node@22, alias `sokar-tunnel`, alias `sokar`)

## Ce qui N'est PAS dans le bundle (volontairement)

- Sessions de debug (`~/.hermes/profiles/*/sessions/*`) — régénérées à l'usage
- `node_modules/`, caches pnpm, `target/` — réinstallés via `pnpm install`
- `.git/` du repo Suppernote — re-cloné depuis GitHub
- Bases Postgres/Redis — ce sont des services à réinstaller (brew services)
- Clés API et tokens vivants restent dans `auth.json` + `config.yaml` du bundle

## Checklist post-install

- [ ] `hermes doctor` (vert)
- [ ] `hermes` démarre en TUI sans erreur
- [ ] `ssh pmbtc 'hostname && pwd'` répond depuis le VPS
- [ ] `pmbtc-tunnel` (alias) ouvre le tunnel SSH
- [ ] `cd /Users/hamza/Desktop/Sokar && PATH="/usr/local/opt/node@22/bin:$PATH" pnpm install`
- [ ] `pnpm db:push` (si DB locale présente)
- [ ] `pnpm dev` démarre API + dashboard

## Si install.sh échoue

Les diagnostics les plus courants :

- **passphrase refusée** : tu t'es trompé, réessaie. Bundle.sh te l'a montrée au moment de la saisir, l'astuce c'est de la stocker dans un mot de passe iCloud Keychain si possible.
- **Permission denied** : relance avec `chmod +x install.sh && ./install.sh ...`
- **hermes pas dans le PATH** : `pipx install hermes-agent && pipx ensurepath`, puis re-ouvre le terminal.
- **SSH host key changed** : si ton nouveau Mac voit le VPS comme un nouvel hôte, copie aussi le `known_hosts` (déjà inclus).
