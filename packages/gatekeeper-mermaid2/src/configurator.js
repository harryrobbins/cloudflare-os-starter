import { RpcTarget, newMessagePortRpcSession } from 'capnweb';
class Configurator extends RpcTarget {
  async collectResourceUrl() { return 'mermaid2://renderer'; }
  updateViewport() {}
  windowResized() {}
}
const { port1, port2 } = new MessageChannel();
const host = newMessagePortRpcSession(port1, new Configurator());
window.parent.postMessage({ type: 'handshake' }, '*', [port2]);
host.setSelectionReady(true);
const report = () => { const height = Math.ceil(document.documentElement.getBoundingClientRect().height); host.resize(height, height); };
new ResizeObserver(report).observe(document.documentElement); report();
