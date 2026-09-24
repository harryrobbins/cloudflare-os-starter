// @ts-check
// The project board: state, loading, actions and rendering.
//
// Records are read and written through a SyncClient (packages/records-sync-client) whose transport
// is the gadget server's RECORDS pass-through (../transport.js). Every change shows at once as a
// local guess; the server's version replaces it when a pull brings it. Nothing is persisted across
// sessions except the chosen project (in window.name): unsynced changes live in memory, and the
// page warns before it is closed with any.

import { h, option, relativeTime } from "./dom.js";
import { CSS } from "./styles.js";
import {
  PRIORITIES, PRIORITY_LABELS, allowedTargets, canTransition, capabilities, columns, commentsIn, conflictingFields,
  isProvisional, issuesIn, knownPeople, missingScopes, projectsIn, sortedStates,
} from "../model.js";
import { gadgetTransport } from "../transport.js";
import { createPokeChannel } from "../pokes.js";
import { SyncClient, guardUnload } from "../../../../records-sync-client/src/index.ts";
import { errorCode, errorDetail } from "../../shared/records.js";

/** @typedef {import("../model.js").Issue} Issue */
/**
 * One change the viewer made, as shown in the status panel.
 * @typedef {{
 *   id: number, name: string, args: any, label: string, issueId: string|null,
 *   status: "saving"|"pending"|"applied"|"conflict"|"rejected",
 *   actionId: number|null, approved: boolean, code: string|null, message: string, currentRevision: number|null,
 * }} Change
 */

const PREFS_PREFIX = "project-board:";
const APPLIED_VISIBLE_MS = 6_000;
/** The SyncClient's own safety pull; the poke channel pulls more often while live updates are off. */
const SAFETY_PULL_MS = 60_000;
const EDIT_FIELDS = /** @type {const} */ (["title", "description", "priority", "assigneeId"]);

/** Per-viewer preferences that survive a frame reload. Holds ids only, never record content. */
export const windowNameStore = {
  load() {
    try {
      const raw = window.name;
      return typeof raw === "string" && raw.startsWith(PREFS_PREFIX) ? JSON.parse(raw.slice(PREFS_PREFIX.length)) : {};
    } catch { return {}; }
  },
  /** @param {any} prefs */
  save(prefs) {
    try { window.name = PREFS_PREFIX + JSON.stringify(prefs); } catch { /* ignore */ }
  },
};

/** @param {Change} change @param {string|null} [likelyToFail] */
export function describeChange(change, likelyToFail = null) {
  switch (change.status) {
    case "saving":
      return "Saving…" + (likelyToFail ? ` This will probably be refused (${likelyToFail}); the Records service decides.` : "");
    case "pending":
      return change.approved
        ? "Approved in the Workshop. Loading the saved version…"
        : `Awaiting approval in the Workshop (action #${change.actionId}). Not saved yet.`;
    case "applied": return "Saved.";
    case "conflict":
      return change.code === "workflow_conflict"
        ? "Not saved: that move is not allowed from the issue's current state. The board shows the current version."
        : "Not saved: someone else changed this issue first. The board shows their version.";
    case "rejected": return `Not saved: ${change.message || "the Records service refused this change."}`;
  }
}

const STATUS_LABELS = { saving: "Saving", pending: "Pending approval", applied: "Saved", conflict: "Conflict", rejected: "Not saved" };

/** @param {string|null} code */
function phaseForCode(code) {
  if (code === "not_connected") return "not_connected";
  if (code === "forbidden" || code === "unauthenticated") return "forbidden";
  if (code === "payload_too_large") return "too_large";
  return "error";
}

/**
 * @param {{
 *   gadget: any, root: HTMLElement, prefs?: {load(): any, save(p: any): void}, autoStart?: boolean,
 *   viewer?: {id?: string, displayName?: string}|null,
 *   syncOptions?: Record<string, any>, pokeOptions?: Record<string, any>, unloadTarget?: any,
 * }} options
 */
