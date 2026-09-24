// Where a hit's url goes. Origin-relative paths stay inside this deployment, in the same tab; an
// absolute http(s) URL opens in a new tab with `noopener`. Anything else (`javascript:`, `data:`,
// protocol-relative `//host`) is not a link at all.

export interface LinkTarget {
  href: string;
  external: boolean;
}

export function linkTarget(url: string | null | undefined): LinkTarget | null {
  if (url === null || url === undefined) return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//") && !trimmed.startsWith("/\\")) {
    return { href: trimmed, external: false };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return { href: parsed.href, external: true };
  } catch {
    return null;
  }
}

/** Follows a link the way a click on it would. */
export function openLink(target: LinkTarget): void {
  if (target.external) window.open(target.href, "_blank", "noopener,noreferrer");
  else window.location.assign(target.href);
}
