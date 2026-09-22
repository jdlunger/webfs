/**
 * What the app itself looks like — which files are open in which pane, which
 * folders are collapsed, which files are shown as source — remembered across
 * reloads.
 *
 * localStorage, not OPFS, for the same reason `syncConfig.ts` is there: OPFS
 * is the tree that gets pushed to GitHub, and none of this belongs in
 * someone's notes repository. It's per-device UI state, and it's also *per
 * device on purpose* — which files you had open on a phone is not a fact
 * about the notes, and syncing it would have two devices fighting over one
 * answer.
 *
 * Everything here is pure but the two functions that touch the store, which
 * is what makes the validation below testable (`workspace.test.ts`) — and it
 * earns the effort: this is the one input to the app that nobody typed and
 * nothing this session produced. A stale entry from an older build, or one
 * edited by hand, must not be able to hand `panes.ts` a layout that breaks
 * the invariants the rest of the app leans on.
 */
import { type Pane, type PaneLayout, MAX_PANES } from "./panes";

const WORKSPACE_KEY = "webfs:workspace";

/**
 * Bumped when the stored shape changes meaning. An entry that doesn't match
 * is dropped whole rather than half-read: the cost is one forgotten layout,
 * where guessing at an older shape costs a wrong one.
 */
const VERSION = 1;

export interface Workspace {
  layout: PaneLayout;
  /**
   * Folder ids the tree draws collapsed — the collapsed ones rather than the
   * expanded ones, because a tree opens expanded: an empty list has to mean
   * "as it has always looked", and a folder that arrives later (created here,
   * or pulled by a sync) has to appear open rather than hidden inside an
   * entry written before it existed.
   */
  collapsed: string[];
  /** File ids shown as markdown source rather than in Crepe. */
  textViews: string[];
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === "string");

/**
 * Rebuilds a layout from whatever was stored, enforcing `panes.ts`'s rules on
 * the way through: at most `MAX_PANES` panes, no file open in two of them, an
 * `activeId` that is really one of the pane's tabs, and a `focused` that names
 * a pane that exists. Returns null for anything it can't make sense of at all.
 */
function parseLayout(panes: unknown, focused: unknown): PaneLayout | null {
  if (!Array.isArray(panes)) return null;

  const seen = new Set<string>();
  const kept: Pane[] = [];
  for (const value of panes.slice(0, MAX_PANES)) {
    if (!value || typeof value !== "object") return null;
    const { tabs, activeId } = value as Record<string, unknown>;
    if (!isStringArray(tabs)) return null;
    if (activeId !== null && activeId !== undefined && typeof activeId !== "string") return null;

    // "A file is open in at most one pane" is load-bearing — two Crepe
    // instances over one document overwrite each other — and this is the one
    // place a layout can arrive without it.
    const unique: string[] = [];
    for (const tab of tabs) {
      if (seen.has(tab)) continue;
      seen.add(tab);
      unique.push(tab);
    }

    const active = typeof activeId === "string" && unique.includes(activeId) ? activeId : unique[0] ?? null;
    kept.push({ tabs: unique, activeId: active });
  }
  if (kept.length === 0) return null;

  const index = Number.isInteger(focused) && (focused as number) >= 0 && (focused as number) < kept.length;
  return { panes: kept, focused: index ? (focused as number) : 0 };
}

export function parseWorkspace(raw: string | null): Workspace | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const { version, panes, focused, collapsed, textViews } = parsed as Record<string, unknown>;
  if (version !== VERSION) return null;

  const layout = parseLayout(panes, focused);
  if (!layout) return null;

  // The two lists are advisory — a bad one costs an expanded folder or a
  // rendered document, not a broken app — so they're dropped on their own
  // rather than taking the layout down with them.
  return {
    layout,
    collapsed: isStringArray(collapsed) ? collapsed : [],
    textViews: isStringArray(textViews) ? textViews : [],
  };
}

export function serializeWorkspace(workspace: Workspace): string {
  return JSON.stringify({
    version: VERSION,
    panes: workspace.layout.panes,
    focused: workspace.layout.focused,
    collapsed: workspace.collapsed,
    textViews: workspace.textViews,
  });
}

/** Private browsing and blocked-cookie settings make localStorage throw. */
export function loadWorkspace(): Workspace | null {
  try {
    return parseWorkspace(localStorage.getItem(WORKSPACE_KEY));
  } catch {
    return null;
  }
}

export function saveWorkspace(workspace: Workspace): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, serializeWorkspace(workspace));
  } catch {
    /* nothing to do: the app just opens the way it always used to */
  }
}
