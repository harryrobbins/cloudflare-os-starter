// Requests an agent should handle; evals never ship in the gadget.
export default [
{
  id: "services-elements", kind: "use",
  prompt: "Add three elements to the map: Hospital, Pharmacy, and Shelter.",
  reference: { code: "await env.Map.addElements({labels:[\"Hospital\",\"Pharmacy\",\"Shelter\"]});", final: "" },
  async check(t) { const s = await t.gadget.findElements({limit:100}); return ["Hospital","Pharmacy","Shelter"].every(label => s.some(e => e.label === label)) ? [] : ["elements missing"]; },
},
{
  id: "kitchen-element", kind: "use",
  prompt: "Add an element named Community kitchen.",
  reference: { code: "await env.Map.addElements({labels:[\"Community kitchen\"]});", final: "" },
  async check(t) { const s = await t.gadget.findElements({text:"Community kitchen"}); return s.some(e => e.label === "Community kitchen") ? [] : ["element missing"]; },
},
{
  id: "explore-action", kind: "adapt",
  prompt: "Customize this Network Map with an extra button labelled Explore. Clicking it should show \"Exploring this view\". On opening the view show \"Ready to explore\", and set the page background to rgb(240, 245, 250).",
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
