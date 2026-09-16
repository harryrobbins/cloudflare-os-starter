# Notebook browser checks

Requires repository Node/pnpm versions, installed root and submodule dependencies, Docker and Playwright Chromium. The local launcher uses port **8797** and its own process group/state marker, preserving other worktrees' running servers. It includes the real Notebook Python Worker through a Workshop-only service binding.

```sh
bash packages/blueprint-notebook/e2e/start-local-platform.sh
node packages/blueprint-notebook/e2e/platform.mjs
bash packages/blueprint-notebook/e2e/stop-local-platform.sh
```

The test creates local-only accounts and notebooks, imports saved output, checks Markdown/HTML sanitization, downloads `.ipynb`, connects Python, requests execution through the actual notebook UI and approves it with the authenticated owner API. A second account reads the shared output and attempts a forged execution permit. An imported copy starts without a Python connection, then executes under its new owner in a fresh kernel without seeing the original variables. Both kernels are stopped through approved actions. The screenshot is `/tmp/notebook-browser.png`.

The tests use actual Workshop authentication and gadget frames. The RPC helper lives only in the test browser; it is not bundled into the application. The Docker smoke test separately checks variable persistence, duplicate and rejected requests, Python errors, output caps, internet denial, cancellation and fresh-generation isolation.

Do not run `pnpm check` concurrently with these browser checks: its production frontend build enables Cloudflare Access mode and replaces the local password-signup bundle. Stop/restart the local launcher afterward to rebuild the password frontend if necessary. Test scripts never deploy Cloudflare resources.
