// @ts-check
// The project board: state, loading, actions and rendering. Records are read and written only
// through the gadget server's RECORDS pass-through; nothing is cached across sessions except the
// chosen project and the ids of writes awaiting approval (in window.name).

import { h, option, relativeTime } from "./dom.js";
import { CSS } from "./styles.js";
import {
  PRIORITIES, PRIORITY_LABELS, allowedTargets, canTransition, capabilities, columns, conflictingFields,
  knownPeople, loadAllIssues, mergeIssue, missingScopes, replaceIssues, sortedStates,
} from "../model.js";
import { createWriteTracker } from "../writes.js";
import { createSync } from "../sync.js";
import { errorCode, errorDetail } from "../../shared/records.js";

/** @typedef {import("../model.js").Issue} Issue */
/** @typedef {import("../writes.js").WriteEntry} WriteEntry */

const PREFS_PREFIX = "project-board:";
const APPLIED_VISIBLE_MS = 6_000;
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

/** @param {WriteEntry} entry */
export function describeWrite(entry) {
  switch (entry.status) {
    case "saving": return "Saving…";
    case "pending":
      return `Awaiting approval in the Workshop (action #${entry.actionId}). Not saved yet.` +
        (entry.checkFailed ? " The last status check failed; retrying." : "");
    case "applied": return "Saved.";
    case "conflict":
      return entry.code === "workflow_conflict"
        ? "Not saved: that move is not allowed from the issue's current state. Reload the issue and decide again."
        : "Not saved: someone else changed this issue first. Reload it and decide again.";
    case "rejected": return `Not saved: ${entry.message || "the Records service refused this change."}`;
    case "unknown": return "No answer from the Records service. It may or may not have been saved; check again before retrying.";
  }
}

/** @param {unknown} err */
function phaseForError(err) {
  const code = errorCode(err);
  if (code === "not_connected") return "not_connected";
  if (code === "forbidden" || code === "unauthenticated") return "forbidden";
  return "error";
}

/**
 * @param {{gadget: any, root: HTMLElement, prefs?: {load(): any, save(p: any): void}, autoStart?: boolean}} options
 */
