// Real-browser check of the call's optional effects (quality phase 2): RNNoise noise suppression and
// MediaPipe background blur, in headless Chromium with its fake camera and microphone. No call, no
// Worker and no SFU: it builds `e2e/effects/`, serves it on a local port, and runs two probes.
//
//   cd packages/gatekeeper-chat && node e2e/effects-check.mjs
//
// Env: EFFECTS_PORT (default 8799), EFFECTS_OUT (build dir, default $TMPDIR/cfos-effects-check),
//      EFFECTS_SHOT (a path prefix: `-raw.png` and `-blurred.png` frames are written).
// Prints PASS/FAIL per check; exits 1 on any FAIL.
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

import { chromium } from 'playwright'

const HERE = import.meta.dirname
const OUT = process.env.EFFECTS_OUT ?? join(process.env.TMPDIR ?? '/tmp', 'cfos-effects-check')
const PORT = Number(process.env.EFFECTS_PORT ?? 8799)

execFileSync('pnpm', ['exec', 'vite', 'build', '--config', join(HERE, 'effects/vite.config.ts'), '--logLevel', 'warn'], {
  stdio: 'inherit',
  env: { ...process.env, EFFECTS_OUT: OUT },
})

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream' }
const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^\/+/, '')
  const file = join(OUT, path === '' ? 'index.html' : path)
  if (!file.startsWith(OUT) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404).end()
    return
  }
  // The app's own policy for scripts, so a Wasm or worker load the CSP would block fails here too.
  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; media-src 'self' blob:",
  })
  createReadStream(file).pipe(response)
})
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

const results = []
function check(name, ok, detail) {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} -- ${JSON.stringify(detail)}`)
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
})
try {
  const page = await browser.newPage()
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text())
  })
  page.on('pageerror', (error) => problems.push(error.message))
  await page.goto(`http://127.0.0.1:${PORT}/`)

  const noise = await page.evaluate(() => window.probeNoise())
  check('noise suppression builds and passes audio', noise.built === true && noise.state === 'live' && noise.processedPeak > 0.001, noise)

  const { rawImage, processedImage, ...blur } = await page.evaluate(() => window.probeBlur())
  if (process.env.EFFECTS_SHOT && rawImage) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${process.env.EFFECTS_SHOT}-raw.png`, Buffer.from(rawImage.split(',')[1], 'base64'))
    writeFileSync(`${process.env.EFFECTS_SHOT}-blurred.png`, Buffer.from(processedImage.split(',')[1], 'base64'))
  }
  check('background blur produces frames', blur.built === true && blur.fps >= 5, blur)
  // No person in the fake camera's picture, so the whole frame is background: every hard edge blurs.
  check('background blur softens edges', blur.built === true && blur.processedMaxStep < blur.rawMaxStep / 2, blur)
  if (problems.length > 0) console.log(`console: ${problems.slice(0, 5).join(' | ')}`)
} finally {
  await browser.close()
  server.close()
}
process.exit(results.every(Boolean) ? 0 : 1)
