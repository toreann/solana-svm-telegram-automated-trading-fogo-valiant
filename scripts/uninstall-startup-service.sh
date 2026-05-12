#!/usr/bin/env bash
set -euo pipefail

systemctl --user disable --now telegram-trading-bot.service valiant-brave.service || true
systemctl --user daemon-reload

echo "Startup services disabled."
