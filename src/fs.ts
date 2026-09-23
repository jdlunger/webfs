/**
 * The in-memory shape of the filesystem, and pure queries over it.
 *
 * A node's id *is* its path — the segments joined by "/" — because at any
 * instant a file has exactly one path, and `isValidName` guarantees no segment
 * contains a separator. So the record is keyed by path, `segmentsOf` is a
 * split rather than a walk up the parents, and "is this inside that folder" is
 * a prefix test.
 *
 * This is a projection of what's in OPFS (built by tree.ts), not a store: it
 * holds no persistence and is never the source of truth. Structural changes go
 * to storage.ts and the tree is re-read, rather than being edited here.
 */
export type NodeType = "file" | "folder";

export interface FSNode {
  /** The node's path, segments joined by "/". Empty string for the root. */
  id: string;
  name: string;
  type: NodeType;
  parentId: string | null;
  /**
   * Only present for files, and only once loaded: text is read when a file is
   * opened, so `undefined` on a file means "not read yet", not "empty".
   */
  content?: string;
  /**
   * Set once the file has been read and turned out not to be text. The editor
   * shows it rather than opening it — rendering bytes as text and saving that
   * back would destroy the file.
   */
  binary?: boolean;
  /**
   * When the file was last written, as OPFS reports it. Only files have one —
   * a directory carries no timestamp — so a folder sorted by date falls back
   * to its name.
   */
  lastModified?: number;
}

export type FileSystem = Record<string, FSNode>;

export const ROOT_ID = "";

/** Storage path of a node, as raw name segments. */
export function segmentsOf(id: string): string[] {
  return id === ROOT_ID ? [] : id.split("/");
}

export function idOf(segments: readonly string[]): string {
  return segments.join("/");
}

/**
 * The same id after `from` has been renamed or moved to `to`.
 *
 * An id *is* a path, so a folder moving takes everything under it along:
 * prefix in, prefix out. Ids outside that subtree come back untouched.
 */
export function remapId(id: string, from: string, to: string): string {
  if (id === from) return to;
  return id.startsWith(`${from}/`) ? to + id.slice(from.length) : id;
}

/** The same path, encoded for the URL bar. */
export function getNodePath(id: string): string {
  return "/" + segmentsOf(id).map(encodeURIComponent).join("/");
}

/**
 * The orders the sidebar offers. Stored per drive (`workspace.ts`), so a new
 * value here has to survive being read back by a build that predates it —
 * `isSortBy` is what makes an unrecognised one fall back rather than break.
 *
 * Each date has both directions. `modified` is the odd name out: it means
 * newest-first and predates there being a pair, and renaming it to
 * `modified-desc` would quietly reset the order of everyone who had chosen
 * it — a stored value this build doesn't know falls back to the default.
 */
export type SortBy = "name" | "name-desc" | "modified" | "modified-asc" | "created" | "created-asc";

export const DEFAULT_SORT: SortBy = "name";

const SORTS: readonly SortBy[] = ["name", "name-desc", "modified", "modified-asc", "created", "created-asc"];

export function isSortBy(value: unknown): value is SortBy {
  return typeof value === "string" && (SORTS as readonly string[]).includes(value);
}

export const SORT_LABELS: Record<SortBy, string> = {
  name: "Name (A–Z)",
  "name-desc": "Name (Z–A)",
  modified: "Modified (newest first)",
  "modified-asc": "Modified (oldest first)",
  created: "Created (newest first)",
  "created-asc": "Created (oldest first)",
};

/**
 * When each file first appeared on this device, path → time (`createdAt.ts`).
 *
 * It's passed to the sort rather than hung on `FSNode`, because a node is a
 * projection of what's in OPFS and this isn't in OPFS — there is no creation
 * time in the filesystem to project. Keeping it beside the tree rather than
 * inside it is what stops the record having two sources of truth.
 */
export type CreatedAt = Readonly<Record<string, number>>;

/**
 * The same map after `from` was renamed or moved to `to` — the in-memory
 * mirror of what `remapCreated` does to the stored rows, so a rename doesn't
 * have to wait for a round trip to IndexedDB to show the right order.
 */
export function remapCreatedAt(created: CreatedAt, from: string, to: string): CreatedAt {
  const next: Record<string, number> = {};
  let changed = false;
  for (const [path, at] of Object.entries(created)) {
    const moved = remapId(path, from, to);
    if (moved !== path) changed = true;
    next[moved] = at;
  }
  return changed ? next : created;
}

const byName = (a: FSNode, b: FSNode) => a.name.localeCompare(b.name);

/**
 * Orders files by a time, with ties broken by name so the list is stable.
 *
 * **An unknown time sorts last in *both* directions**, which is the one rule
 * here worth stating out loud. Standing in a missing date with ±Infinity
 * would work for one direction and put every dateless file at the very top of
 * the other — and "unknown" is not "the oldest thing here" any more than it
 * is "the newest". Files with no creation date are the common case on a vault
 * that predates this being recorded, so an order that buries them is right
 * and an order that leads with them is unusable.
 */
function byTime(timeOf: (node: FSNode) => number | undefined, newestFirst: boolean) {
  return (a: FSNode, b: FSNode) => {
    const at = timeOf(a);
    const bt = timeOf(b);
    if (at === undefined || bt === undefined) {
      return at === bt ? byName(a, b) : at === undefined ? 1 : -1;
    }
    return at === bt ? byName(a, b) : newestFirst ? bt - at : at - bt;
  };
}

