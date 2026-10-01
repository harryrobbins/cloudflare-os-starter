// Requests an agent should handle; evals never ship in the gadget.
import { syntheticEnvironment } from "../../../scripts/blueprint-evals/fixtures.mjs";
export default [
{
  id: "select-orders", kind: "use",
  environment: syntheticEnvironment,
  prompt: "Select orders as the explorer collection and clear any previous page history.",
  reference: { code: "await env.DataExplorer.setState({collection:\"orders\",cursorHistory:[]});", final: "" },
  async check(t) { const s = await t.gadget.getState(); return s.collection === "orders" && s.cursorHistory.length === 0 ? [] : ["collection or history incorrect"]; },
},
{
  id: "count-orders", kind: "use",
  environment: syntheticEnvironment,
  prompt: "Show me how many synthetic orders there are.",
  reference: { code: "console.log(await env.DataExplorer.aggregate({collection:\"orders\",metrics:[{name:\"total\",function:\"count\"}]}));", final: "24 synthetic orders." },
  async check(t) { return /\b24\b/.test(t.final) ? [] : ["answer did not give the 24-order count"]; },
},
{
  id: "explore-action", kind: "adapt",
  environment: syntheticEnvironment,
  prompt: "Customize this Synthetic Data Explorer with an extra button labelled Explore. Clicking it should show \"Exploring this view\". On opening the view show \"Ready to explore\", and set the page background to rgb(240, 245, 250).",
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
    await page.getByText("Exploring this view", { exact: true }).waitFor();
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    return [...(ready ? [] : ["onReady status missing"]), ...(bg === "rgb(240, 245, 250)" ? [] : ["custom CSS missing"])];
  },
},
];
