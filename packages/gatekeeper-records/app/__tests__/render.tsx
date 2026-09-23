import { render } from '@testing-library/react'
import App from '../App'
import type { DataApi } from '../api'
import { DataApiProvider, PresentationProvider } from '../bridge'

/** Render the page against a fake capability. The host's presentation handshake acks at once. */
export function renderApp(api: DataApi, props: { pageSize?: number } = {}) {
  return render(
    <DataApiProvider value={api}>
      <PresentationProvider setPresenting={async () => ({ rect: null, willResize: false })}>
        <App {...props} />
      </PresentationProvider>
    </DataApiProvider>,
  )
}
