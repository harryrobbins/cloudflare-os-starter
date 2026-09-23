// A deterministic stand-in for a model, for e2e/agent-check.mjs.
//
// Speaks just enough of the OpenAI chat-completions API for the Workshop's "Ollama" provider (which is
// OpenAI-compatible at `<apiUrl>/v1`), streaming and not, so a local account can be given a model
// without a key, a network or a bill. It never calls a tool: every turn is one short text answer that
// quotes the question's framing back, which is what lets the check prove the prompt chat built reached
// the model and that the answer travelled back into chat.
//
//   node packages/gatekeeper-chat/e2e/fake-model.mjs [port]      # default 8799
//
// Every request body is appended to $FAKE_MODEL_LOG (default $TMPDIR/cfos-fake-model.jsonl).
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? process.env.FAKE_MODEL_PORT ?? 8799)
const LOG = process.env.FAKE_MODEL_LOG ?? join(process.env.TMPDIR ?? '/tmp', 'cfos-fake-model.jsonl')

/** The text of the last user turn, whatever shape its content has. */
function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const user = messages.toReversed().find((m) => m.role === 'user')
  if (user === undefined) return ''
  if (typeof user.content === 'string') return user.content
  if (Array.isArray(user.content)) return user.content.map((part) => part.text ?? '').join('')
  return ''
}

function answerFor(body) {
  const text = lastUserText(body)
  const framing = text.split('\n')[0] ?? ''
  // A title request (the Workshop names new chats with the same model) gets a title.
  if (!framing.startsWith('You are the Agent member')) return 'Chat agent question'
  const asked = text.slice(text.lastIndexOf(':\n') + 2).trim()
  return `FAKE-MODEL answer. I read: "${framing}" and the question "${asked}".`
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }))
    return
  }
  if (request.method !== 'POST' || !request.url?.startsWith('/v1/chat/completions')) {
    response.writeHead(404).end()
    return
  }
  let raw = ''
  request.on('data', (chunk) => { raw += chunk })
  request.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch { /* answered anyway */ }
    appendFileSync(LOG, JSON.stringify({ at: Date.now(), body }) + '\n')
    const content = answerFor(body)
    const id = `chatcmpl-${Date.now().toString(36)}`
    const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    if (body.stream !== true) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id, object: 'chat.completion', created: 0, model: body.model ?? 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
      }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const chunk = (delta, finish, extra = {}) => `data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created: 0, model: body.model ?? 'fake-model',
      choices: [{ index: 0, delta, finish_reason: finish }], ...extra,
    })}\n\n`
    response.write(chunk({ role: 'assistant', content }, null))
    response.write(chunk({}, 'stop', { usage }))
    response.end('data: [DONE]\n\n')
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`fake model on http://127.0.0.1:${PORT} (log: ${LOG})`))
