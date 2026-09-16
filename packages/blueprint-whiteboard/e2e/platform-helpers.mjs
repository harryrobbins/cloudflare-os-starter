// Playwright helpers for driving a local Cloudflare OS Workshop (see ./README.md).
//
// Adapted from packages/blueprint-kanban/e2e/platform-helpers.mjs.
// Plain ESM; imports `playwright` (devDependency of blueprint-whiteboard, pinned to 1.61.0 so it uses
// the Chromium build already cached in ~/.cache/ms-playwright). Run scripts with the Linux node from
// this package directory so the import resolves.
import { chromium } from 'playwright'

export const DEFAULT_BASE_URL = 'http://localhost:8787'

/** Launch headless Chromium. `acceptDownloads` is needed for export tests. */
export async function launch(opts = {}) {
  return chromium.launch({ headless: true, ...opts })
}

/** New isolated context + page (one per user: auth token lives in localStorage). */
export async function newUserPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 }, acceptDownloads: true })
  const page = await context.newPage()
  return { context, page }
}

// Usernames must match /^[a-z0-9_-]+$/i (no emails); passwords need >= 8 chars.
export async function signUp(page, baseUrl, username, password) {
  await page.goto(`${baseUrl}/signup`)
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Confirm Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  // On success the page stores `authToken` in localStorage and hard-navigates to "/"; a taken
  // username shows "Username already exists" instead.
  const outcome = await Promise.race([
    page.waitForFunction(() => !!localStorage.getItem('authToken'), null, { timeout: 30_000 }).then(() => 'ok'),
    page.getByText('Username already exists').waitFor({ timeout: 30_000 }).then(() => 'exists'),
  ])
  if (outcome === 'exists') throw new Error('Username already exists')
  await page.waitForURL(u => new URL(u).pathname === '/', { timeout: 30_000 })
  await completeOnboarding(page)
}

/**
 * A fresh account is shown a full-screen "Let's set you up" wizard (routes/__root.tsx) instead of
 * any route until it is finished. Click "Next" through it, then "Let's build". No-op if absent.
 */
export async function completeOnboarding(page) {
  const heading = page.getByRole('heading', { name: "Let's set you up" })
  try {
    await heading.waitFor({ timeout: 5_000 })
  } catch {
    return
  }
  const finish = page.getByRole('button', { name: "Let's build" })
  for (let i = 0; i < 6 && !(await finish.isVisible()); i++) {
    await page.getByRole('button', { name: 'Next', exact: true }).click()
  }
  await finish.click()
  await heading.waitFor({ state: 'detached', timeout: 30_000 })
}

export async function signIn(page, baseUrl, username, password) {
  await page.goto(`${baseUrl}/`)
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForFunction(() => !!localStorage.getItem('authToken'), null, { timeout: 30_000 })
  await completeOnboarding(page)
}

/** Sign up, falling back to sign-in when the username already exists (re-runs on a kept .wrangler). */
export async function signUpOrIn(page, baseUrl, username, password) {
  try {
    await signUp(page, baseUrl, username, password)
  } catch (err) {
    if (err.message === 'Username already exists') {
      await signIn(page, baseUrl, username, password)
    } else {
      throw err
    }
  }
}

/**
 * Upload a `.gadget` archive through the Blueprints page's hidden file input and return the new
 * blueprint's id (diffed against the ids listed before the upload).
 */
export async function uploadGadget(page, baseUrl, archivePath) {
  await page.goto(`${baseUrl}/blueprints`)
  await page.getByRole('heading', { name: 'Blueprints', level: 1 }).waitFor()
  // Wait for the list to settle (skeleton rows gone) before snapshotting ids.
  await page.waitForFunction(() => !document.querySelector('.animate-pulse'), null, { timeout: 30_000 })
  const before = new Set(await blueprintIds(page))
  await page.locator('input[type="file"][accept=".gadget"]').setInputFiles(archivePath)
  await page.getByText('Blueprint uploaded').first().waitFor({ timeout: 60_000 })
  let ids = []
  await expectEventually(async () => {
    ids = (await blueprintIds(page)).filter(id => !before.has(id))
    return ids.length > 0
  }, 30_000)
  return ids[0]
}

