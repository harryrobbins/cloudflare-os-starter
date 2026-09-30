// Live call check against a REAL Cloudflare Realtime SFU app (docs/plans/chat-video-implementation.md,
// Stream E). Not part of `test:run`: it needs a dev SFU app, a TURN key and one `wrangler dev`.
//
//   # an env file OUTSIDE the repo with REALTIME_SFU_APP_ID, REALTIME_SFU_APP_SECRET,
//   # REALTIME_TURN_KEY_ID, REALTIME_TURN_KEY_API_TOKEN and a DEV_IDENTITIES with >= 5 people
//   CHAT_DEV_ENV_FILE=/path/calls.env packages/gatekeeper-chat/e2e/start-dev.sh
//   node packages/gatekeeper-chat/e2e/call-check.mjs       # PASS/FAIL per check, exits 1 on any FAIL
//   packages/gatekeeper-chat/e2e/stop-dev.sh
//
// Env: CALL_PEOPLE (dev identity ids, comma-separated; default the first five of DEV_IDENTITIES),
//      CALL_RELAY_LAST=1 (default) forces the last person to iceTransportPolicy "relay" (TURN only),
//      CALL_SHOTS (screenshots, default $TMPDIR/cfos-call-check).
//
// Each context runs Chromium's fake camera and microphone. An init script wraps RTCPeerConnection so
// the check can read the engine's negotiated SDP and getStats() without any app hook.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { chromium } from 'playwright'

import { APP, apiClient, until } from './helpers.mjs'

const SHOTS = process.env.CALL_SHOTS ?? join(process.env.TMPDIR ?? '/tmp', 'cfos-call-check')
mkdirSync(SHOTS, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}

function wrapPeerConnection(relayOnly) {
  const Original = window.RTCPeerConnection
  window.__pcs = []
  window.RTCPeerConnection = class extends Original {
    constructor(config, ...rest) {
      super(relayOnly ? { ...config, iceTransportPolicy: 'relay' } : config, ...rest)
      window.__pcs.push(this)
    }
  }
}

/** The engine's current peer connection: SDP facts and a trimmed getStats(). */
function snapshot(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs?.at(-1)
    if (!pc) return null
    const report = await pc.getStats()
    const all = []
    report.forEach((s) => all.push(s))
    const pair = all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
    const local = pair ? report.get(pair.localCandidateId) : undefined
    return {
      state: pc.connectionState,
      localSdp: pc.localDescription?.sdp ?? '',
      remoteSdp: pc.remoteDescription?.sdp ?? '',
      candidate: local ? `${local.candidateType}/${local.protocol}` : null,
      out: all
        .filter((s) => s.type === 'outbound-rtp')
        .map((s) => ({ kind: s.kind, rid: s.rid ?? null, bytes: s.bytesSent, frames: s.framesEncoded ?? 0, width: s.frameWidth ?? null, active: s.active, limit: s.qualityLimitationReason ?? null })),
      in: all
        .filter((s) => s.type === 'inbound-rtp')
        .map((s) => ({ kind: s.kind, mid: s.mid, bytes: s.bytesReceived, frames: s.framesDecoded ?? 0, width: s.frameWidth ?? null })),
      codecs: all.filter((s) => s.type === 'codec').map((s) => ({ id: s.id, mime: s.mimeType, fmtp: s.sdpFmtpLine ?? '' })),
      tiles: document.querySelectorAll("[data-testid='call-tile']").length,
    }
  })
}

