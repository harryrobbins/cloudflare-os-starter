// Datastore picker shown in the Workshop's "Add connection" modal. Talks to ConfiguratorApi via
// the host's `gatekeeper` capability; lists only datastores the person can read and only the
// scopes they could grant.
import { RpcTarget, newMessagePortRpcSession } from "capnweb";

const $ = (s) => document.querySelector(s);
const search = $("#q");
const list = $("#list");
const scopesBox = $("#scopes");
const status = $("#status");
const SCOPE_LABELS = {
  "projects.read": "Read projects",
  "issues.read": "Read issues and comments",
  "issues.create": "Create issues",
  "issues.edit": "Edit issues",
  "issues.transition": "Move issues through the workflow",
  "comments.create": "Add comments",
};
let selected = null;
let initialScopes = null;

class Configurator extends RpcTarget {
  async collectResourceUrl() {
    if (!selected) throw new Error("Choose a datastore.");
    const scopes = [...scopesBox.querySelectorAll("input:checked")].map((i) => i.value);
    return host.gatekeeper.resourceUrl(selected, scopes);
  }
  updateViewport() {}
  windowResized() {}
}

const { port1, port2 } = new MessageChannel();
const host = newMessagePortRpcSession(port1, new Configurator());
window.parent.postMessage({ type: "handshake" }, "*", [port2]);

function text(tag, value, cls) {
  const el = document.createElement(tag);
  el.textContent = value;
  if (cls) el.className = cls;
  return el;
}

async function choose(id) {
  selected = id;
  host.setSelectionReady(false);
  scopesBox.replaceChildren(text("p", "Loading permissions…", "muted"));
  try {
    const grantable = await host.gatekeeper.grantableScopes(id);
    scopesBox.replaceChildren(text("p", "This gadget may:", "label"));
    for (const scope of grantable) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = scope;
      box.checked = initialScopes ? initialScopes.includes(scope) : scope.endsWith(".read");
      if (scope === "projects.read") box.disabled = box.checked = true;
      label.append(box, " ", SCOPE_LABELS[scope] ?? scope);
      scopesBox.append(label);
    }
    scopesBox.append(text("p", "Changes are always made as the person using the gadget, within their own permissions.", "muted"));
    host.setSelectionReady(true);
  } catch {
    scopesBox.replaceChildren(text("p", "You can no longer read this datastore.", "error"));
  }
  reportSize();
}

async function load() {
  status.textContent = "Searching…";
  try {
    const page = await host.gatekeeper.searchDatastores(search.value);
    list.replaceChildren();
    for (const ds of page.items) {
      const label = document.createElement("label");
      label.className = "row";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "ds";
      radio.value = ds.id;
      radio.checked = ds.id === selected;
      radio.addEventListener("change", () => choose(ds.id));
      const body = document.createElement("span");
      body.append(text("strong", ds.name), text("span", ` — ${ds.role}`, "muted"));
      if (ds.description) body.append(text("div", ds.description, "muted"));
      label.append(radio, body);
      list.append(label);
    }
    status.textContent = page.items.length ? "" : "No datastores you can read match. Ask a datastore owner to add you.";
  } catch {
    status.textContent = "Could not load datastores.";
  }
  reportSize();
}

const reportSize = () => {
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  host.resize(height, height);
};
new ResizeObserver(reportSize).observe(document.documentElement);

let timer;
search.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(load, 250);
});

host.getInitialResource().then((initial) => {
  const match = initial && /^records:\/\/datastore\/([0-9a-f-]{36})(?:\/([a-z.,]*))?/.exec(initial.resourceUrl);
  if (match) {
    initialScopes = match[2] ? match[2].split(",") : null;
    choose(match[1]);
  }
}).catch(() => {}).finally(load);
