// @ts-check
// The Ranked Vote UI: plain DOM, no framework.
//
// Rendering is per section (header, notices, results, ranking, readiness, fields, activity). A
// section holding the focused text box, or the ranking while an option is being dragged, is not
// replaced; it is marked stale and redrawn when focus leaves or the drag ends. Buttons carry a
// data-key so focus returns to the same control after a redraw.
//
// Order: the list shows, in priority, the viewer's unsaved local order (a drag in flight), their
// saved ballot, or a per-viewer shuffle the server suggests. The first drag saves a ballot.
//
// No <form> anywhere: the gadget iframe has no allow-forms. No confirm(): two-step buttons instead.

/** @typedef {ReturnType<typeof import("../core/vote.js").Vote.prototype.viewFor>} View */

/**
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {(Node|string|null|undefined|false)[]} [children]
 */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string") /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const GRIP = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 14 20");
  svg.setAttribute("aria-hidden", "true");
  for (const y of [4, 10, 16]) for (const x of [4, 10]) {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", String(x)); c.setAttribute("cy", String(y)); c.setAttribute("r", "1.6"); c.setAttribute("fill", "currentColor");
    svg.appendChild(c);
  }
  return svg;
};

/** @param {number} t */
function when(t) {
  const d = new Date(t);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/** @param {unknown} e */
function message(e) {
  const m = String(/** @type {any} */ (e)?.message ?? e ?? "Something went wrong");
  return m.replace(/^(\w*Error: )+/, "");
}

/**
 * Two-step destructive button: the first click arms it for 4 s, the second acts.
 * @param {string} label @param {string} armed @param {string} key @param {() => void} act @param {string} [cls]
 */
function twoStep(label, armed, key, act, cls = "btn link danger") {
  /** @type {any} */
  let timer = null;
  const b = h("button", { class: cls, type: "button", text: label, dataset: { key } });
  b.addEventListener("click", () => {
    if (timer) { clearTimeout(timer); timer = null; act(); return; }
    b.textContent = armed;
    timer = setTimeout(() => { timer = null; b.textContent = label; }, 4000);
  });
  return b;
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   me: {id: string, name: string},
 *   call: (method: string, args: any) => Promise<any>,
 *   onRetry: () => void,
 * }} deps
 */
