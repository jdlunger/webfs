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

/** The same path, encoded for the URL bar. */
export function getNodePath(id: string): string {
  return "/" + segmentsOf(id).map(encodeURIComponent).join("/");
}

export function childrenOf(fs: FileSystem, parentId: string): FSNode[] {
  return Object.values(fs)
    .filter(n => n.parentId === parentId)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export function updateFileContent(fs: FileSystem, id: string, content: string): FileSystem {
  const node = fs[id];
  if (!node || node.type !== "file") return fs;
  return { ...fs, [id]: { ...node, content, binary: false } };
}

/** Records that a file's bytes aren't text, so the editor won't open it. */
export function markFileBinary(fs: FileSystem, id: string): FileSystem {
  const node = fs[id];
  if (!node || node.type !== "file") return fs;
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