/**
 * Folders always come first and always by name, whatever the order is.
 *
 * Interleaving them by date would need a timestamp they don't have (OPFS
 * gives directories none, and nothing records a creation date for one), and a
 * tree whose folders move around as their contents are edited is harder to
 * navigate than one where they sit still. So the order chosen applies to the
 * files, which is where it was aimed.
 */
function comparator(sortBy: SortBy, created: CreatedAt): (a: FSNode, b: FSNode) => number {
  const forFiles = (compare: (a: FSNode, b: FSNode) => number) => (a: FSNode, b: FSNode) =>
    a.type === "folder" ? byName(a, b) : compare(a, b);

  switch (sortBy) {
    case "name-desc":
      return forFiles((a, b) => byName(b, a));
    case "modified":
      return forFiles(byTime(node => node.lastModified, true));
    case "modified-asc":
      return forFiles(byTime(node => node.lastModified, false));
    case "created":
      return forFiles(byTime(node => created[node.id], true));
    case "created-asc":
      return forFiles(byTime(node => created[node.id], false));
    default:
      return byName;
  }
}

export function childrenOf(
  fs: FileSystem,
  parentId: string,
  sortBy: SortBy = DEFAULT_SORT,
  created: CreatedAt = {},
): FSNode[] {
  const compare = comparator(sortBy, created);
  return Object.values(fs)
    .filter(n => n.parentId === parentId)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return compare(a, b);
    });
}

/**
 * The ids the sidebar draws for a search, or null for "show everything".
 *
 * A node is in the set if its own name matches, if something below it does
 * (or the match would be unreachable — its folders have to be drawn to get to
 * it), or if a folder above it matched: searching for a folder by name is a
 * way of asking what is in it, so the whole subtree comes along.
 *
 * Matching is on the name rather than the path, so a query never quietly
 * turns into "everything under a folder that happens to be spelt this way".
 */
export function searchTree(fs: FileSystem, query: string): ReadonlySet<string> | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;

  const visible = new Set<string>();
  // Walking up stops at the first ancestor already revealed: if it is in, so
  // is everything above it.
  const revealUpwards = (id: string) => {
    let current: string | null = id;
    while (current !== null && current !== ROOT_ID && !visible.has(current)) {
      visible.add(current);
      current = fs[current]?.parentId ?? null;
    }
  };

  const nodes = Object.values(fs).filter(n => n.id !== ROOT_ID);
  const matchedFolders: string[] = [];
  for (const node of nodes) {
    if (!node.name.toLowerCase().includes(needle)) continue;
    revealUpwards(node.id);
    if (node.type === "folder") matchedFolders.push(`${node.id}/`);
  }
  if (matchedFolders.length > 0) {
    for (const node of nodes) {
      if (matchedFolders.some(prefix => node.id.startsWith(prefix))) visible.add(node.id);
    }
  }
  return visible;
}

export function updateFileContent(fs: FileSystem, id: string, content: string): FileSystem {
  const node = fs[id];
  if (!node || node.type !== "file") return fs;
  return { ...fs, [id]: { ...node, content, binary: false } };
}

/**
 * Records that a file has just been written, for the sake of the sort order.
 *
 * The tree is only re-walked on *structural* changes, so without this a save
 * leaves the timestamp the last walk read — and "last modified" would list a
 * file you are editing right now as the oldest thing in the folder until
 * something unrelated happened. `at` is when the write landed rather than
 * what OPFS recorded: reading it back would cost a `getFile()` per save to
 * learn a number a millisecond away from this one, and the next walk replaces
 * it with the real value regardless.
 *
 * Returns the same record when there is nothing to change, like the two
 * above, so an effect keyed on `fs` can't drive itself in a circle.
 */
export function touchFile(fs: FileSystem, id: string, at: number): FileSystem {
  const node = fs[id];
  if (!node || node.type !== "file" || node.lastModified === at) return fs;
  return { ...fs, [id]: { ...node, lastModified: at } };
}

/**
 * Records that a file's bytes aren't text, so the editor won't open it.
 *
 * Returns the same record when nothing changes, so a caller that re-runs on
 * every `fs` update can't drive itself in a circle.
 */
export function markFileBinary(fs: FileSystem, id: string): FileSystem {
  const node = fs[id];
  if (!node || node.type !== "file" || node.binary) return fs;
  return { ...fs, [id]: { ...node, binary: true } };
}

/**
 * Guards a move. Dropping a folder into its own subtree has to be rejected:
 * directories are relocated by recursive copy (OPFS gives them no move()), so
 * the copy would descend into the target it is creating and never terminate.
 */
export function canMove(fs: FileSystem, id: string, newParentId: string): boolean {
  const node = fs[id];
  const target = fs[newParentId];
  if (!node || !target || target.type !== "folder") return false;
  if (node.parentId === newParentId) return false;
  return newParentId !== id && !newParentId.startsWith(`${id}/`);
}

export function findNodeByPath(fs: FileSystem, path: string): FSNode | null {
  const id = idOf(path.split("/").filter(Boolean).map(decodeURIComponent));
  return id === ROOT_ID ? null : fs[id] ?? null;
}

export function findFirstFile(fs: FileSystem, parentId: string = ROOT_ID): FSNode | null {
  for (const child of childrenOf(fs, parentId)) {
    if (child.type === "file") return child;
    const found = findFirstFile(fs, child.id);
    if (found) return found;
  }
  return null;
}
