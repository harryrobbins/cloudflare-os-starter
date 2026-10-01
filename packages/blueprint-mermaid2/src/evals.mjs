// Requests an agent should handle; evals never ship in the gadget.
import { diagramEnvironment } from "../../../scripts/blueprint-evals/fixtures.mjs";
export default [
{
  id: "start-finish-d2", kind: "use",
  environment: diagramEnvironment,
  prompt: "Save a D2 diagram that connects Start to Finish, using the ELK layout.",
  reference: { code: "await env.Diagram.updateDiagram({source:\"Start -> Finish\",language:\"d2\",layout:\"elk\"});", final: "" },
  async check(t) { const s = await t.gadget.getDocument(); return s.language === "d2" && s.layout === "elk" && /Start.*->.*Finish/s.test(s.drafts.d2) ? [] : ["diagram or layout missing"]; },
},
{
  id: "intake-review-mermaid", kind: "use",
  environment: diagramEnvironment,
  prompt: "Save a Mermaid flowchart from Intake to Review using Dagre.",
  reference: { code: "await env.Diagram.updateDiagram({source:\"flowchart LR\\nIntake --> Review\",language:\"mermaid\",layout:\"dagre\"});", final: "" },
  async check(t) { const s = await t.gadget.getDocument(); return s.language === "mermaid" && s.layout === "dagre" && /Intake.*-->.*Review/s.test(s.drafts.mermaid) ? [] : ["Mermaid source missing"]; },
},
{
  id: "explore-action", kind: "adapt",
  environment: diagramEnvironment,
  prompt: "Customize this MermaiD2 with an extra button labelled Explore. Clicking it should show \"Exploring this view\". On opening the view show \"Ready to explore\", and set the page background to rgb(240, 245, 250).",
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
