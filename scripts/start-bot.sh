#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$APP_DIR"

mkdir -p logs data

if [[ ! -d node_modules ]]; then
  npm ci
fi

needs_build=false
if [[ ! -f dist/src/index.js ]]; then
  needs_build=true
elif [[ package.json -nt dist/src/index.js || package-lock.json -nt dist/src/index.js || tsconfig.json -nt dist/src/index.js ]]; then
  needs_build=true
else
  newer_source="$(find src tests -type f -newer dist/src/index.js -print -quit)"
  if [[ -n "$newer_source" ]]; then
    needs_build=true
  fi
fi

if [[ "$needs_build" == true ]]; then
  npm run build
fi

exec npm start
