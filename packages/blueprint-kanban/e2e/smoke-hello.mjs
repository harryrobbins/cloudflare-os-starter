// End-to-end smoke test of the platform contract a gadget relies on, against a running local
// Workshop: upload .gadget -> create gadget -> DO RPC + storage -> export formats -> use-role share.
//
//   node e2e/smoke-hello.mjs <archive.gadget> [baseUrl]
//
// Expects the archive's client to render <h1>"hello spike #N"</h1> via a DO RPC that increments N,
// and an ExportHandler offering "CSV" (server) and "HTML" (browser). Exits non-zero on failure.
import assert from 'node:assert/strict'
import * as h from './platform-helpers.mjs'

const [archive, base = h.DEFAULT_BASE_URL] = process.argv.slice(2)
if (!archive) throw new Error('usage: node e2e/smoke-hello.mjs <archive.gadget> [baseUrl]')
const PASSWORD = 'correct-horse-battery-staple'
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`)
const counter = async (page) => {
  const h1 = h.gadgetFrame(page).locator('h1')
  await h1.waitFor({ timeout: 60_000 })
  const text = await h1.innerText()
  return Number(/#(\d+)/.exec(text)?.[1])
}

const browser = await h.launch()
try {
  const alice = await h.newUserPage(browser)
  await h.signUpOrIn(alice.page, base, 'alice', PASSWORD)
  const blueprintId = await h.uploadGadget(alice.page, base, archive)
  log(`uploaded blueprint ${blueprintId}`)
  const gadgetUrl = await h.createGadgetFromBlueprint(alice.page, base, blueprintId)
  log(`gadget ${gadgetUrl}`)

  const n1 = await counter(alice.page)
  await alice.page.reload()
  const n2 = await counter(alice.page)
  assert.equal(n2, n1 + 1, 'DO storage should persist across reloads')
  log(`counter ${n1} -> ${n2}`)

  assert.deepEqual(await h.listExportFormats(alice.page), ['CSV', 'HTML'])
  const csv = await h.downloadExport(alice.page, 'CSV')
  assert.equal(csv.text, 'a,b\r\n1,2\r\n')
  log(`export CSV ok (${csv.filename})`)

  const shareUrl = await h.createUseShareLink(alice.page)
  log(`share link ${shareUrl}`)
  const bob = await h.newUserPage(browser)
  await h.signUpOrIn(bob.page, base, 'bob', PASSWORD)
  await bob.page.goto(shareUrl)
  const n3 = await counter(bob.page)
  assert.equal(n3, n2 + 1, 'bob should see the same DO storage')
  assert.equal(await bob.page.getByRole('button', { name: 'Share workspace' }).count(), 0, 'use role has no Share')
  log(`bob sees counter ${n3}; PASS`)
} finally {
  await browser.close()
}
