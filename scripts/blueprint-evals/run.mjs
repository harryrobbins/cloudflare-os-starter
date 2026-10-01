// Runs a blueprint's evals (packages/blueprint-*/src/evals.mjs; see
// .agents/skills/author-adaptable-blueprints) against the format archive that ships,
// formats/<format>.gadget. Evals stay in the package: shipped in the gadget, an agent reads them
// and copies the answers.
//
//   node scripts/blueprint-evals/run.mjs <format> [--eval <id>] [--reference] [--runs N] [--model M]
//
//   --reference   run each eval's known-good solution instead of a model: proves the eval can be
//                 done with the shipped gadget and that its check is right. Needs no model.
//   --model       a LiteLLM proxy model (default: the testing model, litellm_proxy/deepseek/deepseek-v4-flash)
//   --runs        model runs per eval (default 1)
//
// Model runs read LITELLM_PROXY_API_KEY and LITELLM_PROXY_API_BASE from the environment or from
// .env.local in this checkout or the main one. Results are written to scratch/blueprint-evals/.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArchive } from "../../packages/blueprint-kanban/scripts/archive.mjs";
import { formatGadgetDescription } from "../../cloudflare-os/packages/workshop-backend/src/gadget-files.ts";
import { executeCode, runAgent } from "./agent.mjs";
import { openClient } from "./client-page.mjs";
import { loadGadget, MemoryStorage, requireFromBlueprints } from "./node-gadget.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_MODEL = "litellm_proxy/deepseek/deepseek-v4-flash";

/** The shipped gadget: files, title, noun and the binding name an agent would see. */
export async function loadFormat(/** @type {string} */ format) {
  const { files } = parseArchive(new Uint8Array(await readFile(join(repo, "formats", `${format}.gadget`))));
  const sidecar = JSON.parse(await readFile(join(repo, "formats", `${format}.json`), "utf8"));
  const noun = sidecar.output?.noun ?? sidecar.title;
  const binding = noun.replace(/[^A-Za-z0-9]+(.)?/g, (/** @type {string} */ _, /** @type {string} */ c) => (c ?? "").toUpperCase()).replace(/^./, (/** @type {string} */ c) => c.toUpperCase());
  return { files, info: { binding, title: sidecar.title, noun } };
}

/** The package that packs formats/<format>.gadget. */
export async function formatPackage(/** @type {string} */ format) {
  const packages = await readdir(join(repo, "packages"));
  for (const name of packages.filter((p) => p.startsWith("blueprint-")).sort()) {
    const pack = await readFile(join(repo, "packages", name, "scripts", "pack-gadget.mjs"), "utf8").catch(() => "");
    if (pack.includes(`formats/${format}.gadget`) || pack.includes(`"${format}.gadget"`)) return join(repo, "packages", name);
  }
  return null;
}

/** A format's evals, from its package's src/evals.mjs. */
export async function loadEvals(/** @type {string} */ format) {
  const pkg = await formatPackage(format);
  const file = pkg && join(pkg, "src", "evals.mjs");
  if (!file || !(await readFile(file, "utf8").catch(() => null))) throw new Error(`no src/evals.mjs for format ${format}`);
  const evals = (await import(pathToFileURL(file).href)).default;
  if (!Array.isArray(evals)) throw new Error("evals.mjs must export default an array");
  return evals;
}

/**
 * A gadget whose server is rebuilt whenever its server files change, keeping its storage.
 * @param {Record<string, string>} files  live, edited in place by the agent
 */
function liveGadget(files) {
  const storage = new MemoryStorage();
  /** @type {{key: string, loaded: Awaited<ReturnType<typeof loadGadget>>} | null} */
  let current = null;
  return {
    async get() {
      const key = Object.keys(files).filter((f) => f.endsWith(".js") && f !== "client.lib.js").sort().map((f) => f + "\0" + files[f]).join("\0");
      if (current?.key !== key) {
        await current?.loaded.dispose();
        current = { key, loaded: await loadGadget(files, { storage }) };
      }
      return current.loaded.gadget;
    },
    async dispose() { await current?.loaded.dispose(); },
  };
}

/** describeBinding for a gadget, as overseer.ts builds it. */
async function describeGadgetBinding(/** @type {string} */ name, /** @type {any} */ gadget, /** @type {string} */ title) {
  let text = `Binding: env.${name}\n\nThis binding is an RPC stub that points at the main Durable Object instance of the ` +
    `Gadget ${JSON.stringify(title)}. Calling a method on the stub invokes the same-named method on the class ` +
    `exported by the Gadget's server.js (read that file to learn the API it offers).`;
  if (typeof gadget.describeGadget === "function") {
    try {
      const formatted = formatGadgetDescription(await gadget.describeGadget());
      if (formatted) text += `\n\n${formatted}`;
    } catch (e) {
      text += `\n\n(Its describeGadget() method failed: ${String(e).slice(0, 200)}.)`;
    }
  }
  return text;
}

/** @param {Record<string, string>} files @param {{file: string, find: string, replace: string}[]} edits */
function applyEdits(files, edits) {
  for (const e of edits) {
    const text = files[e.file];
    if (text === undefined) throw new Error(`reference edits a missing file: ${e.file}`);
    const n = text.split(e.find).length - 1;
    if (n !== 1) throw new Error(`reference edit to ${e.file}: find text occurs ${n} times, not once`);
    files[e.file] = text.replace(e.find, () => e.replace);
  }
}

/**
 * Runs one eval once.
 * @param {object} o
 * @param {any} o.ev
 * @param {Awaited<ReturnType<typeof loadFormat>>} o.format
 * @param {{base: string, key: string, model: string} | null} o.llm  null: run the reference
 * @param {() => Promise<import("playwright").Browser>} o.browser
 */
