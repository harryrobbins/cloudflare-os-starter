import { useEffect, useState } from "react";

/** Subscribes to a media query. Used for the narrow, single-column layout. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (): void => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** The plan's "narrow widths: one column at a time with a back button". */
export const NARROW_QUERY = "(max-width: 899px)";
