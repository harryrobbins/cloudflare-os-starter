// Browser tests against the fidelity harness (harness/): the built client (dist/client.js) in an
// opaque-origin srcdoc frame under the platform's CSP, over the real src/server/core.js in the
// parent page. Plan: docs/plans/tessera-blueprint.md, Part C, scenarios 1-6.
//
//   node scripts/build.mjs && node --test --test-concurrency=1 e2e/harness.test.mjs
//   (or: pnpm run test:e2e)
//
// Headless Linux Chromium from the Playwright cache (the playwright-wsl recipe). The harness
// server is started here in its own process group and killed afterwards. Screenshots of failures
// go to $HARNESS_SHOTS (default /tmp/tessera-harness-shots).
//
// Test hooks the client provides inside the frame: globalThis.tesseraGadget =
// {handle, ready, engine(), state(), currentKey(), count()}.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { chromium } from 'playwright'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.HARNESS_PORT || 8791)
const SHOTS = process.env.HARNESS_SHOTS || '/tmp/tessera-harness-shots'

let server
let browser

before(async () => {
  await mkdir(SHOTS, { recursive: true })
  server = await startServer()
  browser = await chromium.launch({ headless: true })
})

after(async () => {
  await browser?.close()
  server?.stop()
})

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(PKG, 'harness/serve.mjs'), '--port', String(PORT)], { cwd: PKG, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const stop = () => { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
    const timer = setTimeout(() => { stop(); reject(new Error(`harness server did not start: ${out}`)) }, 10_000)
    child.stdout.on('data', d => {
      out += d
      const m = /HARNESS_URL (\S+)/.exec(out)
      if (m) { clearTimeout(timer); resolve({ url: m[1], stop }) }
    })
    child.stderr.on('data', d => { out += d })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`harness server exited ${code}: ${out}`)) })
  })
}

