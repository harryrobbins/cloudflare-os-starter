// The one runtime answer to "may this move?".
//
// The stylesheet already disables every named animation under `prefers-reduced-motion: reduce`, but
// three things are not CSS animations and so cannot be covered there: `scrollIntoView`/`scrollTo`
// with `behavior: "smooth"`, and the components that decide whether to mount an entrance animation at
// all. Those ask here, so there is one media query in the app rather than one per caller.

const QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    // jsdom and older engines: assume motion is fine rather than disabling it everywhere.
    return false;
  }
}

/** `smooth`, unless the reader asked for less movement. */
export function smoothScroll(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
