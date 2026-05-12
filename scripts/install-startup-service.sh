#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$SYSTEMD_USER_DIR"
install -m 0644 "$APP_DIR/systemd/valiant-brave.service" "$SYSTEMD_USER_DIR/valiant-brave.service"
install -m 0644 "$APP_DIR/systemd/telegram-trading-bot.service" "$SYSTEMD_USER_DIR/telegram-trading-bot.service"

systemctl --user daemon-reload
systemctl --user enable valiant-brave.service telegram-trading-bot.service
systemctl --user restart valiant-brave.service telegram-trading-bot.service

cat <<'MESSAGE'
Startup services installed and started.

Useful commands:
  systemctl --user status telegram-trading-bot.service
  systemctl --user status valiant-brave.service
  journalctl --user -u telegram-trading-bot.service -f
  journalctl --user -u valiant-brave.service -f

To start these user services before login, run:
  sudo loginctl enable-linger "$USER"

If Brave needs your desktop session or wallet unlock, leave linger disabled and the services
will start when you log in.
MESSAGE
