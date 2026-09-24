// Lets plain `node` run this workspace's TypeScript sources, which import siblings with `.js`
// suffixes and use parameter properties (so Node's strip-only mode is not enough):
//   resolve: `./x.js` from a .ts file falls back to `./x.ts` when no .js exists;
//   load:    .ts files outside node_modules are transformed with node:module's own
//            stripTypeScriptTypes in "transform" mode (no extra dependency, no build step).
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.endsWith(".js") && context.parentURL?.endsWith(".ts") && (specifier.startsWith(".") || specifier.startsWith("/"))) {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".ts") && !url.includes("/node_modules/")) {
      const source = readFileSync(new URL(url), "utf8");
      return { format: "module", source: stripTypeScriptTypes(source, { mode: "transform", sourceMap: false }), shortCircuit: true };
    }
    return next(url, context);
  },
});
