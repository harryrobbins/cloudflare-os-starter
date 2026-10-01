// Requests an agent should handle; evals never ship in the gadget.
export default [
{
  id: "lunar-game", kind: "use",
  prompt: "Make a new blank game named Lunar landing practice.",
  reference: { code: "await env.Arcade.createGame({title:\"Lunar landing practice\",template:\"blank\"});", final: "" },
  async check(t) { const s = await t.gadget.getView(); return s.games.some(c => c.title === "Lunar landing practice") ? [] : ["game missing"]; },
},
{
  id: "friday-title", kind: "use",
  prompt: "Rename this arcade to Friday games.",
  reference: { code: "await env.Arcade.setTitle({title:\"Friday games\"});", final: "" },
  async check(t) { const s = await t.gadget.getView(); return s.title === "Friday games" ? [] : ["arcade title did not change"]; },
},
{
  id: "explore-action", kind: "adapt",
  prompt: "Customize this Arcade with an extra button labelled Explore. Clicking it should show \"Exploring this view\". On opening the view show \"Ready to explore\", and set the page background to rgb(240, 245, 250).",
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
