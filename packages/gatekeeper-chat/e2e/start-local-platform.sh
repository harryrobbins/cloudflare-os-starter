#!/usr/bin/env bash
# Starts the local Cloudflare OS platform with THIS package bound to the dev router as
# `GATEKEEPER_CHAT`, so `/gatekeeper/chat/*`, the WebSocket upgrade and the shell's chat dock are proved
# end to end through the real router rather than against the chat Worker directly.
#
#   packages/gatekeeper-chat/e2e/start-local-platform.sh     # prints PGIDs and URL, then returns
#   packages/gatekeeper-chat/e2e/stop-local-platform.sh      # kills both process groups
#
# Two `wrangler dev` processes, not one:
#
#   1. the platform, from the submodule's launcher (`scripts/run-dev-server.ts`) copied into a temp
#      dir and patched there, exactly as `packages/blueprint-whiteboard/e2e/start-local-platform.sh`
#      does, plus one patch of our own: the generated dev-router config gains a service binding named
#      by `$EXTRA_ROUTER_SERVICE` ("GATEKEEPER_CHAT=cfos-chat-dev"), so the router's `GATEKEEPER_*`
#      scan finds it. Nothing in `cloudflare-os/` is edited.
#   2. this package's Worker, `wrangler dev -c wrangler.dev.jsonc --port 8788`, started AFTER the
#      platform. The router reaches it through wrangler's local dev registry (a service binding whose
#      target runs in another `wrangler dev` on the same machine), and a WebSocket upgrade survives it.
#
# Why not one multi-config `wrangler dev` with the chat config appended, which is what the whiteboard
# needs? Because both the Workshop backend (the frontend dist) and this Worker (`app/dist`) carry an
# `assets` directory, and one workerd serves ONE asset directory: with the chat config in the list the
# shell's `/` answered with the chat app's index.html and its bundle 500'd. Two processes keep the two
# asset servers apart. Two rules the registry imposes, both learned the hard way:
#
#   - Same wrangler version on both sides. The platform runs the submodule's wrangler; this package's
#     own is newer, and the older one prunes a registry entry the newer one wrote, so the router
#     answered 503 within a minute. The chat Worker is therefore started with `$C/node_modules/.bin/wrangler`.
#   - Chat after the platform. A platform start prunes entries it did not see come up, so restarting
#     the platform alone leaves the router with a 503 until the chat process is restarted too.
#
# Env: CFOS_REBUILD=1, CFOS_LOG, CFOS_READY_TIMEOUT -- same meanings as the whiteboard script. Plus
# VITE_CHAT_DOCK (default "true"), which is the *shell's* build-time flag for the chat dock: the
# frontend dist is rebuilt whenever it does not match, because a dist built without it has no sidebar
# row, no drawer and no /chat route to check.
#
# CHAT_IN_PLATFORM=1 is the other layout, for `@agent` (e2e/agent-check.mjs): this Worker runs INSIDE
# the platform's workerd, appended to its multi-config `wrangler dev` (one more patch:
# `EXTRA_WORKER_CONFIG`), from a generated copy of wrangler.dev.jsonc with no `assets` -- so the API
# works and the SPA does not. It exists because a question to the Agent hands the Workshop a
# `ctx.exports` service stub to call back, and a service stub cannot cross two workerd processes:
# each encrypts its stub tokens with its own key, and the platform logs "channel token failed
# authentication" for every call. In production both Workers run in one account and the stub
# travels like the gatekeepers' account stubs the Workshop already stores.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"
C="$REPO/cloudflare-os"
URL="http://localhost:8787"
CHAT_PORT=8788
STATE_DIR="${TMPDIR:-/tmp}/cfos-chat-platform"
PGID_FILE="$STATE_DIR/pgid"
CHAT_PGID_FILE="$STATE_DIR/chat.pgid"
LOG="${CFOS_LOG:-${TMPDIR:-/tmp}/cfos-chat-platform.log}"
CHAT_LOG="${LOG%.log}.chat.log"
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
    -e 's#^  \.\.\.gatekeepers\.map(gk => join(gk\.dir, "wrangler\.dev\.jsonc")),#&\n  ...(process.env.EXTRA_WORKER_CONFIG ? [process.env.EXTRA_WORKER_CONFIG] : []),#' \
    "$C/scripts/run-dev-server.ts" > "$PATCHED"
