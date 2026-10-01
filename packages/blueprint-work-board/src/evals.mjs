// Requests an agent should handle; evals never ship in the gadget.
import { workEnvironment } from "../../../scripts/blueprint-evals/fixtures.mjs";
export default [
{
  id: "follow-up-view", kind: "use",
  environment: workEnvironment,
  prompt: "Create a saved list view called Follow up with id follow-up, showing all work.",
  reference: { code: "await env.WorkBoard.saveView({id:\"follow-up\",name:\"Follow up\",query:\"\",layout:\"list\"});", final: "" },
  async check(t) { const s = await t.gadget.listViews(); return s.some(v => v.id === "follow-up" && v.name === "Follow up" && v.layout === "list") ? [] : ["saved list view missing"]; },
},
{
  id: "weekly-view", kind: "use",
  environment: workEnvironment,
  prompt: "Create a saved board view called Weekly work with id weekly-work, showing all work.",
  reference: { code: "await env.WorkBoard.saveView({id:\"weekly-work\",name:\"Weekly work\",query:\"\",layout:\"board\"});", final: "" },
  async check(t) { const s = await t.gadget.listViews(); return s.some(v => v.id === "weekly-work" && v.name === "Weekly work" && v.layout === "board") ? [] : ["saved board view missing"]; },
},
{
  id: "explore-action", kind: "adapt",
  environment: workEnvironment,
  prompt: "Customize this Work Board with an extra button labelled Explore. Clicking it should show \"Exploring this view\". On opening the view show \"Ready to explore\", and set the page background to rgb(240, 245, 250).",
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
