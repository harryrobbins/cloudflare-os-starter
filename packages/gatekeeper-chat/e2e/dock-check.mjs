// Live check of the shell's chat dock (the fork's `feat/chat-dock` commit) against this Worker,
// through the real router on the local platform. Not part of `test:run`: it needs
// `e2e/start-local-platform.sh` up first (see the README, "Through the real router").
//
//   packages/gatekeeper-chat/e2e/start-local-platform.sh
//   node packages/gatekeeper-chat/e2e/dock-check.mjs        # prints PASS/FAIL per step, exits 1 on any FAIL
//   packages/gatekeeper-chat/e2e/stop-local-platform.sh
//
// Two browser contexts: A is the person in the shell (platform account `admin`, chat identity
// `dev-admin`), B writes to them from the standalone chat page (`beta` / `dev-user`). Step 6 adds a
// third, C (`gamma` / `dev-colleague`), who signs in to the platform and never opens chat. The platform's
// accounts and the chat Durable Object persist across runs in wrangler's local state, so every count
// is relative to what was there before and every message carries a fresh marker.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { BASE, REPO, chatApi, chatDevCookie, chatDevLogin, chromium, signUpOrIn, until } from './platform-helpers.mjs'
const SHOTS = process.env.CHAT_DOCK_SHOTS ?? join(process.env.TMPDIR ?? '/tmp', 'cfos-chat-dock')
mkdirSync(SHOTS, { recursive: true })
const ARCHIVE = join(REPO, 'formats', 'whiteboard.gadget')

const A = { user: 'admin', pass: 'chatdock123', chat: 'dev-admin' }
const B = { user: 'beta', pass: 'chatdock123', chat: 'dev-user' }
/** Signs in to the platform and never opens chat: the People check (step 6). */
const C = { user: 'gamma', pass: 'chatdock123', chat: 'dev-colleague' }

const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png` })

/** Console errors, page errors and 5xx, kept for the framing/CSP summary at the end. */
function watch(page, label, sink) {
  page.on('console', (m) => {
    if (m.type() === 'error') sink.push(`${label} console.error: ${m.text()}`)
  })
  page.on('pageerror', (e) => sink.push(`${label} pageerror: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 500) sink.push(`${label} http ${r.status()}: ${r.request().method()} ${r.url()}`)
  })
}

// --- locators -----------------------------------------------------------------

const dock = (page) => page.locator('[data-testid="chat-dock"]')
const dockFrame = (page) => page.frameLocator('iframe[title="Team chat"]')
const sidebarChat = (page) => page.locator('nav').getByRole('button', { name: /^Chat($| —)/ })
/** Either proves the app rendered: compact mode lands on the inbox with the rail behind a button. */
const appLoaded = (frame) => frame.locator('a[data-channel-id="general"], button[aria-label="Conversations"]').first()
const dockState = async (page) => dock(page).getAttribute('aria-hidden')
const mentionsIn = (label) => Number((label ?? '').match(/(\d+) mention/)?.[1] ?? 0)

async function frameEval(page, fn) {
  const frame = page.frames().find((f) => f.url().includes('/gatekeeper/chat/'))
  if (frame === undefined) throw new Error('no chat frame on the page')
  return frame.evaluate(fn)
}

// --- the run --------------------------------------------------------------------

