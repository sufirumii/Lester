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
if command -v desktop-file-install >/dev/null 2>&1 || [ -d "$HOME/.local/share/applications" ]; then
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
echo "    lester            (or: bun run start:prod)"
echo "  then open http://localhost:8090"
echo "  Uninstall anytime: bash uninstall.sh"
