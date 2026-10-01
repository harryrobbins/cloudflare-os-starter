# network-map blueprint

Source for the bundled Workshop format.

## Adaptable gadget checks

The packed format ships readable client/server entries, prebuilt libraries, and a bounded
`describeGadget()` contract. Evals live in `src/evals.mjs` and are never packed.

Run the archive integration checks with `node --test scripts/blueprint-adapt.test.ts` from
the repository root. They run every RPC example and every reference eval against the
shipped archive, including the real assembled client in Chromium. Connector-backed formats
use deterministic fixtures, not live accounts.

Reference validation (2026-10-01): 3/3 evals pass against the packed archive; all
`describeGadget()` examples run. Package unit/server suites pass. Shared extension and
build checks, scoped tooling lint, and script type checks pass. Signed-in Workshop
smoke tests have not been run.

Model evals: pending authorization to send gadget source and prompts to the configured
`litellm_proxy/deepseek/deepseek-v4-flash` test proxy (2026-10-01). No model pass rate is claimed.