async function blueprintIds(page) {
  const hrefs = await page.locator('a[href^="/blueprint/"]').evaluateAll(as => as.map(a => a.getAttribute('href')))
  return [...new Set(hrefs.map(h => decodeURIComponent(h.slice('/blueprint/'.length))))]
}

/**
 * Open /blueprint/<id>, click "Create Gadget" (blueprints without bindings need no configuration),
 * and return the resulting workspace URL (`/workspace/<n>`).
 */
export async function createGadgetFromBlueprint(page, baseUrl, blueprintId) {
  await page.goto(`${baseUrl}/blueprint/${encodeURIComponent(blueprintId)}`)
  await page.getByRole('button', { name: 'Create Gadget' }).click()
  await page.waitForURL(/\/workspace\/[^/?#]+/, { timeout: 60_000 })
  return page.url()
}

/** FrameLocator for the sandboxed srcdoc iframe the gadget's client.js runs in. */
export function gadgetFrame(page) {
  return page.frameLocator('iframe[title="Gadget UI"]')
}

/**
 * From an open workspace: header "Share workspace" -> "Create a share link" -> role menu defaults to
 * "use" -> "Create link". Returns the one-time URL shown in the "Link ready" card, closing the modal.
 */
export async function createUseShareLink(page) {
  await page.getByRole('button', { name: 'Share workspace' }).click()
  await page.getByRole('button', { name: 'Create a share link' }).click()
  const roleMenu = page.getByRole('button', { name: 'Access granted by link' })
  await roleMenu.waitFor()
  // The `use` role is labelled "Gadget only" in the UI ("build" is "Workspace"); it is the default.
  if (!/Gadget only/.test(await roleMenu.innerText())) {
    await roleMenu.click()
    await page.getByRole('menuitem', { name: /^Gadget only/ }).click()
  }
  await page.getByRole('button', { name: 'Create link' }).click()
  const card = page.getByText('Link ready').locator('xpath=ancestor::div[contains(@class,"share-fade-in")]')
  const url = (await card.locator('p.font-mono').innerText({ timeout: 30_000 })).trim()
  await page.keyboard.press('Escape')
  return url
}

/** Open the gadget pane's export dropdown (download icon, aria-label "Export Gadget"). */
export async function openExportMenu(page) {
  // After a previous export the button keeps focus and its tooltip ("data-instant=focus") covers
  // it, intercepting the next click. Blur and move the pointer away first.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() })
  await page.mouse.move(1, 1)
  await page.locator('[data-base-ui-portal] .kumo-tooltip, [data-base-ui-portal] [data-instant]').first()
    .waitFor({ state: 'detached', timeout: 3_000 }).catch(() => {})
  await page.getByRole('button', { name: 'Export Gadget' }).click()
  const menu = page.getByRole('menu')
  await menu.waitFor()
  // Formats load lazily on open; wait for the loading skeleton to go.
  await page.getByRole('status', { name: 'Loading export formats' }).waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {})
  return menu
}

/** Labels of the export formats offered for the selected gadget (menu is left closed). */
export async function listExportFormats(page) {
  const menu = await openExportMenu(page)
  const labels = await menu.getByRole('menuitem').allInnerTexts()
  await page.keyboard.press('Escape')
  return labels.map(s => s.trim())
}

/**
 * Click an export format and capture the resulting file. Returns { filename, text, bytes } or throws.
 * The frontend uses showSaveFilePicker when available, otherwise a blob download.
 * Pass a RegExp such as /^SVG image$/ when one label is a prefix of another: a string `name`
 * matches substrings, which trips Playwright's strict mode.
 * @param {import('playwright').Page} page
 * @param {string|RegExp} label
 */
export async function downloadExport(page, label) {
  // Force the <a download> fallback path so Playwright sees a download event.
  await page.evaluate(() => { try { delete window.showSaveFilePicker } catch {} ; window.showSaveFilePicker = undefined })
  const menu = await openExportMenu(page)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    menu.getByRole('menuitem', { name: label }).click(),
  ])
  const stream = await download.createReadStream()
  const chunks = []
  for await (const c of stream) chunks.push(c)
  const bytes = Buffer.concat(chunks)
  return { filename: download.suggestedFilename(), text: bytes.toString('utf8'), bytes }
}

async function expectEventually(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('condition not met in time')
}
