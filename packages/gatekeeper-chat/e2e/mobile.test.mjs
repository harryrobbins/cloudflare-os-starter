import assert from 'node:assert/strict'
import { it } from 'node:test'
import { chromium, webkit } from 'playwright'
const APP = `${process.env.CHAT_URL ?? 'http://localhost:8798'}/gatekeeper/chat`
const engines = process.env.CHAT_WEBKIT === '1' ? [['Chromium', chromium], ['WebKit', webkit]] : [['Chromium', chromium]]
for (const [name, engine] of engines) {
  it(`${name}: mobile messaging and installation`, async () => {
    const browser = await engine.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto(`${APP}/dev/login?as=dev-admin`)
      const nav = page.getByRole('navigation', { name: 'Chat navigation' })
      await nav.waitFor()
      await nav.getByRole('button', { name: 'Conversations' }).click()
      const drawer = page.getByRole('dialog', { name: 'Conversations' })
      await drawer.locator('a[data-channel-id="general"]').click()
      await drawer.waitFor({ state: 'detached' })
      const composer = page.locator('textarea').first()
      const run = `Mobile ${name} ${Date.now()}`
      await composer.fill(run)
      await composer.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
      assert.equal(await composer.inputValue(), run)
      await composer.press('Enter')
      assert.equal(await composer.inputValue(), `${run}\n`)
      await composer.type('second line')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await page.getByText(run, { exact: false }).first().waitFor()
      assert.equal(await composer.inputValue(), '')
      const actions = page.locator('.chat-message-actions').last()
      assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), '1')
      await actions.getByRole('button', { name: 'Reply in thread' }).click()
      await page.waitForURL(/\/t\//)
      await page.goBack()
      await page.waitForURL(/\/c\/general$/)
      await composer.fill('draft retained')
      await page.reload()
      await composer.waitFor()
      assert.equal(await composer.inputValue(), 'draft retained')
      await composer.fill('')
      for (const [width, height] of [[320, 640], [430, 932], [844, 390]]) {
        await page.setViewportSize({ width, height })
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
        const send = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox()
        assert.ok(send.width >= 44 && send.height >= 44)
        assert.ok(send.y + send.height <= height)
        assert.equal(await composer.evaluate(el => getComputedStyle(el).fontSize), '16px')
      }
      await page.setViewportSize({ width: 390, height: 844 })
      // Emulate the browser's visual viewport signal, not a real software keyboard.
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, 'height', { configurable: true, value: 450 })
        visualViewport.dispatchEvent(new Event('resize'))
      })
      assert.equal(await nav.isVisible(), false)
      const keyboardSend = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox()
      assert.ok(keyboardSend.y + keyboardSend.height <= 450)
      await page.evaluate(() => {
        delete visualViewport.height
        visualViewport.dispatchEvent(new Event('resize'))
      })
      await page.screenshot({ path: '/tmp/chat-mobile-phone.png' })
      await nav.getByRole('button', { name: 'Conversations' }).click()
      await drawer.getByRole('button', { name: 'Close', exact: true }).click()
      await drawer.waitFor({ state: 'detached' })
      await nav.getByRole('button', { name: 'Conversations' }).click()
      await drawer.getByRole('link', { name: 'Settings', exact: true }).click()
      await page.getByText('Chat on your phone', { exact: true }).waitFor()
      assert.equal(await page.getByRole('link', { name: 'Open standalone Chat' }).getAttribute('href'), '/gatekeeper/chat/')
      const manifestResponse = await context.request.get(`${APP}/manifest.webmanifest`)
      assert.ok(manifestResponse.headers()['content-type'].includes('manifest'))
      const manifest = await manifestResponse.json()
      assert.equal(manifest.id, '/gatekeeper/chat/')
      assert.equal(manifest.scope, '/gatekeeper/chat/')
      for (const icon of manifest.icons) {
        const response = await context.request.get(new URL(icon.src, APP).href)
        assert.equal(response.headers()['content-type'], 'image/png')
      }
      const sw = await context.request.get(`${APP}/sw.js`)
      assert.ok(sw.headers()['content-type'].includes('javascript'))
      if (name === 'Chromium') {
        await page.evaluate(() => navigator.serviceWorker.ready)
        await page.reload()
        await context.setOffline(true)
        await page.goto(`${APP}/`)
        await page.getByRole('heading', { name: 'Chat is offline' }).waitFor()
        await context.setOffline(false)
      }
      await page.goto(`${APP}/c/general?embed=1&compact=1`)
      await composer.waitFor()
      assert.equal(await nav.count(), 0)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`${APP}/c/general`)
      await page.locator('a[data-channel-id="general"]').waitFor({timeout: 5000}).catch(async e => { console.log(await page.evaluate(() => ({width:innerWidth, body:document.body.innerText, url:location.href}))); await page.screenshot({path:'/tmp/chat-mobile-failure.png'}); throw e; })
      assert.equal(await nav.count(), 0)
      assert.deepEqual(errors, [])
    } finally { await context.close(); await browser.close() }
  })
}
