// The Workshop hosts the Data page in a sandboxed iframe without `allow-forms`: the browser blocks
// native form submission before `submit` fires, so a <form> silently does nothing when clicked.
// Use SandboxForm (components/ui.tsx) instead.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === '__tests__' || name === 'node_modules') return []
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(tsx?|jsx?)$/.test(name) ? [path] : []
  })
}

describe('sandboxed forms', () => {
  it('never renders a native <form> or a submit button', () => {
    const offenders = sources(new URL('..', import.meta.url).pathname.replace(/^\/@fs/, '')).filter((file) =>
      /<form[\s>]|type=["']submit["']/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
