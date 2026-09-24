// Writes the generated sources that the Worker serves as text:
//   - src/types-code.ts from src/types.d.ts: the agent-facing declarations (a test fails if the
//     two drift);
//   - src/configurator-html.ts: the resource configurator page, src/configurator.js bundled with
//     capnweb into one self-contained HTML document.
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const types = readFileSync(new URL("../src/types.d.ts", import.meta.url), "utf8");
writeFileSync(new URL("../src/types-code.ts", import.meta.url),
  "// Generated from types.d.ts by scripts/gen-types.mjs; a test fails if the two drift.\n" +
  `const TYPES_CODE = ${JSON.stringify(types)};\n\nexport default TYPES_CODE;\n`);

const bundle = await build({
  entryPoints: [new URL("../src/configurator.js", import.meta.url).pathname],
  bundle: true, format: "iife", minify: true, write: false,
});
const script = bundle.outputFiles[0].text.replaceAll("</script", "<\\/script");
const html =
  `<html><body data-resource-url="jev://decisions" style="font:14px system-ui,sans-serif;margin:0;padding:16px 18px;color:#172033">` +
  `<p style="margin:0 0 8px;font-weight:600">Jev decisions for this workspace</p>` +
  `<p style="margin:0;color:#526079">The agent and Gadgets here can ask TypeSafe's Jev decision model yes/no, choice ` +
  `and score questions through OpenRouter. The text in each question is sent to OpenRouter. Other workspaces are not ` +
  `affected; disconnect it here to take it away again.</p>` +
  `<script>${script}</script></body></html>`;
writeFileSync(new URL("../src/configurator-html.ts", import.meta.url),
  "// Generated from configurator.js by scripts/gen-types.mjs.\n" +
  `const CONFIGURATOR_HTML = ${JSON.stringify(html)};\n\nexport default CONFIGURATOR_HTML;\n`);
