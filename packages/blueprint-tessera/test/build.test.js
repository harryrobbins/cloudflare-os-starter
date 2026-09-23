// The layout worker must run as a self-contained ES module from a `data:` URL (the gadget CSP
// allows data: scripts and blocks blob:). Node can import data: URLs, so the bundled worker is
// executed here against a fake `self` and asked for a real layout.
import { describe, expect, it } from 'vitest'
import { workerDataUrl } from '../scripts/build.mjs'

describe('layout worker bundle', () => {
  it('is an ASCII data: URL module that answers load and layout messages', async () => {
    const url = await workerDataUrl()
    expect(url.startsWith('data:text/javascript;base64,')).toBe(true)
    const source = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8')
    expect([...source].every(char => char.charCodeAt(0) < 128)).toBe(true)
    expect(source).not.toMatch(/\bimport\s*[({"'\w*]/)

    const replies = []
    const previous = globalThis.self
    globalThis.self = { postMessage: message => replies.push(message) }
    try {
      await import(/* @vite-ignore */ url)
      const handler = globalThis.self.onmessage
      handler({ data: { type: 'load', id: 1, data: { n: 12, columns: {} } } })
      handler({ data: { type: 'layout', id: 2, spec: { type: 'grid' }, mask: null, aspect: 1.6 } })
    } finally { globalThis.self = previous }
    expect(replies[0]).toEqual({ type: 'loaded', id: 1, n: 12 })
    expect(replies[1]).toMatchObject({ type: 'layout', id: 2, visible: 12 })
    expect(replies[1].positions).toHaveLength(48)
  })
})
