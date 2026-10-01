// Requests an agent should handle; evals never ship in the gadget.
import { syntheticEnvironment } from "../../../scripts/blueprint-evals/fixtures.mjs";
export default [
{
  id: "titanic-grid", kind: "use",
  environment: syntheticEnvironment,
  prompt: "Save Titanic as the mosaic demo with a grid layout.",
  reference: { code: "await env.Mosaic.setState({source:{kind:\"demo\",key:\"titanic\"},view:{layout:\"grid\"}});", final: "" },
  async check(t) { const s = await t.gadget.getState(); return s.source.kind === "demo" && s.source.key === "titanic" && s.view.layout === "grid" ? [] : ["Titanic grid settings missing"]; },
},
{
  id: "orders-bars", kind: "use",
  environment: syntheticEnvironment,
  prompt: "Save a mosaic sourced from PROCGEN orders with a 100-row cap and a bars layout.",
  reference: { code: "await env.Mosaic.setState({source:{kind:\"connector\",sourceId:\"PROCGEN\",table:\"orders\",maxRows:100},view:{layout:\"bars\"}});", final: "" },
  async check(t) { const s = await t.gadget.getState(); return s.source.sourceId === "PROCGEN" && s.source.table === "orders" && s.source.maxRows === 100 && s.view.layout === "bars" ? [] : ["connector settings missing"]; },
},
{
  id: "explore-action", kind: "adapt",
  environment: syntheticEnvironment,
  prompt: "Customize this Tessera Mosaic with an extra button labelled Explore. Clicking it should show \"Exploring this view\". On opening the view show \"Ready to explore\", and set the page background to rgb(240, 245, 250).",
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
