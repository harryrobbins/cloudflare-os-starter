// Writes src/types-code.ts from src/types.d.ts: the agent-facing declarations, served as text.
import { readFileSync, writeFileSync } from "node:fs";

const types = readFileSync(new URL("../src/vendor/types.d.ts", import.meta.url), "utf8");
writeFileSync(new URL("../src/vendor/types-code.ts", import.meta.url),
  "// Generated from types.d.ts by scripts/gen-types.mjs; a test fails if the two drift.\n" +
  `const TYPES_CODE = ${JSON.stringify(types)};\n\nexport default TYPES_CODE;\n`);
