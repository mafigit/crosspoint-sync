#!/usr/bin/env bash
# End-to-end test: real server + real plugin + mocked KOReader (fake book).
# Needs: node >= 22.13, luajit, lua-socket, lua-cjson (apt: luajit lua-socket lua-cjson)
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
# Optional local rocks: luarocks --lua-version 5.1 --tree .rocks install luasocket lua-cjson
if [ -d .rocks ]; then
  export LUA_PATH="$PWD/.rocks/share/lua/5.1/?.lua;$PWD/.rocks/share/lua/5.1/?/init.lua;;"
  export LUA_CPATH="$PWD/.rocks/lib/lua/5.1/?.so;;"
fi
[ -f ffi/sha2.lua ] || { mkdir -p ffi; curl -sL https://raw.githubusercontent.com/koreader/koreader-base/master/ffi/sha2.lua -o ffi/sha2.lua; }
( cd "$ROOT"; [ -d node_modules ] || npm ci --silent; npm run build --silent )
DB="$(mktemp -d)/e2e.db"
DATABASE_PATH="$DB" PORT="${E2E_PORT:-18080}" node "$ROOT/dist/index.js" > "${DB%.db}-server.log" 2>&1 &
SERVER=$!; trap 'kill $SERVER' EXIT; sleep 2
E2E_PORT="${E2E_PORT:-18080}" PLUGIN_DIR="$ROOT/koreader/crosspointclippings.koplugin" luajit run.lua
