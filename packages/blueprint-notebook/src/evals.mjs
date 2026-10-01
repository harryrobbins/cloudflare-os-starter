// Requests an agent should handle; evals never ship in the gadget.
import { pythonEnvironment } from "../../../scripts/blueprint-evals/fixtures.mjs";
export default [
{
  id: "findings-cell", kind: "use",
  environment: pythonEnvironment,
  prompt: "Append a Markdown cell that says ## Findings followed by No results yet. Do not run Python.",
  reference: { code: "await env.Notebook.appendCell({type:\"markdown\",source:\"## Findings\\n\\nNo results yet.\"});", final: "" },
  async check(t) { const s = await t.gadget.getNotebook(); return s.cells.some(c => c.type === "markdown" && /Findings/.test(c.source) && /No results yet/.test(c.source)) ? [] : ["Markdown cell missing"]; },
},
{
  id: "unexecuted-code-cell", kind: "use",
  environment: pythonEnvironment,
  prompt: "Append a code cell containing print(6 * 7), without executing it.",
  reference: { code: "await env.Notebook.appendCell({type:\"code\",source:\"print(6 * 7)\"});", final: "" },
  async check(t) { const s = await t.gadget.getNotebook(); return s.cells.some(c => c.type === "code" && /print\(6\s*\*\s*7\)/.test(c.source) && !c.run) ? [] : ["unexecuted code cell missing"]; },
},
{
  id: "explore-action", kind: "adapt",
  environment: pythonEnvironment,
  prompt: "Customize this Python Notebook with an extra button labelled Explore. Clicking it should show \"Exploring this view\". On opening the view show \"Ready to explore\", and set the page background to rgb(240, 245, 250).",
  reference: { edits: [
    { file: "client.js", find: '  styles: "",', replace: '  styles: "body { background: rgb(240, 245, 250) !important; }",' },
    { file: "client.js", find: '  actions: [],', replace: '  actions: [{ id: "explore", label: "Explore", run(app) { app.notify("Exploring this view"); } }],' },
    { file: "client.js", find: '  onReady(app) {},', replace: '  onReady(app) { app.notify("Ready to explore"); },' },
  ] },
  async check(t) {
    const page = await t.client();
    await page.getByRole("button", { name: "Explore", exact: true }).waitFor({ timeout: 15000 });
    const ready = await page.getByText("Ready to explore", { exact: true }).count();
    await page.getByRole("button", { name: "Explore", exact: true }).click();
    await page.getByText("Exploring this view", { exact: true }).first().waitFor();
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    return [...(ready ? [] : ["onReady status missing"]), ...(bg === "rgb(240, 245, 250)" ? [] : ["custom CSS missing"])];
  },
},
];