for needle in 'const SCRIPTS_DIR = "' 'createRequire' '"--no-cache"' 'SPIKE_NO_WATCHERS' 'EXTRA_ROUTER_SERVICE' 'EXTRA_WORKER_CONFIG'; do
  grep -qF "$needle" "$PATCHED" || { echo "patch did not apply: $needle (has run-dev-server.ts changed?)" >&2; exit 1; }
done
# `\|` is alternation in GNU sed's BRE, so the `config.services || []` anchor above is written with
# `[]` only; make sure it landed exactly once, inside the router block, and not somewhere else.
if [[ "$(grep -c 'extraService' "$PATCHED")" -ne 2 ]]; then
  echo "the router-config patch landed $(grep -c 'extraService' "$PATCHED") times, expected 2" >&2; exit 1
fi
awk '/const srcPath = join\(ROOT, "wrangler.jsonc"\);/{r=NR} /extraService/{last=NR} END{exit (r>0 && last>r)?0:1}' "$PATCHED" \
  || { echo "the router-config patch did not land in the router block" >&2; exit 1; }

FRONTEND_DIST="$C/packages/workshop-frontend/dist"

# The chat *dock* is a build-time flag in the shell (`VITE_CHAT_DOCK`, read by
# `packages/workshop-frontend/src/chatDockBus.ts`), so this script owns it: a run through the real
# router exists to drive the shell against this Worker, and a dist built without the flag has no
# sidebar row, no drawer and no /chat route. Default on; `VITE_CHAT_DOCK=false` checks the other build.
CHAT_DOCK="${VITE_CHAT_DOCK:-true}"

access_mode_build() {
  [[ -d "$FRONTEND_DIST/assets" ]] && grep -rqlE 'authenticateFromCfAccess|Authenticating\.\.\.' "$FRONTEND_DIST/assets" "$FRONTEND_DIST/index.html" 2>/dev/null
}
# Which way the *existing* dist was built, so a rebuild happens when the flag changed rather than only
# when the directory is missing. `CHAT_DOCK_ENABLED` is a folded constant, so exactly one side of
# `ChatPage`'s `if (!CHAT_DOCK_ENABLED)` survives: the flag-off message is in the bundle iff the flag
# was off. Prints `true`, `false`, or nothing when there is no dist to read.
dock_flag_in_dist() {
  [[ -d "$FRONTEND_DIST/assets" ]] || return 0
  if grep -rqF 'Team chat is not enabled' "$FRONTEND_DIST/assets"; then echo false; else echo true; fi
}
if [[ -n "${CFOS_REBUILD:-}" || ! -d "$C/node_modules" || ! -f "$C/packages/typed-storage/dist/index.js" \
      || ! -f "$FRONTEND_DIST/index.html" || "$(dock_flag_in_dist)" != "$CHAT_DOCK" ]] || access_mode_build; then
  echo "Building typed-storage and the Workshop frontend with VITE_CHAT_DOCK=$CHAT_DOCK (~20 s)..."
  (cd "$C" && pnpm install --frozen-lockfile >/dev/null \
    && pnpm --filter @gadgets/typed-storage build >/dev/null \
    && env -u VITE_CF_ACCESS_MODE VITE_CHAT_DOCK="$CHAT_DOCK" \
         pnpm --filter @gadgets/workshop-frontend exec vite build >/dev/null)
fi
# Loudly rather than a shell with no way into chat and no explanation.
if [[ "$(dock_flag_in_dist)" != "$CHAT_DOCK" ]]; then
  echo "the frontend dist does not match VITE_CHAT_DOCK=$CHAT_DOCK (got '$(dock_flag_in_dist)');" >&2
  echo "if ChatPage's flag-off message changed, update dock_flag_in_dist() in this script" >&2
  exit 1
fi

# The assets binding reads app/dist once, at start-up.
echo "Building the chat SPA..."
(cd "$REPO" && pnpm --filter gatekeeper-chat build >/dev/null)

stop_all() {
  for f in "$CHAT_PGID_FILE" "$PGID_FILE"; do
    [[ -f "$f" ]] && { kill -- "-$(cat "$f")" 2>/dev/null || true; rm -f "$f"; }
  done
}

