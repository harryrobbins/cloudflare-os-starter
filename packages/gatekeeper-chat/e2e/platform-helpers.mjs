// Shared by e2e/dock-check.mjs and e2e/agent-check.mjs: the local platform's own sign-up, the chat
// dev identity, and a polling helper. Both run against e2e/start-local-platform.sh.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG = join(HERE, '..')
export const REPO = join(PKG, '..', '..')
export const { chromium } = createRequire(join(PKG, 'package.json'))('playwright')
export const BASE = process.env.CFOS_URL ?? 'http://localhost:8787'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function until(check, timeout, what) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    try {
      last = await check()
      if (last) return last
    } catch (err) {
      last = err.message
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${last})`)
    await sleep(250)
  }
}

// --- the platform's own sign-up (mirrors packages/blueprint-whiteboard/e2e/platform-helpers.mjs) ---

export async function completeOnboarding(page) {
  const heading = page.getByRole('heading', { name: "Let's set you up" })
  try {
    await heading.waitFor({ timeout: 8_000 })
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

export async function signUpOrIn(page, username, password) {
  await page.goto(`${BASE}/signup`)
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Confirm Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  const outcome = await Promise.race([
    page.waitForFunction(() => !!localStorage.getItem('authToken'), null, { timeout: 30_000 }).then(() => 'ok'),
    page.getByText('Username already exists').waitFor({ timeout: 30_000 }).then(() => 'exists'),
  ])
  if (outcome === 'exists') {
    await page.goto(`${BASE}/`)
    await page.getByLabel('Username').fill(username)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForFunction(() => !!localStorage.getItem('authToken'), null, { timeout: 30_000 })
  } else {
    await page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 30_000 })
  }
  await completeOnboarding(page)
}

/**
 * The chat identity: in production the Worker verifies an Access assertion; locally
 * `wrangler.dev.jsonc` points `main` at `src/dev/entry.ts` and a signed `chat_dev_identity` cookie
 * stands in. Per browser context, scoped to `/gatekeeper/chat/`, which the shell's same-origin
 * iframe sends too.
 */
export async function chatDevLogin(page, id) {
  await page.goto(`${BASE}/gatekeeper/chat/dev/login?as=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' })
  await page.locator('a[data-channel-id="general"]').first().waitFor({ timeout: 30_000 })
}

/**
 * The chat dev identity without loading the chat app: sets the signed `chat_dev_identity` cookie in
 * this browser context and stops at the redirect. For a person who only ever sees the shell, and for
 * the in-platform layout, which serves the API but no SPA.
 */
export async function chatDevCookie(context, id) {
  const response = await context.request.get(`${BASE}/gatekeeper/chat/dev/login?as=${encodeURIComponent(id)}`, {
    maxRedirects: 0,
  })
  if (response.status() !== 302) throw new Error(`dev login as ${id} -> ${response.status()}`)
}

/** One chat API call as that context's identity, with the Origin a browser would send. */
export async function chatApi(context, method, path, body) {
  const response = await context.request.fetch(`${BASE}/gatekeeper/chat/api${path}`, {
    method,
    headers: { origin: BASE, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { data: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok()) throw new Error(`${method} ${path} -> ${response.status()} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}
