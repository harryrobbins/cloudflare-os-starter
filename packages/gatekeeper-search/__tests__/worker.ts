// The Worker under test.
//
// The one thing it adds to src/index.ts: the dense half is swapped for the deterministic fake. The
// override is module state in src/dense.ts, set here at import time, before any Durable Object or
// handler runs. Production's entry never calls it and the fake is not under src/, so it cannot ship.
import { overrideDenseIndexFactory } from "../src/dense.js";
import { testDenseFactory } from "./support/fake-dense.js";

overrideDenseIndexFactory(testDenseFactory);

export { default } from "../src/index.js";
export * from "../src/index.js";
// Named, not only covered by the `export *` above: the pool builds `ctx.exports` from the entry's
// statically visible exports and does not follow a star re-export.
export { SearchIndex, SearchService, GatekeeperVendor, SearchAccount, SearchVerifier, SearchGatekeeper } from "../src/index.js";
