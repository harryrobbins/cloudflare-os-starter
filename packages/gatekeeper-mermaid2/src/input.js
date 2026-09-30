// Accept code fences copied along with a diagram. Mermaid frontmatter and
// initialization directives configure Mermaid's renderer rather than D2's.
export function prepareInput(source, language) {
  let body = source.replace(/^\uFEFF/, '').trim();
  const fenced = body.match(/^```(?:mermaid|d2)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) body = fenced[1].trim();
  if (language === 'mermaid') {
    if (body.startsWith('---')) {
      const frontmatter = body.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
      if (!frontmatter) throw new Error('Mermaid frontmatter is missing its closing --- delimiter.');
      body = body.slice(frontmatter[0].length).trim();
    }
    body = body.replace(/%%\{[\s\S]*?\}%%/g, '').trim();
  }
  return body;
}

export function preserveFlowDirection(source, converted) {
  // mermaid2d2 omits TD/TB because down is D2's usual default. TALA may freely
  // place nodes without an explicit direction, so retain the author's constraint.
  const header = source.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith('%%')) ?? '';
  return /^\s*(?:flowchart|graph)\s+(?:TD|TB)\b/.test(header) ? `direction: down\n${converted}` : converted;
}
