// @ts-check
// A small, safe Markdown renderer: builds DOM nodes with textContent only, so no HTML in a
// description can ever become markup. Supports paragraphs, headings, lists (incl. task boxes),
// block quotes, fenced code, rules, and inline code, bold, italic, strikethrough and links
// (http, https and mailto only; opened in a new tab as the gadget frame requires).

/**
 * @param {Document} doc @param {string} source @returns {DocumentFragment}
 */
export function renderMarkdown(doc, source) {
  const frag = doc.createDocumentFragment();
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const el = (/** @type {string} */ tag, /** @type {string} */ cls = "") => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  let i = 0;
  /** @type {string[]} */ let para = [];
  const flush = () => {
    if (!para.length) return;
    const p = el("p");
    inline(doc, p, para.join(" "));
    frag.append(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      const pre = el("pre"), code = el("code");
      code.textContent = body.join("\n");
      pre.append(code);
      frag.append(pre);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      // Descriptions sit under the item's own heading: start at h3 and never go past h6.
      const h = el(`h${Math.min(6, heading[1].length + 2)}`);
      inline(doc, h, heading[2]);
      frag.append(h);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); frag.append(el("hr")); i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      const bq = el("blockquote");
      bq.append(renderMarkdown(doc, quote.join("\n")));
      frag.append(bq);
      continue;
    }
    const bullet = /^\s*([-*+]|\d{1,9}[.)])\s+/.exec(line);
    if (bullet) {
      flush();
      const ordered = /\d/.test(bullet[1]);
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        const li = el("li");
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(m[2]);
        if (task) {
          const box = el("span", `md-task${task[1] === " " ? "" : " done"}`);
          box.setAttribute("role", "img");
          box.setAttribute("aria-label", task[1] === " " ? "Not done:" : "Done:");
          box.textContent = task[1] === " " ? "☐" : "☑";
          li.append(box, " ");
          inline(doc, li, task[2]);
        } else inline(doc, li, m[2]);
        list.append(li);
        i++;
      }
      frag.append(list);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return frag;
}

const INLINE = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/**
 * @param {Document} doc @param {HTMLElement} parent @param {string} text
 */
export function inline(doc, parent, text) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = /** @type {number} */ (m.index);
    if (at > last) parent.append(text.slice(last, at));
    last = at + m[0].length;
    if (m[1]) { const c = doc.createElement("code"); c.textContent = m[2]; parent.append(c); }
    else if (m[3] || m[4]) { const b = doc.createElement("strong"); inline(doc, b, m[3] ?? m[4]); parent.append(b); }
    else if (m[5]) { const d = doc.createElement("del"); inline(doc, d, m[5]); parent.append(d); }
    else if (m[6] || m[7]) { const e = doc.createElement("em"); inline(doc, e, m[6] ?? m[7]); parent.append(e); }
    else if (m[8]) parent.append(link(doc, m[9], m[8]));
    else if (m[10]) parent.append(link(doc, m[10], m[10]));
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** @param {Document} doc @param {string} href @param {string} label */
function link(doc, href, label) {
  if (!/^(https?:|mailto:)/i.test(href)) return doc.createTextNode(label);
  const a = doc.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label;
  return a;
}

/** Plain text of Markdown (for card snippets and accessible names). @param {string} source */
export function plainText(source) {
  return String(source ?? "").replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`~[\]]|\(https?:[^)]*\)/g, "").replace(/\s+/g, " ").trim();
}
