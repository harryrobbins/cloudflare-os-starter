#!/usr/bin/env bash
# The whole end-to-end run: build the SPA, start ONE `wrangler dev`, drive it with Playwright, stop
# the server whatever happened. Deliberately not wired into `pnpm test:run` -- it needs a port and a
# browser, which a unit-test run should not assume.
#
#   eval "$(fnm env)" && fnm use v24.21.0
#   packages/gatekeeper-chat/e2e/run.sh
#
# Env: CHAT_SHOTS (screenshots, default /tmp/chat-e2e), CHAT_KEEP_STATE=1 to keep .wrangler/state
# (the workspace is a Durable Object, so a kept state means a kept #general).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"

# The assets binding reads the manifest once, at start-up: building while the server runs makes every
# hashed asset a 404. So build first, always.
(cd "$REPO" && pnpm --filter gatekeeper-chat build >/dev/null) || exit 1

if [[ -z "${CHAT_KEEP_STATE:-}" ]]; then
  rm -rf "$PKG/.wrangler/state"
fi

CHAT_SKIP_BUILD=1 "$HERE/start-dev.sh" || exit 1
cd "$PKG"
node --test --test-concurrency=1 e2e/chat.test.mjs
status=$?
"$HERE/stop-dev.sh"
exit $status
