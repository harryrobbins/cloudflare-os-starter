// Host bridge helpers: the DataManagementApi capability in React context, and the Workshop's
// modal-presentation protocol (copied from gatekeeper-context's app/bridge.ts, which documents it).
//
// The `ui` capability is an RpcStub. It lives in React context, never in useState (a stub looks
// callable, so useState's setter would call it). Methods return plain data only, so no result
// needs disposing; the session's own stub is released when the iframe goes away.

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'
import type { DataApi } from './api'

const DataApiContext = createContext<DataApi | null>(null)

export const DataApiProvider = DataApiContext.Provider

export function useDataApi(): DataApi {
  const api = useContext(DataApiContext)
  if (!api) throw new Error('useDataApi() used outside DataApiProvider')
  return api
}

// ---------------------------------------------------------------------------
// Modal presentation (full-viewport overlay)
//
// The app iframe fills only the Workshop's content pane. To show a modal over the whole app, the
// host grows the iframe to cover the viewport while we pin the page content to its pane rect.
// ---------------------------------------------------------------------------

/**
 * The content-pane rect, in viewport coordinates, where the app holds its page fixed while the
 * iframe expands to full-viewport.
 */
export type OverlayRect = { left: number; top: number; width: number; height: number }

/**
 * The host's reply to setPresenting. On open, `rect` is where the app holds its page fixed while
 * the iframe expands to full-viewport (null on restore); `willResize` is whether switching the iframe
 * to/from full-viewport actually changes its pixel size (it won't if the pane already fills the window).
 */
export type PresentAck = { rect: OverlayRect | null; willResize: boolean }

/** Enter/leave overlay mode. */
export type PresentationController = {
  present(): void
  dismiss(): void
}

const PresentationContext = createContext<PresentationController>({
  present() {},
  dismiss() {},
})

// True once the iframe covers the full viewport and the app's page is pinned.
const PresentationActiveContext = createContext(false)

export function usePresentation(): PresentationController {
  return useContext(PresentationContext)
}

export type PresentWhileOpen = {
  /** True once the overlay is ready. Gate the Dialog's `open` on this. */
  presenting: boolean
  /**
   * Pass to <Dialog.Root onOpenChangeComplete>. Restores the iframe to pane size once the close
   * animation finishes.
   */
  onOpenChangeComplete: (open: boolean) => void
}

/**
 * Drives a modal's overlay lifecycle: presents when it wants to open, and dismisses once its close
 * animation completes.
 */
export function usePresentWhileOpen(open: boolean): PresentWhileOpen {
  const presentation = usePresentation()
  const presenting = useContext(PresentationActiveContext)
  const presentedRef = useRef(false)

  useEffect(() => {
    if (open && !presentedRef.current) {
      presentedRef.current = true
      presentation.present()
    }
  }, [open, presentation])

  // If the caller closes before presentation reaches the Dialog, there won't be a Dialog close
  // animation to release the host presentation.
  useEffect(() => {
    if (!open && !presenting && presentedRef.current) {
      presentedRef.current = false
      presentation.dismiss()
    }
  }, [open, presenting, presentation])

  useEffect(() => {
    return () => {
      if (presentedRef.current) {
        presentedRef.current = false
        presentation.dismiss()
      }
    }
  }, [presentation])

  const onOpenChangeComplete = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && presentedRef.current) {
        presentedRef.current = false
        presentation.dismiss()
      }
    },
    [presentation],
  )

  return { presenting, onOpenChangeComplete }
}

