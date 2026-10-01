// Requests an agent should handle; evals never ship in the gadget.
import { projectsEnvironment } from "../../../scripts/blueprint-evals/fixtures.mjs";
export default [
{
  id: "issue-titles", kind: "use",
  environment: projectsEnvironment,
  prompt: "List the titles of the issues currently on this project board.",
  reference: { code: "console.log(await env.ProjectBoard.listIssues({limit:20}));", final: "Issue 1, Issue 2, Issue 3." },
  async check(t) { return ["Issue 1","Issue 2","Issue 3"].every(title => t.final.includes(title)) ? [] : ["issue titles missing from reply"]; },
},
{
  id: "project-name", kind: "use",
  environment: projectsEnvironment,
  prompt: "Tell me the name of the project on this board.",
  reference: { code: "console.log(await env.ProjectBoard.listProjects());", final: "ENG" },
  async check(t) { return /ENG/i.test(t.final) ? [] : ["project name missing"]; },
},
{
  id: "explore-action", kind: "adapt",
  environment: projectsEnvironment,
  prompt: "Customize this Project Board with an extra button labelled Explore. Clicking it should show \"Exploring this view\". On opening the view show \"Ready to explore\", and set the page background to rgb(240, 245, 250).",
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
