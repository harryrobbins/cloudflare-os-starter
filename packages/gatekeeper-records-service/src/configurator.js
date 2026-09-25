// Datastore picker shown in the Workshop's "Add connection" modal. Lists the datastores the
// deployment operator approved (via the `gatekeeper` capability, which never returns credentials)
// and lets the person choose read-only access or read plus approved changes.
import { RpcTarget, newMessagePortRpcSession } from "capnweb";

const list = document.querySelector("#list");
const access = document.querySelector("#access");
const status = document.querySelector("#status");
let datastores = [];
let selected = null;
let initialAccess = null;

class Configurator extends RpcTarget {
  async collectResourceUrl() {
    if (!selected) throw new Error("Choose a datastore.");
    const chosen = access.querySelector("input:checked")?.value ?? "read";
    return host.gatekeeper.resourceUrl(selected, chosen);
  }
  updateViewport() {}
  windowResized() {}
}

const { port1, port2 } = new MessageChannel();
const host = newMessagePortRpcSession(port1, new Configurator());
window.parent.postMessage({ type: "handshake" }, "*", [port2]);

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function renderAccess() {
  access.replaceChildren();
  const entry = datastores.find((item) => item.id === selected);
  if (!entry) return;
  const option = (value, label, hint, disabled) => {
    const row = document.createElement("label");
    row.className = "choice" + (disabled ? " disabled" : "");
    const input = document.createElement("input");
    input.type = "radio"; input.name = "access"; input.value = value; input.disabled = disabled;
    input.checked = !disabled && (initialAccess ?? "write") === value;
    row.append(input, " ", text("strong", label), text("span", hint, "hint"));
    access.append(row);
  };
  access.append(text("p", "This gadget may:", "label"));
  option("write", "Read and request changes", `Create and edit ${entry.moduleId} records. Each change is approved in the Workshop and attributed to the person who asked.`, !entry.writable);
  option("read", "Read only", "Browse records and the model. No changes.", false);
  if (!access.querySelector("input:checked")) access.querySelector("input[value=read]").checked = true;
}

function render() {
  list.replaceChildren();
  if (!datastores.length) {
    list.append(text("p", "No datastores are approved for this deployment yet. Ask the operator to add one.", "muted"));
    host.setSelectionReady(false);
    return;
  }
  for (const entry of datastores) {
    const row = document.createElement("label");
    row.className = "row" + (entry.available ? "" : " disabled");
    const radio = document.createElement("input");
    radio.type = "radio"; radio.name = "datastore"; radio.value = entry.id; radio.disabled = !entry.available;
    radio.checked = entry.id === selected;
    radio.addEventListener("change", () => { selected = entry.id; renderAccess(); host.setSelectionReady(true); reportSize(); });
    const body = document.createElement("span");
    body.append(text("strong", entry.label), text("span", entry.available
      ? `${entry.moduleId} v${entry.apiMajor} · ${(entry.entities ?? []).join(", ") || "no entities"}`
      : "Unavailable right now", "hint"));
    row.append(radio, body);
    list.append(row);
  }
  renderAccess();
  host.setSelectionReady(Boolean(selected));
}

async function load() {
  status.textContent = "Loading approved datastores…";
  try {
    const [initial, entries] = await Promise.all([host.getInitialResource().catch(() => null), host.gatekeeper.datastores()]);
    datastores = entries;
    const match = initial && /^records-service:\/\/datastore\/([0-9a-f-]{36})\/[^/]+\/v\d+\/(read|write)/.exec(initial.resourceUrl);
    if (match) { selected = match[1]; initialAccess = match[2]; }
    if (!selected) selected = datastores.find((entry) => entry.available)?.id ?? null;
    status.textContent = "";
  } catch {
    status.textContent = "Could not load the approved datastores. Close this dialog and try again.";
  }
  render();
  reportSize();
}

// Report the form's real height as both the frame and layout height (see gatekeeper-procgen).
function reportSize() {
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  host.resize(height, height);
}
new ResizeObserver(reportSize).observe(document.documentElement);
load();
