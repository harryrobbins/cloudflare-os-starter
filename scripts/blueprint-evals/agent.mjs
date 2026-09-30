// A stand-in for the Workshop agent, for blueprint evals: the Workshop's own prompt sections and
// tool descriptions (read from the fork's agent.ts, so they stay in step), a gadget listing
// shaped like the Workshop's, and the tools that matter for using or adapting one gadget:
// readFile, writeFile, editFile, describeBinding and executeCode. The model is reached through
// the LiteLLM proxy's OpenAI-compatible API.

import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const AGENT_TS = new URL("../../cloudflare-os/packages/workshop-backend/src/agent.ts", import.meta.url);

/** Text of a `let NAME = \`...\`.trim();` constant in agent.ts, unescaped. */
function templateConstant(/** @type {string} */ source, /** @type {string} */ name) {
  const m = source.match(new RegExp(`let ${name} = \`([\\s\\S]*?)\`\\.trim\\(\\);`));
  if (!m) throw new Error(`agent.ts no longer defines ${name}`);
  return unescapeTemplate(m[1]).trim();
}

function unescapeTemplate(/** @type {string} */ s) {
  return s.replace(/\\`/g, "`").replace(/\\\$\{/g, "${").replace(/\\\\/g, "\\");
}

/** The Workshop's guidance on writing, using and adapting gadgets. */
export async function workshopPrompt() {
  const source = await readFile(AGENT_TS, "utf8");
  const start = source.indexOf("# Writing Gadgets");
  const end = source.indexOf("## Exporting files from Gadgets");
  if (start < 0 || end < start) throw new Error("agent.ts no longer has the '# Writing Gadgets' section");
  return {
    guidance: unescapeTemplate(source.slice(start, end)).trim(),
    tools: {
      readFile: templateConstant(source, "READ_FILE_TOOL_DESCRIPTION"),
      writeFile: templateConstant(source, "WRITE_FILE_TOOL_DESCRIPTION"),
      editFile: templateConstant(source, "EDIT_FILE_TOOL_DESCRIPTION"),
      describeBinding: templateConstant(source, "DESCRIBE_BINDING_TOOL_DESCRIPTION"),
      executeCode: templateConstant(source, "EXECUTE_CODE_TOOL_DESCRIPTION"),
    },
  };
}

/** The Workshop's gadget listing for one format gadget (agent.ts, "gadgetInfos"). */
export function gadgetListing({ binding, title, noun, files }) {
  return [
    `# Gadgets in this workspace`,
    ``,
    `## Gadget ${binding}: ${JSON.stringify(title)}`,
    `This is the workspace's default gadget: file tools operate on it when their \`workpiece\` parameter is omitted.`,
    `As of the start of this session, this gadget contained the following files:`,
    ...Object.keys(files).map((f) => `* ${f}`),
    `This gadget is a ${noun}: a finished application whose content is data in its own storage, not text in its code. ` +
    `To read or change what it contains, call its RPC methods from \`executeCode\` (\`env.${binding}\`); call ` +
    `\`describeBinding\` on it first (a gadget that implements \`describeGadget()\` lists its operations there, with ` +
    `input schemas and examples), or read its README.md or server.js to learn the methods it offers for this. Do NOT ` +
    `edit its code to change its content. Edit the code only if the user asks to change how the ${noun} itself works ` +
    `(its editor, layout, or features); then start from README.md's "Adapting this gadget" section and edit client.js ` +
    `or server.js, never a .lib.js file.`,
    `This gadget has no bindings.`,
  ].join("\n");
}

/**
 * Runs an executeCode module against `env`, returning its console output like the Workshop does.
 * Accepts a full module (`export default async function(self, env, ctx) {...}`) or, for eval
 * references, a bare function body.
 */
export async function executeCode(/** @type {string} */ code, /** @type {Record<string, unknown>} */ env) {
  const module = /\bexport\s+default\b/.test(code) ? code : `export default async function(self, env, ctx) {\n${code}\n}`;
  const dir = await mkdtemp(join(tmpdir(), "eval-exec-"));
  const file = join(dir, "code.mjs");
  await writeFile(file, module);
  /** @type {string[]} */
  const logs = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture = (/** @type {string} */ level) => (/** @type {unknown[]} */ ...args) =>
    logs.push((level === "log" ? "" : `[${level}] `) + args.map((a) => typeof a === "string" ? a : safeJson(a)).join(" "));
  Object.assign(console, { log: capture("log"), info: capture("info"), warn: capture("warn"), error: capture("error") });
  try {
    const mod = await import(pathToFileURL(file).href);
    const result = await withTimeout(mod.default({}, env, { waitUntil() {} }), 30_000);
    if (result !== undefined) logs.push(`Return value: ${safeJson(result)}`);
    return { ok: true, output: logs.join("\n") || "(no output)" };
  } catch (e) {
    return { ok: false, output: `${logs.join("\n")}\nError: ${/** @type {any} */ (e)?.stack ?? e}`.trim() };
  } finally {
    Object.assign(console, original);
    await rm(dir, { recursive: true, force: true });
  }
}

function safeJson(/** @type {unknown} */ v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function withTimeout(/** @type {Promise<unknown>} */ p, /** @type {number} */ ms) {
  return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref())]);
}

