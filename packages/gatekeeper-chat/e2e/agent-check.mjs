// Live check of `@agent` against the real Workshop: the chat Worker's outbox, the Workshop's
// ExternalMessageGateway, a real Overseer and agent turn, and the answer delivered back through the
// stored `ChatAgentReply` stub. Needs the in-platform layout, because the reply target is a service
// stub and cannot cross two local workerd processes (start-local-platform.sh explains):
//
//   CHAT_IN_PLATFORM=1 packages/gatekeeper-chat/e2e/start-local-platform.sh
//   node packages/gatekeeper-chat/e2e/agent-check.mjs      # PASS/FAIL per step, exits 1 on any FAIL
//   packages/gatekeeper-chat/e2e/stop-local-platform.sh
//
// No real model is involved. The check starts e2e/fake-model.mjs (an OpenAI-compatible stub that
// answers by quoting the question's framing back) and gives the asking account an "Ollama" model
// pointing at it, so what it proves is the plumbing: the prompt chat built reached a model, and the
// model's answer reached chat. The in-platform layout has no chat SPA; the UI side of the same states
// is covered by the SPA suites against the mock (app/src/mock/mock.test.ts).
//
// Accounts: `admin` asks as dev-admin and is given the fake model; `beta` (dev-user) asks with no
// model first, to see the Workshop's own refusal surfaced, then gets the model and retries. Both
// persist in wrangler's local state across runs, so every question carries a fresh marker.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { BASE, HERE, chatApi, chatDevCookie, chromium, signUpOrIn, sleep, until } from './platform-helpers.mjs'

const MODEL_PORT = Number(process.env.FAKE_MODEL_PORT ?? 8799)
const MODEL_LOG = join(process.env.TMPDIR ?? '/tmp', `cfos-fake-model-${process.pid}.jsonl`)
const A = { user: 'admin', pass: 'chatdock123', chat: 'dev-admin' }
const B = { user: 'beta', pass: 'chatdock123', chat: 'dev-user' }
const NO_MODEL = /needs an AI model configured/

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

const marker = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

async function question(context, channelId, messageId, rootId) {
  const page = await chatApi(context, 'GET', `/channels/${channelId}/messages?${rootId ? `rootId=${rootId}` : `around=${messageId}`}`)
  return { asked: page.messages.find((m) => m.id === messageId), page }
}

/** Waits for a question to leave pending/accepted, and returns it with its conversation page. */
async function settled(context, channelId, messageId, rootId) {
  return until(async () => {
    const found = await question(context, channelId, messageId, rootId)
    const state = found.asked?.agentRequest?.state
    return state === 'replied' || state === 'failed' ? found : null
  }, 90_000, `question ${messageId} to settle`)
}

async function hasFakeModel(page) {
  await page.goto(`${BASE}/providers`)
  await page.getByRole('heading', { name: 'AI providers' }).waitFor({ timeout: 30_000 })
  await sleep(1500)
  return (await page.getByText('fake-model', { exact: true }).count()) > 0
}

/** An Ollama model at the fake server, added through the platform's own providers page. */
async function giveFakeModel(page) {
  if (await hasFakeModel(page)) return 'already configured'
  await page.getByRole('button', { name: /add provider/i }).first().click()
  const dialog = page.locator('[role=dialog]')
  await dialog.getByRole('combobox').first().click()
  await page.getByRole('option', { name: 'Other Ollama...' }).click()
  await dialog.getByLabel('Model ID').fill('fake-model')
  await dialog.getByLabel('Display Name').fill('Fake model')
  await dialog.getByLabel('API URL').fill(`http://127.0.0.1:${MODEL_PORT}`)
  await dialog.getByRole('button', { name: 'Add Model' }).click()
  await page.getByText('fake-model', { exact: true }).first().waitFor({ timeout: 20_000 })
  return 'added'
}

const model = spawn(process.execPath, [join(HERE, 'fake-model.mjs'), String(MODEL_PORT)], {
  env: { ...process.env, FAKE_MODEL_LOG: MODEL_LOG },
  stdio: 'ignore',
})
const modelLog = () => (existsSync(MODEL_LOG) ? readFileSync(MODEL_LOG, 'utf8') : '')

const browser = await chromium.launch({ headless: true })
const a = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const b = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const aPage = await a.newPage()
const bPage = await b.newPage()

