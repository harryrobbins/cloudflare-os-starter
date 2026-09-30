// Live check that a call survives moving between the shell's full chat page and its sidebar, against
// a REAL Realtime SFU app through the real router (docs/plans/chat-video-implementation.md, Stream F).
// Not part of `test:run`.
//
//   CHAT_DEV_ENV_FILE=/path/calls.env packages/gatekeeper-chat/e2e/start-local-platform.sh
//   node packages/gatekeeper-chat/e2e/call-move-check.mjs   # PASS/FAIL per step, exits 1 on any FAIL
//   packages/gatekeeper-chat/e2e/stop-local-platform.sh
//
// A is in the shell (platform account `admin`, chat `dev-admin`); B joins from the standalone chat page
// (`dev-user`). Every step checks the same RTCPeerConnection is still connected and still receiving
// B's audio: a move that remounted the frame or the engine would show up as a new connection.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { BASE, chatDevLogin, chromium, signUpOrIn, until } from './platform-helpers.mjs'

const SHOTS = process.env.CALL_MOVE_SHOTS ?? join(process.env.TMPDIR ?? '/tmp', 'cfos-call-move')
mkdirSync(SHOTS, { recursive: true })
const A = { user: 'admin', pass: 'chatdock123', chat: 'dev-admin' }
const B = { chat: 'dev-user' }

const results = []
async function step(name, fn) {
  try {
    const detail = await fn()
    results.push({ ok: true, line: `PASS ${name}${typeof detail === 'string' ? ` — ${detail}` : ''}` })
  } catch (error) {
    await a.screenshot({ path: join(SHOTS, `fail-${results.length}.png`) }).catch(() => undefined)
    results.push({ ok: false, line: `FAIL ${name} — ${error.message.split('\n')[0].slice(0, 300)}` })
  }
  console.log(results.at(-1).line)
}

function tagPeerConnections() {
  const Original = window.RTCPeerConnection
  if (!Original) return
  window.__pcs = []
  window.RTCPeerConnection = class extends Original {
    constructor(...args) {
      super(...args)
      window.__pcs.push(this)
    }
  }
}

const chatFrame = (page) => page.frames().find((frame) => frame.url().includes('/gatekeeper/chat/'))
const frameLoc = (page) => page.frameLocator('iframe[title="Team chat"]')

/** The engine's connection in the shell's chat frame, and what it has received so far. */
async function media(page) {
  const frame = chatFrame(page)
  if (!frame) throw new Error('no chat frame')
  return frame.evaluate(async () => {
    const pc = window.__pcs?.at(-1)
    if (!pc) return null
    let audio = 0
    ;(await pc.getStats()).forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') audio += s.packetsReceived
    })
    return { count: window.__pcs.length, state: pc.connectionState, audio }
  })
}

/** Same connection, still connected, and B's audio packets keep arriving across `ms`. */
async function audioContinues(page, before, ms = 3_000) {
  await page.waitForTimeout(ms)
  const after = await media(page)
  if (!after) throw new Error('the connection is gone')
  if (after.count !== before.count) throw new Error(`a new peer connection was made (${before.count} -> ${after.count})`)
  if (after.state !== 'connected') throw new Error(`connection ${after.state}`)
  if (after.audio <= before.audio) throw new Error(`no audio packets in ${ms} ms (${before.audio} -> ${after.audio})`)
  return after
}

