#!/usr/bin/env bash
#
# Installs scripts/updater.sh as a systemd service on this server, so the app's
# settings page can update / roll back the app (experimental).
#
#   make updater-install        install + start
#   make updater-uninstall      stop + remove
#   make updater-status         is it running?
#   make updater-logs           what did it do?
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="warehouse-updater.service"
UNIT_PATH="/etc/systemd/system/${UNIT}"
SUDO=""
[[ "$(id -u)" -eq 0 ]] || SUDO="sudo"

command -v systemctl >/dev/null 2>&1 || { echo "systemd is required (systemctl not found)." >&2; exit 1; }

case "${1:-install}" in
  install)
    git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1 || { echo "$ROOT_DIR is not a git checkout; the updater needs one." >&2; exit 1; }
    $SUDO tee "$UNIT_PATH" >/dev/null <<EOF
[Unit]
Description=Warehouse app updater (handles update / rollback requests from the settings page)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
ExecStart=/usr/bin/env bash ${ROOT_DIR}/scripts/updater.sh run
Restart=always
RestartSec=10
Environment=HOME=${HOME}

[Install]
WantedBy=multi-user.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now "$UNIT"
    echo "Installed and started ${UNIT}."
    echo "Open the app: تنظیمات > نسخه و به‌روزرسانی. Logs: make updater-logs"
    ;;
  uninstall)
    $SUDO systemctl disable --now "$UNIT" 2>/dev/null || true
    $SUDO rm -f "$UNIT_PATH"
    $SUDO systemctl daemon-reload
    echo "Removed ${UNIT}."
    ;;
  status)
    $SUDO systemctl --no-pager status "$UNIT" || true
    ;;
  logs)
    $SUDO journalctl -u "$UNIT" --no-pager -n "${LINES_N:-80}"
    ;;
  *)
    echo "usage: $0 [install|uninstall|status|logs]" >&2; exit 1 ;;
esac