try {
  await step('setup: A and B platform accounts and chat identities', async () => {
    await signUpOrIn(aPage, A.user, A.pass)
    await chatDevCookie(a, A.chat)
    await signUpOrIn(bPage, B.user, B.pass)
    await chatDevCookie(b, B.chat)
    const me = await chatApi(a, 'GET', '/me')
    if (me.agent?.replies !== 'enabled') throw new Error(`agent replies ${JSON.stringify(me.agent)}`)
    return `A is ${me.user.id}; replies ${me.agent.replies}`
  })

  // 1. The Workshop's own refusal, surfaced on the message
  let refused = null
  await step("1a B (no model) asks in #general; the Workshop's refusal lands on the question", async () => {
    if (await hasFakeModel(bPage)) return 'skipped: B already has the fake model from an earlier run'

    const sent = await chatApi(b, 'POST', '/channels/general/messages', {
      body: `<@agent> are you there? ${marker()}`,
      clientId: `agent-e2e-${marker()}`,
    })
    if (sent.message.agentRequest?.state !== 'pending') throw new Error(`sent as ${JSON.stringify(sent.message.agentRequest)}`)
    const { asked } = await settled(b, 'general', sent.message.id)
    if (asked.agentRequest.state !== 'failed' || !NO_MODEL.test(asked.agentRequest.error ?? '')) {
      throw new Error(`got ${JSON.stringify(asked.agentRequest)}`)
    }
    if (!asked.agentRequest.retryable) throw new Error('not offered as retryable')
    refused = asked
    return `"${asked.agentRequest.error}"`
  })
  await step('1b only the asker may retry it', async () => {
    if (refused === null) return 'skipped'
    const response = await a.request.post(`${BASE}/gatekeeper/chat/api/messages/${refused.id}/agent/retry`, {
      headers: { origin: BASE },
    })
    if (response.status() !== 403) throw new Error(`A's retry -> ${response.status()}`)
    return '403 for somebody else'
  })

  // 2. A full round trip
  await step('2a A gets the fake model through the providers page', () => giveFakeModel(aPage))
  let answered = null
  const asked2 = `when is the freeze over ${marker()}`
  await step('2b A asks @agent in #general; accepted, then answered in the thread as the Agent', async () => {
    const sent = await chatApi(a, 'POST', '/channels/general/messages', {
      body: `<@agent> ${asked2}`,
      clientId: `agent-e2e-${marker()}`,
    })
    const { asked, page } = await settled(a, 'general', sent.message.id, sent.message.id)
    if (asked.agentRequest.state !== 'replied') throw new Error(`got ${JSON.stringify(asked.agentRequest)}`)
    const reply = page.messages.find((m) => m.id === asked.agentRequest.replyId)
    if (reply?.authorId !== 'agent' || reply.kind !== 'agent' || reply.rootId !== asked.id) {
      throw new Error(`reply ${JSON.stringify(reply)?.slice(0, 200)}`)
    }
    if (!reply.body.includes(asked2)) throw new Error(`reply body ${reply.body.slice(0, 200)}`)
    if (reply.agentReply?.requesterId !== 'dev-admin' || !reply.agentReply.chatPath?.startsWith('/workspace/')) {
      throw new Error(`agentReply ${JSON.stringify(reply.agentReply)}`)
    }
    answered = { asked, reply }
    return reply.body.slice(0, 160)
  })
  await step("2c the prompt the model saw was chat's, framed and bounded to #general", async () => {
    const prompts = modelLog().split('\n').filter((line) => line.includes(asked2))
    if (prompts.length === 0) throw new Error('the fake model never saw the question')
    const text = prompts.at(-1)
    for (const expected of ['You are the Agent member of the team chat, replying to Dev Admin in #general', 'Earlier messages in this conversation']) {
      if (!text.includes(expected)) throw new Error(`prompt lacks "${expected}"`)
    }
    return `${prompts.length} model request(s) carried it`
  })
  await step('2d "Open in workspace" is the asker\'s own workspace chat, and it opens in the shell', async () => {
    if (answered === null) throw new Error('no answer to follow')
    await aPage.goto(`${BASE}${answered.reply.agentReply.chatPath}`)
    await aPage.waitForURL(/\/workspace\/[^/?#]+/, { timeout: 30_000 })
    await aPage.getByText(asked2).first().waitFor({ timeout: 30_000 })
    await aPage.screenshot({ path: join(process.env.TMPDIR ?? '/tmp', 'cfos-agent-workspace.png') })
    return new URL(aPage.url()).pathname
  })

  // 3. Where the Agent answers, and where it does not
  await step('3a a DM with Agent is answered inline, in one workspace chat', async () => {
    const dm = await chatApi(a, 'POST', '/channels', { kind: 'dm', memberIds: ['agent'] })
    const text = `in a DM ${marker()}`
    const sent = await chatApi(a, 'POST', `/channels/${dm.channel.id}/messages`, { body: text, clientId: `agent-e2e-${marker()}` })
    const { asked } = await settled(a, dm.channel.id, sent.message.id)
    if (asked.agentRequest.state !== 'replied') throw new Error(`got ${JSON.stringify(asked.agentRequest)}`)
    const reply = (await chatApi(a, 'GET', `/channels/${dm.channel.id}/messages`)).messages.find((m) => m.id === asked.agentRequest.replyId)
    if (reply?.rootId !== null) throw new Error(`the DM answer is not inline: ${JSON.stringify(reply)?.slice(0, 160)}`)
    return reply.body.slice(0, 120)
  })
  await step('3b a private channel is refused on the message, and nothing reaches the model', async () => {
    const name = `agent-e2e-${marker()}`
    const channel = await chatApi(a, 'POST', '/channels', { kind: 'private', name })
    const secret = `private words ${marker()}`
    const sent = await chatApi(a, 'POST', `/channels/${channel.channel.id}/messages`, {
      body: `<@agent> ${secret}`,
      clientId: `agent-e2e-${marker()}`,
    })
    const request = sent.message.agentRequest
    if (request?.state !== 'failed' || request.retryable) throw new Error(`got ${JSON.stringify(request)}`)
    await sleep(3000)
    if (modelLog().includes(secret)) throw new Error('the private message reached the model')
    return `"${request.error}"`
  })

  // 4. Retry after fixing the cause
  await step("4a B gets the model and retries the refused question; it's answered", async () => {
    if (refused === null) return 'skipped'
    await giveFakeModel(bPage)
    await chatApi(b, 'POST', `/messages/${refused.id}/agent/retry`)
    const { asked } = await settled(b, 'general', refused.id, refused.id)
    if (asked.agentRequest.state !== 'replied') throw new Error(`got ${JSON.stringify(asked.agentRequest)}`)
    return `answered after retry (${asked.agentRequest.replyId})`
  })
} finally {
  await browser.close()
  model.kill()
  rmSync(MODEL_LOG, { force: true })
}

const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