export function createBoardApp(options) {
  const { gadget, root } = options;
  const prefs = options.prefs ?? windowNameStore;
  const saved = prefs.load() ?? {};

  const state = {
    /** @type {"loading"|"not_connected"|"incompatible"|"forbidden"|"no_read"|"no_projects"|"too_large"|"error"|"ready"} */
    phase: "loading",
    errorMessage: "",
    /** @type {any} */ setup: null,
    /** @type {any} */ binding: null,
    caps: capabilities(null),
    /** @type {string[]} */ missing: [],
    /** @type {any[]} */ members: [],
    /** @type {string|null} */ projectId: typeof saved.projectId === "string" ? saved.projectId : null,
    filter: { text: "", assigneeId: "", priority: "" },
    /** @type {string|null} */ selectedId: null,
    /** @type {import("../../../../records-sync-client/src/index.ts").SyncStatus|null} */ syncStatus: null,
    live: { live: /** @type {string} */ ("off"), error: /** @type {string|null} */ (null) },
    lastSync: /** @type {number|null} */ (null),
    liveError: "",
    /** @type {Map<number, Change>} */ changes: new Map(),
    /**
     * An edit of the open issue that conflicted. Once the server's newer version is in view, the
     * form is rebased onto it (your fields kept), so saving again applies on top of it.
     * @type {{changeId: number, issueId: string, patch: Record<string, any>, code: string, currentRevision: number|null, rebased: boolean}|null}
     */
    conflict: null,
  };

  /** @type {SyncClient|null} */
  let client = null;
  let started = false;
  /** @type {(() => void)[]} */
  const cleanups = [];
  /** @type {Set<any>} */
  const dismissTimers = new Set();

  /** Form state for the open issue; see renderDetail. */
  let draft = /** @type {null|{issueId: string, baseRevision: number, base: Record<string, any>}} */ (null);
  let detailEl = /** @type {HTMLElement|null} */ (null);
  let dragging = /** @type {Issue|null} */ (null);
  let createOpen = false;

  const persistPrefs = (/** @type {any} */ patch) => prefs.save({ ...prefs.load(), ...patch });

  const pokes = createPokeChannel({
    gadget,
    onStatus: (s) => { state.live = s; renderHeader(); },
    isHidden: () => typeof document !== "undefined" && document.hidden,
    ...options.pokeOptions,
  });

  // --- Derived state -------------------------------------------------------------------------

  const workflow = () => /** @type {any} */ (client?.get("meta/workflow") ?? null);
  const projects = () => (client ? projectsIn(client) : []);
  const issues = () => (client ? issuesIn(client, state.projectId) : new Map());
  const issueById = (/** @type {string} */ id) => /** @type {Issue|undefined} */ (client?.get(`issue/${id}`));

  /** The signed-in viewer as a Records principal, for local guesses (createdBy, author). */
  function principal() {
    const v = options.viewer ?? null;
    const name = (typeof v?.displayName === "string" && v.displayName.trim()) || v?.id || "You";
    const member = state.members.find((m) => m.displayName === name);
    return member ?? { id: `viewer:${v?.id ?? "me"}`, displayName: name, kind: "human" };
  }

  function createClient() {
    const c = new SyncClient({
      transport: gadgetTransport(gadget),
      principal: principal(),
      onPoke: (handler) => pokes.subscribe(handler),
      safetyPullIntervalMs: SAFETY_PULL_MS,
      ...options.syncOptions,
    });
    cleanups.push(
      c.subscribe(() => onViewChanged()),
      c.on("status", (s) => {
        const wasPulling = state.syncStatus?.pulling;
        state.syncStatus = s;
        if (wasPulling && !s.pulling && !s.lastError) state.lastSync = Date.now();
        renderHeader();
        renderBanners();
      }),
      c.on("awaiting", (list) => {
        for (const a of list) { const ch = state.changes.get(a.mutationId); if (ch) ch.approved = a.approved; }
        renderWrites();
      }),
      c.on("approval", (ev) => onApproval(ev)),
      guardUnload(c, options.unloadTarget ?? window),
    );
    return c;
  }

  // --- Loading -------------------------------------------------------------------------------

  async function loadAll({ quiet = false } = {}) {
    if (!quiet) { state.phase = "loading"; render(); }
    try {
      const setup = await gadget.getSetup();
      state.setup = setup;
      if (!setup.connected) { state.phase = "not_connected"; render(); return; }
      if (setup.error) throw new Error(setup.error);
      const binding = setup.binding;
      state.binding = binding;
      state.caps = capabilities(binding);
      state.missing = missingScopes(setup.requirement, binding);
      if (binding.moduleId !== setup.requirement.moduleId || binding.apiMajor !== setup.requirement.apiMajor) {
        state.phase = "incompatible"; render(); return;
      }
      if (!state.caps.read) { state.phase = "no_read"; render(); return; }
      state.members = await gadget.listAssignees().catch(() => []);
      client ??= createClient();
      if (!started) { started = true; await client.start(); } else await client.pull();
      evaluate();
    } catch (err) {
      // Never throws: every failure is shown.
      state.phase = /** @type {any} */ (phaseForCode(errorCode(err)));
      state.errorMessage = errorDetail(err);
      render();
    }
  }

  /** Decides the phase from the synced view (after the first pull, and after later ones). */
  function evaluate() {
    if (!client) return;
    if (client.cookie === null) {
      // The first pull failed; the client keeps retrying transient failures on its own.
      const e = client.status().lastError;
      state.phase = /** @type {any} */ (phaseForCode(e?.code ?? null));
      state.errorMessage = e?.message ?? "The board could not be loaded.";
      render();
      return;
    }
    const list = projects();
    if (!list.length) { state.phase = "no_projects"; render(); return; }
    if (!list.some((p) => p.id === state.projectId)) state.projectId = list[0].id;
    state.phase = "ready";
    if (state.selectedId && !issueById(state.selectedId)) closeIssue(false);
    render();
  }

  function onViewChanged() {
    if (["loading", "ready", "no_projects", "error", "forbidden", "too_large"].includes(state.phase)) evaluate();
  }

  // --- Changes -------------------------------------------------------------------------------

  /**
   * Applies a change locally at once and queues it for the Records service.
   * @param {string} name @param {any} args @param {{label: string, issueId?: string|null}} meta
   */
  function mutate(name, args, meta) {
    if (!client) return null;
    const handle = client.mutateByName(name, args);
    const queued = /** @type {any} */ (handle.args);
    /** @type {Change} */
    const change = {
      id: handle.id, name, args: queued, label: meta.label,
      issueId: meta.issueId ?? queued.issueId ?? (name === "projects.createIssue" ? queued.id : null),
      status: "saving", actionId: null, approved: false, code: null, message: "", currentRevision: null,
    };
    state.changes.set(change.id, change);
    void handle.result.then((r) => onResult(change, r));
    render();
    return { change, handle };
  }

  /** @param {Change} change @param {import("../../../../records-sync-client/src/index.ts").MutationResult} r */
  function onResult(change, r) {
    if (!state.changes.has(change.id)) return;
    if (r.status === "confirmed" || r.status === "processed") {
      markApplied(change);
    } else if (r.status === "pending") {
      change.status = "pending";
      change.actionId = r.actionId;
    } else if (r.status === "conflict") {
      Object.assign(change, { status: "conflict", code: r.code, message: r.message, currentRevision: r.currentRevision ?? null });
      if (change.name === "projects.editIssue" && state.selectedId === change.args.issueId) {
        state.conflict = {
          changeId: change.id, issueId: change.args.issueId, patch: change.args.patch, code: r.code,
          currentRevision: r.currentRevision ?? null, rebased: false,
        };
      }
    } else {
      Object.assign(change, { status: "rejected", code: r.code, message: r.message });
    }
    render();
  }

  /** @param {Change} change */
  function markApplied(change) {
    change.status = "applied";
    const t = setTimeout(() => {
      dismissTimers.delete(t);
      if (state.changes.get(change.id)?.status === "applied") { state.changes.delete(change.id); renderWrites(); }
    }, APPLIED_VISIBLE_MS);
    dismissTimers.add(t);
  }

  /** @param {import("../../../../records-sync-client/src/index.ts").ApprovalResolvedEvent} ev */
  function onApproval(ev) {
    const change = state.changes.get(ev.entry.mutationId);
    if (!change) return;
    if (ev.resolution === "applied") markApplied(change);
    else if (ev.resolution === "dismissed") state.changes.delete(change.id);
    else {
      const defaults = {
        rejected: "an approver declined it.",
        expired: "the approval request expired.",
        timeout: "no approval decision arrived in time. It may still be approved later; refresh to check.",
      };
      Object.assign(change, { status: "rejected", code: `approval_${ev.resolution}`, message: ev.message || defaults[ev.resolution] });
    }
    render();
  }

  function dismissChange(/** @type {Change} */ change) {
    if (change.status === "pending") client?.dismissApproval(change.id);
    state.changes.delete(change.id);
    if (state.conflict?.changeId === change.id) state.conflict = null;
    render();
  }

  /** Why the local guess of a queued change already fails, by mutation id. */
  function likelyFailures() {
    /** @type {Map<number, string>} */
    const out = new Map();
    for (const p of client?.pending() ?? []) if (p.likelyToFail) out.set(p.id, p.likelyToFail.message);
    return out;
  }

  /** @param {string} issueId */
  function busyFor(issueId) {
    let found = /** @type {Change|null} */ (null);
    for (const c of state.changes.values()) if (c.issueId === issueId && (c.status === "saving" || c.status === "pending")) found = c;
    return found;
  }

  // --- Writes --------------------------------------------------------------------------------

  /** @param {Issue} issue */
  function baseValues(issue) {
    return { title: issue.title, description: issue.description, priority: issue.priority, assigneeId: issue.assignee?.id ?? "" };
  }

  /** @param {Issue} issue */
  function resetDraft(issue) {
    draft = { issueId: issue.id, baseRevision: issue.revision, base: baseValues(issue) };
    if (detailEl) detailEl.remove();
    detailEl = null;
    if (state.conflict?.issueId === issue.id) state.conflict = null;
  }

  /** @param {Issue} issue @param {string} toState */
  function transition(issue, toState) {
    const wf = workflow();
    if (!state.caps.transition || !wf || !canTransition(wf, issue.state, toState)) return null;
    const target = wf.states.find((/** @type {any} */ s) => s.key === toState);
    return mutate("projects.transitionIssue", { issueId: issue.id, expectedRevision: issue.revision, toState },
      { label: `${issue.key}: move to ${target?.name ?? toState}`, issueId: issue.id })?.change ?? null;
  }

  /** Saves the open issue's changed fields. Returns null if nothing changed. */
  function saveEdit() {
    if (!draft || !detailEl || !state.caps.edit) return null;
    const issue = issueById(draft.issueId);
    if (!issue) return null;
    const values = readForm(detailEl);
    /** @type {Record<string, any>} */
    const patch = {};
    for (const field of EDIT_FIELDS) {
      if (values[field] !== draft.base[field]) patch[field] = field === "assigneeId" ? (values[field] || null) : values[field];
    }
    if (!Object.keys(patch).length) return null;
    if ("title" in patch && !String(patch.title).trim()) {
      showFieldError("Title cannot be empty.");
      return null;
    }
    state.conflict = null;
    const done = mutate("projects.editIssue", { issueId: issue.id, expectedRevision: draft.baseRevision, patch },
      { label: `${issue.key}: edit ${Object.keys(patch).map((f) => f === "assigneeId" ? "assignee" : f).join(", ")}`, issueId: issue.id });
    // The view now shows the guess; continue editing from it (its revision is the one the server
    // will assign). If the guess could not be applied, keep the form as typed.
    const guessed = issueById(issue.id);
    if (done && !done.handle.likelyToFail && guessed) resetDraft(guessed);
    render();
    return done?.change ?? null;
  }

  /** @param {{title: string, description?: string, priority?: string, assigneeId?: string}} fields */
  function createIssue(fields) {
    if (!state.caps.create || !state.projectId) return null;
    /** @type {Record<string, any>} */
    const input = { projectId: state.projectId, title: fields.title.trim() };
    if (fields.description?.trim()) input.description = fields.description;
    if (fields.priority && fields.priority !== "none") input.priority = fields.priority;
    if (fields.assigneeId) input.assigneeId = fields.assigneeId;
    return mutate("projects.createIssue", input, { label: `New issue: ${input.title}` })?.change ?? null;
  }

  /** @param {string} body */
  function addComment(body) {
    if (!state.caps.comment || !state.selectedId || !body.trim()) return null;
    const issue = issueById(state.selectedId);
    return mutate("projects.addComment", { issueId: state.selectedId, body },
      { label: `${issue?.key ?? "Issue"}: comment`, issueId: state.selectedId })?.change ?? null;
  }

  // --- Navigation ----------------------------------------------------------------------------

  /** @param {string} issueId */
  function openIssue(issueId) {
    const issue = issueById(issueId);
    if (!issue) return;
    state.selectedId = issueId;
    resetDraft(issue);
    render();
    detailEl?.querySelector("h2")?.focus();
  }

  function closeIssue(rerender = true) {
    const was = state.selectedId;
    state.selectedId = null;
    draft = null;
    detailEl?.remove();
    detailEl = null;
    state.conflict = null;
    if (rerender) {
      render();
      const card = [...root.querySelectorAll(".pb-card")].find((c) => /** @type {HTMLElement} */ (c).dataset.issueId === was);
      /** @type {HTMLElement|null} */ (card?.querySelector("button.open") ?? null)?.focus();
    }
  }

  /** @param {string} projectId */
  function selectProject(projectId) {
    state.projectId = projectId;
    persistPrefs({ projectId });
    closeIssue(false);
    render();
  }

  async function requestLive() {
    state.liveError = "";
    try { await pokes.requestLive(); }
    catch (err) { state.liveError = `Live updates could not be requested: ${errorDetail(err)}`; }
    renderHeader();
    renderBanners();
  }

  function refresh() {
    if (client && started) void client.sync();
    else void loadAll();
  }

  // --- Rendering -----------------------------------------------------------------------------

  const els = {
    header: h("header", { class: "pb-header" }),
    banners: h("div", { class: "pb-banners" }),
    toolbar: h("div", { class: "pb-toolbar", role: "toolbar", "aria-label": "Board filters" }),
    main: h("main", { class: "pb-main" }),
    board: h("div", { class: "pb-board" }),
    writes: h("div", { class: "pb-writes", "aria-live": "polite", "aria-label": "Change status" }),
    dialog: h("div"),
  };
  root.replaceChildren(h("div", { class: "pb-app" }, els.header, els.banners, els.toolbar, els.main), els.writes, els.dialog);

  function render() {
    renderHeader();
    renderBanners();
    if (state.phase !== "ready") {
      els.toolbar.hidden = true;
      els.main.replaceChildren(statePanel());
      detailEl = null;
      renderWrites();
      return;
    }
    els.toolbar.hidden = false;
    renderToolbar();
    renderBoard();
    if (!els.main.contains(els.board)) els.main.replaceChildren(els.board);
    renderDetail();
    renderWritesOnly();
  }

  function renderHeader() {
    const b = state.binding;
    const live = state.live.live;
    const liveText = live === "active" ? "Live updates on"
      : live === "requested" ? "Live updates awaiting approval · checking every 15 s"
        : "Checking every 15 s";
    const last = state.lastSync ? ` · synced ${relativeTime(new Date(state.lastSync).toISOString())}` : "";
    const unsynced = state.syncStatus?.unsynced ?? 0;
    // `h` drops null children; replaceChildren would render them as the text "null".
    els.header.replaceChildren(h("div", { style: "display: contents" },
      h("h1", null, "Project board"),
      b ? h("span", { class: "datastore" }, `${b.datastore.name}${b.datastore.lifecycle === "archived" ? " (archived)" : ""}`) : null,
      h("span", { class: "spacer" }),
      unsynced ? h("span", { class: "unsynced", role: "status", title: "Changes the Records service has not received yet. They are lost if you close the page now." },
        `${unsynced} unsynced change${unsynced === 1 ? "" : "s"}`) : null,
      state.phase === "ready" ? h("span", { class: "live", "data-live": live, role: "status" },
        h("span", { class: "dot", "aria-hidden": "true" }), liveText + last) : null,
      state.phase === "ready" && live === "off"
        ? h("button", { class: "link", onclick: () => void requestLive(), title: "Asks the Records service to notify this board of changes. The Workshop owner approves this once." }, "Turn on live updates")
        : null,
      state.phase !== "loading" ? h("button", { onclick: () => refresh(), "aria-label": "Refresh from the datastore" }, "Refresh") : null,
    ));
  }

  function renderBanners() {
    /** @type {HTMLElement[]} */
    const list = [];
    const b = state.binding;
    if (state.phase === "ready" && b?.datastore.lifecycle === "archived") {
      list.push(h("div", { class: "banner warn", role: "status" },
        "This datastore is archived. You can read its issues, but nothing can be changed until an administrator restores it in Workshop → Data."));
    } else if (state.phase === "ready" && state.missing.length) {
      const what = [!state.caps.create && "create issues", !state.caps.edit && "edit issues",
        !state.caps.transition && "move issues", !state.caps.comment && "comment"].filter(Boolean);
      if (what.length) {
        list.push(h("div", { class: "banner", role: "status" },
          `This connection is read-only for some actions: it cannot ${what.join(", ")}. ` +
          `A Workshop owner can reconnect it with ${state.missing.join(", ")}.`));
      }
    }
    const s = state.syncStatus;
    if (state.phase === "ready" && s?.lastError) {
      const n = s.unsynced;
      if (n && s.blocked) {
        list.push(h("div", { class: "banner bad", role: "alert" },
          `${n} change${n === 1 ? " is" : "s are"} not being sent: ${s.lastError.message} `,
          h("button", { class: "link", onclick: () => void client?.retry() }, "Retry")));
      } else if (n) {
        list.push(h("div", { class: "banner warn", role: "status" },
          `${n} change${n === 1 ? " is" : "s are"} not saved yet. Retrying automatically (${s.lastError.message}). Keep this page open.`));
      } else if (!s.pulling) {
        list.push(h("div", { class: "banner bad", role: "alert" },
          `The last sync failed (${s.lastError.message}). What you see may be out of date. `,
          h("button", { class: "link", onclick: () => refresh() }, "Try again")));
      }
    }
    if (state.liveError) list.push(h("div", { class: "banner warn", role: "status" }, state.liveError));
    els.banners.replaceChildren(...list);
  }

  function statePanel() {
    switch (state.phase) {
      case "loading":
        return h("div", { class: "state-panel", role: "status" }, h("h2", null, "Loading the board…"), h("p", null, "Reading projects and issues from the Records service."));
      case "not_connected":
        return h("div", { class: "state-panel" },
          h("h2", null, "Connect a Projects datastore"),
          h("p", null, "This board shows issues from an organisation Projects datastore. It stores no records itself."),
          h("ol", null,
            h("li", null, "Open this gadget's Connections tab and choose Connect resource."),
            h("li", null, "Pick your Records connection, then a Projects datastore you are a member of."),
            h("li", null, "Use the binding name RECORDS, then return here and refresh.")),
          h("button", { class: "primary", onclick: () => void loadAll() }, "Check again"));
      case "incompatible":
        return h("div", { class: "state-panel", role: "alert" },
          h("h2", null, "This datastore does not fit this board"),
          h("p", null, `The board needs a ${state.setup?.requirement.moduleId} datastore speaking API v${state.setup?.requirement.apiMajor}; ` +
            `the connection offers ${state.binding?.moduleId} API v${state.binding?.apiMajor}. Connect a compatible datastore.`));
      case "forbidden":
        return h("div", { class: "state-panel", role: "alert" },
          h("h2", null, "You don't have access to this datastore"),
          h("p", null, "Records checks your own membership of the datastore, not only this gadget's connection. Having this board shared with you does not grant access to its records."),
          h("p", null, "Ask a datastore owner or administrator to add you as a reader or editor in Workshop → Data."),
          state.errorMessage ? h("p", { class: "sub" }, state.errorMessage) : null,
          h("button", { onclick: () => void loadAll() }, "Check again"));
      case "no_read":
        return h("div", { class: "state-panel", role: "alert" },
          h("h2", null, "This connection cannot read issues"),
          h("p", null, "Reconnect the datastore with the projects.read and issues.read operations."));
      case "no_projects":
        return h("div", { class: "state-panel" },
          h("h2", null, "No projects yet"),
          h("p", null, `${state.binding?.datastore.name ?? "This datastore"} has no projects. A datastore administrator creates projects in Workshop → Data.`),
          h("button", { onclick: () => void loadAll() }, "Check again"));
      case "too_large":
        return h("div", { class: "state-panel", role: "alert" },
          h("h2", null, "This datastore is too large for the board"),
          h("p", null, "The board keeps a live copy of every project, issue and comment, and this datastore has more than that copy allows. Use a Project report, or the Records API, instead."),
          state.errorMessage ? h("p", { class: "sub" }, state.errorMessage) : null);
      default:
        return h("div", { class: "state-panel", role: "alert" },
          h("h2", null, "The Records service is unavailable"),
          h("p", null, state.errorMessage || "The board could not be loaded."),
          h("p", null, "Nothing has been changed. Try again in a moment; if it keeps failing, reload the page."),
          h("div", { class: "row" },
            h("button", { class: "primary", onclick: () => void loadAll() }, "Try again"),
            h("button", { onclick: () => location.reload() }, "Reload page")));
    }
  }

  function renderToolbar() {
    // Rebuilding would steal focus from a control the person is using; the next render catches up.
    if (els.toolbar.contains(document.activeElement) && /** @type {any} */ (document.activeElement)?.type !== "search") return;
    const list = projects();
    const people = knownPeople(issues().values(), state.members);
    const current = list.find((p) => p.id === state.projectId) ?? list[0];
    const projectSelect = list.length > 1
      ? h("label", null, h("span", { class: "sr-only" }, "Project"),
        h("select", { "aria-label": "Project", onchange: (/** @type {Event} */ e) => selectProject(/** @type {HTMLSelectElement} */ (e.target).value) },
          list.map((p) => option(p.id, `${p.key} · ${p.name}`, p.id === state.projectId))))
      : h("strong", null, `${current.key} · ${current.name}`);
    const focused = document.activeElement;
    const search = h("input", {
      type: "search", placeholder: "Filter by key or title", "aria-label": "Filter issues by key or title", value: state.filter.text,
      oninput: (/** @type {Event} */ e) => { state.filter.text = /** @type {HTMLInputElement} */ (e.target).value; renderBoard(); },
    });
    els.toolbar.replaceChildren(
      projectSelect,
      search,
      h("select", { "aria-label": "Filter by assignee", onchange: (/** @type {Event} */ e) => { state.filter.assigneeId = /** @type {HTMLSelectElement} */ (e.target).value; renderBoard(); } },
        option("", "Anyone", !state.filter.assigneeId), option("none", "Unassigned", state.filter.assigneeId === "none"),
        people.map((p) => option(p.id, p.displayName, state.filter.assigneeId === p.id))),
      h("select", { "aria-label": "Filter by priority", onchange: (/** @type {Event} */ e) => { state.filter.priority = /** @type {HTMLSelectElement} */ (e.target).value; renderBoard(); } },
        option("", "Any priority", !state.filter.priority), PRIORITIES.map((p) => option(p, PRIORITY_LABELS[p], state.filter.priority === p))),
      h("span", { class: "spacer" }),
      h("button", { class: "primary", disabled: !state.caps.create, onclick: () => openCreate(),
        title: state.caps.create ? "" : "This connection cannot create issues" }, "New issue"),
    );
    if (focused && /** @type {any} */ (focused).type === "search") { search.focus(); /** @type {HTMLInputElement} */ (search).setSelectionRange(9999, 9999); }
  }

  function renderBoard() {
    const wf = workflow();
    if (!wf) return;
    const cols = columns(wf, issues().values(), state.filter);
    els.board.replaceChildren(...cols.map(({ state: col, issues: list }) => {
      const ul = h("ul", { "aria-label": `${col.name} issues` }, list.map((issue) => cardEl(issue)));
      const colEl = h("section", {
        class: "pb-column", "data-state": col.key, "aria-label": col.name,
        ondragover: (/** @type {DragEvent} */ e) => {
          if (dragging && canTransition(wf, dragging.state, col.key)) { e.preventDefault(); colEl.classList.add("drop-over"); }
        },
        ondragleave: () => colEl.classList.remove("drop-over"),
        ondrop: (/** @type {DragEvent} */ e) => {
          e.preventDefault();
          colEl.classList.remove("drop-over");
          const issue = dragging;
          endDrag();
          const current = issue ? issueById(issue.id) ?? issue : null;
          if (current && canTransition(wf, current.state, col.key)) transition(current, col.key);
        },
      }, h("h2", null, h("span", null, col.name), h("span", { "aria-label": `${list.length} issues` }, String(list.length))), ul);
      return colEl;
    }));
  }

  function endDrag() {
    dragging = null;
    for (const c of els.board.querySelectorAll(".pb-column")) c.classList.remove("drop-ok", "drop-no", "drop-over");
  }

  /** @param {Change|null} busy @param {Issue} issue */
  function chipFor(busy, issue) {
    if (busy?.status === "pending") return h("span", { class: "chip pending" }, "Awaiting approval");
    if (busy?.status === "saving") return h("span", { class: "chip saving" }, "Saving…");
    if (isProvisional(issue)) return h("span", { class: "chip saving" }, "Not saved yet");
    return null;
  }

  /** @param {Issue} issue */
  function cardEl(issue) {
    const busy = busyFor(issue.id);
    const provisional = isProvisional(issue);
    const wf = workflow();
    return h("li", {
      class: `pb-card${busy ? " busy" : ""}${provisional ? " provisional" : ""}`, "data-issue-id": issue.id,
      draggable: state.caps.transition ? "true" : null,
      "aria-current": state.selectedId === issue.id ? "true" : null,
      ondragstart: (/** @type {DragEvent} */ e) => {
        dragging = issue;
        e.dataTransfer?.setData("text/plain", issue.key);
        for (const c of els.board.querySelectorAll(".pb-column")) {
          const key = /** @type {HTMLElement} */ (c).dataset.state ?? "";
          if (key !== issue.state) c.classList.add(canTransition(wf, issue.state, key) ? "drop-ok" : "drop-no");
        }
      },
      ondragend: () => endDrag(),
    },
    h("button", { class: "open", onclick: () => openIssue(issue.id),
      "aria-label": `${provisional ? "New issue, not numbered yet" : issue.key}: ${issue.title}. Open details` },
      h("div", { class: "key" }, issue.key),
      h("div", { class: "title" }, issue.title),
      h("div", { class: "meta" },
        issue.priority !== "none" ? h("span", { class: `prio ${issue.priority}` }, PRIORITY_LABELS[issue.priority]) : null,
        h("span", null, issue.assignee ? issue.assignee.displayName || "Assigned" : "Unassigned"),
        chipFor(busy, issue))));
  }

  /** @param {HTMLElement} el */
  function readForm(el) {
    const val = (/** @type {string} */ name) => /** @type {HTMLInputElement} */ (el.querySelector(`[name="${name}"]`))?.value ?? "";
    return { title: val("title"), description: val("description"), priority: val("priority"), assigneeId: val("assigneeId") };
  }

  /** @param {HTMLElement} el @param {string} field @param {string} value */
  function setField(el, field, value) {
    /** @type {HTMLInputElement} */ (el.querySelector(`[name="${field}"]`)).value = value;
  }

  function showFieldError(/** @type {string} */ message) {
    const slot = detailEl?.querySelector(".field-error");
    if (slot) slot.textContent = message;
  }

  function renderDetail() {
    if (state.phase !== "ready") return;
    const issue = state.selectedId ? issueById(state.selectedId) : null;
    if (!issue || !draft) { detailEl?.remove(); detailEl = null; return; }
    if (!detailEl) {
      detailEl = buildDetail(issue);
      els.main.append(detailEl);
    }
    updateDetail(detailEl, issue);
  }

  /** @param {Issue} issue */
  function buildDetail(issue) {
    const people = knownPeople(issues().values(), state.members);
    const ro = !state.caps.edit;
    const el = h("aside", { class: "pb-detail", "aria-labelledby": "pb-detail-title",
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape") closeIssue(); } },
      h("div", { class: "row", style: "justify-content: space-between; margin-top: 0" },
        h("span", { class: "sub detail-key" }), h("button", { onclick: () => closeIssue(), "aria-label": "Close issue details" }, "Close")),
      h("h2", { id: "pb-detail-title", tabindex: "-1", class: "detail-title" }),
      h("div", { class: "sub detail-meta" }),
      h("div", { class: "detail-status", role: "status" }),
      h("label", { for: "pb-f-title" }, "Title"),
      h("input", { id: "pb-f-title", type: "text", name: "title", maxlength: "200", disabled: ro }),
      h("label", { for: "pb-f-desc" }, "Description"),
      h("textarea", { id: "pb-f-desc", name: "description", rows: "5", disabled: ro }),
      h("label", { for: "pb-f-prio" }, "Priority"),
      h("select", { id: "pb-f-prio", name: "priority", disabled: ro }, PRIORITIES.map((p) => option(p, PRIORITY_LABELS[p]))),
      h("label", { for: "pb-f-assignee" }, "Assignee"),
      h("select", { id: "pb-f-assignee", name: "assigneeId", disabled: ro },
        option("", "Unassigned"),
        (issue.assignee && !people.some((p) => p.id === issue.assignee?.id) ? [issue.assignee, ...people] : people)
          .map((p) => option(p.id, p.displayName || p.id))),
      h("div", { class: "field-error", role: "alert" }),
      h("div", { class: "conflict-slot" }),
      h("div", { class: "row" },
        h("button", { class: "primary save", disabled: ro, onclick: () => void saveEdit() }, "Save changes"),
        h("button", { class: "discard", disabled: ro, onclick: () => { const cur = issueById(issue.id); if (cur) { resetDraft(cur); render(); } } }, "Discard")),
      h("section", { "aria-label": "Workflow" }, h("h3", null, "Move"), h("div", { class: "row transitions", style: "margin-top: 0" })),
      h("section", { "aria-label": "Comments" },
        h("h3", null, "Comments"),
        h("ul", { class: "comments" }),
        h("div", { class: "comments-status sub", role: "status" }),
        state.caps.comment ? h("div", null,
          h("label", { for: "pb-f-comment" }, "Add a comment"),
          h("textarea", { id: "pb-f-comment", name: "comment", rows: "3", maxlength: "10000" }),
          h("div", { class: "row" }, h("button", { class: "add-comment", onclick: () => {
            const box = /** @type {HTMLTextAreaElement} */ (el.querySelector("[name=comment]"));
            if (!box.value.trim()) return;
            if (addComment(box.value)) box.value = "";
          } }, "Add comment"))) : null));
    const d = /** @type {NonNullable<typeof draft>} */ (draft);
    for (const field of EDIT_FIELDS) setField(el, field, d.base[field]);
    return el;
  }

  /**
   * Keeps the form consistent with the view while it is open:
   * - after a conflict, once the server's newer version is in view, rebase onto it: the fields
   *   you changed keep your values, the rest take the current ones;
   * - when a guess of yours vanished (refused), adopt the current version as the base, keeping
   *   what the form holds, so Save sends it again;
   * - when someone else's change arrives while you edit, fold it into untouched fields; if you
   *   touched any field, keep the old base so saving reports a conflict instead of overwriting.
   * @param {HTMLElement} el @param {Issue} issue
   */
  function syncDraft(el, issue) {
    const d = /** @type {NonNullable<typeof draft>} */ (draft);
    const c = state.conflict?.issueId === issue.id ? state.conflict : null;
    const fresh = baseValues(issue);
    if (c && !c.rebased && issue.revision >= (c.currentRevision ?? issue.revision) && issue.revision !== d.baseRevision) {
      for (const f of EDIT_FIELDS) {
        const yours = f in c.patch ? (f === "assigneeId" ? c.patch[f] ?? "" : c.patch[f]) : fresh[f];
        setField(el, f, yours);
      }
      d.base = fresh;
      d.baseRevision = issue.revision;
      c.rebased = issue.revision >= (c.currentRevision ?? 0);
    } else if (issue.revision < d.baseRevision) {
      d.base = fresh;
      d.baseRevision = issue.revision;
    } else if (issue.revision > d.baseRevision) {
      const values = readForm(el);
      const touched = EDIT_FIELDS.some((f) => values[f] !== d.base[f]);
      for (const f of EDIT_FIELDS) if (values[f] === d.base[f]) setField(el, f, fresh[f]);
      if (!touched) { d.base = fresh; d.baseRevision = issue.revision; }
    }
  }

  /** @param {HTMLElement} el @param {Issue} issue */
  function updateDetail(el, issue) {
    const d = /** @type {NonNullable<typeof draft>} */ (draft);
    const wf = workflow();
    syncDraft(el, issue);
    /** @type {HTMLElement} */ (el.querySelector(".detail-key")).textContent = isProvisional(issue) ? `${issue.key} (not numbered yet)` : issue.key;
    /** @type {HTMLElement} */ (el.querySelector(".detail-title")).textContent = issue.title;
    const stateName = wf.states.find((/** @type {any} */ s) => s.key === issue.state)?.name ?? issue.state;
    /** @type {HTMLElement} */ (el.querySelector(".detail-meta")).textContent =
      `${stateName} · revision ${issue.revision} · updated ${relativeTime(issue.updatedAt)} by ${issue.updatedBy.displayName}`;

    const busy = busyFor(issue.id);
    /** @type {HTMLElement} */ (el.querySelector(".detail-status")).textContent =
      issue.revision > d.baseRevision ? "Someone changed this issue while you were editing. Saving will show you what changed." :
        busy ? describeChange(busy, likelyFailures().get(busy.id) ?? null) : "";

    const slot = /** @type {HTMLElement} */ (el.querySelector(".conflict-slot"));
    const c = state.conflict?.issueId === issue.id ? state.conflict : null;
    slot.replaceChildren(c ? conflictBox(c, issue) : "");

    // Transitions: only the workflow's allowed moves.
    const targets = allowedTargets(wf, issue.state);
    /** @type {HTMLElement} */ (el.querySelector(".transitions")).replaceChildren(
      ...(targets.length ? targets.map((t) => h("button", {
        disabled: !state.caps.transition,
        onclick: () => { const cur = issueById(issue.id); if (cur) transition(cur, t.key); },
      }, `Move to ${t.name}`)) : [h("span", { class: "sub" }, "No moves are allowed from this state.")]),
      !state.caps.transition && targets.length ? h("span", { class: "sub" }, "This connection cannot move issues.") : "");

    // Comments, from the synced view (yours show at once, marked until saved).
    const sending = new Set([...state.changes.values()].filter((ch) => ch.name === "projects.addComment" && ch.status === "saving").map((ch) => ch.args.id));
    const list = client ? commentsIn(client, issue.id) : [];
    /** @type {HTMLElement} */ (el.querySelector(".comments")).replaceChildren(...list.map((cm) =>
      h("li", { class: sending.has(cm.id) ? "sending" : null },
        h("div", { class: "by" }, `${cm.author.displayName} · ${sending.has(cm.id) ? "sending…" : relativeTime(cm.createdAt)}`),
        h("div", { class: "body" }, cm.body))));
    /** @type {HTMLElement} */ (el.querySelector(".comments-status")).textContent = list.length ? "" : "No comments yet.";
  }

  /** @param {NonNullable<typeof state.conflict>} c @param {Issue} issue */
  function conflictBox(c, issue) {
    const rows = conflictingFields(c.patch, issue);
    return h("div", { class: "conflict-box", role: "alert" },
      h("strong", null, "Your change was not saved."),
      h("p", { style: "margin: 4px 0" }, `${issue.key} was changed by someone else after you opened it.`),
      rows.length
        ? h("table", null, h("thead", null, h("tr", null, h("th", null, "Field"), h("th", null, "Your version"), h("th", null, "Current"))),
          h("tbody", null, rows.map((r) => h("tr", null, h("td", null, r.field === "assigneeId" ? "assignee" : r.field),
            h("td", null, fmt(r.field, r.yours)), h("td", null, fmt(r.field, r.theirs))))))
        : h("p", null, "The current version already matches yours."),
      h("p", { style: "margin: 4px 0" }, c.rebased
        ? "The form holds your version on top of the current one. Save again to apply it, or discard it."
        : "Loading the current version…"));
  }

  /** @param {string} field @param {any} value */
  function fmt(field, value) {
    if (value === null || value === undefined || value === "") return "—";
    if (field === "assigneeId") return knownPeople(issues().values(), state.members).find((p) => p.id === value)?.displayName ?? String(value);
    if (field === "priority") return /** @type {any} */ (PRIORITY_LABELS)[value] ?? String(value);
    return String(value);
  }

  function renderWritesOnly() {
    const failing = likelyFailures();
    els.writes.replaceChildren(...[...state.changes.values()].map((change) => h("div", { class: "write", "data-status": change.status, "data-change-id": String(change.id) },
      h("div", { class: "what" }, change.label),
      h("div", null, h("span", { class: `chip ${change.status}` }, STATUS_LABELS[change.status]), " ", describeChange(change, failing.get(change.id) ?? null)),
      h("div", { class: "actions" },
        change.status === "pending" ? h("button", { onclick: () => void client?.checkApprovals() }, "Check now") : null,
        change.status === "conflict" && change.name === "projects.editIssue" && state.selectedId !== change.args.issueId && issueById(change.args.issueId)
          ? h("button", { onclick: () => {
            openIssue(change.args.issueId);
            state.conflict = { changeId: change.id, issueId: change.args.issueId, patch: change.args.patch, code: change.code ?? "", currentRevision: change.currentRevision, rebased: false };
            render();
          } }, "Review") : null,
        change.status !== "saving"
          ? h("button", { class: "link", onclick: () => dismissChange(change), "aria-label": `Dismiss: ${change.label}` }, "Dismiss")
          : null))));
  }

  function renderWrites() {
    renderWritesOnly();
    // Card chips and detail status follow change state.
    if (state.phase === "ready") { renderBoard(); if (detailEl && state.selectedId) { const i = issueById(state.selectedId); if (i) updateDetail(detailEl, i); } }
  }

  // --- Create dialog -------------------------------------------------------------------------

  function openCreate() {
    if (createOpen) return;
    createOpen = true;
    const opener = document.activeElement;
    const people = knownPeople(issues().values(), state.members);
    const close = () => { createOpen = false; els.dialog.replaceChildren(); /** @type {HTMLElement|null} */ (opener)?.focus?.(); };
    const error = h("div", { class: "field-error", role: "alert" });
    const dialog = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "pb-create-title",
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape") close(); } },
      h("h2", { id: "pb-create-title" }, "New issue"),
      h("p", { class: "sub" }, `In ${projects().find((p) => p.id === state.projectId)?.name ?? "this project"}. It starts in ${sortedStates(workflow())[0]?.name ?? "the first state"}.`),
      h("label", { for: "pb-c-title" }, "Title"),
      h("input", { id: "pb-c-title", type: "text", name: "title", maxlength: "200", required: true }),
      h("label", { for: "pb-c-desc" }, "Description (optional)"),
      h("textarea", { id: "pb-c-desc", name: "description", rows: "4" }),
      h("label", { for: "pb-c-prio" }, "Priority"),
      h("select", { id: "pb-c-prio", name: "priority" }, PRIORITIES.map((p) => option(p, PRIORITY_LABELS[p], p === "none"))),
      h("label", { for: "pb-c-assignee" }, "Assignee"),
      h("select", { id: "pb-c-assignee", name: "assigneeId" }, option("", "Unassigned", true), people.map((p) => option(p.id, p.displayName))),
      error,
      h("div", { class: "row" },
        h("button", { onclick: close }, "Cancel"),
        h("button", { class: "primary create", onclick: () => {
          const get = (/** @type {string} */ n) => /** @type {HTMLInputElement} */ (dialog.querySelector(`[name="${n}"]`)).value;
          if (!get("title").trim()) { error.textContent = "Give the issue a title."; return; }
          createIssue({ title: get("title"), description: get("description"), priority: get("priority"), assigneeId: get("assigneeId") });
          close();
        } }, "Create issue")));
    els.dialog.replaceChildren(h("div", { class: "dialog-backdrop", onclick: (/** @type {Event} */ e) => { if (e.target === e.currentTarget) close(); } }, dialog));
    /** @type {HTMLElement} */ (dialog.querySelector("[name=title]")).focus();
  }

  // --- Start ---------------------------------------------------------------------------------

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  render();

  let ready = Promise.resolve();
  if (options.autoStart !== false) {
    ready = loadAll();
    const onVisible = () => { if (!document.hidden) void pokes.wake(); };
    document.addEventListener("visibilitychange", onVisible);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));
  }

  return {
    state, ready, render, loadAll, openIssue, closeIssue, saveEdit, transition, createIssue,
    addComment, selectProject, requestLive, refresh, pokes,
    get client() { return client; },
    issueById,
    destroy() {
      client?.close();
      for (const fn of cleanups.splice(0)) fn();
      for (const t of dismissTimers) clearTimeout(t);
      root.replaceChildren();
      style.remove();
    },
  };
}