export async function runEval({ ev, format, llm, browser }) {
  const files = { ...format.files };
  const live = liveGadget(files);
  /** @type {{page: import("playwright").Page}[]} */
  const opened = [];
  const started = Date.now();
  /** @type {any} */
  let agent = null;
  /** @type {string[]} */
  let problems = [];
  try {
    // Seed the gadget first (people's earlier contributions an agent must not fake).
    if (ev.setup) await ev.setup({ gadget: await live.get(), files, binding: format.info.binding });
    if (!llm) {
      if (ev.reference?.code) {
        const r = await executeCode(ev.reference.code, { [format.info.binding]: await live.get() });
        if (!r.ok) problems.push(`reference code failed: ${r.output}`);
      } else if (ev.reference?.edits) {
        applyEdits(files, ev.reference.edits);
      } else {
        problems.push("eval has no reference");
      }
    } else {
      agent = await runAgent({
        prompt: ev.prompt, files, gadgetInfo: format.info, llm,
        gadget: () => live.get(),
        describeBinding: async (name) => name === format.info.binding
          ? describeGadgetBinding(name, await live.get(), format.info.title)
          : `Error: env has no binding named ${name}`,
      });
      if (ev.kind === "use" && agent.edited.length) problems.push(`a use eval must not edit code, but the agent edited ${agent.edited.join(", ")}`);
    }
    const libEdits = Object.keys(files).filter((f) => f.endsWith(".lib.js") && files[f] !== format.files[f]);
    if (libEdits.length) problems.push(`edited a prebuilt library: ${libEdits.join(", ")}`);
    if (!problems.length) {
      const gadget = await live.get();
      const t = {
        gadget, files, binding: format.info.binding,
        // The agent's closing reply, for requests whose answer is text ("" for a reference run).
        final: agent?.final ?? ev.reference?.final ?? "",
        async client() {
          const o = await openClient({ browser: await browser(), files, gadget });
          opened.push(o);
          return o.page;
        },
      };
      problems = (await ev.check(t)) ?? [];
      for (const o of opened) if (/** @type {any} */ (o).errors?.length) problems.push(`client errors: ${/** @type {any} */ (o).errors.slice(0, 3).join(" | ")}`);
    }
  } catch (e) {
    problems.push(`runner error: ${/** @type {any} */ (e)?.stack ?? e}`);
  } finally {
    for (const o of opened) await o.page.close().catch(() => {});
    await live.dispose();
  }
  return {
    id: ev.id, kind: ev.kind, mode: llm ? llm.model : "reference", pass: problems.length === 0, problems,
    ms: Date.now() - started,
    ...(agent && { steps: agent.steps, usage: agent.usage, edited: agent.edited, final: agent.final, tools: agent.trace.map((/** @type {any} */ s) => s.tool + (s.ok ? "" : "!")), trace: agent.trace }),
  };
}

/** LiteLLM proxy settings from the environment or the checkout's .env.local. */
async function proxySettings(/** @type {string} */ model) {
  let key = process.env.LITELLM_PROXY_API_KEY;
  let base = process.env.LITELLM_PROXY_API_BASE;
  if (!key || !base) {
    const common = execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    for (const file of [join(repo, ".env.local"), join(dirname(common), ".env.local")]) {
      const text = await readFile(file, "utf8").catch(() => "");
      key ??= text.match(/^LITELLM_PROXY_API_KEY=(.+)$/m)?.[1]?.trim();
      base ??= text.match(/^LITELLM_PROXY_API_BASE=(.+)$/m)?.[1]?.trim();
    }
  }
  if (!key || !base) throw new Error("set LITELLM_PROXY_API_KEY and LITELLM_PROXY_API_BASE (or add them to .env.local)");
  return { key, base: base.replace(/\/+$/, ""), model: model.replace(/^litellm_proxy\//, "") };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (/** @type {string} */ name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  const format = args.find((a, i) => !a.startsWith("--") && !["--eval", "--runs", "--model"].includes(args[i - 1]));
  if (!format) throw new Error("usage: run.mjs <format> [--eval id] [--reference] [--runs N] [--model M]");
  const reference = args.includes("--reference");
  const runs = reference ? 1 : Number(opt("--runs") ?? 1);
  const model = opt("--model") ?? DEFAULT_MODEL;
  const loaded = await loadFormat(format);
  const evals = (await loadEvals(format)).filter((/** @type {any} */ e) => !opt("--eval") || e.id === opt("--eval"));
  if (!evals.length) throw new Error("no matching evals");
  const llm = reference ? null : await proxySettings(model);

  /** @type {import("playwright").Browser | null} */
  let browserInstance = null;
  const browser = async () => (browserInstance ??= await requireFromBlueprints("playwright").chromium.launch({ headless: true }));
  const results = [];
  try {
    for (const ev of evals) {
      for (let run = 1; run <= runs; run++) {
        const r = { run, ...(await runEval({ ev, format: loaded, llm, browser })) };
        results.push(r);
        const extra = r.steps ? ` ${r.steps} steps, tools: ${r.tools.join(" ")}` : "";
        console.log(`${r.pass ? "PASS" : "FAIL"} ${format}/${ev.id} [${ev.kind}] ${r.mode}${runs > 1 ? ` run ${run}` : ""} (${(r.ms / 1000).toFixed(1)} s)${extra}`);
        for (const p of r.problems) console.log(`     - ${p.split("\n").slice(0, 6).join("\n       ")}`);
      }
    }
  } finally {
    await browserInstance?.close();
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`${passed}/${results.length} passed`);
  const outDir = join(repo, "scratch", "blueprint-evals");
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, `${format}-${reference ? "reference" : model.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(out, JSON.stringify({ format, model: reference ? "reference" : model, results }, null, 2));
  console.log(`results: ${out}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
