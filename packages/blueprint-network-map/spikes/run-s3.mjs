// Runs spikes S3/S5/S9: builds s3-client.js (with the FA2 worker inlined as a data: URL), loads it in
// a sandboxed srcdoc iframe carrying the exact gadget CSP (GadgetUI.tsx:112), reports CSP
// violations and measurements. Usage: node spikes/run-s3.mjs [n] [m] [--headed]
import { build } from "esbuild";
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const n = Number(process.argv[2] || 10000), m = Number(process.argv[3] || 30000);
const common = { bundle: true, format: "esm", target: "es2022", write: false, minify: true, legalComments: "none", logLevel: "warning" };
const worker = (await build({ ...common, entryPoints: [join(here, "fa2-worker.js")] })).outputFiles[0].text;
const client = (await build({ ...common, entryPoints: [join(here, "s3-client.js")], define: { SPIKE_N: String(n), SPIKE_M: String(m), FA2_WORKER_URL: JSON.stringify("data:text/javascript;base64," + Buffer.from(worker).toString("base64")) } })).outputFiles[0].text;
console.log(`client bytes ${client.length}, worker bytes ${worker.length}`);
const CSP = "default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';";
const probe = `<script>document.addEventListener('securitypolicyviolation', e => parent.postMessage({type:'csp', directive:e.effectiveDirective, blocked:String(e.blockedURI).slice(0,80)}, '*'))<\/script>`;
const srcdoc = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}">${probe}</head><body><script type="module" src="data:text/javascript;charset=utf-8,${encodeURIComponent(client)}"></script></body></html>`;
const page = `<!doctype html><html><body style="margin:0"><iframe id=f sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" style="width:1280px;height:800px;border:0"></iframe>
<script>window.results=[];addEventListener('message',e=>results.push(e.data));</script></body></html>`;
const browser = await chromium.launch({ headless: !process.argv.includes("--headed"), args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--enable-webgl"] });
const p = await browser.newPage({ viewport: { width: 1300, height: 820 } });
p.on("console", (msg) => console.log("console:", msg.type(), msg.text()));
p.on("pageerror", (e) => console.log("pageerror", e.message));
await p.setContent(page);
await p.evaluate((doc) => { document.getElementById('f').srcdoc = doc; }, srcdoc);
const t0 = Date.now();
while (Date.now() - t0 < 480000) {
  const res = await p.evaluate(() => window.results);
  if (res.some((r) => r.type === "spike" && (r.phase === "done" || r.phase === "error"))) { console.log(JSON.stringify(res, null, 1)); break; }
  await new Promise((r) => setTimeout(r, 500));
}
console.log("final", JSON.stringify(await p.evaluate(() => window.results)));
await browser.close();
