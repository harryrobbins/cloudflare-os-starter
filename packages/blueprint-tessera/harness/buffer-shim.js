// The slice of Node's Buffer that test/fake-procgen.js uses (UTF-8 and base64url cursors), so the
// harness can bundle the fake PROCGEN session for the browser. Injected by serve.mjs via esbuild.

const toBase64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const fromBase64url = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))

export const Buffer = {
  from(value, encoding = 'utf8') {
    const bytes = encoding === 'base64url' ? fromBase64url(value) : new TextEncoder().encode(value)
    return { toString: (as = 'utf8') => (as === 'base64url' ? toBase64url(bytes) : new TextDecoder().decode(bytes)) }
  },
}
