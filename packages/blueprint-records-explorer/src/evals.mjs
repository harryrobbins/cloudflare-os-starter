// Requests an agent should handle; evals never ship in the gadget.
import { recordsEnvironment } from "../../../scripts/blueprint-evals/fixtures.mjs";
export default [
{
  id: "model-tab", kind: "use",
  environment: recordsEnvironment,
  prompt: "Open the model tab of the Records Explorer for work_item.",
  reference: { code: "await env.RecordsExplorer.setState({entity:\"work_item\",tab:\"model\"});", final: "" },
  async check(t) { const s = await t.gadget.getState(); return s.entity === "work_item" && s.tab === "model" ? [] : ["model tab selection missing"]; },
},
{
  id: "visible-columns", kind: "use",
  environment: recordsEnvironment,
  prompt: "Save title and status as the visible columns for work_item in the records tab.",
  reference: { code: "await env.RecordsExplorer.setState({entity:\"work_item\",tab:\"records\",columns:{work_item:[\"title\",\"status\"]}});", final: "" },
  async check(t) { const s = await t.gadget.getState(); return s.tab === "records" && s.columns.work_item.join(",") === "title,status" ? [] : ["visible columns incorrect"]; },
},
{
  id: "explore-action", kind: "adapt",
  environment: recordsEnvironment,
  prompt: "Customize this Records Explorer with an extra button labelled Explore. Clicking it should show \"Exploring this view\". On opening the view show \"Ready to explore\", and set the page background to rgb(240, 245, 250).",
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