/**
 * Drives a model through one eval request.
 * @param {object} o
 * @param {string} o.prompt  the person's request
 * @param {Record<string, string>} o.files  the gadget's files; edited in place
 * @param {{binding: string, title: string, noun: string}} o.gadgetInfo
 * @param {() => Promise<any>} o.gadget  the current server instance (rebuilt after code edits)
 * @param {(name: string) => Promise<string>} o.describeBinding
 * @param {{base: string, key: string, model: string}} o.llm
 * @param {number} [o.maxSteps]
 */
export async function runAgent({ prompt, files, gadgetInfo, gadget, describeBinding, llm, maxSteps = 24 }) {
  const { guidance, tools } = await workshopPrompt();
  const system = [
    `You are the agent in Cloudflare OS's Workshop: you help people use and change the gadgets (small apps) in their workspace.`,
    guidance,
    gadgetListing({ ...gadgetInfo, files }),
  ].join("\n\n");
  const toolDefs = [
    fn("readFile", tools.readFile, { filename: str("File name, e.g. client.js") }, ["filename"]),
    fn("writeFile", tools.writeFile, { filename: str("File name"), content: str("The whole new content") }, ["filename", "content"]),
    fn("editFile", tools.editFile, { filename: str("File name"), textToReplace: str("Exact text to replace; must occur exactly once"), replacement: str("Replacement text") }, ["filename", "textToReplace", "replacement"]),
    fn("describeBinding", tools.describeBinding, { name: str("Name of the binding (a property of `env`).") }, ["name"]),
    fn("executeCode", tools.executeCode, { code: str("A complete JavaScript module: export default async function(self, env, ctx) { ... }") }, ["code"]),
  ];
  /** @type {any[]} */
  const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
  /** @type {{tool: string, args: any, ok: boolean, output: string}[]} */
  const trace = [];
  const read = new Set();
  /** @type {Set<string>} */
  const edited = new Set();
  let usage = { prompt_tokens: 0, completion_tokens: 0 };

  for (let step = 0; step < maxSteps; step++) {
    const res = await fetch(`${llm.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${llm.key}` },
      body: JSON.stringify({ model: llm.model, messages, tools: toolDefs, temperature: 0.2 }),
    });
    if (!res.ok) throw new Error(`model call failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    usage.prompt_tokens += body.usage?.prompt_tokens ?? 0;
    usage.completion_tokens += body.usage?.completion_tokens ?? 0;
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error(`model returned no message: ${JSON.stringify(body).slice(0, 300)}`);
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) return { final: msg.content ?? "", trace, edited: [...edited], usage, steps: step + 1 };
    for (const call of msg.tool_calls) {
      let args;
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = null; }
      const r = args === null
        ? { ok: false, output: "Error: tool arguments were not valid JSON" }
        : await runTool(call.function.name, args);
      trace.push({ tool: call.function.name, args, ok: r.ok, output: r.output.slice(0, 2000) });
      messages.push({ role: "tool", tool_call_id: call.id, content: r.output.slice(0, 60_000) });
    }
  }
  return { final: "(stopped: step limit)", trace, edited: [...edited], usage, steps: maxSteps };

  /** @param {string} name @param {any} a @returns {Promise<{ok: boolean, output: string}>} */
  async function runTool(name, a) {
    switch (name) {
      case "readFile": {
        if (!(a.filename in files)) return { ok: false, output: `Error: no such file: ${a.filename}` };
        read.add(a.filename);
        return { ok: true, output: files[a.filename] };
      }
      case "writeFile": {
        files[a.filename] = String(a.content ?? "");
        edited.add(a.filename);
        read.add(a.filename);
        return { ok: true, output: "File written." };
      }
      case "editFile": {
        if (!(a.filename in files)) return { ok: false, output: `Error: no such file: ${a.filename}` };
        if (!read.has(a.filename)) return { ok: false, output: "Error: you must read the file with readFile before editing it." };
        const text = files[a.filename];
        const count = text.split(String(a.textToReplace)).length - 1;
        if (count !== 1) return { ok: false, output: `Error: textToReplace occurs ${count} times in ${a.filename}; it must occur exactly once.` };
        files[a.filename] = text.replace(String(a.textToReplace), () => String(a.replacement));
        edited.add(a.filename);
        return { ok: true, output: "File edited." };
      }
      case "describeBinding":
        return { ok: true, output: await describeBinding(String(a.name).replace(/^env\./, "")) };
      case "executeCode":
        return executeCode(String(a.code ?? ""), { [gadgetInfo.binding]: await gadget() });
      default:
        return { ok: false, output: `Error: unknown tool ${name}` };
    }
  }
}

function fn(name, description, properties, required) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}
function str(description) { return { type: "string", description }; }