export function mountApp(root, { me, call, onRetry }) {
  /** @type {View|null} */
  let view = null;
  /** @type {string[]|null} a local order not yet reflected in `view` */
  let localOrder = null;
  let pendingSaves = 0;
  let awaitRevision = 0;
  /** @type {Set<string>} */
  const expanded = new Set();
  let dragging = false;
  let editingQuestion = false;
  let connection = /** @type {"connecting"|"live"|"lost"} */ ("connecting");

  const live = h("div", { class: "sr-only", "aria-live": "polite", role: "status" });
  const toasts = h("div", { class: "toast-area", role: "alert" });
  const sections = {
    header: h("header", { class: "top" }),
    notices: h("div"),
    results: h("div"),
    add: h("div", { class: "card add-option" }),
    ranking: h("div"),
    ready: h("div", { class: "card" }),
    fields: h("div", { class: "card" }),
    activity: h("div", { class: "card" }),
  };
  root.append(h("div", { class: "app" }, [
    sections.header, sections.notices,
    h("div", { class: "grid" }, [
      h("section", { "aria-label": "Options" }, [sections.results, sections.add, sections.ranking]),
      h("aside", { "aria-label": "Reveal, fields and activity" }, [sections.ready, sections.fields, sections.activity]),
    ]),
  ]), live, toasts);

  /** @param {string} text */
  const announce = (text) => { live.textContent = ""; setTimeout(() => { live.textContent = text; }, 30); };

  /** @param {string} text */
  function toast(text) {
    const t = h("div", { class: "toast", text });
    toasts.append(t);
    setTimeout(() => t.remove(), 6000);
  }

  /** @param {string} method @param {any} args */
  async function act(method, args = {}) {
    try {
      const result = await call(method, { by: me, ...args });
      if (result && typeof result.revision === "number") awaitRevision = Math.max(awaitRevision, result.revision);
      return result;
    } catch (e) {
      toast(message(e));
      throw e;
    }
  }

  // --- Derived state -------------------------------------------------------------------------

  const optionIds = () => (view ? view.options.map((o) => /** @type {any} */ (o).id) : []);
  const locked = () => !view || view.phase !== "open" || !!view.mine?.ready;

  /** Keeps `order` to current options, appending any it lacks. @param {string[]} order */
  function reconcile(order) {
    const ids = optionIds();
    const set = new Set(ids);
    const out = order.filter((id) => set.has(id));
    const have = new Set(out);
    for (const id of ids) if (!have.has(id)) out.push(id);
    return out;
  }

  function currentOrder() {
    if (!view) return [];
    if (localOrder && !locked() && (pendingSaves > 0 || view.revision < awaitRevision)) return reconcile(localOrder);
    localOrder = null;
    return reconcile(view.mine?.ranking ?? view.suggested ?? []);
  }

  // --- Sections ------------------------------------------------------------------------------

  /** @type {Set<keyof typeof sections>} */
  const stale = new Set();

  /** @param {keyof typeof sections} name @param {() => (Node|string|null|false)[]} build */
  function paint(name, build) {
    const el = sections[name];
    const active = document.activeElement;
    const typing = active && el.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
    if (typing || (name === "ranking" && dragging) || (name === "header" && editingQuestion)) { stale.add(name); return; }
    stale.delete(name);
    const key = active instanceof HTMLElement && el.contains(active) ? active.dataset.key : undefined;
    el.replaceChildren(...build().filter((c) => c !== null && c !== false).map((c) => /** @type {Node|string} */ (c)));
    if (key) /** @type {HTMLElement|null} */ (el.querySelector(`[data-key="${CSS.escape(key)}"]`))?.focus();
  }

  root.addEventListener("focusout", () => {
    setTimeout(() => { if (stale.size && view) render(); }, 0);
  });

  function render() {
    paint("header", header);
    paint("notices", notices);
    paint("results", results);
    paint("add", addOption);
    paint("ranking", ranking);
    paint("ready", readiness);
    paint("fields", fields);
    paint("activity", activity);
  }

  function header() {
    if (!view) return [h("h1", { text: "Loading…" })];
    const v = view;
    const title = h("h1", {}, [h("button", {
      class: "question-btn", type: "button", text: v.question, title: "Edit the question", dataset: { key: "question" },
      onclick: () => editQuestion(title),
    })]);
    const ready = v.voters.filter((x) => x.ready).length;
    const chip = v.phase === "closed"
      ? h("span", { class: "chip win", text: "Results revealed" })
      : h("span", { class: `chip ${ready ? "ok" : ""}`, text: `Voting open · ${ready} of ${v.voters.length} ready` });
    const conn = connection === "live" ? null : h("span", { class: "chip warn", text: connection === "lost" ? "Offline" : "Connecting…" });
    return [title, chip, conn];
  }

  /** @param {HTMLElement} title */
  function editQuestion(title) {
    if (!view) return;
    editingQuestion = true;
    const input = /** @type {HTMLInputElement} */ (h("input", { class: "question-input", value: view.question, maxlength: 200, "aria-label": "Question" }));
    let done = false;
    const finish = async (/** @type {boolean} */ save) => {
      if (done) return;
      done = true;
      editingQuestion = false;
      const q = input.value.trim();
      if (save && view && q && q !== view.question) await act("setQuestion", { question: q }).catch(() => {});
      render();
      /** @type {HTMLElement|null} */ (sections.header.querySelector(".question-btn"))?.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    title.replaceChildren(input);
    input.focus();
    input.select();
  }

  function notices() {
    const out = [];
    if (connection === "lost") {
      out.push(h("div", { class: "banner error" }, [
        h("span", { class: "grow", text: "The connection to this vote was lost. Your saved order is safe on the server." }),
        h("button", { class: "btn", type: "button", text: "Reconnect", onclick: onRetry }),
      ]));
    }
    const unseen = view?.phase === "open" ? view?.mine?.unseen.length ?? 0 : 0;
    if (unseen) {
      out.push(h("div", { class: "banner warn", role: "note" }, [
        `${unseen === 1 ? "A new option was" : `${unseen} new options were`} added at the bottom of your list. Drag ${unseen === 1 ? "it" : "them"} into place, or click Keep my order.`,
      ]));
    }
    return out;
  }

  function results() {
    if (!view || !view.results.length) return [];
    const [latest, ...past] = view.results;
    const card = resultCard(/** @type {any} */ (latest), view.phase === "closed");
    if (past.length) {
      card.append(h("details", { class: "past" }, [
        h("summary", { text: `Earlier counts (${past.length})` }),
        ...past.map((r) => resultCard(/** @type {any} */ (r), false, true)),
      ]));
    }
    return [card];
  }

  /**
   * @param {any} r a stored count
   * @param {boolean} current the vote is closed on this count
   * @param {boolean} [nested]
   */
  function resultCard(r, current, nested = false) {
    const name = (/** @type {string} */ id) => r.options[id] ?? "(withdrawn)";
    const lastRound = r.rounds.length;
    /** @type {Record<string, number>} round index in which each option went out */
    const outAt = {};
    r.rounds.forEach((/** @type {any} */ round, /** @type {number} */ i) => { for (const id of round.eliminated) outAt[id] = i; });
    const ids = Object.keys(r.rounds[0]?.counts ?? {});
    const finalCounts = (/** @type {string} */ id) => {
      const i = outAt[id] ?? lastRound - 1;
      return r.rounds[i].counts[id] ?? 0;
    };
    ids.sort((a, b) => (a === r.winner ? -1 : b === r.winner ? 1 : (outAt[b] ?? lastRound) - (outAt[a] ?? lastRound) || finalCounts(b) - finalCounts(a)));
    const table = h("table", { class: "rounds" }, [
      h("thead", {}, [h("tr", {}, [h("th", { scope: "col", text: "Option" }), ...r.rounds.map((/** @type {any} */ _, /** @type {number} */ i) => h("th", { scope: "col", text: `Round ${i + 1}` }))])]),
      h("tbody", {}, ids.map((id) => h("tr", { class: id === r.winner ? "won" : "" }, [
        h("th", { scope: "row", text: `${id === r.winner ? "🏆 " : ""}${name(id)}` }),
        ...r.rounds.map((/** @type {any} */ round, /** @type {number} */ i) => {
          if (!(id in round.counts)) return h("td", { class: "gone", text: "–" });
          const n = round.counts[id];
          const out = round.eliminated.includes(id);
          const pct = r.ballots ? Math.round((n / r.ballots) * 100) : 0;
          return h("td", { class: `n ${out ? "out" : ""}`, title: out ? "Eliminated this round" : "" }, [
            h("div", { class: "bar", style: `width:${pct}%` }),
            h("span", { text: out ? `${n} ✕` : String(n) }),
          ]);
        }),
      ]))),
    ]);
    const story = h("ol", { class: "narrative" }, r.rounds.map((/** @type {any} */ round, /** @type {number} */ i) => {
      const active = Object.values(round.counts).reduce((/** @type {number} */ a, /** @type {any} */ b) => a + b, 0);
      if (!round.eliminated.length) {
        return h("li", { text: r.winner ? `${name(r.winner)} has ${round.counts[r.winner]} of ${active} votes and wins.` : "No winner." });
      }
      const outNames = round.eliminated.map(name).join(", ");
      const moves = Object.entries(round.transfers).map(([id, n]) => `${name(id)} +${n}`);
      if (round.transferredToExhausted) moves.push(`${round.transferredToExhausted} with no choices left`);
      const tie = round.tieBreak === "lot" ? " (a tie, settled by drawing lots)" : round.tieBreak === "earlier-round" ? " (a tie, settled by an earlier round)" : "";
      const n = round.eliminated.reduce((/** @type {number} */ a, /** @type {string} */ id) => a + round.counts[id], 0);
      return h("li", { text: `No majority of ${active}. ${outNames} ${round.eliminated.length > 1 ? "are" : "is"} out${tie}.${n ? ` ${n === 1 ? "1 vote moves" : `${n} votes move`} on: ${moves.join(", ")}.` : ""}` });
    }));
    const children = [
      nested ? h("h3", { text: `Count ${r.n} · ${when(r.at)}` }) : h("h2", { text: current ? "Results" : `Last count (${when(r.at)}) · voting has reopened` }),
      h("div", { class: "winner" }, [h("span", { class: "trophy", "aria-hidden": "true", text: "🏆" }), h("div", {}, [
        h("div", { class: "name", text: r.winner ? name(r.winner) : "No winner" }),
        h("div", { class: "muted small", text: `${r.ballots} ballot${r.ballots === 1 ? "" : "s"}: ${r.voters.join(", ")}. Ballots stay private.` }),
      ])]),
      h("div", { class: "table-wrap" }, [table]),
      story,
    ];
    if (current && !nested) {
      children.push(h("div", { class: "row", style: "margin-top:12px" }, [
        h("span", { class: "grow muted small", text: "Reopen to propose more options or change your order. Everyone clicks Reveal again for a new count." }),
        h("button", { class: "btn", type: "button", text: "Reopen voting", dataset: { key: "reopen" }, onclick: () => act("reopen").catch(() => {}) }),
      ]));
    }
    return h("div", { class: nested ? "" : "card results" }, children);
  }

  function addOption() {
    if (!view) return [];
    if (view.phase !== "open") return [h("div", { class: "muted", text: "Voting is closed. Reopen it to propose more options." })];
    const input = /** @type {HTMLInputElement} */ (h("input", { class: "text grow", placeholder: "Propose an option", maxlength: view.limits.title, "aria-label": "New option" }));
    const desc = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "text", placeholder: "Description (optional)", rows: 2, maxlength: view.limits.value, "aria-label": "Description of the new option" }));
    const submit = async () => {
      const title = input.value.trim();
      if (!title) { input.focus(); return; }
      try {
        const r = await act("addOption", { title, values: desc.value.trim() ? { description: desc.value } : {} });
        input.value = ""; desc.value = "";
        announce(`Added ${r.option.title}. It is at the bottom of everyone's list.`);
        input.focus();
      } catch { /* toast shown */ }
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    desc.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
    return [
      h("div", { class: "row" }, [input, h("button", { class: "btn primary", type: "button", text: "Add", onclick: submit })]),
      desc,
      h("div", { class: "muted small", text: "Adding an option puts it at the bottom of everyone's list and resets any Reveals, so nobody is counted before they have seen it." }),
    ];
  }

  function ranking() {
    if (!view) return [];
    const v = view;
    const order = currentOrder();
    const byId = new Map(v.options.map((o) => [/** @type {any} */ (o).id, /** @type {any} */ (o)]));
    const unseen = new Set(v.phase === "open" ? v.mine?.unseen ?? [] : []);
    const isLocked = locked();
    const list = h("ol", { class: `ranking ${isLocked ? "locked" : ""}`, "aria-label": "Your ranking, most preferred first" },
      order.map((id, i) => optionItem(byId.get(id), i, order.length, unseen.has(id), isLocked)));
    let hint;
    if (v.phase !== "open") hint = "Your order at the count. Nobody else can see it.";
    else if (v.mine?.ready) hint = "Locked while you are ready. Undo Reveal to change it.";
    else if (!v.mine) hint = "Shuffled for you. Drag to rank, most preferred at the top; your first move saves your ballot.";
    else hint = "Drag to rank, most preferred at the top. Only you can see your order.";
    const head = h("div", { class: "list-head" }, [
      h("h2", { text: `Your ranking (${order.length})` }),
      h("span", { class: "muted small", text: hint }),
    ]);
    if (!order.length) return [head, h("div", { class: "card muted", text: "No options yet. Propose the first one above." })];
    return [head, list];
  }

  /**
   * @param {any} o @param {number} i @param {number} total @param {boolean} isNew @param {boolean} isLocked
   */
  function optionItem(o, i, total, isNew, isLocked) {
    const v = /** @type {View} */ (view);
    const open = expanded.has(o.id);
    const li = h("li", { class: `opt ${isNew ? "is-new" : ""}`, dataset: { id: o.id } });
    const handle = h("button", {
      class: "handle", type: "button", disabled: isLocked, dataset: { key: `h:${o.id}` },
      "aria-label": `Move ${o.title}, position ${i + 1} of ${total}. Use the arrow keys.`,
      title: isLocked ? "Locked" : "Drag, or use the arrow keys",
    }, [GRIP()]);
    handle.addEventListener("pointerdown", (e) => startDrag(e, li, handle));
    handle.addEventListener("keydown", (e) => {
      const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? total - 1 : null;
      if (to === null || isLocked) return;
      e.preventDefault();
      moveTo(o.id, to);
    });
    const facts = v.fields.filter((f) => f.id !== "description" && o.values[f.id])
      .map((f) => h("span", { class: "fact" }, [h("b", { text: `${f.label}: ` }), h("span", { text: o.values[f.id] })]));
    const body = h("div", { class: "opt-body" }, [
      h("div", { class: "opt-line" }, [
        h("button", {
          class: "opt-title", type: "button", text: o.title, "aria-expanded": String(open), dataset: { key: `t:${o.id}` },
          title: open ? "Hide details" : "Show and edit details",
          onclick: () => { if (open) expanded.delete(o.id); else expanded.add(o.id); render(); },
        }),
        isNew ? h("span", { class: "badge", text: "New" }) : null,
        h("span", { class: "by", text: `proposed by ${o.by.id === me.id ? "you" : o.by.name}` }),
      ]),
      (o.values.description || facts.length) && !open ? h("div", { class: "summary" }, [
        o.values.description ? h("div", { class: "desc", text: o.values.description }) : null,
        facts.length ? h("div", { class: "facts" }, facts) : null,
      ]) : null,
      open ? details(o) : null,
    ]);
    const moves = h("div", { class: "moves" }, [
      h("button", { class: "btn icon", type: "button", text: "▲", disabled: isLocked || i === 0, "aria-label": `Move ${o.title} up`, dataset: { key: `u:${o.id}` }, onclick: () => moveTo(o.id, i - 1) }),
      h("button", { class: "btn icon", type: "button", text: "▼", disabled: isLocked || i === total - 1, "aria-label": `Move ${o.title} down`, dataset: { key: `d:${o.id}` }, onclick: () => moveTo(o.id, i + 1) }),
    ]);
    li.append(handle, h("span", { class: "rank", text: String(i + 1) }), body, moves);
    return li;
  }

  /** @param {any} o */
  function details(o) {
    const v = /** @type {View} */ (view);
    const open = v.phase === "open";
    const mine = o.by.id === me.id;
    const box = h("div", { class: "details" });
    if (mine && open) {
      const t = /** @type {HTMLInputElement} */ (h("input", { class: "text", value: o.title, maxlength: v.limits.title }));
      t.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); t.blur(); } });
      t.addEventListener("change", () => {
        if (t.value.trim() && t.value.trim() !== o.title) act("updateOption", { optionId: o.id, title: t.value }).catch(() => { t.value = o.title; });
      });
      box.append(h("label", {}, ["Name (renaming resets everyone's Reveal)", t]));
    }
    for (const f of v.fields) {
      const value = o.values[f.id] ?? "";
      const saved = h("span", { class: "saved", "aria-live": "polite" });
      const input = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (f.kind === "long"
        ? h("textarea", { class: "text", rows: 3, maxlength: v.limits.value, disabled: !open })
        : h("input", { class: "text", type: f.kind === "url" ? "url" : "text", maxlength: v.limits.value, disabled: !open, placeholder: f.kind === "url" ? "example.co.uk" : "" }));
      input.value = value;
      if (f.kind !== "long") input.addEventListener("keydown", (e) => { if (/** @type {KeyboardEvent} */ (e).key === "Enter") { e.preventDefault(); /** @type {HTMLElement} */ (input).blur(); } });
      input.addEventListener("change", async () => {
        try {
          await act("updateOption", { optionId: o.id, values: { [f.id]: input.value } });
          saved.textContent = "Saved";
          setTimeout(() => { saved.textContent = ""; }, 2000);
        } catch { input.value = value; }
      });
      box.append(h("label", {}, [h("span", {}, [f.label, " ", saved]), input]));
    }
    const edited = o.editedBy ? ` · last edited by ${o.editedBy.name} ${when(o.editedAt)}` : "";
    box.append(h("div", { class: "muted small", text: `Proposed by ${o.by.name} ${when(o.at)}${edited}. Anyone can fill in the fields.` }));
    if (mine && open) {
      box.append(h("div", { class: "actions" }, [twoStep("Withdraw this option", "Click again to withdraw", `w:${o.id}`, () => act("withdrawOption", { optionId: o.id }).catch(() => {}))]));
    }
    return box;
  }

  function readiness() {
    if (!view) return [];
    const v = view;
    const out = [h("h2", { text: "Reveal" })];
    const waiting = v.voters.filter((x) => !x.ready);
    if (v.phase === "closed") {
      out.push(h("p", { class: "muted small", text: "Everyone clicked Reveal and the count ran. Reopen voting from the results to vote again." }));
    } else if (v.mine?.ready) {
      out.push(h("button", { class: "btn big", type: "button", text: "Undo Reveal", dataset: { key: "reveal" }, onclick: () => act("setReady", { ready: false }).catch(() => {}) }));
      const more = Math.max(0, v.minVoters - v.voters.length);
      const parts = [waiting.length ? `on ${waiting.map((x) => x.name).join(", ")}` : "", more ? `for ${more} more voter${more === 1 ? "" : "s"}` : ""].filter(Boolean);
      out.push(h("p", { class: "small", text: parts.length ? `You're ready. Waiting ${parts.join(" and ")}.` : "You're ready." }));
    } else {
      const few = v.options.length < 2;
      out.push(h("button", {
        class: "btn big primary", type: "button", text: "Reveal", disabled: few, dataset: { key: "reveal" },
        onclick: () => act("setReady", { ready: true, ranking: currentOrder() }).then(() => announce("You're ready. Your order is locked.")).catch(() => {}),
      }));
      out.push(h("p", { class: "muted small", text: few
        ? "Needs at least two options."
        : "Locks in your current order. When everyone who has ranked has clicked Reveal, the count runs and the results show." }));
      if (v.mine && v.mine.unseen.length) {
        out.push(h("button", { class: "btn", type: "button", text: "Keep my order", dataset: { key: "keep" }, onclick: () => saveOrder(currentOrder()) }));
      }
    }
    if (v.phase === "open") {
      const min = /** @type {HTMLInputElement} */ (h("input", { class: "text", type: "number", min: 1, max: v.limits.voters, value: String(v.minVoters), style: "width:70px", "aria-label": "Minimum number of voters" }));
      min.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); min.blur(); } });
      min.addEventListener("change", () => act("setMinVoters", { minVoters: Number(min.value) }).catch(() => { min.value = String(v.minVoters); }));
      const short = Math.max(0, v.minVoters - v.voters.length);
      out.push(h("div", { class: "row small", style: "margin-top:8px" }, [
        h("label", { class: "grow", text: "The count waits for at least", for: "min-voters" }), min, h("span", { text: "voters" }),
      ]));
      min.id = "min-voters";
      if (short) out.push(h("p", { class: "small", style: "color:var(--warn)", text: `Needs ${short} more voter${short === 1 ? "" : "s"} before the count can run. Set this to the size of your group.` }));
    }
    out.push(h("h2", { text: `Voters (${v.voters.length})`, style: "margin-top:14px" }));
    if (!v.voters.length) out.push(h("p", { class: "muted small", text: "Nobody has ranked yet. You join by moving an option or clicking Reveal." }));
    out.push(h("ul", { class: "voters" }, v.voters.map((x) => h("li", {}, [
      h("span", { class: `dot ${x.ready ? "ready" : ""}`, "aria-hidden": "true" }),
      h("span", { class: "name", text: `${x.name}${x.id === me.id ? " (you)" : ""}` }),
      h("span", { class: "muted small", text: x.ready ? "Ready" : "Ranking" }),
      v.phase === "open" && (x.id === me.id || !x.ready)
        ? twoStep(x.id === me.id ? "Leave" : "Remove", "Confirm", `rm:${x.id}`, () => act("removeBallot", { voterId: x.id }).catch(() => {}), "btn link danger small")
        : null,
    ]))));
    if (v.phase === "open" && v.voters.some((x) => !x.ready && x.id !== me.id)) {
      out.push(h("p", { class: "muted small", text: "Remove someone who is away so they don't hold up the reveal. Their ballot is deleted, and it's logged." }));
    }
    return out;
  }

  function fields() {
    if (!view) return [];
    const v = view;
    const kinds = { text: "Short text", long: "Long text", url: "Web address" };
    const label = /** @type {HTMLInputElement} */ (h("input", { class: "text grow", placeholder: "e.g. Companies House check", maxlength: v.limits.fieldLabel, "aria-label": "New field name" }));
    const kind = /** @type {HTMLSelectElement} */ (h("select", { class: "text", "aria-label": "New field type", style: "width:auto" },
      Object.entries(kinds).map(([k, t]) => h("option", { value: k, text: t }))));
    const add = async () => {
      if (!label.value.trim()) { label.focus(); return; }
      try { await act("addField", { label: label.value, kind: kind.value }); label.value = ""; kind.value = "text"; label.focus(); } catch { /* toast */ }
    };
    label.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    return [
      h("h2", { text: "Fields" }),
      h("p", { class: "muted small", text: "Every option has these. Open an option to fill them in." }),
      h("ul", { class: "fields-list" }, v.fields.map((f) => h("li", {}, [
        h("span", { class: "grow", text: f.label }),
        h("span", { class: "kind", text: kinds[f.kind] }),
        f.id === "description" ? null : twoStep("Remove", "Confirm", `rf:${f.id}`, () => act("removeField", { fieldId: f.id }).catch(() => {}), "btn link danger small"),
      ]))),
      v.fields.length < v.limits.fields ? h("div", { class: "row" }, [label, kind, h("button", { class: "btn", type: "button", text: "Add", onclick: add })]) : null,
    ];
  }

  function activity() {
    if (!view) return [];
    return [
      h("h2", { text: "Activity" }),
      view.activity.length
        ? h("ol", { class: "activity" }, view.activity.map((a) => h("li", {}, [h("time", { text: when(a.at) }), `${a.by} ${a.text}`])))
        : h("p", { class: "muted small", text: "Nothing yet." }),
    ];
  }

  // --- Ordering ------------------------------------------------------------------------------

  /** @param {string[]} order */
  async function saveOrder(order) {
    localOrder = order;
    pendingSaves++;
    render();
    try {
      await act("saveRanking", { ranking: order });
    } catch {
      localOrder = null;
    } finally {
      pendingSaves--;
      render();
    }
  }

  /** @param {string} id @param {number} to */
  function moveTo(id, to) {
    const order = currentOrder();
    const from = order.indexOf(id);
    if (from < 0 || to < 0 || to >= order.length || to === from) return;
    order.splice(from, 1);
    order.splice(to, 0, id);
    const title = view?.options.find((o) => /** @type {any} */ (o).id === id)?.title ?? "";
    saveOrder(order);
    announce(`${title} moved to position ${to + 1} of ${order.length}.`);
  }

  /**
   * Pointer drag: the item follows the pointer and swaps with a neighbour once the pointer passes
   * the neighbour's midpoint. Works for mouse, pen and touch (the handle has touch-action: none).
   * @param {PointerEvent} e @param {HTMLElement} li @param {HTMLElement} handle
   */
  function startDrag(e, li, handle) {
    if (e.button !== 0 || locked()) return;
    e.preventDefault();
    const list = /** @type {HTMLElement} */ (li.parentElement);
    const before = [...list.children].map((c) => /** @type {HTMLElement} */ (c).dataset.id);
    const grab = e.clientY - li.getBoundingClientRect().top;
    let lastY = e.clientY;
    let moved = false;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    li.classList.add("dragging");
    /** @type {any} */
    let scroller = null;

    const place = () => {
      li.style.transform = "";
      let prev = /** @type {HTMLElement|null} */ (li.previousElementSibling);
      // Neighbours move around the dragged item; moving the item itself would detach the handle
      // and drop its pointer capture.
      while (prev && lastY < prev.getBoundingClientRect().top + prev.offsetHeight / 2) {
        list.insertBefore(prev, li.nextElementSibling);
        prev = /** @type {HTMLElement|null} */ (li.previousElementSibling);
      }
      let next = /** @type {HTMLElement|null} */ (li.nextElementSibling);
      while (next && lastY > next.getBoundingClientRect().top + next.offsetHeight / 2) {
        list.insertBefore(next, li);
        next = /** @type {HTMLElement|null} */ (li.nextElementSibling);
      }
      li.style.transform = `translateY(${lastY - grab - li.getBoundingClientRect().top}px)`;
      [...list.children].forEach((c, i) => { const r = c.querySelector(".rank"); if (r) r.textContent = String(i + 1); });
    };
    const autoscroll = () => {
      const edge = 60;
      const dy = lastY < edge ? -12 : lastY > window.innerHeight - edge ? 12 : 0;
      if (dy) { window.scrollBy(0, dy); place(); }
      scroller = dy ? requestAnimationFrame(autoscroll) : null;
    };
    /** @param {PointerEvent} ev */
    const move = (ev) => {
      lastY = ev.clientY;
      if (Math.abs(ev.clientY - e.clientY) > 3) moved = true;
      place();
      if (!scroller) scroller = requestAnimationFrame(autoscroll);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (scroller) cancelAnimationFrame(scroller);
      li.classList.remove("dragging");
      li.style.transform = "";
      dragging = false;
      const after = [...list.children].map((c) => /** @type {string} */ (/** @type {HTMLElement} */ (c).dataset.id));
      if (moved && after.join() !== before.join()) {
        const title = view?.options.find((o) => /** @type {any} */ (o).id === li.dataset.id)?.title ?? "";
        announce(`${title} moved to position ${after.indexOf(/** @type {string} */ (li.dataset.id)) + 1}.`);
        saveOrder(after);
      } else {
        render();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  render();

  return {
    /** @param {View} next */
    setView(next) {
      if (view && next.revision < view.revision) return;
      const wasClosed = view?.phase === "closed";
      view = next;
      if (!wasClosed && next.phase === "closed" && next.results[0]) {
        const r = /** @type {any} */ (next.results[0]);
        announce(`Everyone is ready. The winner is ${r.winner ? r.options[r.winner] : "nobody"}.`);
      }
      render();
    },
    /** @param {"connecting"|"live"|"lost"} state */
    setConnection(state) {
      if (state === connection) return;
      connection = state;
      render();
    },
    get awaitRevision() { return awaitRevision; },
    get view() { return view; },
  };
}