const problems = []
const results = []
async function step(name, fn) {
  try {
    const detail = await fn()
    results.push(`PASS ${name}${typeof detail === 'string' ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push(`FAIL ${name} — ${error.message.split('\n')[0].slice(0, 300)}`)
  }
  console.log(results.at(-1))
}

const browser = await chromium.launch({ headless: true })
const a = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage()
const b = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
watch(a, 'A', problems)
watch(b, 'B', problems)

await step('setup: A chat identity + platform account', async () => {
  await chatDevLogin(a, A.chat)
  await signUpOrIn(a, A.user, A.pass)
})
let accent = null
await step('setup: A saves a non-default accent, so chat:theme is observable', async () => {
  await a.goto(`${BASE}/admin`)
  await a.getByRole('heading', { name: 'Theme' }).waitFor({ timeout: 30_000 })
  await a.getByRole('button', { name: 'Purple' }).click()
  // One Save per admin section; the accent's is the first after the swatches.
  await a.getByRole('button', { name: 'Purple' }).locator('xpath=following::button[normalize-space()="Save"][1]').click()
  await a.getByText('Accent color saved').waitFor({ timeout: 20_000 })
  accent = await a.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-kumo-brand').trim())
  return `shell brand var = ${accent}`
})
await step('setup: B chat identity + platform account', async () => {
  await chatDevLogin(b, B.chat)
  await signUpOrIn(b, B.user, B.pass)
  await chatDevLogin(b, B.chat)
})

// 1. the trigger and the drawer
await a.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await step('1a the sidebar has a Chat row', async () => {
  await sidebarChat(a).waitFor({ timeout: 30_000 })
  await shot(a, '01-shell-sidebar')
  return `label "${await sidebarChat(a).getAttribute('aria-label')}"`
})
await step('1b clicking it opens the drawer with the app inside', async () => {
  await sidebarChat(a).click()
  await dock(a).waitFor({ state: 'visible', timeout: 10_000 })
  await appLoaded(dockFrame(a)).waitFor({ timeout: 30_000 })
  if ((await dockState(a)) !== 'false') throw new Error(`aria-hidden=${await dockState(a)}`)
  await shot(a, '02-dock-open')
  const src = await a.locator('iframe[title="Team chat"]').getAttribute('src')
  if (!src.includes('compact=1')) throw new Error(`drawer src is not compact: ${src}`)
  return `iframe src ${src}`
})
await step('1c chat:theme reached the frame (accent applied)', async () => {
  const inFrame = await until(async () => {
    const v = await frameEval(a, () => document.documentElement.style.getPropertyValue('--color-kumo-brand').trim())
    return v.length > 0 ? v : null
  }, 15_000, 'accent in frame')
  // The shell wraps the accent in light-dark(); the frame gets the raw value.
  if (accent && !accent.toLowerCase().includes(inFrame.toLowerCase())) throw new Error(`frame ${inFrame} vs shell ${accent}`)
  return `frame brand var = ${inFrame}`
})

// 2. close, keyboard, reopen
await step('2a the Close button hides the drawer and the trigger stays', async () => {
  await a.getByRole('button', { name: 'Close chat' }).click()
  await until(async () => (await dockState(a)) === 'true', 5_000, 'aria-hidden true')
  if (!(await sidebarChat(a).isVisible())) throw new Error('sidebar trigger vanished')
})
await step('2b Ctrl+Shift+L toggles it open', async () => {
  await a.locator('body').click({ position: { x: 5, y: 5 } })
  await a.keyboard.press('Control+Shift+L')
  await until(async () => (await dockState(a)) === 'false', 5_000, 'aria-hidden false')
})
await step('2c Escape from the drawer chrome closes it', async () => {
  await a.getByRole('button', { name: 'Close chat' }).focus()
  await a.keyboard.press('Escape')
  await until(async () => (await dockState(a)) === 'true', 5_000, 'aria-hidden true')
})

// 3. a mention arrives while the drawer is closed
const marker = `ping from the dock check ${Date.now().toString(36)}`
let mentionsBefore = 0
await step('3a B posts a mention of A in #general', async () => {
  mentionsBefore = mentionsIn(await sidebarChat(a).getAttribute('aria-label'))
  const res = await b.evaluate(async (text) => {
    const r = await fetch('/gatekeeper/chat/api/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: `<@dev-admin> ${text}`, clientId: `dock-${Math.random().toString(36).slice(2)}` }),
    })
    return { status: r.status, body: (await r.text()).slice(0, 200) }
  }, marker)
  if (res.status !== 200) throw new Error(`POST -> ${res.status} ${res.body}`)
})
await step('3b the sidebar badge gains a mention and a toast appears in the shell', async () => {
  await until(async () => mentionsIn(await sidebarChat(a).getAttribute('aria-label')) === mentionsBefore + 1, 20_000, 'mention badge')
  await a.getByText(marker).first().waitFor({ timeout: 10_000 })
  await shot(a, '03-mention-badge-and-toast')
  return `label "${await sidebarChat(a).getAttribute('aria-label')}" (${mentionsBefore} before)`
})
await step("3c the toast's Open lands the dock on the message and the mention clears", async () => {
  await a.getByRole('button', { name: 'Open', exact: true }).first().click()
  await until(async () => (await dockState(a)) === 'false', 5_000, 'dock open')
  await dockFrame(a).getByText(marker).first().waitFor({ timeout: 20_000 })
  await shot(a, '04-dock-at-permalink')
  await until(async () => mentionsIn(await sidebarChat(a).getAttribute('aria-label')) === 0, 20_000, 'mention badge cleared')
  return `label "${await sidebarChat(a).getAttribute('aria-label')}"`
})

// 4. the full page
await step('4a the expand button navigates to /chat/… with the wide layout and one frame', async () => {
  await a.getByRole('button', { name: 'Open chat full page' }).click()
  await a.waitForURL((u) => new URL(u).pathname.startsWith('/chat'), { timeout: 15_000 })
  const frame = a.frameLocator('iframe[title="Team chat"]')
  await frame.locator('a[data-channel-id="general"]').first().waitFor({ timeout: 30_000 })
  await frame.locator('textarea[aria-label^="Message "]').first().waitFor({ timeout: 15_000 })
  const src = await a.locator('iframe[title="Team chat"]').getAttribute('src') // strict: exactly one frame
  if (src.includes('compact=1')) throw new Error(`full page src is compact: ${src}`)
  if ((await dock(a).count()) !== 0) throw new Error('the dock is still mounted beside the page')
  await shot(a, '05-chat-full-page')
  return `${new URL(a.url()).pathname}; src ${src}`
})
await step('4b a direct /chat/c/general load works and the sidebar row still exists', async () => {
  await a.goto(`${BASE}/chat/c/general`, { waitUntil: 'networkidle' })
  await a.frameLocator('iframe[title="Team chat"]').getByText(marker).first().waitFor({ timeout: 30_000 })
  await sidebarChat(a).waitFor({ timeout: 10_000 })
})
await step('4c a message typed on the full page reaches B live', async () => {
  const reply = `reply from the shell page ${Date.now().toString(36)}`
  const field = a.frameLocator('iframe[title="Team chat"]').locator('textarea[aria-label^="Message "]').first()
  await field.click()
  await field.fill(reply)
  await field.press('Enter')
  await b.locator('a[data-channel-id="general"]').first().click()
  await b.getByText(reply).first().waitFor({ timeout: 20_000 })
})

// 5. the fullscreen workspace editor's top-bar button
await step('5a a workspace exists (whiteboard.gadget uploaded if needed, then Create Gadget)', async () => {
  await a.goto(`${BASE}/blueprints`, { waitUntil: 'networkidle' })
  await a.getByRole('heading', { name: 'Blueprints', level: 1 }).waitFor({ timeout: 30_000 })
  await a.waitForFunction(() => !document.querySelector('.animate-pulse'), null, { timeout: 30_000 })
  const links = async () => a.locator('a[href^="/blueprint/"]').evaluateAll((as) => as.map((x) => x.getAttribute('href')))
  let href = (await links())[0]
  if (href === undefined) {
    await a.locator('input[type="file"][accept=".gadget"]').setInputFiles(ARCHIVE)
    await a.getByText('Blueprint uploaded').first().waitFor({ timeout: 60_000 })
    href = await until(async () => (await links())[0], 30_000, 'uploaded blueprint link')
  }
  await a.goto(`${BASE}${href}`)
  await a.getByRole('button', { name: 'Create Gadget' }).click()
  await a.waitForURL(/\/workspace\/[^/?#]+/, { timeout: 60_000 })
  return new URL(a.url()).pathname
})
await step('5b the editor has the chat button and it opens the dock', async () => {
  await a.waitForLoadState('networkidle')
  const button = a.getByRole('button', { name: /^Chat($| —)/ }).last()
  await button.waitFor({ timeout: 30_000 })
  await button.click()
  await until(async () => (await dockState(a)) === 'false', 10_000, 'dock open from the editor')
  await appLoaded(dockFrame(a)).waitFor({ timeout: 30_000 })
  await shot(a, '08-editor-dock')
})

// 6. People from platform sign-ins, and the Agent as an app
let knownBefore = null
await step('6a a colleague who only loads the shell is announced to chat once, with no chat frame', async () => {
  const lookup = await chatApi(b.context(), 'GET', `/users?ids=${C.chat}`)
  knownBefore = lookup.users.length > 0
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await chatDevCookie(context, C.chat)
  const c = await context.newPage()
  watch(c, 'C', problems)
  const seen = c.waitForResponse(
    (r) => r.url().endsWith('/gatekeeper/chat/api/me/seen') && r.request().method() === 'POST',
    { timeout: 90_000 },
  )
  await signUpOrIn(c, C.user, C.pass)
  const response = await seen
  if (response.status() !== 200) throw new Error(`POST /api/me/seen -> ${response.status()}`)
  await c.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await sidebarChat(c).waitFor({ timeout: 30_000 })
  if ((await c.locator('iframe[title="Team chat"]').count()) !== 0) throw new Error('the dock frame was mounted')
  await context.close()
  return knownBefore ? 'announced (already known from an earlier run)' : 'announced; unknown to chat before'
})
await step('6b they appear under People for another user', async () => {
  const lookup = await chatApi(b.context(), 'GET', `/users?ids=${C.chat}`)
  if (lookup.users[0]?.name !== 'Dev Colleague') throw new Error(`lookup ${JSON.stringify(lookup)}`)
  await b.goto(`${BASE}/gatekeeper/chat/people`)
  await b.getByText('Dev Colleague').first().waitFor({ timeout: 20_000 })
  await shot(b, '09-people-colleague')
  return knownBefore === false ? 'absent before 6a, listed after' : 'listed'
})
await step('6c the Agent is listed as an app with what it does, not as an offline person', async () => {
  const hint = b.getByTestId('agent-hint').first()
  await hint.waitFor({ timeout: 10_000 })
  const text = await hint.innerText()
  if (!/Mention @agent in a public channel/.test(text)) throw new Error(`hint "${text}"`)
  return text
})
await step('6d the composer says what asking the Agent sends, before sending', async () => {
  await b.goto(`${BASE}/gatekeeper/chat/c/general`)
  const field = b.locator('textarea[aria-label^="Message "]').first()
  await field.waitFor({ timeout: 20_000 })
  await field.fill('@agent what changed this week?')
  const note = b.getByTestId('agent-note')
  await note.waitFor({ timeout: 10_000 })
  await shot(b, '10-agent-disclosure')
  await field.fill('')
  return (await note.innerText().catch(() => '')).slice(0, 80) || 'shown'
})

await browser.close()
const failed = results.filter((r) => r.startsWith('FAIL')).length
const framing = problems.filter((p) => /Blocked a frame|Content Security Policy|Refused to|http 5\d\d/.test(p))
console.log(`\n${results.length - failed}/${results.length} passed; screenshots in ${SHOTS}`)
console.log(`console problems: ${problems.length} (${framing.length} framing/CSP/5xx)`)
for (const p of framing) console.log(`  ${p.slice(0, 300)}`)
process.exit(failed === 0 && framing.length === 0 ? 0 : 1)
