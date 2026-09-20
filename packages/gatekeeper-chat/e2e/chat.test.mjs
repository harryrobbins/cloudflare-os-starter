// End-to-end: the real SPA bundle, the real Worker, the real Durable Object, two signed-in identities
// in two browser contexts. See ../README.md, "End-to-end tests", for how to run it.
//
// Not part of `pnpm test:run`: it needs a `wrangler dev` on :8787 and a browser, neither of which a
// unit-test run should assume. `e2e/run.sh` starts the server, runs this file and stops the server.
//
// Ordering matters and `--test-concurrency=1` is not optional: every test shares one workspace (a
// Durable Object is a deployment, not a fixture), the reconnect test restarts the server, and the
// rate-limit test burns a per-user budget, so those two come last.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'

import {
  APP,
  IDENTITIES,
  SHOTS,
  apiClient,
  closeDialogs,
  composer,
  launch,
  messageIdOf,
  messageRow,
  openAs,
  openChannel,
  railItem,
  railState,
  rowAction,
  rowMenu,
  say,
  shot,
  sleep,
  startDevServer,
  stopDevServer,
  threadComposer,
  until,
  waitForConnected,
  waitForNewChannel,
} from './helpers.mjs'

/** A distinct run id, so a suite re-run against a kept .wrangler never matches an old message. */
const RUN = Math.random().toString(36).slice(2, 7)
const text = (label) => `${label} ${RUN}`

let browser
let admin
let user
let adminApi
let userApi

before(async () => {
  browser = await launch()
  admin = await openAs(browser, IDENTITIES.admin)
  user = await openAs(browser, IDENTITIES.user)
  adminApi = await apiClient(IDENTITIES.admin)
  userApi = await apiClient(IDENTITIES.user)
})

// A test that fails part-way can leave a modal open, and its overlay swallows every click in the
// next one. One Escape per page keeps a single failure from cascading into ten.
beforeEach(async () => {
  if (admin !== undefined) await closeDialogs(admin.page)
  if (user !== undefined) await closeDialogs(user.page)
})

after(async () => {
  const problems = [...(admin?.problems ?? []), ...(user?.problems ?? [])]
  if (problems.length > 0) writeFileSync(join(SHOTS, 'console-problems.txt'), problems.join('\n'))
  await browser?.close()
})

