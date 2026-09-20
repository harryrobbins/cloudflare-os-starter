// Playwright helpers for driving the chat SPA against `wrangler dev` (see ../README.md,
// "End-to-end tests").
//
// Plain ESM; imports `playwright` (a devDependency of this package, pinned to 1.61.0 so it uses the
// Chromium already cached in ~/.cache/ms-playwright). Run the suite with the Linux node from this
// package directory so the import resolves.
//
// Two identities, one browser context each: the dev-identity cookie is per context, which is the whole
// reason a two-user test works at all.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG = join(HERE, '..')
export const BASE = process.env.CHAT_URL ?? 'http://localhost:8787'
export const APP = `${BASE}/gatekeeper/chat`
export const SHOTS = process.env.CHAT_SHOTS ?? '/tmp/chat-e2e'

mkdirSync(SHOTS, { recursive: true })

export const IDENTITIES = { admin: 'dev-admin', user: 'dev-user' }

export async function launch(opts = {}) {
  return chromium.launch({ headless: true, ...opts })
}

/**
 * A signed-in page for one dev identity.
 *
 * `/dev/login?as=<id>` sets the signed cookie and 302s to the app base; the SPA then routes itself to
 * the last conversation, so "ready" is the rail having rendered #general.
 */
export async function openAs(browser, id, options = {}) {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  const problems = watch(page)
  await page.goto(`${APP}/dev/login?as=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded' })
  await railItem(page, 'general').waitFor({ timeout: 30_000 })
  await waitForConnected(page)
  return { context, page, problems }
}

/** Console errors, page errors and 5xx responses, collected for a failure dump. */
export function watch(page) {
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() >= 500) {
      problems.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`)
    }
  })
  return problems
}

/** The socket is open when the connection banner is gone (it renders for every state but `open`). */
export async function waitForConnected(page, timeout = 30_000) {
  await page
    .locator('[role="status"]', { hasText: /Connecting to chat|Reconnecting|Disconnected/ })
    .waitFor({ state: 'detached', timeout })
    .catch(() => undefined)
}

// --- rail -------------------------------------------------------------------

export function railItem(page, channelId) {
  return page.locator(`a[data-channel-id="${channelId}"]`)
}

export async function railState(page, channelId) {
  const item = railItem(page, channelId)
  return {
    unread: (await item.getAttribute('data-unread')) === 'true',
    mentions: Number(await item.getAttribute('data-mentions')),
  }
}

/** Escape closes any open Modal (Modal.tsx traps focus and dismisses on Escape). */
export async function closeDialogs(page) {
  for (let i = 0; i < 3; i++) {
    if ((await page.getByRole('dialog').count()) === 0) return
    await page.keyboard.press('Escape')
    await sleep(150)
  }
}

/**
 * Clicks something that navigates to a *different* conversation and returns the new channel id.
 *
 * `waitForURL(u => u.pathname.includes('/c/'))` is a trap: the page is usually already on a
 * conversation, so it resolves instantly and hands back the channel you started from.
 */
