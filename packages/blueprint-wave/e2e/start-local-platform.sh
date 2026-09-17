#!/usr/bin/env bash
# Starts ONE local Cloudflare OS Workshop (backend + static frontend) for the platform e2e tests,
# without editing the cloudflare-os/ submodule. See ./README.md section 1.
#
#   packages/blueprint-whiteboard/e2e/start-local-platform.sh     # prints PGID and URL, then returns
#   packages/blueprint-whiteboard/e2e/stop-local-platform.sh      # kills the process group
#
# Env:
#   CFOS_REBUILD=1        force `pnpm install` + typed-storage + frontend builds
#
# The frontend is also rebuilt when its dist/ was built in Cloudflare Access mode
# (VITE_CF_ACCESS_MODE=true, e.g. by a deploy build): such a bundle never shows /signup or the
# password login, so every sign-up in the e2e helpers would time out. The flag is inlined at build
# time, and only an Access-mode bundle contains the `authenticateFromCfAccess` RPC call and the
# "Authenticating..." spinner text. The rebuild here always runs with VITE_CF_ACCESS_MODE unset.
#   CFOS_LOG=<path>       server log (default ${TMPDIR:-/tmp}/cfos-local-platform.log)
#   CFOS_READY_TIMEOUT=s  seconds to wait for http://localhost:8787 (default 240)
#
# The server's upstream launcher (scripts/run-dev-server.ts) is copied into a temp dir and patched
# at run time: imports point back at the submodule, `vp run --cache` becomes `--no-cache` (the cached
# mode fails with `spawn EBUSY` on WSL2) and the per-gatekeeper `vite build --watch` watchers are
# skipped (heat). The pnpm workspace behind it is untouched.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
C="$REPO/cloudflare-os"
URL="http://localhost:8787"
STATE_DIR="${TMPDIR:-/tmp}/cfos-local-platform"
PGID_FILE="$STATE_DIR/pgid"
LOG="${CFOS_LOG:-${TMPDIR:-/tmp}/cfos-local-platform.log}"
TIMEOUT="${CFOS_READY_TIMEOUT:-240}"

if [[ -z "$(command -v node)" || "$(command -v node)" == /mnt/c/* ]]; then
  echo "Linux node not on PATH; run: eval \"\$(fnm env)\" && fnm use v24.21.0" >&2
  exit 1
fi

# Exactly one platform: refuse if anything that looks like one is already running.
if running="$(ps -eo pid,pgid,args | grep -E 'wrangler|workerd|run-dev-server' | grep -v grep)"; then
  echo "A local platform (or wrangler/workerd) is already running; stop it first:" >&2
  echo "$running" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
PATCHED="$STATE_DIR/run-dev-server.patched.ts"
sed -e "s#from \"\./#from \"$C/scripts/#g" \
    -e "s#^import { parse } from .*#import { createRequire } from \"node:module\"; const { parse } = createRequire(\"$C/scripts/run-dev-server.ts\")(\"jsonc-parser\");#" \
    -e "s#^const SCRIPTS_DIR = .*#const SCRIPTS_DIR = \"$C/scripts\";#" \
    -e 's#"--cache"#"--no-cache"#g' \
    -e 's#^function spawnDevWatcher(label: string, command: string, args: string\[\]): void {#&  if (process.env.SPIKE_NO_WATCHERS) return;#' \
    "$C/scripts/run-dev-server.ts" > "$PATCHED"
# Fail loudly if upstream changed shape and a patch silently stopped applying.
for needle in 'const SCRIPTS_DIR = "' 'createRequire' '"--no-cache"' 'SPIKE_NO_WATCHERS'; do
  grep -qF -- "$needle" "$PATCHED" || { echo "patch did not apply ($needle); check $C/scripts/run-dev-server.ts" >&2; exit 1; }
done
if grep -qF '"--cache"' "$PATCHED"; then echo 'patch left a "--cache" flag behind' >&2; exit 1; fi

FRONTEND_DIST="$C/packages/workshop-frontend/dist"
access_mode_build() {
  [[ -d "$FRONTEND_DIST/assets" ]] && grep -rqlE 'authenticateFromCfAccess|Authenticating\.\.\.' "$FRONTEND_DIST/assets" "$FRONTEND_DIST/index.html" 2>/dev/null
}
if [[ -n "${CFOS_REBUILD:-}" || ! -d "$C/node_modules" || ! -f "$C/packages/typed-storage/dist/index.js" \
      || ! -f "$FRONTEND_DIST/index.html" ]] || access_mode_build; then
  if access_mode_build; then
    echo "The Workshop frontend dist/ was built in Cloudflare Access mode (no /signup); rebuilding without it."
  fi
  echo "Building typed-storage and the Workshop frontend (~20 s)..."
  (cd "$C" && pnpm install --frozen-lockfile >/dev/null \
    && pnpm --filter @gadgets/typed-storage build >/dev/null \
    && env -u VITE_CF_ACCESS_MODE pnpm --filter @gadgets/workshop-frontend exec vite build >/dev/null)
  if access_mode_build; then
    echo "frontend is still an Access-mode build (is VITE_CF_ACCESS_MODE set in an .env file?)" >&2; exit 1
  fi
  echo "Note: $FRONTEND_DIST is now a password-auth build; rebuild it before any deploy that reuses it."
fi

cd "$C"
# setsid: the server gets its own session/process group (PGID == its pid) so one kill stops
# wrangler, workerd and the build children together.
SPIKE_NO_WATCHERS=1 setsid node "$PATCHED" --serve-frontend-assets >"$LOG" 2>&1 </dev/null &
PID=$!
sleep 0.5
PGID="$(ps -o pgid= -p "$PID" | tr -d ' ' || true)"
PGID="${PGID:-$PID}"
echo "$PGID" > "$PGID_FILE"
echo "PGID $PGID (log: $LOG)"

deadline=$((SECONDS + TIMEOUT))
until curl -sf -o /dev/null --max-time 30 "$URL/"; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "server exited during startup; tail of $LOG:" >&2; tail -n 40 "$LOG" >&2; rm -f "$PGID_FILE"; exit 1
  fi
  if (( SECONDS > deadline )); then
    echo "not ready after ${TIMEOUT}s; stopping. tail of $LOG:" >&2; tail -n 40 "$LOG" >&2
    kill -- "-$PGID" 2>/dev/null || true; rm -f "$PGID_FILE"; exit 1
  fi
  sleep 2
done
echo "READY $URL"
echo "stop with: $HERE/stop-local-platform.sh   (or: kill -- -$PGID)"