async function until(fn, { timeout = 15_000, interval = 100, message = 'condition' } = {}) {
  const end = Date.now() + timeout
  let last
  for (;;) {
    try { last = await fn(); if (last) return last } catch (error) { last = error }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}; last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)}`)
    await new Promise(r => setTimeout(r, interval))
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Opens the harness in a fresh context and runs `fn`. Afterwards it fails on page errors, console
 * errors (every frame; CSP refusals are logged there too) and CSP violations reported by the frame.
 */
async function withHarness(query, fn) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(`pageerror: ${e}`))
  try {
    await page.goto(`${server.url}${query}`)
    await page.waitForFunction(() => window.harness?.ready === true, null, { timeout: 15_000 })
    const h = { page, errors, frame: () => gadgetFrame(page) }
    await waitGadget(h)
    await fn(h)
    const violations = await page.evaluate(() => window.harness.violations)
    assert.deepEqual(violations, [], 'no CSP violations inside the gadget frame')
    assert.deepEqual(errors.filter(e => !/favicon/.test(e)), [], 'no console or page errors')
  } catch (error) {
    await page.screenshot({ path: join(SHOTS, `failure-${Date.now()}.png`) }).catch(() => {})
    if (errors.length) console.log('# console errors:', errors.slice(0, 10))
    throw error
  } finally {
    await context.close()
  }
}

/** The current gadget frame (a new one after each pane reload). */
async function gadgetFrame(page) {
  const handle = await page.waitForSelector('#pane iframe')
  return until(() => handle.contentFrame(), { message: 'gadget frame' })
}

/** Evaluates `fn(tesseraGadget, arg)` in the frame (over CDP, so the frame's CSP does not apply). */
async function inGadget(h, fn, arg) {
  const frame = await h.frame()
  return frame.evaluate(`(${fn})(globalThis.tesseraGadget, ${JSON.stringify(arg ?? null)})`)
}

/** Waits for the client's hook and its `ready`, then for cards on screen. */
async function waitGadget(h) {
  await until(() => inGadget(h, g => Boolean(g)), { message: 'globalThis.tesseraGadget' })
  await inGadget(h, g => g.ready)
  await until(() => inGadget(h, g => g.count() > 0), { message: 'cards (count() > 0)' })
}

async function reloadPane(h) {
  const before = await h.page.evaluate(() => window.harness.handshakes)
  await h.page.evaluate(() => window.harness.reloadGadget())
  await until(() => h.page.evaluate(n => window.harness.handshakes > n, before), { message: 'new RPC handshake' })
  await waitGadget(h)
}

/** Persisted state as the facet (the real core) holds it. */
const serverState = h => h.page.evaluate(() => window.harness.core.getState())

// ---- a minimal PNG decoder (8-bit RGB/RGBA, non-interlaced), for the pixel sample -------------

function decodePng(buf) {
  let pos = 8
  let width = 0, height = 0, channels = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PNG: only 8-bit non-interlaced')
      channels = { 2: 3, 6: 4 }[data[9]]
      if (!channels) throw new Error(`PNG: colour type ${data[9]}`)
    } else if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      out[y * stride + x] = v & 0xff
    }
  }
  return { width, height, channels, pixels: out }
}

/** Share of pixels that differ clearly from the most common colour (the background). */
function nonBackgroundShare({ width, height, channels, pixels }) {
  const counts = new Map()
  const key = i => (pixels[i] >> 3) << 10 | (pixels[i + 1] >> 3) << 5 | pixels[i + 2] >> 3
  for (let i = 0; i < width * height * channels; i += channels) counts.set(key(i), (counts.get(key(i)) || 0) + 1)
  const top = Math.max(...counts.values())
  return { share: 1 - top / (width * height), colours: counts.size }
}

// ---- scenarios ---------------------------------------------------------------------------------

test('0. the harness frame is opaque-origin and reports CSP violations (detector self-check)', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(server.url)
    await page.waitForFunction(() => window.harness?.ready === true)
    const frame = await gadgetFrame(page)
    const probe = await frame.evaluate(() => {
      let storage = 'ok'
      try { void localStorage.length } catch { storage = 'throws' }
      new Image().src = 'https://example.invalid/x.png' // img-src data: only
      return { origin: location.origin, storage }
    })
    assert.deepEqual(probe, { origin: 'null', storage: 'throws' })
    await until(() => page.evaluate(() => window.harness.violations.some(v => v.directive === 'img-src')), { timeout: 5000, message: 'img-src violation reported' })
  } finally {
    await context.close()
  }
})

test('1. renders a WebGL2 canvas with cards, with no CSP violations or errors', async () => {
  await withHarness('', async h => {
    const frame = await h.frame()
    const info = await frame.evaluate(() => {
      const canvas = document.querySelector('canvas')
      const gl = canvas?.getContext('webgl2')
      return { canvas: Boolean(canvas), webgl2: Boolean(gl), width: canvas?.width ?? 0, height: canvas?.height ?? 0 }
    })
    assert.ok(info.canvas, 'a canvas is mounted')
    assert.ok(info.webgl2, 'the canvas has a WebGL2 context')
    assert.ok(info.width > 0 && info.height > 0, 'the canvas has a size')
    const count = await inGadget(h, g => g.count())
    assert.ok(count > 0, `cards in the collection (${count})`)
    await sleep(1500) // let the fly-in animation settle
    // Hide the HTML overlays (axes, legend, HUD) drawn over the canvas, so only WebGL pixels count.
    await frame.evaluate(() => { for (const el of document.querySelectorAll('#axes, #legend, #hud, .cursor-chip')) el.style.visibility = 'hidden' })
    const shot = await frame.locator('canvas').first().screenshot({ path: join(SHOTS, 'scenario-1-canvas.png') })
    await frame.evaluate(() => { for (const el of document.querySelectorAll('#axes, #legend, #hud, .cursor-chip')) el.style.visibility = '' })
    // A blank canvas is one colour; the opening map layout draws ~1-2% of pixels as dots.
    const sample = nonBackgroundShare(decodePng(shot))
    assert.ok(sample.share > 0.003 && sample.colours > 16, `canvas shows cards, not a blank fill (${JSON.stringify(sample)})`)
  })
})

test('2. the layout worker runs as a data: worker', async () => {
  await withHarness('', async h => {
    // The fallback to in-thread solving happens on onerror or after 3 s without a reply.
    await sleep(3500)
    assert.equal(await inGadget(h, g => g.engine()), 'worker')
  })
})

test('3. switching demo collection and layout persists across a pane reload', async () => {
  await withHarness('', async h => {
    const frame = await h.frame()
    const current = await inGadget(h, g => g.currentKey())
    const next = await frame.evaluate(cur => [...document.querySelectorAll('#dataset option')].map(o => o.value).find(v => v && v !== cur && v.startsWith('invoices:')), current)
    assert.ok(next, `another demo collection in the menu (current ${current})`)
    await frame.locator('#dataset').selectOption(next)
    await until(() => inGadget(h, (g, key) => g.currentKey() === key && g.count() > 0, next), { message: `collection ${next} loaded` })
    await frame.locator('#layoutSeg button[data-layout="bars"]').click()
    await until(() => inGadget(h, g => g.state()?.view?.layout === 'bars' || g.handle.getView().layout === 'bars'), { message: 'bars layout' })
    await until(async () => { const s = await serverState(h); return s.source?.kind === 'demo' && s.source.key === next && s.view?.layout === 'bars' }, { message: 'view saved to the facet' })

    await reloadPane(h)
    assert.equal(await inGadget(h, g => g.currentKey()), next, 'collection restored')
    assert.equal(await inGadget(h, g => g.handle.getView().layout), 'bars', 'layout restored')
    const active = await (await h.frame()).locator('#layoutSeg button.active').getAttribute('data-layout')
    assert.equal(active, 'bars', 'layout control shows the restored layout')
  })
})

test('4. Titanic loads from the inlined CSV', async () => {
  await withHarness('', async h => {
    await (await h.frame()).locator('#dataset').selectOption('titanic')
    await until(() => inGadget(h, g => g.currentKey() === 'titanic' && g.count() === 1309), { message: 'Titanic with 1309 cards' })
  })
})

test('5. with PROCGEN, the Data popover lists tables; daily_metrics loads 730 cards and survives a reload', async () => {
  await withHarness('?procgen=1', async h => {
    const frame = await h.frame()
    await frame.locator('#tg-data-btn').click()
    await frame.locator('#tg-data-popover').waitFor({ state: 'visible' })
    const tables = await frame.locator('button[data-tg-source="PROCGEN"]').evaluateAll(els => els.map(el => el.dataset.tgTable))
    assert.ok(tables.length > 1, `tables listed (${tables})`)
    assert.ok(tables.includes('daily_metrics'), `daily_metrics listed (${tables})`)
    assert.equal(await frame.locator('#tg-maxrows').count(), 1, 'a row cap selector')
    await frame.locator('button[data-tg-table="daily_metrics"][data-tg-source="PROCGEN"]').click()
    await until(() => inGadget(h, g => g.count() === 730), { timeout: 30_000, message: '730 cards' })
    await until(async () => /Loaded 730 rows/.test(await frame.locator('#tg-status').textContent()), { message: '#tg-status "Loaded 730 rows"' })
    const key = await inGadget(h, g => g.currentKey())
    assert.equal(key, 'src:PROCGEN:daily_metrics')
    await until(async () => { const s = await serverState(h); return s.source?.kind === 'connector' && s.source.table === 'daily_metrics' }, { message: 'connector source saved' })

    await reloadPane(h)
    await until(() => inGadget(h, g => g.count() === 730), { timeout: 30_000, message: '730 cards after reload' })
    assert.equal(await inGadget(h, g => g.currentKey()), key, 'connector table restored')
  })
})

test('5b. a sampled orders load brings the joined customer facets in one read', async () => {
  await withHarness('?procgen=1', async h => {
    const frame = await h.frame()
    await frame.locator('#tg-data-btn').click()
    await frame.locator('#tg-data-popover').waitFor({ state: 'visible' })
    await frame.locator('button[data-tg-table="orders"][data-tg-source="PROCGEN"]').click()
    await until(() => inGadget(h, g => g.count() === 2_000), { timeout: 30_000, message: '2,000 cards (the default cap of 10,000 orders)' })
    const facets = await frame.locator('#colorBy option').evaluateAll(els => els.map(el => el.value))
    for (const facet of ['status', 'customer tier', 'customer country code']) assert.ok(facets.includes(facet), `${facet} is a facet (${facets})`)
  })
})

test('6. without a connector, the Data popover shows the connect hint', async () => {
  await withHarness('', async h => {
    const frame = await h.frame()
    await frame.locator('#tg-data-btn').click()
    await frame.locator('#tg-data-popover').waitFor({ state: 'visible' })
    const hint = frame.locator('#tg-connect-hint')
    await hint.waitFor({ state: 'visible' })
    assert.match(await hint.textContent(), /Connect a data source/)
    assert.equal(await frame.locator('button[data-tg-table]').count(), 0, 'no connector tables')
    // Live regions stay in the accessibility tree while empty, so later text is announced.
    assert.equal(await frame.locator('#tg-toast').evaluate(el => !el.hidden && getComputedStyle(el).display !== 'none'), true, 'toast live region rendered')
    assert.equal(await frame.locator('#tg-status').evaluate(el => getComputedStyle(el).display !== 'none'), true, 'status live region rendered')
    // Focus moving outside the Data control closes the popover.
    await frame.locator('#dataset').focus()
    await frame.locator('#tg-data-popover').waitFor({ state: 'hidden' })
    assert.equal(await frame.locator('#tg-data-btn').getAttribute('aria-expanded'), 'false')
  })
})
