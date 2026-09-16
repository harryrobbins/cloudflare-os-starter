import { RpcTarget, newMessagePortRpcSession } from 'capnweb';
const input = document.querySelector('input');
class Configurator extends RpcTarget {
  async collectResourceUrl() {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.value)) throw new Error('Use a short name with letters, numbers, dashes or underscores.');
    return 'python://notebook/' + input.value;
  }
  updateViewport() {}
}
const { port1, port2 } = new MessageChannel();
const host = newMessagePortRpcSession(port1, new Configurator());
window.parent.postMessage('handshake', '*', [port2]);
host.getInitialResource().then(initial => {
const match = initial && /^python:\/\/notebook\/([a-zA-Z0-9_-]{1,64})$/.exec(initial.resourceUrl);
if (match) input.value = match[1];
}).catch(() => {});
host.resize(170, 170);
host.setSelectionReady(true);
input.addEventListener('input', () => host.setSelectionReady(/^[a-zA-Z0-9_-]{1,64}$/.test(input.value)));
