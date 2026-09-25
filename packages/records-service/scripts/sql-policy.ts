/** Module SQL is privileged reviewed code. This only protects installer transaction ownership. */
export function assertTransactionalSql(source: string): void {
  let visible = ''; let i = 0;
  while (i < source.length) {
    if (source.startsWith('--', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; visible += ' '; continue; }
    if (source.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('Unclosed SQL comment'); visible += ' '; continue;
    }
    const delimiter = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(source.slice(i))?.[0];
    if (delimiter) {
      const end = source.indexOf(delimiter, i + delimiter.length);
      if (end < 0) throw new Error('Unclosed SQL function body');
      i = end + delimiter.length; visible += ' body '; continue;
    }
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i++]; let closed = false;
      while (i < source.length) {
        if (source[i] === quote) {
          i++; if (source[i] === quote) { i++; continue; } closed = true; break;
        }
        // Escaped literals are accepted only for reviewed SQL; hiding top-level text is not possible.
        if (source[i] === '\\') i++;
        i++;
      }
      if (!closed) throw new Error('Unclosed SQL literal'); visible += ' literal '; continue;
    }
    visible += source[i++];
  }
  if (visible.split(';').some(statement => /^\s*(begin|commit|rollback|end|abort|start\s+transaction|prepare\s+transaction)\b/i.test(statement))) {
    throw new Error('Module migrations cannot control the installer transaction');
  }
}
