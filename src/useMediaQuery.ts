import { useEffect, useState } from "react";

/**
 * Tabs and the split view are a large-screen feature, and whether they're on
 * has to be known in JavaScript, not just in CSS: hiding a second pane with
 * `display: none` would still mount a second Crepe instance over a second
 * file, doing real work behind a blank screen.
 *
 * Kept in step by hand with the `max-width: 768px` blocks in index.css.
 */
export const WIDE_SCREEN = "(min-width: 769px)";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);

  return matches;
}
