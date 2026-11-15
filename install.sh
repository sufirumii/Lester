#!/usr/bin/env bash
# Lester installer — Linux / macOS. Options:
#   --offline   skip downloading Bun (expects bun on PATH or packaging/vendor/bun)
#   --systemd   install a systemd service (Linux, root)
set -euo pipefail

cd "$(dirname "$0")"
OFFLINE=0
SYSTEMD=0
for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    --systemd) SYSTEMD=1 ;;
  esac
done

echo "── Lester installer ──────────────────────────────"

# 1. Bun runtime
if ! command -v bun >/dev/null 2>&1; then
  if [ "$OFFLINE" = "1" ]; then
    if [ -x "packaging/vendor/bun" ]; then
      sudo mkdir -p /usr/local/bin && sudo cp packaging/vendor/bun /usr/local/bin/bun
    else
      echo "✗ --offline set but no bun on PATH and no packaging/vendor/bun." >&2
      exit 1
    fi
  else
    echo "· Installing Bun (the only download this installer makes)…"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi
echo "· Bun $(bun --version)"

# 2. Dependencies (from registry.npmjs.org — see docs/guide.md for the honest
#    network requirements list)
echo "· Installing dependencies…"
bun install --frozen-lockfile

# 2b. Repository hygiene files (v1.0.4): the release ZIP ships no dotfiles
#     (GitHub's web uploader skips OS-hidden files), so recreate them here.
if [ ! -f .gitignore ]; then
  cat > .gitignore <<'EOF'
# Lester .gitignore — env.example MUST be committed; runtime data, keys,
# logs and release artifacts must NOT be.

node_modules
/.next/
/out/
next-env.d.ts
*.tsbuildinfo
/coverage
/build

/db/
*.db
*.db-wal
*.db-shm
/dev-data/

.env
.env.*

*.pem
*.key
db/keys/

*.log
dev.log
server.log

*.zip
SHA256SUMS
SHA256SUMS.txt
lester-offline-bundle-*.tar.gz

.DS_Store
Thumbs.db

.vercel
.pnpm-debug.log*
EOF
  echo "· Created .gitignore"
fi
if [ ! -f .dockerignore ]; then
  cat > .dockerignore <<'EOF'
node_modules
.next
.git
staging
dist
db
*.db
*.db-wal
*.db-shm
.env
.env.*
*.log
*.zip
SHA256SUMS
.DS_Store
lester-offline-bundle-*.tar.gz
EOF
  echo "· Created .dockerignore"
fi

# 3. Database schema — real migrations, never destructive
echo "· Preparing the database (migrations; existing data is preserved)…"
bun run migrate

# 4. Launcher
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/lester" <<EOF
#!/usr/bin/env bash
cd "$(pwd)"
bun run start:prod
EOF
chmod +x "$BIN_DIR/lester"
echo "· Launcher installed: $BIN_DIR/lester"

# 5. Desktop entry (Linux)
if [ "$(uname -s)" = "Linux" ] && { command -v desktop-file-install >/dev/null 2>&1 || [ -d "$HOME/.local/share/applications" ]; }; then
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/lester.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Lester
Comment=Private AI control plane
Exec=$BIN_DIR/lester
Icon=$(pwd)/public/icons/icon-512.png
Terminal=false
Categories=Utility;
EOF
  echo "· Desktop entry installed."
fi

# 6. systemd service (optional)
if [ "$SYSTEMD" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  if [ "$(id -u)" != "0" ]; then
    echo "! --systemd needs root; run with sudo to install the service." >&2
  else
    cat > /etc/systemd/system/lester.service <<EOF
[Unit]
Description=Lester — private AI control plane
After=network.target

[Service]
Type=simple
User=${SUDO_USER:-root}
WorkingDirectory=$(pwd)
# loopback-only by default; override in /etc/lester.env for LAN exposure
EnvironmentFile=-/etc/lester.env
ExecStart=$(command -v bun) run start:prod
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now lester
    echo "· systemd service 'lester' installed and started."
  fi
fi

echo
echo "✔ Installed. Start with:"
echo "    bun run start:prod        (run from this folder: $(pwd))"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "    lester                    (launcher, works from anywhere)" ;;
  *) echo "    $BIN_DIR/lester   (launcher; $BIN_DIR is not on your PATH)" ;;
esac
echo "  then open http://localhost:8090"
echo "  Your data (database, backups, keys) lives in: $(pwd)/db"

# Friendly, non-fatal hint: Lester needs a local engine to answer prompts.
if ! curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo
  echo "· No Ollama detected on 127.0.0.1:11434. Lester needs a local engine to chat:"
  echo "    macOS:  brew install ollama && brew services start ollama"
  echo "    Linux:  https://ollama.com/download"
  echo "    then:   ollama pull llama3.2:1b"
  echo "  (LM Studio, llama.cpp and vLLM also work — see docs/guide.md.)"
fi
echo
echo "  Uninstall anytime: bash uninstall.sh"
