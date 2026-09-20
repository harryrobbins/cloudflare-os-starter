#!/usr/bin/env bash
# Starts the local Cloudflare OS platform with THIS package bound to the dev router as
# `GATEKEEPER_CHAT`, so `/gatekeeper/chat/*` and the WebSocket upgrade are proved end to end through
# the real router rather than against the chat Worker directly.
#
#   packages/gatekeeper-chat/e2e/start-local-platform.sh     # prints PGID and URL, then returns
#   packages/gatekeeper-chat/e2e/stop-local-platform.sh      # kills the process group
#
# Nothing in `cloudflare-os/` is edited. The submodule's launcher (`scripts/run-dev-server.ts`) is
# copied into a temp dir and patched there, exactly as
# `packages/blueprint-whiteboard/e2e/start-local-platform.sh` does, with two extra patches of our own:
#
#   1. the generated dev-router config gains a service binding named by `$EXTRA_ROUTER_SERVICE`
#      ("GATEKEEPER_CHAT=cfos-chat-dev"), so the router's `GATEKEEPER_*` scan finds it;
#   2. `$EXTRA_WRANGLER_CONFIGS` is prepended to the `-c` list, so the same multi-config
#      `wrangler dev` also starts this package's Worker. One workerd, so a service binding between
#      two configs is a real binding and a WebSocket upgrade survives it.
#
# The chat Worker keeps its own `wrangler.dev.jsonc` (dev identities, local R2, `app/dist` assets).
# Env: CFOS_REBUILD=1, CFOS_LOG, CFOS_READY_TIMEOUT -- same meanings as the whiteboard script.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"
C="$REPO/cloudflare-os"
URL="http://localhost:8787"
STATE_DIR="${TMPDIR:-/tmp}/cfos-chat-platform"
PGID_FILE="$STATE_DIR/pgid"
LOG="${CFOS_LOG:-${TMPDIR:-/tmp}/cfos-chat-platform.log}"
TIMEOUT="${CFOS_READY_TIMEOUT:-300}"

if [[ -z "$(command -v node)" || "$(command -v node)" == /mnt/c/* ]]; then
  echo "Linux node not on PATH; run: eval \"\$(fnm env)\" && fnm use v24.21.0" >&2
  exit 1
fi

if running="$(ps -eo pid,pgid,args | grep -E 'wrangler(\.js)? dev|/workerd |run-dev-server' | grep -v grep)"; then
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
    -e 's#^  const srcPath = join(ROOT, "wrangler.jsonc");#&\n  const extraService = process.env.EXTRA_ROUTER_SERVICE;#' \
    -e '0,/^  config.services = config.services || \[\];/s##&\n  if (extraService !== undefined) { const [binding, service] = extraService.split("="); config.services.push({ binding, service }); }#' \
    -e 's#^const configs = \[#&\n  ...(process.env.EXTRA_WRANGLER_CONFIGS ? process.env.EXTRA_WRANGLER_CONFIGS.split(",") : []),#' \
    "$C/scripts/run-dev-server.ts" > "$PATCHED"
for needle in 'const SCRIPTS_DIR = "' 'createRequire' '"--no-cache"' 'SPIKE_NO_WATCHERS' \
              'EXTRA_ROUTER_SERVICE' 'EXTRA_WRANGLER_CONFIGS'; do
  grep -qF -- "$needle" "$PATCHED" || { echo "patch did not apply ($needle); check $C/scripts/run-dev-server.ts" >&2; exit 1; }
done
if grep -qF '"--cache"' "$PATCHED"; then echo 'patch left a "--cache" flag behind' >&2; exit 1; fi
# Two traps in one line. `\|` is GNU sed's BRE *alternation*, not a literal pipe, so writing the anchor
# with `\|\|` matches the empty string on every line and rewrites the whole file, silently. And both
# the router and the workshop-backend generator have a `config.services = config.services || [];`
# line, so the substitution is addressed to the first match only -- `extraService` is declared in the
# router's block and is not in scope in the other one.
if [[ "$(grep -c 'extraService' "$PATCHED")" -ne 2 ]]; then
  echo "the router-config patch did not apply cleanly (expected exactly 2 extraService lines)" >&2
  exit 1
fi
awk '/const srcPath = join\(ROOT, "wrangler.jsonc"\);/{r=NR} /extraService/{last=NR} END{exit (r>0 && last>r)?0:1}' "$PATCHED" \
  || { echo "the router-config patch did not land in the router block" >&2; exit 1; }

FRONTEND_DIST="$C/packages/workshop-frontend/dist"
access_mode_build() {
  [[ -d "$FRONTEND_DIST/assets" ]] && grep -rqlE 'authenticateFromCfAccess|Authenticating\.\.\.' "$FRONTEND_DIST/assets" "$FRONTEND_DIST/index.html" 2>/dev/null
}
if [[ -n "${CFOS_REBUILD:-}" || ! -d "$C/node_modules" || ! -f "$C/packages/typed-storage/dist/index.js" \
      || ! -f "$FRONTEND_DIST/index.html" ]] || access_mode_build; then
  echo "Building typed-storage and the Workshop frontend (~20 s)..."
  (cd "$C" && pnpm install --frozen-lockfile >/dev/null \
    && pnpm --filter @gadgets/typed-storage build >/dev/null \
    && env -u VITE_CF_ACCESS_MODE pnpm --filter @gadgets/workshop-frontend exec vite build >/dev/null)
fi

# The assets binding reads app/dist once, at start-up.
echo "Building the chat SPA..."
(cd "$REPO" && pnpm --filter gatekeeper-chat build >/dev/null)

# A copy of this package's dev config with every path made absolute, in the state dir.
#
# The multi-config `wrangler dev` runs from the submodule root, and a custom build's `cwd` defaults to
# the invocation directory rather than the config's -- so `pnpm exec capnweb-validate` would run in
# `cloudflare-os/`, which does not have it. (The submodule's own generator sets `build.cwd` per worker
# for exactly this reason; it only does it for the gatekeepers it discovers.) `main` and the asset
# directory move with it, so they are absolute too. Nothing in the package is edited.
CHAT_CONFIG="$STATE_DIR/gatekeeper-chat.wrangler.dev.jsonc"
CHAT_CONFIG="$CHAT_CONFIG" PKG="$PKG" node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const { createRequire } = require("node:module");
  const { parse } = createRequire(process.env.PKG + "/package.json")("jsonc-parser");
  const pkg = process.env.PKG;
  const config = parse(readFileSync(pkg + "/wrangler.dev.jsonc", "utf8"));
  config.main = pkg + "/" + config.main.replace(/^\.\//, "");
  config.build = { ...config.build, cwd: pkg };
  if (config.assets) config.assets.directory = pkg + "/" + config.assets.directory.replace(/^\.\//, "");
  writeFileSync(process.env.CHAT_CONFIG, JSON.stringify(config, null, 2) + "\n");
'

cd "$C"
SPIKE_NO_WATCHERS=1 \
EXTRA_ROUTER_SERVICE="GATEKEEPER_CHAT=cfos-chat-dev" \
EXTRA_WRANGLER_CONFIGS="$CHAT_CONFIG" \
  setsid node "$PATCHED" --serve-frontend-assets >"$LOG" 2>&1 </dev/null &
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
echo "READY $URL  (chat through the router: $URL/gatekeeper/chat/dev/login?as=dev-admin)"
echo "stop with: $HERE/stop-local-platform.sh   (or: kill -- -$PGID)"
