// Snippet sanitizer.
//
// The server promises escaped text with `<mark>` as the only markup. The app still does not trust
// that: the snippet is parsed into an inert document (DOMParser never runs scripts or loads
// resources), walked, and rebuilt as plain segments. Only the text survives, plus a flag for whether
// it sat inside a `<mark>`. React then renders the segments as text nodes, so no server string ever
// reaches `innerHTML`.

export interface SnippetSegment {
  text: string;
  mark: boolean;
}

/** Elements whose text content is never shown (it is code or metadata, not prose). */
const DROPPED = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "OBJECT", "SVG", "MATH", "HEAD", "TITLE"]);

export function sanitizeSnippet(html: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  const push = (text: string, mark: boolean): void => {
    if (text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.mark === mark) last.text += text;
    else segments.push({ text, mark });
  };

  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  const walk = (node: Node, inMark: boolean): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        push(child.textContent ?? "", inMark);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = (child as Element).tagName.toUpperCase();
        if (DROPPED.has(tag)) continue;
        // `<br>` is the one element whose meaning is whitespace.
        if (tag === "BR") {
          push(" ", inMark);
          continue;
        }
        walk(child, inMark || tag === "MARK");
      }
      // Comments, processing instructions and the rest are dropped.
    }
  };
  walk(doc.body, false);
  return segments;
}
