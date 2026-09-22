/**
 * How wide the file tree is, and where that survives a reload: localStorage.
 *
 * Not OPFS, for the same reason the sync token isn't (see syncConfig.ts) —
 * OPFS is the document store and gets pushed to GitHub, and how wide a pane
 * is on this screen is not a document. It's per-device by nature: the same
 * notes opened on a laptop and a large monitor want different widths, and
 * localStorage is already the per-device store here.
 */

const WIDTH_KEY = "webfs:sidebar:width";

export const DEFAULT_SIDEBAR_WIDTH = 260;

/** Narrower than this and the tree shows a few characters of a name. */
export const MIN_SIDEBAR_WIDTH = 160;

/** Wider than this is a file tree pretending to be a document. */
export const MAX_SIDEBAR_WIDTH = 600;

/**
 * Whatever is left over has to still be an editor, so the ceiling follows the
 * window as well: a width saved on a wide monitor must not swallow the
 * document when the same store is opened in a narrow one.
 */
export const MIN_CONTENT_WIDTH = 320;

export function clampSidebarWidth(width: number, viewportWidth = Infinity): number {
  const wanted = Number.isFinite(width) ? width : DEFAULT_SIDEBAR_WIDTH;
  const ceiling = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, viewportWidth - MIN_CONTENT_WIDTH));
  return Math.round(Math.min(Math.max(wanted, MIN_SIDEBAR_WIDTH), ceiling));
}

/** Private browsing and blocked-cookie settings make localStorage throw. */
export function loadSidebarWidth(viewportWidth = Infinity): number {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(WIDTH_KEY);
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  if (raw === null) return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, viewportWidth);
  // Clamped on the way in as well as on the way out: the stored number was
  // valid on the screen that wrote it, which isn't necessarily this one.
  return clampSidebarWidth(Number(raw), viewportWidth);
}

export function saveSidebarWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* nothing to do: the width just won't persist across reloads */
  }
}