# --- in-platform layout: this Worker's dev config, minus `assets`, for the platform's own workerd -----
EXTRA_WORKER_CONFIG=""
if [[ -n "${CHAT_IN_PLATFORM:-}" ]]; then
  mkdir -p "$PKG/.wrangler/in-platform"
  EXTRA_WORKER_CONFIG="$PKG/.wrangler/in-platform/wrangler.jsonc"
  (cd "$REPO" && PKG="$PKG" OUT="$EXTRA_WORKER_CONFIG" node --input-type=module -e '
    import { createRequire } from "node:module";
    import { readFileSync, writeFileSync } from "node:fs";
    const { parse } = createRequire(process.cwd() + "/package.json")("jsonc-parser");
    const pkg = process.env.PKG;
    const config = parse(readFileSync(pkg + "/wrangler.dev.jsonc", "utf8"), [], { allowTrailingComma: true });
    delete config.assets;
    delete config["$schema"];
    config.main = pkg + "/" + config.main;
    config.build = { ...config.build, cwd: pkg, watch_dir: pkg + "/src" };
    writeFileSync(process.env.OUT, JSON.stringify(config, null, 2));
  ')
  echo "chat runs inside the platform process (API only, no SPA): $EXTRA_WORKER_CONFIG"
fi

# --- 1. the platform ---------------------------------------------------------------------------
cd "$C"
SPIKE_NO_WATCHERS=1 \
EXTRA_ROUTER_SERVICE="GATEKEEPER_CHAT=cfos-chat-dev" \
EXTRA_WORKER_CONFIG="$EXTRA_WORKER_CONFIG" \
  setsid node "$PATCHED" --serve-frontend-assets >"$LOG" 2>&1 </dev/null &
PID=$!
sleep 0.5
PGID="$(ps -o pgid= -p "$PID" | tr -d ' ' || true)"
PGID="${PGID:-$PID}"
echo "$PGID" > "$PGID_FILE"
echo "platform PGID $PGID (log: $LOG)"

deadline=$((SECONDS + TIMEOUT))
until curl -sf -o /dev/null --max-time 30 "$URL/"; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "the platform exited during startup; tail of $LOG:" >&2; tail -n 40 "$LOG" >&2; stop_all; exit 1
  fi
  if (( SECONDS > deadline )); then
    echo "the platform was not ready after ${TIMEOUT}s; stopping. tail of $LOG:" >&2; tail -n 40 "$LOG" >&2
    stop_all; exit 1
  fi
  sleep 2
done

if [[ -n "$EXTRA_WORKER_CONFIG" ]]; then
  until curl -sf -o /dev/null --max-time 10 "$URL/gatekeeper/chat/dev/identities"; do
    if (( SECONDS > deadline )); then
      echo "the router did not reach the in-platform chat Worker within ${TIMEOUT}s; tail of $LOG:" >&2
      tail -n 30 "$LOG" >&2; stop_all; exit 1
    fi
    sleep 2
  done
  echo "READY $URL  (chat API inside the platform: $URL/gatekeeper/chat/dev/login?as=dev-admin; no SPA)"
  echo "stop with: $HERE/stop-local-platform.sh   (or: kill -- -$PGID)"
  exit 0
fi

# --- 2. this Worker, registered with the platform's wrangler ---------------------------------------
cd "$PKG"
setsid "$C/node_modules/.bin/wrangler" dev -c wrangler.dev.jsonc --port "$CHAT_PORT" >"$CHAT_LOG" 2>&1 </dev/null &
CHAT_PID=$!
sleep 0.5
CHAT_PGID="$(ps -o pgid= -p "$CHAT_PID" | tr -d ' ' || true)"
CHAT_PGID="${CHAT_PGID:-$CHAT_PID}"
echo "$CHAT_PGID" > "$CHAT_PGID_FILE"
echo "chat PGID $CHAT_PGID (log: $CHAT_LOG)"

# Up on its own port first, then reachable through the router, which is the registry having caught up.
until curl -sf -o /dev/null --max-time 10 "http://localhost:$CHAT_PORT/gatekeeper/chat/dev/identities" \
   && curl -sf -o /dev/null --max-time 10 "$URL/gatekeeper/chat/dev/identities"; do
  if ! kill -0 "$CHAT_PID" 2>/dev/null; then
    echo "the chat Worker exited during startup; tail of $CHAT_LOG:" >&2; tail -n 40 "$CHAT_LOG" >&2; stop_all; exit 1
  fi
  if (( SECONDS > deadline )); then
    echo "the router did not reach the chat Worker within ${TIMEOUT}s; stopping. tails:" >&2
    tail -n 20 "$LOG" >&2; tail -n 20 "$CHAT_LOG" >&2; stop_all; exit 1
  fi
  sleep 2
done
echo "READY $URL  (chat through the router: $URL/gatekeeper/chat/dev/login?as=dev-admin)"
echo "stop with: $HERE/stop-local-platform.sh   (or: kill -- -$PGID -$CHAT_PGID)"
