import { RpcTarget, newMessagePortRpcSession } from "capnweb";
const seed = document.querySelector("#seed");
const profile = document.querySelector("#profile");
const valid = () => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(seed.value);
class Configurator extends RpcTarget {
  async collectResourceUrl() {
    if (!valid()) throw new Error("Seed must use 1-64 letters, numbers, dots, dashes, or underscores.");
    return `procgen://commerce/v1/${encodeURIComponent(seed.value)}/${profile.value}`;
  }
  updateViewport() {}
  windowResized() {}
}
const { port1, port2 } = new MessageChannel();
const host = newMessagePortRpcSession(port1, new Configurator());
window.parent.postMessage({ type: "handshake" }, "*", [port2]);
host.getInitialResource().then(initial => {
  if (!initial) return;
  const match = /^procgen:\/\/commerce\/v1\/([^/]+)\/(small|medium)$/.exec(initial.resourceUrl);
  if (match) { seed.value = decodeURIComponent(match[1]); profile.value = match[2]; }
}).catch(() => {});
const update = () => host.setSelectionReady(valid());
seed.addEventListener("input", update); profile.addEventListener("change", update);
// Report the form's real height as both the frame and layout height. The host treats a frame taller
// than its layout as an open popup and stops clipping it, which let the frame cover the modal footer.
const reportSize = () => {
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  host.resize(height, height);
};
new ResizeObserver(reportSize).observe(document.documentElement);
reportSize(); update();
