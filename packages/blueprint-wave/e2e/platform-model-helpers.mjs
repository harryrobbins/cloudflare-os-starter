// @ts-check
// Adds an AI model to a local-platform account, so the Wave's declared `Model` binding (an
// `aiModel` with suggestedModel openrouter/qwen/qwen3.8-flash) can be satisfied on the blueprint
// page. The local platform runs without AI Gateway, so the model calls OpenRouter directly with
// the key from OPENROUTER_API_KEY. The key is typed into the Workshop's own Add AI Model dialog
// and stored in the local platform's storage only; it is never written to a file here.

/** The model the Wave's sidecar suggests; the id and name match production's gateway catalogue. */
export const SUGGESTED_MODEL = { id: "qwen/qwen3.8-flash", name: "Qwen 3.8 Flash (OpenRouter)" };

/**
 * Opens /providers and adds the suggested model through "Other OpenRouter...", unless the account
 * already lists it.
 * @param {import("playwright").Page} page  signed in
 * @param {string} baseUrl
 * @param {string} apiToken
 * @returns {Promise<"added"|"existing">}
 */
export async function addOpenRouterModel(page, baseUrl, apiToken) {
  if (!apiToken) throw new Error("OPENROUTER_API_KEY is not set");
  await page.goto(`${baseUrl}/providers`);
  await page.waitForLoadState("networkidle");
  if (await page.getByText(SUGGESTED_MODEL.name, { exact: true }).count()) return "existing";
  await page.getByRole("button", { name: /^Add provider$/ }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /^Other OpenRouter/ }).click();
  await dialog.getByLabel("Model ID").fill(SUGGESTED_MODEL.id);
  await dialog.getByLabel("Display Name").fill(SUGGESTED_MODEL.name);
  await dialog.getByLabel("API Token").fill(apiToken);
  await dialog.getByRole("button", { name: /^Add/ }).last().click();
  await page.getByText("AI model added successfully").waitFor({ timeout: 15000 });
  return "added";
}

/**
 * On /blueprint/<id> for a blueprint that declares bindings: waits for the Model connection to be
 * prefilled from suggestedModel, then creates the gadget.
 * @param {import("playwright").Page} page
 * @param {string} baseUrl
 * @param {string} blueprintId
 * @returns {Promise<{workspaceUrl: string, prefilled: boolean}>}
 */
export async function createWithSuggestedModel(page, baseUrl, blueprintId) {
  await page.goto(`${baseUrl}/blueprint/${blueprintId}`);
  const create = page.getByRole("button", { name: "Create Gadget" });
  await create.waitFor();
  // "Ready" next to the Model connection: suggestedModel matched one of the account's models.
  const ready = page.getByText("Everything is ready", { exact: false });
  const prefilled = await ready.waitFor({ timeout: 15000 }).then(() => true, () => false);
  if (!prefilled) throw new Error("the Model connection was not prefilled from suggestedModel");
  await create.click();
  await page.waitForURL(/\/workspace\/[0-9a-f]{64}/, { timeout: 60000 });
  return { workspaceUrl: page.url(), prefilled };
}
