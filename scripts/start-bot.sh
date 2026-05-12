#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$APP_DIR"

mkdir -p logs data

if [[ ! -d node_modules ]]; then
  npm ci
fi

npm run build

exec npm start