export function PresentationProvider({
  setPresenting,
  children,
}: {
  setPresenting: (active: boolean) => Promise<PresentAck>
  children: ReactNode
}) {
  // `ready` reveals the Dialog; `rect` pins the app surface to the pane.
  const [ready, setReady] = useState(false)
  const [rect, setRect] = useState<OverlayRect | null>(null)

  // A modal here needs to cover the whole app, but this app only fills the Workshop's content pane.
  // So when one opens, the host grows the iframe to fill the window. We pin the page to its old pane
  // rect, and unpin it when the iframe shrinks back.
  //
  // Pinning (our document) and growing the iframe (the host's) are separate steps. If the pane already
  // fills the window there's no resize to wait for, so the host tells us up front (`willResize`) and
  // we apply the change immediately. We do this to ensure modal renders smoothly.
  //
  // `phase` tells the resize handler what to do:
  //   idle --present()--> opening --grew--> open --dismiss()--> closing --shrank--> idle
  type Phase = 'idle' | 'opening' | 'open' | 'closing'
  const phase = useRef<Phase>('idle')
  const epoch = useRef(0) // bumped per present/dismiss; results from a stale epoch are ignored
  const depth = useRef(0) // refcount so overlapping modals share one overlay
  const targetRect = useRef<OverlayRect | null>(null) // pane rect to pin to once the iframe is full
  const resizeSeen = useRef(false)
  const fallbackTimer = useRef<number | null>(null)

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimer.current !== null) {
      window.clearTimeout(fallbackTimer.current)
      fallbackTimer.current = null
    }
  }, [])

  // Pin the app surface to the pane and reveal the Dialog.
  const commitOpen = useCallback(() => {
    clearFallbackTimer()
    phase.current = 'open'
    flushSync(() => {
      setRect(targetRect.current)
      setReady(true)
    })
  }, [clearFallbackTimer])

  // Unpin; content flows back into the pane-sized iframe.
  const commitClose = useCallback(() => {
    clearFallbackTimer()
    phase.current = 'idle'
    targetRect.current = null
    resizeSeen.current = false
    flushSync(() => {
      setRect(null)
      setReady(false)
    })
  }, [clearFallbackTimer])

  // The iframe's resize is our cue to pin (open) or unpin (close).
  useEffect(() => {
    const onResize = () => {
      if (phase.current === 'opening') {
        resizeSeen.current = true
        if (targetRect.current) commitOpen()
      } else if (phase.current === 'closing') {
        commitClose()
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [commitOpen, commitClose])

  const present = useCallback(() => {
    depth.current += 1
    if (depth.current !== 1) return

    clearFallbackTimer()
    targetRect.current = null
    resizeSeen.current = false
    const requestEpoch = ++epoch.current
    const isStale = () => requestEpoch !== epoch.current || phase.current !== 'opening'
    phase.current = 'opening'

    setPresenting(true)
      .then((ack) => {
        if (isStale()) return
        targetRect.current = ack.rect
        if (!ack.willResize || resizeSeen.current) {
          commitOpen()
        } else {
          // The resize event can race the RPC ack. If it is missed, don't leave the iframe expanded
          // with the Dialog hidden forever.
          fallbackTimer.current = window.setTimeout(() => {
            if (!isStale()) commitOpen()
          }, 120)
        }
      })
      .catch(() => {
        if (!isStale()) commitOpen()
      })
  }, [clearFallbackTimer, commitOpen, setPresenting])

  // Called once the modal's close animation has finished (via usePresentWhileOpen).
  const dismiss = useCallback(() => {
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current !== 0) return

    clearFallbackTimer()
    const requestEpoch = ++epoch.current
    const isStale = () => requestEpoch !== epoch.current || phase.current !== 'closing'
    phase.current = 'closing'

    setPresenting(false)
      .then((ack) => {
        if (isStale()) return
        // If a resize is coming, unpin in the resize handler; otherwise now.
        if (!ack.willResize) {
          commitClose()
        } else {
          fallbackTimer.current = window.setTimeout(() => {
            if (!isStale()) commitClose()
          }, 120)
        }
      })
      .catch(() => {
        if (!isStale()) commitClose()
      })
  }, [clearFallbackTimer, commitClose, setPresenting])

  useEffect(() => {
    return () => {
      epoch.current += 1
      depth.current = 0
      phase.current = 'idle'
      clearFallbackTimer()
      setPresenting(false).catch(() => {})
    }
  }, [clearFallbackTimer, setPresenting])

  // Transparent document background while pinned, so the host shows through around the pinned content.
  useEffect(() => {
    const root = document.documentElement
    if (rect) root.classList.add('data-presenting')
    else root.classList.remove('data-presenting')
    return () => root.classList.remove('data-presenting')
  }, [rect])

  const controller = useMemo<PresentationController>(() => ({ present, dismiss }), [present, dismiss])

  const box = createElement(
    'div',
    {
      style: rect
        ? {
            position: 'fixed',
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            overflow: 'hidden',
            background: 'var(--color-kumo-base)',
          }
        : { display: 'contents' },
    },
    children,
  )

  return createElement(
    PresentationContext.Provider,
    { value: controller },
    createElement(PresentationActiveContext.Provider, { value: ready }, box),
  )
}
