// Entrypoint for the sandboxed Data management iframe. All data flows through the host-injected
// DataManagementApi capability (`ui`), acting as the signed-in person.

import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@cloudflare/kumo'
import { RpcTarget, newMessagePortRpcSession } from 'capnweb'
import type { RpcStub } from 'capnweb'
import type { GatekeeperAppTheme, GatekeeperAppThemeReceiver } from '@gadgets/workshop-shared/theme'
import App from './App'
import type { DataApi, DataManagementApi } from './api'
import { DataApiProvider, PresentationProvider, type PresentAck } from './bridge'
import { applyAppTheme } from './theme'
import './styles.css'

// The only capability the iframe exposes back to the host: a receiver for theme pushes.
class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme)
  }
}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<DataManagementApi>
  setPresenting(active: boolean): Promise<PresentAck>
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>
}

function main() {
  const root = document.getElementById('root')
  if (!root) throw new Error('missing #root')

  const { port1, port2 } = new MessageChannel()
  // Opaque-origin iframes can't name their parent origin; the message only transfers a private port.
  window.parent.postMessage({ type: 'handshake' }, '*', [port2])
  const iframe = new AppIframe()
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe)
  host.subscribeTheme(iframe).then(applyAppTheme).catch(() => {})
  // Held in context for the page's lifetime (never in useState; see bridge.ts).
  const api = host.ui as unknown as DataApi

  createRoot(root).render(
    <DataApiProvider value={api}>
      <PresentationProvider setPresenting={(active) => host.setPresenting(active)}>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </PresentationProvider>
    </DataApiProvider>,
  )
}

main()
