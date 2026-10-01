// Requests an agent should handle; evals never ship in the gadget.
export default [
{
  id: "launch-cards", kind: "use",
  prompt: "Add two cards named Plan launch and Check metrics to the board.",
  reference: { code: "await env.Board.addCards({cards:[{title:\"Plan launch\",column:\"Backlog\"},{title:\"Check metrics\",column:\"Backlog\"}]});", final: "" },
  async check(t) { const s = await t.gadget.getBoard(); const cards = Object.values(s.cards); return ["Plan launch", "Check metrics"].every(title => cards.some(c => c.title === title)) ? [] : ["missing requested cards"]; },
},
{
  id: "feedback-column", kind: "use",
  prompt: "Add a new column named Waiting for feedback.",
  reference: { code: "await env.Board.addColumn({name:\"Waiting for feedback\"});", final: "" },
  async check(t) { const s = await t.gadget.getBoard(); return Object.values(s.columns).some(c => c.name === "Waiting for feedback") ? [] : ["column missing"]; },
},
{
  id: "explore-action", kind: "adapt",
  prompt: "Customize this Board with an extra button labelled Explore. Clicking it should show \"Exploring this view\". On opening the view show \"Ready to explore\", and set the page background to rgb(240, 245, 250).",
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
