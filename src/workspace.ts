/**
 * What the app itself looks like — which files are open in which pane, which
 * folders are collapsed, which files are shown as source — remembered across
 * reloads, for each drive separately.
 *
 * Per drive because every id in here is a path *within* one (see drives.ts):
 * two drives can both hold `Notes/todo.md`, and one entry shared between them
 * would restore tabs on whatever happened to sit at those paths.
 *
 * localStorage, not OPFS, for the same reason `driveConfig.ts` is there: OPFS
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
import { type FileSystem, ROOT_ID, idOf, segmentsOf } from "./fs";
import { type Pane, type PaneLayout, MAX_PANES } from "./panes";
import { driveId, type Drive } from "./drives";

const WORKSPACE_PREFIX = "webfs:workspace:";

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

const workspaceKey = (drive: Drive) => WORKSPACE_PREFIX + driveId(drive);

/** Private browsing and blocked-cookie settings make localStorage throw. */
export function loadWorkspace(drive: Drive): Workspace | null {
  try {
    return parseWorkspace(localStorage.getItem(workspaceKey(drive)));
  } catch {
    return null;
  }
}

export function saveWorkspace(drive: Drive, workspace: Workspace): void {
  try {
    localStorage.setItem(workspaceKey(drive), serializeWorkspace(workspace));
  } catch {
    /* nothing to do: the app just opens the way it always used to */
  }
}

/**
 * What a drive opened for the first time starts with: every folder closed,
 * except the ones an open file is inside.
 *
 * A tree that opens fully expanded is fine for the three starter notes and
 * unreadable for a vault — the first thing you see is someone else's whole
 * folder structure at once, and there is no "collapse all". So a drive with no
 * workspace yet writes the list it would otherwise leave empty. Nothing about
 * the meaning of `collapsed` changes: this is a starting point that is then
 * remembered and edited like any other, and a folder that arrives afterwards
 * still appears open, because it isn't in the list this produced.
 *
 * Since a workspace is per drive, this is every drive's own first visit, not
 * the app's — which is where it matters most: adding a GitHub drive is exactly
 * how someone else's vault arrives here.
 *
 * The exception exists because that same first load opens a file (or a deep
 * link named one), and a selected file the sidebar can't show is worse than a
 * folder left open.
 */
export function initialCollapsed(fs: FileSystem, open: readonly string[]): string[] {
  const keep = new Set<string>();
  for (const id of open) {
    const segments = segmentsOf(id);
    // The last segment is the file itself; everything before it is a folder.
    for (let i = 1; i < segments.length; i++) keep.add(idOf(segments.slice(0, i)));
  }
  // The root is a folder in the record and not a row in the tree: collapsing
  // it would hide everything.
  return Object.values(fs)
    .filter(node => node.type === "folder" && node.id !== ROOT_ID && !keep.has(node.id))
    .map(node => node.id);
}
