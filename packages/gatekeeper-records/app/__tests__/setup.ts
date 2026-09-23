// jsdom gaps that Kumo / base-ui touch, and RTL cleanup between tests.
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
window.matchMedia ??= ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList) as typeof window.matchMedia
Element.prototype.scrollIntoView ??= function () {}