export function createBoardApp(options) {
  const { gadget, root } = options;
  const prefs = options.prefs ?? windowNameStore;
  const saved = prefs.load() ?? {};

  const state = {
    /** @type {"loading"|"not_connected"|"incompatible"|"forbidden"|"no_read"|"no_projects"|"error"|"ready"} */
    phase: "loading",
    errorMessage: "",
    /** @type {any} */ setup: null,
    /** @type {any} */ binding: null,
    caps: capabilities(null),
    /** @type {string[]} */ missing: [],
    /** @type {any[]} */ projects: [],
    /** @type {any[]} */ members: [],
    /** @type {string|null} */ projectId: typeof saved.projectId === "string" ? saved.projectId : null,
    /** @type {any} */ workflow: null,
    /** @type {Map<string, Issue>} */ issues: new Map(),
    truncated: false,
    filter: { text: "", assigneeId: "", priority: "" },
    /** @type {string|null} */ selectedId: null,
    comments: { issueId: /** @type {string|null} */ (null), items: /** @type {any[]} */ ([]), nextCursor: /** @type {string|null} */ (null), loading: false, error: "" },
    /** Last refresh failure while data is still shown. */
    staleError: "",
    sync: { live: "off", lastRefresh: /** @type {number|null} */ (null), error: /** @type {string|null} */ (null) },
    liveError: "",
    /** @type {{entryId: string, issueId: string, rows: {field: string, yours: any, theirs: any}[]|null, code: string, reloaded?: boolean}|null} */
    conflict: null,
  };

  /** Form state for the open issue; see renderDetail. */
  let draft = /** @type {null|{issueId: string, baseRevision: number, base: Record<string, any>}} */ (null);
  let detailEl = /** @type {HTMLElement|null} */ (null);
  let dragging = /** @type {Issue|null} */ (null);
  let createOpen = false;

  const persistPrefs = (/** @type {any} */ patch) => {
    const next = { ...prefs.load(), ...patch };
    prefs.save(next);
  };

  const tracker = createWriteTracker({
    gadget,
    persist: (pending) => persistPrefs({ pending }),
    onUpdate: () => renderWrites(),
    onApplied: (entry) => {
      applyRecord(entry);
      setTimeout(() => { if (tracker.get(entry.id)?.status === "applied") { tracker.dismiss(entry.id); renderWrites(); } }, APPLIED_VISIBLE_MS);
    },
  });

  const sync = createSync({
    gadget,
    onRefetchAll: () => loadAll({ quiet: true }),
    onChanges: (changes) => applyChanges(changes),
    onStatus: (s) => { state.sync = s; renderHeader(); },
    isHidden: () => typeof document !== "undefined" && document.hidden,
  });

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
      const [projects, workflow, members] = await Promise.all([gadget.listProjects(), gadget.getWorkflow(), gadget.listAssignees().catch(() => [])]);
      state.projects = projects;
      state.members = members;
      state.workflow = workflow;
      if (!projects.length) { state.phase = "no_projects"; render(); return; }
      if (!projects.some((/** @type {any} */ p) => p.id === state.projectId)) state.projectId = projects[0].id;
      const { items, truncated } = await loadAllIssues((input) => gadget.listIssues(input), /** @type {string} */ (state.projectId));
      state.issues = replaceIssues(state.issues, items);
      state.truncated = truncated;
      if (state.selectedId && !state.issues.has(state.selectedId)) closeIssue(false);
      state.phase = "ready";
      state.staleError = "";
      render();
      if (state.selectedId && state.comments.issueId === state.selectedId) void loadComments(state.selectedId, false);
    } catch (err) {
      // Never throws: every failure is shown. A refresh failure while issues are on screen keeps
      // them, marked as possibly out of date; access and connection failures replace the board.
      const phase = phaseForError(err);
      if (state.phase === "ready" && phase === "error") {
        state.staleError = errorDetail(err);
      } else {
        state.phase = phase;
        state.errorMessage = errorDetail(err);
      }
      render();
    }
  }

  /** @param {{entityType: string, entityId: string, revision: number}[]} changes */
  async function applyChanges(changes) {
    const issueChanges = changes.filter((c) => c.entityType === "issue");
    const structural = changes.some((c) => !["issue", "comment"].includes(c.entityType));
    if (structural || issueChanges.length > 25) return loadAll({ quiet: true });
    for (const change of issueChanges) {
      const held = state.issues.get(change.entityId);
      if (held && held.revision >= change.revision) continue; // obsolete or already seen
      try {
        const issue = await gadget.getIssue(change.entityId);
        if (issue.projectId !== state.projectId) state.issues.delete(issue.id);
        else mergeIssue(state.issues, issue);
      } catch (err) {
        if (errorCode(err) === "not_found") state.issues.delete(change.entityId);
        else throw err;
      }
    }
    if (changes.some((c) => c.entityType === "comment") && state.selectedId) await loadComments(state.selectedId, false);
    render();
  }

  /** @param {string} issueId @param {boolean} [more] */
  async function loadComments(issueId, more = false) {
    const c = state.comments;
    if (c.issueId !== issueId) Object.assign(c, { issueId, items: [], nextCursor: null, error: "" });
    c.loading = true;
    renderDetail();
    try {
      const page = await gadget.listComments({ issueId, limit: 50, ...(more && c.nextCursor ? { cursor: c.nextCursor } : {}) });
      if (c.issueId !== issueId) return;
      c.items = more ? [...c.items, ...page.items] : page.items;
      c.nextCursor = page.nextCursor;
      c.error = "";
    } catch (err) {
      c.error = `Comments could not be loaded: ${errorDetail(err)}`;
    } finally {
      c.loading = false;
      renderDetail();
    }
  }

  /** Re-reads one issue, e.g. after a conflict. @param {string} issueId */
  async function reloadIssue(issueId) {
    try {
      const issue = await gadget.getIssue(issueId);
      mergeIssue(state.issues, issue);
      if (state.conflict?.issueId === issueId) {
        const entry = tracker.get(state.conflict.entryId);
        const patch = entry?.operation === "editIssue" ? entry.input.patch : {};
        state.conflict.rows = entry?.operation === "editIssue" ? conflictingFields(patch, issue) : null;
        state.conflict.reloaded = true;
        if (draft?.issueId === issueId) {
          draft.baseRevision = issue.revision;
          draft.base = baseValues(issue);
        }
      }
      render();
      return issue;
    } catch (err) {
      if (errorCode(err) === "not_found") { state.issues.delete(issueId); render(); return null; }
      state.staleError = errorDetail(err);
      render();
      return null;
    }
  }

  // --- Writes --------------------------------------------------------------------------------

  /** @param {WriteEntry} entry */
  function applyRecord(entry) {
    const record = entry.record;
    if (!record) return;
    if (entry.operation === "addComment") {
      if (state.comments.issueId === record.issueId && !state.comments.items.some((c) => c.id === record.id)) {
        state.comments.items = [...state.comments.items, record];
      }
    } else if (record.projectId === state.projectId) {
      mergeIssue(state.issues, record);
      if (draft?.issueId === record.id && entry.operation === "editIssue") resetDraft(record);
    }
    render();
  }

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

  function busyFor(/** @type {string} */ issueId) {
    return tracker.list().find((e) => e.issueId === issueId && (e.status === "saving" || e.status === "pending" || e.status === "unknown")) ?? null;
  }

  /** @param {Issue} issue @param {string} toState */
  async function transition(issue, toState) {
    if (!state.caps.transition || !canTransition(state.workflow, issue.state, toState)) return null;
    const target = state.workflow.states.find((/** @type {any} */ s) => s.key === toState);
    const entry = await tracker.start("transitionIssue", { issueId: issue.id, expectedRevision: issue.revision, toState },
      { label: `${issue.key}: move to ${target?.name ?? toState}`, issueId: issue.id });
    if (entry.status === "conflict") state.conflict = { entryId: entry.id, issueId: issue.id, rows: null, code: entry.code ?? "" };
    render();
    return entry;
  }

  /** Saves the open issue's changed fields. Returns null if nothing changed. */
  async function saveEdit() {
    if (!draft || !detailEl || !state.caps.edit) return null;
    const issue = state.issues.get(draft.issueId);
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
    const entry = await tracker.start("editIssue", { issueId: issue.id, expectedRevision: draft.baseRevision, patch },
      { label: `${issue.key}: edit ${Object.keys(patch).map((f) => f === "assigneeId" ? "assignee" : f).join(", ")}`, issueId: issue.id });
    if (entry.status === "conflict") state.conflict = { entryId: entry.id, issueId: issue.id, rows: null, code: entry.code ?? "" };
    render();
    return entry;
  }

  /** @param {{title: string, description?: string, priority?: string, assigneeId?: string}} fields */
  async function createIssue(fields) {
    if (!state.caps.create || !state.projectId) return null;
    /** @type {Record<string, any>} */
    const input = { projectId: state.projectId, title: fields.title.trim() };
    if (fields.description?.trim()) input.description = fields.description;
    if (fields.priority && fields.priority !== "none") input.priority = fields.priority;
    if (fields.assigneeId) input.assigneeId = fields.assigneeId;
    return tracker.start("createIssue", input, { label: `New issue: ${input.title}`, issueId: null });
  }

  /** @param {string} body */
  async function addComment(body) {
    if (!state.caps.comment || !state.selectedId || !body.trim()) return null;
    const issue = state.issues.get(state.selectedId);
    return tracker.start("addComment", { issueId: state.selectedId, body },
      { label: `${issue?.key ?? "Issue"}: comment`, issueId: state.selectedId });
  }

  // --- Navigation ----------------------------------------------------------------------------

  /** @param {string} issueId */
  function openIssue(issueId) {
    const issue = state.issues.get(issueId);
    if (!issue) return;
    state.selectedId = issueId;
    resetDraft(issue);
    render();
    void loadComments(issueId);
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
  async function selectProject(projectId) {
    state.projectId = projectId;
    persistPrefs({ projectId });
    state.issues = new Map();
    closeIssue(false);
    await loadAll();
  }

  async function requestLive() {
    state.liveError = "";
    try { await sync.requestLive(); }
    catch (err) { state.liveError = `Live updates could not be requested: ${errorDetail(err)}`; }
    renderHeader();
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
      return;
    }
    els.toolbar.hidden = false;
    renderToolbar();
    renderBoard();
    if (!els.main.contains(els.board)) els.main.replaceChildren(els.board);
    renderDetail();
    renderWrites();
  }

  function renderHeader() {
    const b = state.binding;
    const liveText = state.sync.live === "active" ? "Live updates on"
      : state.sync.live === "requested" ? "Live updates awaiting approval · refreshing every 15 s"
        : "Refreshing every 15 s";
    const last = state.sync.lastRefresh ? ` · updated ${relativeTime(new Date(state.sync.lastRefresh).toISOString())}` : "";
    els.header.replaceChildren(
      h("h1", null, "Project board"),
      b ? h("span", { class: "datastore" }, `${b.datastore.name}${b.datastore.lifecycle === "archived" ? " (archived)" : ""}`) : null,
      h("span", { class: "spacer" }),
      state.phase === "ready" ? h("span", { class: "live", "data-live": state.sync.live, role: "status" },
        h("span", { class: "dot", "aria-hidden": "true" }), liveText + last) : null,
      state.phase === "ready" && state.sync.live === "off"
        ? h("button", { class: "link", onclick: () => void requestLive(), title: "Asks the Records service to notify this board of changes. The Workshop owner approves this once." }, "Turn on live updates")
        : null,
      state.phase !== "loading" ? h("button", { onclick: () => void sync.refreshNow().catch(() => {}), "aria-label": "Refresh from the datastore" }, "Refresh") : null,
    );
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
    if (state.phase === "ready" && state.staleError) {
      list.push(h("div", { class: "banner bad", role: "alert" },
        `The last refresh failed (${state.staleError}). What you see may be out of date. `,
        h("button", { class: "link", onclick: () => void sync.refreshNow().catch(() => {}) }, "Try again")));
    }
    if (state.sync.error && state.phase === "ready" && !state.staleError) {
      list.push(h("div", { class: "banner warn", role: "status" }, `Automatic refresh is failing (${state.sync.error}). Use Refresh to retry.`));
    }
    if (state.liveError) list.push(h("div", { class: "banner warn", role: "status" }, state.liveError));
    if (state.phase === "ready" && state.truncated) {
      list.push(h("div", { class: "banner", role: "status" }, "This project has more than 1,000 issues; the board shows the first 1,000 by number. Use the Records API or a report for the rest."));
    }
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
    const people = knownPeople(state.issues.values(), state.members);
    const projectSelect = state.projects.length > 1
      ? h("label", null, h("span", { class: "sr-only" }, "Project"),
        h("select", { "aria-label": "Project", onchange: (/** @type {Event} */ e) => void selectProject(/** @type {HTMLSelectElement} */ (e.target).value) },
          state.projects.map((p) => option(p.id, `${p.key} · ${p.name}`, p.id === state.projectId))))
      : h("strong", null, `${state.projects[0].key} · ${state.projects[0].name}`);
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
    if (!state.workflow) return;
    const cols = columns(state.workflow, state.issues.values(), state.filter);
    els.board.replaceChildren(...cols.map(({ state: col, issues }) => {
      const list = h("ul", { "aria-label": `${col.name} issues` }, issues.map((issue) => cardEl(issue)));
      const colEl = h("section", {
        class: "pb-column", "data-state": col.key, "aria-label": col.name,
        ondragover: (/** @type {DragEvent} */ e) => {
          if (dragging && canTransition(state.workflow, dragging.state, col.key)) { e.preventDefault(); colEl.classList.add("drop-over"); }
        },
        ondragleave: () => colEl.classList.remove("drop-over"),
        ondrop: (/** @type {DragEvent} */ e) => {
          e.preventDefault();
          colEl.classList.remove("drop-over");
          const issue = dragging;
          endDrag();
          const current = issue ? state.issues.get(issue.id) ?? issue : null;
          if (current && canTransition(state.workflow, current.state, col.key)) void transition(current, col.key);
        },
      }, h("h2", null, h("span", null, col.name), h("span", { "aria-label": `${issues.length} issues` }, String(issues.length))), list);
      return colEl;
    }));
  }

  function endDrag() {
    dragging = null;
    for (const c of els.board.querySelectorAll(".pb-column")) c.classList.remove("drop-ok", "drop-no", "drop-over");
  }

  /** @param {Issue} issue */
  function cardEl(issue) {
    const busy = busyFor(issue.id);
    const draggable = state.caps.transition && !busy;
    return h("li", {
      class: `pb-card${busy ? " busy" : ""}`, "data-issue-id": issue.id, draggable: draggable ? "true" : null,
      "aria-current": state.selectedId === issue.id ? "true" : null,
      ondragstart: (/** @type {DragEvent} */ e) => {
        dragging = issue;
        e.dataTransfer?.setData("text/plain", issue.key);
        for (const c of els.board.querySelectorAll(".pb-column")) {
          const key = /** @type {HTMLElement} */ (c).dataset.state ?? "";
          if (key !== issue.state) c.classList.add(canTransition(state.workflow, issue.state, key) ? "drop-ok" : "drop-no");
        }
      },
      ondragend: () => endDrag(),
    },
    h("button", { class: "open", onclick: () => openIssue(issue.id), "aria-label": `${issue.key}: ${issue.title}. Open details` },
      h("div", { class: "key" }, issue.key),
      h("div", { class: "title" }, issue.title),
      h("div", { class: "meta" },
        issue.priority !== "none" ? h("span", { class: `prio ${issue.priority}` }, PRIORITY_LABELS[issue.priority]) : null,
        h("span", null, issue.assignee ? issue.assignee.displayName : "Unassigned"),
        busy ? h("span", { class: `chip ${busy.status}` }, busy.status === "pending" ? "Awaiting approval" : busy.status === "saving" ? "Saving…" : "Unconfirmed") : null)));
  }

  /** @param {HTMLElement} el */
  function readForm(el) {
    const val = (/** @type {string} */ name) => /** @type {HTMLInputElement} */ (el.querySelector(`[name="${name}"]`))?.value ?? "";
    return { title: val("title"), description: val("description"), priority: val("priority"), assigneeId: val("assigneeId") };
  }

  function showFieldError(/** @type {string} */ message) {
    const slot = detailEl?.querySelector(".field-error");
    if (slot) slot.textContent = message;
  }

  function renderDetail() {
    if (state.phase !== "ready") return;
    const issue = state.selectedId ? state.issues.get(state.selectedId) : null;
    if (!issue || !draft) { detailEl?.remove(); detailEl = null; return; }
    if (!detailEl) {
      detailEl = buildDetail(issue);
      els.main.append(detailEl);
    }
    updateDetail(detailEl, issue);
  }

  /** @param {Issue} issue */
  function buildDetail(issue) {
    const people = knownPeople(state.issues.values(), state.members);
    const ro = !state.caps.edit;
    const el = h("aside", { class: "pb-detail", "aria-labelledby": "pb-detail-title",
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape") closeIssue(); } },
      h("div", { class: "row", style: "justify-content: space-between; margin-top: 0" },
        h("span", { class: "sub detail-key" }), h("button", { onclick: () => closeIssue(), "aria-label": "Close issue details" }, "Close")),
      h("h2", { id: "pb-detail-title", tabindex: "-1", class: "detail-title" }),
      h("div", { class: "sub detail-meta" }),
      h("div", { class: "detail-status", role: "status" }),
      h("label", { for: "pb-f-title" }, "Title"),
      h("input", { id: "pb-f-title", type: "text", name: "title", maxlength: "300", disabled: ro }),
      h("label", { for: "pb-f-desc" }, "Description"),
      h("textarea", { id: "pb-f-desc", name: "description", rows: "5", disabled: ro }),
      h("label", { for: "pb-f-prio" }, "Priority"),
      h("select", { id: "pb-f-prio", name: "priority", disabled: ro }, PRIORITIES.map((p) => option(p, PRIORITY_LABELS[p]))),
      h("label", { for: "pb-f-assignee" }, "Assignee"),
      h("select", { id: "pb-f-assignee", name: "assigneeId", disabled: ro },
        option("", "Unassigned"),
        (issue.assignee && !people.some((p) => p.id === issue.assignee?.id) ? [issue.assignee, ...people] : people)
          .map((p) => option(p.id, p.displayName))),
      h("div", { class: "field-error", role: "alert" }),
      h("div", { class: "conflict-slot" }),
      h("div", { class: "row" },
        h("button", { class: "primary save", disabled: ro, onclick: () => void saveEdit() }, "Save changes"),
        h("button", { class: "discard", disabled: ro, onclick: () => { const cur = state.issues.get(issue.id); if (cur) { resetDraft(cur); render(); } } }, "Discard")),
      h("section", { "aria-label": "Workflow" }, h("h3", null, "Move"), h("div", { class: "row transitions", style: "margin-top: 0" })),
      h("section", { "aria-label": "Comments" },
        h("h3", null, "Comments"),
        h("ul", { class: "comments" }),
        h("div", { class: "comments-status sub", role: "status" }),
        h("button", { class: "link more", hidden: true, onclick: () => void loadComments(issue.id, true) }, "Load more comments"),
        state.caps.comment ? h("div", null,
          h("label", { for: "pb-f-comment" }, "Add a comment"),
          h("textarea", { id: "pb-f-comment", name: "comment", rows: "3" }),
          h("div", { class: "row" }, h("button", { class: "add-comment", onclick: () => {
            const box = /** @type {HTMLTextAreaElement} */ (el.querySelector("[name=comment]"));
            const body = box.value;
            if (!body.trim()) return;
            void addComment(body).then((entry) => { if (entry && (entry.status === "applied" || entry.status === "pending")) box.value = ""; });
          } }, "Add comment"))) : null));
    const d = /** @type {NonNullable<typeof draft>} */ (draft);
    for (const field of EDIT_FIELDS) {
      /** @type {HTMLInputElement} */ (el.querySelector(`[name="${field}"]`)).value = d.base[field];
    }
    return el;
  }

  /** @param {HTMLElement} el @param {Issue} issue */
  function updateDetail(el, issue) {
    const d = /** @type {NonNullable<typeof draft>} */ (draft);
    /** @type {HTMLElement} */ (el.querySelector(".detail-key")).textContent = issue.key;
    /** @type {HTMLElement} */ (el.querySelector(".detail-title")).textContent = issue.title;
    const stateName = state.workflow.states.find((/** @type {any} */ s) => s.key === issue.state)?.name ?? issue.state;
    /** @type {HTMLElement} */ (el.querySelector(".detail-meta")).textContent =
      `${stateName} · revision ${issue.revision} · updated ${relativeTime(issue.updatedAt)} by ${issue.updatedBy.displayName}`;

    // Fold a newer revision into untouched fields. If the person has edited any field, keep the
    // old base revision so saving reports a conflict rather than overwriting the newer change.
    if (issue.revision > d.baseRevision) {
      const values = readForm(el);
      const touched = EDIT_FIELDS.some((f) => values[f] !== d.base[f]);
      const fresh = baseValues(issue);
      for (const f of EDIT_FIELDS) {
        if (values[f] === d.base[f]) /** @type {HTMLInputElement} */ (el.querySelector(`[name="${f}"]`)).value = fresh[f];
      }
      if (!touched) { d.base = fresh; d.baseRevision = issue.revision; }
    }
    const busy = busyFor(issue.id);
    /** @type {HTMLElement} */ (el.querySelector(".detail-status")).textContent =
      issue.revision > d.baseRevision ? "Someone changed this issue while you were editing. Saving will show you what changed." :
        busy ? describeWrite(busy) : "";

    // Conflict panel.
    const slot = /** @type {HTMLElement} */ (el.querySelector(".conflict-slot"));
    const c = state.conflict?.issueId === issue.id ? state.conflict : null;
    slot.replaceChildren(c ? conflictBox(c, issue) : "");

    // Transitions: only the workflow's allowed moves.
    const targets = allowedTargets(state.workflow, issue.state);
    /** @type {HTMLElement} */ (el.querySelector(".transitions")).replaceChildren(
      ...(targets.length ? targets.map((t) => h("button", {
        disabled: !state.caps.transition || Boolean(busy),
        onclick: () => void transition(/** @type {Issue} */ (state.issues.get(issue.id)), t.key),
      }, `Move to ${t.name}`)) : [h("span", { class: "sub" }, "No moves are allowed from this state.")]),
      !state.caps.transition && targets.length ? h("span", { class: "sub" }, "This connection cannot move issues.") : "");

    // Comments.
    const cm = state.comments.issueId === issue.id ? state.comments : null;
    /** @type {HTMLElement} */ (el.querySelector(".comments")).replaceChildren(...(cm?.items ?? []).map((c) =>
      h("li", null, h("div", { class: "by" }, `${c.author.displayName} · ${relativeTime(c.createdAt)}`), h("div", { class: "body" }, c.body))));
    /** @type {HTMLElement} */ (el.querySelector(".comments-status")).textContent =
      cm?.loading ? "Loading comments…" : cm?.error || (cm && !cm.items.length ? "No comments yet." : "");
    /** @type {HTMLElement} */ (el.querySelector(".more")).hidden = !cm?.nextCursor;
  }

  /** @param {NonNullable<typeof state.conflict>} c @param {Issue} issue */
  function conflictBox(c, issue) {
    const workflow = c.code === "workflow_conflict";
    return h("div", { class: "conflict-box", role: "alert" },
      h("strong", null, workflow ? "That move was not saved." : "Your change was not saved."),
      h("p", { style: "margin: 4px 0" }, workflow
        ? "The workflow no longer allows it from the issue's current state."
        : `${issue.key} was changed by someone else after you opened it.`),
      c.rows ? (c.rows.length
        ? h("table", null, h("thead", null, h("tr", null, h("th", null, "Field"), h("th", null, "Your version"), h("th", null, "Current"))),
          h("tbody", null, c.rows.map((r) => h("tr", null, h("td", null, r.field === "assigneeId" ? "assignee" : r.field),
            h("td", null, fmt(r.field, r.yours)), h("td", null, fmt(r.field, r.theirs))))))
        : h("p", null, "The current version already matches yours."))
        : null,
      !c.reloaded
        ? h("button", { class: "reload-issue", onclick: () => void reloadIssue(issue.id) }, "Reload issue")
        : c.rows
          ? h("p", { style: "margin: 4px 0" }, "The form still holds your version. Save again to apply it on top of the current issue, or discard it.")
          : h("p", { style: "margin: 4px 0" }, `Reloaded: ${issue.key} is now in ${state.workflow.states.find((/** @type {any} */ s) => s.key === issue.state)?.name ?? issue.state}. Move it again if you still want to.`));
  }

  /** @param {string} field @param {any} value */
  function fmt(field, value) {
    if (value === null || value === undefined || value === "") return "—";
    if (field === "assigneeId") return knownPeople(state.issues.values(), state.members).find((p) => p.id === value)?.displayName ?? String(value);
    if (field === "priority") return /** @type {any} */ (PRIORITY_LABELS)[value] ?? String(value);
    return String(value);
  }

  function renderWrites() {
    const entries = tracker.list();
    els.writes.replaceChildren(...entries.map((entry) => h("div", { class: "write", "data-status": entry.status, "data-write-id": entry.id },
      h("div", { class: "what" }, entry.label),
      h("div", null, h("span", { class: `chip ${entry.status}` }, STATUS_LABELS[entry.status]), " ", describeWrite(entry)),
      h("div", { class: "actions" },
        entry.status === "unknown" ? h("button", { onclick: () => void tracker.checkAgain(entry.id) }, "Check again") : null,
        entry.status === "pending" ? h("button", { onclick: () => void tracker.refreshPending(entry.id) }, "Check now") : null,
        entry.status === "conflict" && entry.issueId ? h("button", { onclick: () => {
          if (entry.operation === "editIssue" && state.selectedId !== entry.issueId) openIssue(/** @type {string} */ (entry.issueId));
          state.conflict = { entryId: entry.id, issueId: /** @type {string} */ (entry.issueId), rows: null, code: entry.code ?? "" };
          void reloadIssue(/** @type {string} */ (entry.issueId));
        } }, "Reload issue") : null,
        entry.status !== "pending" && entry.status !== "saving"
          ? h("button", { class: "link", onclick: () => { tracker.dismiss(entry.id); renderWrites(); }, "aria-label": `Dismiss: ${entry.label}` }, "Dismiss")
          : null))));
    // Card chips and detail status follow write state.
    if (state.phase === "ready") { renderBoard(); if (detailEl && state.selectedId) { const i = state.issues.get(state.selectedId); if (i) updateDetail(detailEl, i); } }
  }

  // --- Create dialog -------------------------------------------------------------------------

  function openCreate() {
    if (createOpen) return;
    createOpen = true;
    const opener = document.activeElement;
    const people = knownPeople(state.issues.values(), state.members);
    const close = () => { createOpen = false; els.dialog.replaceChildren(); /** @type {HTMLElement|null} */ (opener)?.focus?.(); };
    const error = h("div", { class: "field-error", role: "alert" });
    const dialog = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "pb-create-title",
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === "Escape") close(); } },
      h("h2", { id: "pb-create-title" }, "New issue"),
      h("p", { class: "sub" }, `In ${state.projects.find((p) => p.id === state.projectId)?.name ?? "this project"}. It starts in ${sortedStates(state.workflow)[0]?.name ?? "the first state"}.`),
      h("label", { for: "pb-c-title" }, "Title"),
      h("input", { id: "pb-c-title", type: "text", name: "title", maxlength: "300", required: true }),
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
          void createIssue({ title: get("title"), description: get("description"), priority: get("priority"), assigneeId: get("assigneeId") });
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
    ready = sync.start().catch(() => { /* phase already rendered */ });
    tracker.restore(saved.pending);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void sync.wake(); });
  }

  return {
    state, tracker, sync, ready, render, loadAll, openIssue, closeIssue, saveEdit, transition, createIssue,
    addComment, reloadIssue, selectProject, requestLive, applyChanges,
    destroy() { sync.stop(); tracker.dispose(); root.replaceChildren(); style.remove(); },
  };
}

const STATUS_LABELS = { saving: "Saving", pending: "Pending approval", applied: "Saved", conflict: "Conflict", rejected: "Not saved", unknown: "Unconfirmed" };