export async function waitForNewChannel(page, previousId, timeout = 20_000) {
  await page.waitForURL(
    (url) => {
      const match = /\/c\/([^/?#]+)/.exec(url.pathname)
      return match !== null && match[1] !== previousId
    },
    { timeout },
  )
  return /\/c\/([^/?#]+)/.exec(new URL(page.url()).pathname)[1]
}

export function currentChannel(page) {
  return /\/c\/([^/?#]+)/.exec(new URL(page.url()).pathname)?.[1] ?? null
}

export async function openChannel(page, channelId) {
  await closeDialogs(page)
  await railItem(page, channelId).click()
  await page.waitForURL((url) => url.pathname.includes(`/c/${channelId}`), { timeout: 15_000 })
  // The composer, not the message list: MessageList renders its empty state instead of the
  // `role="list"` container when the conversation has no messages yet, so waiting on the list hangs
  // on a brand-new workspace -- which is exactly the state the first test runs in.
  await composer(page).waitFor({ timeout: 15_000 })
}

// --- conversation -----------------------------------------------------------

export function messageList(page) {
  return page.getByRole('list', { name: 'Messages' }).first()
}

/** The channel composer. The thread pane's has its own label, so this never picks the wrong one. */
export function composer(page) {
  return page.locator('textarea[aria-label^="Message "]')
}

/** The thread pane's composer. `getByLabel` alone also matches every row's "Reply in thread" button. */
export function threadComposer(page) {
  return page.getByRole('textbox', { name: 'Reply in thread' })
}

/**
 * Types into a composer and sends.
 *
 * The Enter wait is not belt and braces: the composer refuses to send while an attachment is still
 * uploading (`canSend` in Composer.tsx), and Enter is a silent no-op then, so a test that typed and
 * pressed Enter straight after `setInputFiles` would post nothing at all. The Send button's
 * `disabled` is the same `canSend`, so waiting for it to be enabled covers both.
 */
export async function say(page, text, { box = composer } = {}) {
  const field = box(page)
  await field.click()
  await field.fill(text)
  await page
    .locator('button[aria-label="Send message"]:not([disabled])')
    .first()
    .waitFor({ timeout: 30_000 })
  await field.press('Enter')
}

/** A message row, found by its rendered text. Rows carry `data-message-id`. */
export function messageRow(page, text) {
  return page.locator('[data-message-id]').filter({ hasText: text }).first()
}

/**
 * The *server's* id for a message.
 *
 * An optimistic row is in the list first, under `local:<uuid>`, and that id is not a permalink -- so
 * this waits for the reconciliation rather than handing back an id no other tab has ever seen.
 */
export async function messageIdOf(page, text) {
  return until(
    async () => {
      const id = await messageRow(page, text).getAttribute('data-message-id')
      return id !== null && !id.startsWith('local:') ? id : null
    },
    15_000,
    `a server id for "${text}"`,
  )
}

/** Reveals the hover action bar, which is opacity-0 until the row is hovered or focused. */
export async function hoverRow(page, text) {
  const row = messageRow(page, text)
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  return row
}

export async function rowAction(page, text, label) {
  const row = await hoverRow(page, text)
  await row.getByRole('button', { name: label, exact: true }).click()
}

/** "More actions" menu item, e.g. "Mark unread from here". */
export async function rowMenu(page, text, item) {
  const row = await hoverRow(page, text)
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: item }).click()
}

// --- HTTP, as one identity --------------------------------------------------

/**
 * A `fetch` carrying a dev-identity cookie, for the steps a browser should not be doing: seeding
 * history, posting while a tab is disconnected, exhausting a rate-limit budget.
 */
export async function apiClient(id) {
  const response = await fetch(`${APP}/dev/login?as=${encodeURIComponent(id)}`, { redirect: 'manual' })
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
  if (!cookie.startsWith('chat_dev_identity=')) throw new Error(`no dev cookie for ${id}: ${cookie}`)
  const call = async (method, path, body) => {
    const res = await fetch(`${APP}${path}`, {
      method,
      headers: {
        cookie,
        origin: BASE,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    })
    const text = await res.text()
    let parsed
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    return { status: res.status, headers: res.headers, body: parsed }
  }
  return {
    cookie,
    call,
    async ok(method, path, body) {
      const result = await call(method, path, body)
      if (result.status !== 200) {
        throw new Error(`${method} ${path} -> ${result.status} ${JSON.stringify(result.body)}`)
      }
      return result.body
    },
    send(channelId, text, extra = {}) {
      return this.ok('POST', `/api/channels/${encodeURIComponent(channelId)}/messages`, {
        body: text,
        clientId: `e2e-${Math.random().toString(36).slice(2)}`,
        ...extra,
      })
    },
  }
}

// --- the dev server ---------------------------------------------------------

/** Runs `e2e/start-dev.sh` / `stop-dev.sh`, which own the process group. */
export function devServer(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(HERE, script), [], {
      cwd: PKG,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${script}: ${out}`))))
  })
}

export const startDevServer = () => devServer('start-dev.sh', { CHAT_SKIP_BUILD: '1' })
export const stopDevServer = () => devServer('stop-dev.sh')

// --- misc -------------------------------------------------------------------

export async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

/** Polls `check` until it is truthy. Playwright's own waits cover locators; this covers state. */
export async function until(check, timeout = 15_000, label = 'condition') {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