describe('gatekeeper-chat end to end', () => {
  it('T1 delivers a message live between two identities in #general', async () => {
    const body = text('live hello')
    await openChannel(admin.page, 'general')
    await openChannel(user.page, 'general')
    await say(admin.page, body)

    // The author sees their own optimistic row reconciled, the other tab sees the socket `msg`.
    await messageRow(admin.page, body).waitFor({ timeout: 15_000 })
    await messageRow(user.page, body).waitFor({ timeout: 15_000 })
    await shot(admin.page, 'T1-admin-general')
    await shot(user.page, 'T1-user-general')

    // And the other way, so the fan-out is not one-directional by accident.
    const reply = text('live reply')
    await say(user.page, reply)
    await messageRow(admin.page, reply).waitFor({ timeout: 15_000 })
  })

  it('T2 opens a thread, posts a reply, and lists it in Threads', async () => {
    const root = text('thread root')
    await openChannel(admin.page, 'general')
    await say(admin.page, root)
    await messageRow(user.page, root).waitFor({ timeout: 15_000 })

    await rowAction(admin.page, root, 'Reply in thread')
    await threadComposer(admin.page).waitFor({ timeout: 10_000 })
    const reply = text('thread reply')
    await say(admin.page, reply, { box: threadComposer })
    await admin.page.getByText(reply).first().waitFor({ timeout: 15_000 })
    await shot(admin.page, 'T2-thread-pane')

    // The reply is a thread reply, not a channel message: the root grows a summary instead.
    await messageRow(admin.page, root).getByText(/1 reply/).waitFor({ timeout: 15_000 })

    await admin.page.getByRole('link', { name: 'Threads' }).click()
    await admin.page.getByRole('heading', { name: 'Threads' }).waitFor({ timeout: 10_000 })
    await admin.page.getByText(root).first().waitFor({ timeout: 15_000 })
    await shot(admin.page, 'T2-threads-view')
  })

  it('T3 badges the other identity as unread, and clears it on read', async () => {
    // The reader has to be somewhere else for the channel to be unread at all.
    await user.page.getByRole('link', { name: 'People' }).click()
    await user.page.getByRole('heading', { name: 'People' }).waitFor({ timeout: 10_000 })

    const body = text('unread badge')
    await openChannel(admin.page, 'general')
    await say(admin.page, body)

    await until(
      async () => (await railState(user.page, 'general')).unread,
      15_000,
      'the rail to show #general unread',
    )
    await shot(user.page, 'T3-unread-rail')

    await openChannel(user.page, 'general')
    await messageRow(user.page, body).waitFor({ timeout: 15_000 })
    await until(
      async () => !(await railState(user.page, 'general')).unread,
      15_000,
      'the unread state to clear on read',
    )
  })

  it('T4 badges a mention with a count', async () => {
    await user.page.getByRole('link', { name: 'People' }).click()
    await user.page.getByRole('heading', { name: 'People' }).waitFor({ timeout: 10_000 })

    // `<@dev-user>` is the shared mention token (src/shared/validate.ts); the composer inserts it
    // from autocomplete, and the server resolves it against a real user at post time.
    const body = `${text('mention')} <@dev-user> please look`
    await adminApi.send('general', body)

    await until(
      async () => (await railState(user.page, 'general')).mentions >= 1,
      15_000,
      'the mention badge',
    )
    await shot(user.page, 'T4-mention-badge')

    await openChannel(user.page, 'general')
    await user.page.getByText('@Dev User').first().waitFor({ timeout: 15_000 })
    await until(
      async () => (await railState(user.page, 'general')).mentions === 0,
      15_000,
      'the mention badge to clear',
    )
  })

  it('T5 marks unread from a message', async () => {
    const body = text('mark unread here')
    await openChannel(admin.page, 'general')
    await say(admin.page, body)
    await openChannel(user.page, 'general')
    await messageRow(user.page, body).waitFor({ timeout: 15_000 })

    await rowMenu(user.page, body, 'Mark unread from here')
    await until(
      async () => (await railState(user.page, 'general')).unread,
      15_000,
      'the conversation to go unread again',
    )
    await user.page.getByText('New messages').first().waitFor({ timeout: 10_000 })
    await shot(user.page, 'T5-mark-unread')

    // Leave it read for the tests that follow.
    await user.page.getByRole('link', { name: 'People' }).click()
    await openChannel(user.page, 'general')
  })

  it('T6 keeps a private channel invisible to a non-member', async () => {
    const name = `secret-${RUN}`
    await openChannel(admin.page, 'general')
    await admin.page.getByRole('button', { name: 'New channel' }).first().click()
    await admin.page.getByPlaceholder('release-week').fill(name)
    await admin.page.getByRole('radio', { name: /Private/ }).check()
    await admin.page.getByRole('button', { name: 'Create channel' }).click()
    const channelId = await waitForNewChannel(admin.page, 'general')
    await say(admin.page, text('private message'))
    await shot(admin.page, 'T6-private-channel')

    // The API says "no such channel", not "forbidden": a 403 would confirm it exists.
    const page = await userApi.call('GET', `/api/channels/${channelId}/messages`)
    assert.equal(page.status, 404, JSON.stringify(page.body))
    assert.equal(page.body.error.code, 'not_found')
    const send = await userApi.call('POST', `/api/channels/${channelId}/messages`, {
      body: 'let me in',
      clientId: 'e2e-private',
    })
    assert.equal(send.status, 404)

    // And it is absent from Browse, which lists every channel the rail knows about.
    await user.page.getByRole('link', { name: 'Browse channels' }).click()
    await user.page.getByRole('heading', { name: 'Browse channels' }).waitFor({ timeout: 10_000 })
    await user.page.getByLabel('Search channels').fill(name)
    await sleep(300)
    assert.equal(await user.page.getByText(`#${name}`).count(), 0)
    await shot(user.page, 'T6-browse-without-private')
    await openChannel(user.page, 'general')
  })

  it('T7 opens a direct message and shows a seen cursor', async () => {
    await openChannel(admin.page, 'general')
    await admin.page.getByRole('button', { name: 'New message' }).first().click()
    await admin.page.getByLabel('Search people').fill('Dev User')
    await admin.page.getByRole('button', { name: /Dev User/ }).first().click()
    await admin.page.getByRole('button', { name: 'Start conversation' }).click()
    const dmId = await waitForNewChannel(admin.page, 'general')

    const body = text('dm hello')
    await say(admin.page, body)
    await messageRow(admin.page, body).waitFor({ timeout: 15_000 })

    // The other side opens it, which advances their cursor and fans a `read` with their id back.
    await until(async () => (await railItem(user.page, dmId).count()) > 0, 20_000, 'the DM in the rail')
    await openChannel(user.page, dmId)
    await messageRow(user.page, body).waitFor({ timeout: 15_000 })

    // The marker is an avatar stack sitting after the last message that person has read, so the
    // sentence lives on its label rather than in its text (delight pass, item 10).
    const seen = admin.page.getByTestId('seen-by').first()
    await seen.waitFor({ timeout: 20_000 })
    assert.match(await seen.getAttribute('aria-label'), /Seen by Dev User/)
    await shot(admin.page, 'T7-dm-seen-by')
    await openChannel(admin.page, 'general')
    await openChannel(user.page, 'general')
  })

  it('T8 uploads an image and a non-image, and serves both', async () => {
    await openChannel(admin.page, 'general')
    const input = admin.page.locator('input[type="file"]').first()

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR42mP8z8BQz0AEYBxVSF+FAAcQE/3sYw3PAAAAAElFTkSuQmCC',
      'base64',
    )
    await input.setInputFiles({ name: `shot-${RUN}.png`, mimeType: 'image/png', buffer: png })
    await say(admin.page, text('an image'))
    const imageRow = messageRow(admin.page, text('an image'))
    await imageRow.locator('img').first().waitFor({ timeout: 20_000 })

    // The `<img>` is served by the Worker's authenticated /files/ route, not a data URL.
    const src = await imageRow.locator('img').first().getAttribute('src')
    assert.match(src, /\/gatekeeper\/chat\/files\//, `image src was ${src}`)
    const fetched = await admin.page.request.get(new URL(src, APP).toString())
    assert.equal(fetched.status(), 200)
    assert.match(fetched.headers()['content-type'], /^image\/png/)
    assert.match(fetched.headers()['content-disposition'] ?? 'inline', /inline/)

    await input.setInputFiles({
      name: `notes-${RUN}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('plain text attachment\n'),
    })
    await say(admin.page, text('a file'))
    const fileRow = messageRow(admin.page, text('a file'))
    const link = fileRow.locator(`a[download="notes-${RUN}.txt"]`).first()
    await link.waitFor({ timeout: 20_000 })
    await shot(admin.page, 'T8-attachments')

    const href = await link.getAttribute('href')
    const downloaded = await admin.page.request.get(new URL(href, APP).toString())
    assert.equal(downloaded.status(), 200)
    assert.match(downloaded.headers()['content-disposition'], /attachment/)
    assert.equal(await downloaded.text(), 'plain text attachment\n')

    // The other identity sees both, through the same authenticated route.
    await openChannel(user.page, 'general')
    await messageRow(user.page, text('an image')).locator('img').first().waitFor({ timeout: 20_000 })
  })

  it('T9 searches with in: and from: qualifiers, and jumps to a hit', async () => {
    const needle = `porcupine${RUN}`
    await openChannel(admin.page, 'general')
    await say(admin.page, `a searchable ${needle} message`)
    await messageRow(admin.page, needle).waitFor({ timeout: 15_000 })

    // The rail's box opens the quick switcher; its last row hands off to the search view. The needle
    // is a nonsense word, so no channel or person matches and the hand-off row is the only one.
    await admin.page.getByRole('navigation', { name: 'Conversations' })
      .getByRole('button', { name: /Search or jump/ })
      .click()
    await admin.page.getByTestId('quick-switcher').waitFor({ timeout: 10_000 })
    await admin.page.getByRole('combobox').fill(needle)
    await admin.page.getByRole('option', { name: /Search messages for/ }).click()

    const search = admin.page.getByLabel('Search messages')
    await search.waitFor({ timeout: 10_000 })
    await search.fill(`in:#general from:@dev-admin ${needle}`)
    await search.press('Enter')
    await admin.page.locator('mark', { hasText: needle }).first().waitFor({ timeout: 20_000 })
    await shot(admin.page, 'T9-search-qualifiers')

    // A qualifier that excludes the message finds nothing, so the filters are really applied.
    await search.fill(`from:@dev-user ${needle}`)
    await search.press('Enter')
    await until(
      async () => (await admin.page.locator('mark', { hasText: needle }).count()) === 0,
      20_000,
      'the from: qualifier to exclude the hit',
    )

    await search.fill(`in:#general ${needle}`)
    await search.press('Enter')
    // `exact`: the rail's own button is called "Search or jump to…", and a substring match on
    // "Jump" picks that up first.
    await admin.page.getByRole('button', { name: 'Jump', exact: true }).first().click()
    await admin.page.waitForURL((url) => /\/c\/general\/m\//.test(url.pathname), { timeout: 15_000 })
    await messageRow(admin.page, needle).waitFor({ timeout: 15_000 })
    await shot(admin.page, 'T9-jump')
  })

  it('T10 opens a permalink deep link in a fresh tab', async () => {
    const body = text('permalink target')
    await openChannel(admin.page, 'general')
    await say(admin.page, body)
    await messageRow(admin.page, body).waitFor({ timeout: 15_000 })
    const messageId = await messageIdOf(admin.page, body)

    const page = await admin.context.newPage()
    await page.goto(`${APP}/c/general/m/${messageId}`, { waitUntil: 'domcontentloaded' })
    await page.locator(`[data-message-id="${messageId}"]`).waitFor({ timeout: 30_000 })
    await shot(page, 'T10-permalink')
    await page.close()
  })

  it('T11 works at a narrow viewport', async () => {
    const narrow = await browser.newContext({ viewport: { width: 390, height: 780 } })
    const page = await narrow.newPage()
    await page.goto(`${APP}/dev/login?as=${IDENTITIES.user}`, { waitUntil: 'domcontentloaded' })
    // The rail is not rendered at all below 900px, so "loaded" is the conversation, not the rail.
    await page.goto(`${APP}/c/general`, { waitUntil: 'domcontentloaded' })
    await composer(page).waitFor({ timeout: 30_000 })
    await shot(page, 'T11-narrow-conversation')

    await page.getByRole('button', { name: 'Conversations', exact: true }).click()
    await page.getByRole('dialog', { name: 'Conversations' }).waitFor({ timeout: 10_000 })
    await shot(page, 'T11-narrow-rail')
    await page
      .getByRole('dialog', { name: 'Conversations' })
      .locator('a[data-channel-id="general"]')
      .click()
    await composer(page).waitFor({ timeout: 15_000 })
    await narrow.close()
  })

  it('T12 shows the banner, reconnects and catches up when the server restarts', async () => {
    await openChannel(admin.page, 'general')

    // Offline at the browser too, not only at the server. The restart alone is not a deterministic
    // test: wrangler comes back in a few seconds and the socket's jittered backoff can reconnect
    // before the message is posted, in which case the message arrives live and the `since` catch-up
    // is never exercised. Holding the tab offline across the restart closes that window; the server is
    // still really killed and really restarted.
    await admin.context.setOffline(true)
    await stopDevServer()

    const banner = admin.page.locator('[role="status"]', { hasText: /Reconnecting|Disconnected/ })
    await banner.waitFor({ timeout: 30_000 })
    await shot(admin.page, 'T12-reconnecting-banner')

    await startDevServer()
    const api = await apiClient(IDENTITIES.user)
    const body = text('sent while you were away')
    await api.send('general', body)

    // Still disconnected, so this cannot have arrived over the socket.
    assert.equal(await banner.count(), 1, 'the tab should still be offline')
    assert.equal(await messageRow(admin.page, body).count(), 0)

    await admin.context.setOffline(false)
    await waitForConnected(admin.page, 90_000)
    await messageRow(admin.page, body).waitFor({ timeout: 60_000 })
    await shot(admin.page, 'T12-caught-up')
  })

  it('T13 surfaces a 429 as a toast', async () => {
    // The budget is 30 messages a minute, per user (RATE_LIMITS in src/shared/protocol.ts). Burn it
    // over HTTP as the same identity the browser is signed in as, then send one from the composer.
    await user.page.reload({ waitUntil: 'domcontentloaded' })
    await railItem(user.page, 'general').waitFor({ timeout: 30_000 })
    await openChannel(user.page, 'general')

    const api = await apiClient(IDENTITIES.user)
    let limited = false
    for (let i = 0; i < 40 && !limited; i++) {
      const result = await api.call('POST', '/api/channels/general/messages', {
        body: `burn ${RUN} ${i}`,
        clientId: `burn-${RUN}-${i}`,
      })
      limited = result.status === 429
      if (limited) assert.equal(result.body.error.code, 'rate_limited')
    }
    assert.ok(limited, 'the message budget should run out within 40 sends')

    await say(user.page, text('one too many'))
    await user.page.getByText('Message not sent').first().waitFor({ timeout: 20_000 })
    await shot(user.page, 'T13-rate-limit-toast')
    await user.page.getByRole('button', { name: 'Retry' }).first().waitFor({ timeout: 5_000 })
  })
})
