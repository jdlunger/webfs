/**
 * Which files are open, in which pane, and which one each pane shows.
 *
 * Pure, like `fs.ts`: this holds no DOM and touches no storage, so the rules
 * that are easy to get subtly wrong — what closing a tab activates next, where
 * a rename moves an open file to, what a split does with the file you were
 * looking at — are testable without a browser (`panes.test.ts`).
 *
 * Two invariants the rest of the app leans on:
 *
 * - **A file is open in at most one pane.** Two Crepe instances over one file
 *   would each own an uncontrolled copy of the document, and neither hears the
 *   other's edits, so the second one to save would write its stale text over
 *   the first. Opening a file that's already open elsewhere therefore focuses
 *   it where it is instead of opening a second copy.
 * - **Panes never collapse on their own.** A pane emptied by closing its last
 *   tab stays, showing the same placeholder a freshly split one does; closing
 *   a pane is the ✕ in its tab strip and nothing else. The alternative —
 *   collapsing an empty pane — can't tell "you closed the last tab" from "you
 *   just split", and would swallow the new pane the instant it appeared.
 *
 * Every function returns the layout it was given when nothing changes, so
 * callers can feed the result straight back into `setState` without
 * re-rendering (and `pruneMissing`, which runs on every tree change, can't
 * drive a loop).
 */

export interface Pane {
  /** Open files, in tab order. Ids are `fs.ts` ids, i.e. paths. */
  tabs: string[];
  /** The tab this pane is showing; null only when `tabs` is empty. */
  activeId: string | null;
}

export interface PaneLayout {
  panes: Pane[];
  /** Index into `panes`: the pane the sidebar and the URL follow. */
  focused: number;
}

/** Side-by-side, not a tiling manager: one split is the whole feature. */
export const MAX_PANES = 2;

const EMPTY_PANE: Pane = { tabs: [], activeId: null };

export function singlePane(id: string | null): PaneLayout {
  return { panes: [id ? { tabs: [id], activeId: id } : EMPTY_PANE], focused: 0 };
}

/** The focused pane's file — what the sidebar highlights and the URL names. */
export function activeId(layout: PaneLayout): string | null {
  return layout.panes[layout.focused]?.activeId ?? null;
}

/** The file each pane is showing: exactly the ones whose text is needed. */
export function activeIds(layout: PaneLayout): string[] {
  return layout.panes.map(pane => pane.activeId).filter((id): id is string => id !== null);
}

/** Every open file, active or not — what the sidebar marks as open. */
export function openIds(layout: PaneLayout): string[] {
  return layout.panes.flatMap(pane => pane.tabs);
}

function paneHolding(layout: PaneLayout, id: string): number {
  return layout.panes.findIndex(pane => pane.tabs.includes(id));
}

function withPane(layout: PaneLayout, index: number, pane: Pane, focused = layout.focused): PaneLayout {
  return { panes: layout.panes.map((p, i) => (i === index ? pane : p)), focused };
}

export function focusPane(layout: PaneLayout, index: number): PaneLayout {
  if (index === layout.focused || !layout.panes[index]) return layout;
  return { ...layout, focused: index };
}

/**
 * Opens a file in the focused pane, or focuses it where it already is.
 *
 * `replace` is the narrow-screen mode: there's no tab strip to steer, so a
 * phone keeps showing one file at a time the way it always has.
 */
export function openFile(layout: PaneLayout, id: string, options: { replace?: boolean } = {}): PaneLayout {
  const existing = paneHolding(layout, id);
  if (existing !== -1) {
    const pane = layout.panes[existing]!;
    if (pane.activeId === id) return focusPane(layout, existing);
    return withPane(layout, existing, { ...pane, activeId: id }, existing);
  }

  const pane = layout.panes[layout.focused]!;
  const tabs = options.replace ? [id] : [...pane.tabs, id];
  return withPane(layout, layout.focused, { tabs, activeId: id });
}

/** Opens a file in the *other* pane, splitting first if there isn't one yet. */
export function openBeside(layout: PaneLayout, id: string): PaneLayout {
  if (layout.panes.length < MAX_PANES) {
    const split = splitPane(layout);
    return moveOrOpen(split, id, split.focused);
  }
  return moveOrOpen(layout, id, 1 - layout.focused);
}

/** Puts a file in a named pane, taking it out of the other one if it's there. */
function moveOrOpen(layout: PaneLayout, id: string, to: number): PaneLayout {
  const from = paneHolding(layout, id);
  if (from === to) {
    const pane = layout.panes[to]!;
    if (pane.activeId === id) return focusPane(layout, to);
    return withPane(layout, to, { ...pane, activeId: id }, to);
  }
  const detached = from === -1 ? layout : removeTab(layout, from, id);
  const target = detached.panes[to]!;
  return withPane(detached, to, { tabs: [...target.tabs, id], activeId: id }, to);
}

function removeTab(layout: PaneLayout, index: number, id: string): PaneLayout {
  const pane = layout.panes[index]!;
  const at = pane.tabs.indexOf(id);
  if (at === -1) return layout;
  const tabs = pane.tabs.filter(tab => tab !== id);
  // Closing the tab you're looking at lands on its neighbour — the one to the
  // right, or the left when it was last.
  const activeId = pane.activeId === id ? tabs[at] ?? tabs[at - 1] ?? null : pane.activeId;
  return withPane(layout, index, { tabs, activeId });
}

export function closeTab(layout: PaneLayout, index: number, id: string): PaneLayout {
  return removeTab(layout, index, id);
}

/** Adds a second, empty pane and focuses it: click a file to fill it. */
export function splitPane(layout: PaneLayout): PaneLayout {
  if (layout.panes.length >= MAX_PANES) return layout;
  return { panes: [...layout.panes, EMPTY_PANE], focused: layout.panes.length };
}

/** Closes a pane, keeping its tabs open in the one that remains. */
export function closePane(layout: PaneLayout, index: number): PaneLayout {
  if (layout.panes.length < 2 || !layout.panes[index]) return layout;
  const closing = layout.panes[index]!;
  const kept = layout.panes[1 - index]!;
  return {
    panes: [{ tabs: [...kept.tabs, ...closing.tabs], activeId: kept.activeId ?? closing.activeId }],
    focused: 0,
  };
}

/**
 * Follows open files through a rename or a move. An id *is* a path, so a
 * folder moving takes everything under it along: prefix in, prefix out.
 */
export function remapPaths(layout: PaneLayout, from: string, to: string): PaneLayout {
  const remap = (id: string) => (id === from ? to : id.startsWith(`${from}/`) ? to + id.slice(from.length) : id);
  let changed = false;
  const panes = layout.panes.map(pane => {
    const tabs = pane.tabs.map(remap);
    const activeId = pane.activeId === null ? null : remap(pane.activeId);
    if (tabs.some((tab, i) => tab !== pane.tabs[i]) || activeId !== pane.activeId) {
      changed = true;
      return { tabs, activeId };
    }
    return pane;
  });
  return changed ? { ...layout, panes } : layout;
}

/**
 * Drops tabs whose file is gone — deleted here, on another tab, or by a sync.
 * Runs against every tree refresh, so returning the same layout unchanged is
 * load-bearing rather than an optimisation.
 */
export function pruneMissing(layout: PaneLayout, exists: (id: string) => boolean): PaneLayout {
  let next = layout;
  for (const pane of layout.panes) {
    for (const tab of pane.tabs) {
      if (exists(tab)) continue;
      const index = next.panes.findIndex(p => p.tabs.includes(tab));
      if (index !== -1) next = removeTab(next, index, tab);
    }
  }
  return next;
}
