// The resource configurator for a connector with one fixed resource: nothing to choose, so it only
// explains what connecting grants and hands back the resource URL written on <body>. Bundled into
// src/configurator-html.ts by scripts/gen-types.mjs.
import { RpcTarget, newMessagePortRpcSession } from "capnweb";

const resourceUrl = document.body.dataset.resourceUrl;

class Configurator extends RpcTarget {
  async collectResourceUrl() {
    return resourceUrl;
  }
  updateViewport() {}
  windowResized() {}
}

const { port1, port2 } = new MessageChannel();
const host = newMessagePortRpcSession(port1, new Configurator());
window.parent.postMessage({ type: "handshake" }, "*", [port2]);
// Report the real height as both frame and layout height; a taller frame reads as an open popup.
const reportSize = () => {
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  host.resize(height, height);
};
new ResizeObserver(reportSize).observe(document.documentElement);
reportSize();
host.setSelectionReady(true);