const { identities } = await (await fetch(`${APP}/dev/identities`)).json()
const ids = (process.env.CALL_PEOPLE?.split(',') ?? identities.map((i) => i.id)).slice(0, 5)
if (ids.length < 2) throw new Error(`need at least two dev identities, have ${ids.length}`)
const relayLast = process.env.CALL_RELAY_LAST !== '0'

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
const people = []
try {
  for (const [index, id] of ids.entries()) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] })
    await context.addInitScript(wrapPeerConnection, relayLast && index === ids.length - 1)
    const page = await context.newPage()
    const failures = []
    page.on('response', (r) => {
      if (/\/api\/(calls\/|channels\/[^/]+\/call)/.test(r.url()) && r.status() >= 400) failures.push(`${r.status()} ${new URL(r.url()).pathname}`)
    })
    await page.goto(`${APP}/dev/login?as=${encodeURIComponent(id)}`)
    await page.locator('a[data-channel-id="general"]').click({ timeout: 30_000 })
    people.push({ id, page, failures })
  }

  // --- join, one at a time ------------------------------------------------
  for (const person of people) {
    await person.page.getByRole('button', { name: /^(Start call|Join call)/ }).first().click({ timeout: 20_000 })
    await person.page.locator('[data-call-join]').click({ timeout: 20_000 })
    await person.page.waitForTimeout(2_000)
    if (person.failures.length > 0) {
      check(`${person.id} joins`, false, `${person.failures.join(', ')} (a 502 on join is usually the SFU refusing REALTIME_SFU_APP_SECRET; see the dev log)`)
      throw new Error('join failed')
    }
  }
  const expectedTiles = people.length
  for (const person of people) {
    await until(async () => (await snapshot(person.page))?.state === 'connected', 30_000, `${person.id} connected`).then(
      () => check(`${person.id} peer connection connected`, true),
      (error) => check(`${person.id} peer connection connected`, false, error.message),
    )
  }
  await people[0].page.waitForTimeout(10_000)

  // --- negotiated media -------------------------------------------------------
  for (const [index, person] of people.entries()) {
    const s = await snapshot(person.page)
    await person.page.screenshot({ path: join(SHOTS, `grid-${person.id}.png`) })
    const remoteVideoIn = s.in.filter((i) => i.kind === 'video' && i.bytes > 0).length
    const remoteAudioIn = s.in.filter((i) => i.kind === 'audio' && i.bytes > 0).length
    check(`${person.id} sees ${expectedTiles} tiles`, s.tiles === expectedTiles, `tiles=${s.tiles}`)
    check(`${person.id} receives video from the others`, remoteVideoIn >= people.length - 1, `video in=${remoteVideoIn}`)
    check(`${person.id} receives audio from the others`, remoteAudioIn >= people.length - 1, `audio in=${remoteAudioIn}`)
    const rids = s.out.filter((o) => o.kind === 'video' && o.rid).map((o) => o.rid)
    check(`${person.id} sends simulcast`, rids.length >= 2, `rids=${rids.join(',') || 'none'}`)
    const opusFmtp = s.codecs.filter((c) => /opus/i.test(c.mime)).map((c) => c.fmtp)
    check(`${person.id} Opus FEC in use`, opusFmtp.some((f) => /useinbandfec=1/.test(f)), opusFmtp.join(' | '))
    check(`${person.id} Opus DTX in use`, opusFmtp.some((f) => /usedtx=1/.test(f)), opusFmtp.join(' | '))
    const red = /a=rtpmap:\d+ red\/48000/i.test(s.remoteSdp)
    console.log(`INFO ${person.id} RED in the SFU's answer: ${red}; candidate ${s.candidate}`)
    if (relayLast && index === people.length - 1) {
      check(`${person.id} (relay only) connects through TURN`, s.candidate?.startsWith('relay') ?? false, `candidate=${s.candidate}`)
    }
  }

  // --- camera off past the SFU's 30 s inactivity window ---------------------
  const [first, second] = people
  await first.page.getByRole('button', { name: /^Turn camera off/ }).click()
  await first.page.waitForTimeout(35_000)
  const layers = async () => Object.fromEntries((await snapshot(first.page)).out.filter((o) => o.kind === 'video').map((o) => [o.rid, o.frames]))
  const sent = async () => (await snapshot(first.page)).out.filter((o) => o.kind === 'video').reduce((sum, o) => sum + o.bytes, 0)
  const layers1 = await layers()
  const sent1 = await sent()
  const t1 = (await snapshot(second.page)).in.filter((i) => i.kind === 'video')
  // The black track is a 1 fps canvas: a window of a few frames, not a few packets.
  await second.page.waitForTimeout(6_000)
  const sent2 = await sent()
  const layers2 = await layers()
  const encoding = Object.keys(layers2).filter((rid) => layers2[rid] > (layers1[rid] ?? 0))
  const t2 = (await snapshot(second.page)).in.filter((i) => i.kind === 'video')
  const flowing = t2.filter((b) => b.bytes > (t1.find((a) => a.mid === b.mid)?.bytes ?? 0)).length
  check(`camera off 35 s: ${first.id} still sends video (black frames)`, sent2 > sent1, `${sent2 - sent1} bytes in 6 s`)
  check(`camera off 35 s: ${first.id} keeps every simulcast layer alive`, encoding.length === Object.keys(layers2).length, `encoding ${encoding.join(',') || 'none'} of ${Object.keys(layers2).join(',')}`)
  check(`camera off 35 s: ${second.id} still receives every video track`, flowing >= people.length - 1, `flowing=${flowing}`)
  await first.page.getByRole('button', { name: /^Turn camera on/ }).click()
  // Back on: everybody decodes real video from everybody again, whatever layer they pull.
  const decodingAll = async () => {
    for (const person of people) {
      const a = (await snapshot(person.page)).in.filter((i) => i.kind === 'video')
      await person.page.waitForTimeout(1_500)
      const b = (await snapshot(person.page)).in.filter((i) => i.kind === 'video')
      const moving = b.filter((x) => x.frames > (a.find((y) => y.mid === x.mid)?.frames ?? 0) + 5).length
      if (moving < people.length - 1) return false
    }
    return true
  }
  const back = await until(decodingAll, 20_000, 'video after camera on').then(() => true, () => false)
  check(`camera on again: everybody decodes ${first.id}'s video`, back)

  // --- leave ------------------------------------------------------------------
  for (const person of people) {
    await person.page.getByRole('button', { name: 'Leave the call' }).first().click().catch(() => undefined)
  }
  await people[0].page.waitForTimeout(3_000)
  const history = await people[0].page.locator("[data-call='ended']").count()
  check('call ends with an "ended" history row', history >= 1, `rows=${history}`)

  // --- a DM rings the other person ------------------------------------------
  const caller = await apiClient(first.id)
  const dm = await caller.ok('POST', '/api/channels', { kind: 'dm', memberIds: [second.id] })
  const dmId = dm.channel?.id ?? dm.id
  await first.page.goto(`${APP}/c/${encodeURIComponent(dmId)}`)
  await first.page.getByRole('button', { name: /^Start call/ }).click({ timeout: 20_000 })
  await first.page.locator('[data-call-join]').click({ timeout: 20_000 })
  const ring = second.page.getByTestId('incoming-call')
  const rang = await ring.waitFor({ timeout: 15_000 }).then(() => true, () => false)
  check(`DM call rings ${second.id}`, rang, rang ? await ring.getAttribute('aria-label') : 'no incoming-call card')
  if (rang) {
    await second.page.screenshot({ path: join(SHOTS, 'dm-ring.png') })
    await ring.getByRole('button', { name: 'Join', exact: true }).click()
    await second.page.locator('[data-call-join]').click({ timeout: 20_000 })
    const both = await until(async () => {
      const [a, b] = [await snapshot(first.page), await snapshot(second.page)]
      return a?.state === 'connected' && b?.state === 'connected' && a.tiles === 2 && b.tiles === 2
        && a.in.some((i) => i.kind === 'video' && i.bytes > 0) && b.in.some((i) => i.kind === 'video' && i.bytes > 0)
    }, 30_000, 'DM call media').then(() => true, () => false)
    const brief = (x) => x && { state: x.state, tiles: x.tiles, videoIn: x.in.filter((i) => i.kind === 'video').map((i) => i.bytes) }
    check('DM call connects both ways with media', both, both ? '' : JSON.stringify([brief(await snapshot(first.page)), brief(await snapshot(second.page))]))
  }
  for (const person of [first, second]) {
    await person.page.getByRole('button', { name: 'Leave the call' }).first().click().catch(() => undefined)
  }
} catch (error) {
  if (error.message !== 'join failed') check('run completed', false, error.stack ?? String(error))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed; screenshots in ${SHOTS}`)
process.exit(failed > 0 ? 1 : 0)