/** Where keyboard focus is: the shell element, or the element inside the chat frame. */
async function focusReport(page) {
  const shell = await page.evaluate(() => {
    const el = document.activeElement
    return el ? `${el.tagName.toLowerCase()}${el.getAttribute('title') ? `[title="${el.getAttribute('title')}"]` : ''}${el.getAttribute('aria-label') ? `[aria-label="${el.getAttribute('aria-label')}"]` : ''}` : 'none'
  })
  const inner = shell.startsWith('iframe')
    ? await chatFrame(page)?.evaluate(() => {
        const el = document.activeElement
        return el ? `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[aria-label="${el.getAttribute('aria-label')}"]` : ''}` : 'none'
      })
    : null
  return inner ? `${shell} > ${inner}` : shell
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const aContext = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ['camera', 'microphone'] })
await aContext.addInitScript(tagPeerConnections)
const a = await aContext.newPage()
const bContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] })
const b = await bContext.newPage()
let snapshot = null

try {
  await step('setup: A signs in to the platform and chat', async () => {
    await chatDevLogin(a, A.chat)
    await signUpOrIn(a, A.user, A.pass)
  })
  await step('setup: B opens the standalone chat page', async () => {
    await chatDevLogin(b, B.chat)
    await b.locator('a[data-channel-id="general"]').first().click()
  })

  await step('A starts a call from the full /chat page in the shell', async () => {
    await a.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    await a.goto(`${BASE}/chat/c/general`, { waitUntil: 'networkidle' })
    const frame = frameLoc(a)
    await frame.getByRole('button', { name: /^(Start call|Join call)/ }).first().click({ timeout: 30_000 })
    await frame.locator('[data-call-join]').click({ timeout: 20_000 })
    await b.getByRole('button', { name: /^Join call/ }).first().click({ timeout: 20_000 })
    await b.locator('[data-call-join]').click({ timeout: 20_000 })
    snapshot = await until(async () => {
      const m = await media(a)
      return m?.state === 'connected' && m.audio > 0 ? m : null
    }, 30_000, 'A connected and hearing B')
    await a.screenshot({ path: join(SHOTS, '1-full-page.png') })
    return `connection ${snapshot.count}, ${snapshot.audio} audio packets`
  })

  await step('Pop out to sidebar keeps the connection and the audio', async () => {
    await frameLoc(a).getByRole('button', { name: 'Pop out to sidebar' }).click()
    await until(async () => !new URL(a.url()).pathname.startsWith('/chat'), 15_000, 'shell left /chat')
    await a.locator('[data-testid="chat-dock"]').waitFor({ state: 'visible', timeout: 10_000 })
    snapshot = await audioContinues(a, snapshot)
    await a.screenshot({ path: join(SHOTS, '2-sidebar.png') })
    const focus = await focusReport(a)
    if (!focus.startsWith('iframe')) throw new Error(`focus left the call: ${focus}`)
    return `now at ${new URL(a.url()).pathname}; focus ${focus}`
  })

  await step('closing the sidebar mid-call shows the In a call pill and audio continues', async () => {
    await a.locator('[data-testid="chat-dock"]').getByRole('button', { name: 'Close chat' }).first().click()
    await a.getByText('In a call').first().waitFor({ timeout: 10_000 })
    snapshot = await audioContinues(a, snapshot)
    await a.screenshot({ path: join(SHOTS, '3-pill.png') })
    const focus = await focusReport(a)
    if (!focus.includes('aria-label="Mute"') && !focus.includes('Toggle microphone') && !focus.includes('Unmute')) {
      throw new Error(`focus is not on the pill: ${focus}`)
    }
    return `focus ${focus}`
  })

  await step("the pill's side-panel button brings the call back with focus in it", async () => {
    await a.getByTestId('chat-call-pill').getByRole('button', { name: 'Show call in the side panel' }).click()
    await a.locator('[data-testid="chat-dock"]').waitFor({ state: 'visible', timeout: 10_000 })
    snapshot = await audioContinues(a, snapshot)
    const focus = await focusReport(a)
    if (!focus.startsWith('iframe')) throw new Error(`focus left the call: ${focus}`)
    return `focus ${focus}`
  })

  await step('Expand to full page keeps the connection, the audio and the focus', async () => {
    const frame = frameLoc(a)
    // The compact call bar keeps it in the "More call options" menu.
    await frame.getByRole('button', { name: 'More call options' }).click()
    await frame.getByRole('menuitem', { name: 'Expand to full page' }).click({ timeout: 10_000 })
    await until(async () => new URL(a.url()).pathname.startsWith('/chat'), 15_000, 'shell on /chat')
    snapshot = await audioContinues(a, snapshot)
    await a.screenshot({ path: join(SHOTS, '4-expanded.png') })
    const focus = await focusReport(a)
    if (!focus.startsWith('iframe')) throw new Error(`focus left the call: ${focus}`)
    return `now at ${new URL(a.url()).pathname}; focus ${focus}`
  })

  await step('leaving from the full page ends A in the call', async () => {
    await frameLoc(a).getByRole('button', { name: 'Leave the call' }).first().click()
    await b.getByRole('button', { name: 'Leave the call' }).first().click()
  })
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed; screenshots in ${SHOTS}`)
process.exit(failed > 0 ? 1 : 0)
