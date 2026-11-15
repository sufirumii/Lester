#!/usr/bin/env bash
# Lester uninstaller — Linux / macOS. NEVER deletes user data (db/, backups,
# keys, .env) without an explicit confirmation for each.
set -euo pipefail
cd "$(dirname "$0")"

echo "── Lester uninstaller ────────────────────────────"

# service
if systemctl list-unit-files 2>/dev/null | grep -q "^lester.service"; then
  sudo systemctl disable --now lester || true
  sudo rm -f /etc/systemd/system/lester.service
  sudo systemctl daemon-reload || true
  echo "· systemd service removed."
fi

# launcher + desktop entry (never touches data)
rm -f "$HOME/.local/bin/lester" "$HOME/.local/share/applications/lester.desktop"
echo "· Launcher and desktop entry removed."

# data (explicit confirmation, default NO)
reply=""
read -r -p "Delete all Lester data (database, backups, keys) in ./db? [y/N] " reply || true
if [[ "$reply" =~ ^[Yy]$ ]]; then
  rm -rf db
  echo "· Data deleted."
else
  echo "· Data kept in $(pwd)/db"
fi

echo "✔ Uninstalled. The source tree remains at $(pwd) — delete it if you wish."
