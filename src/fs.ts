/**
 * The in-memory shape of the filesystem, and pure queries over it.
 *
 * This is a projection of what's in OPFS (built by tree.ts), not a store: it
 * holds no persistence and is never the source of truth. Structural changes go
 * to storage.ts and the tree is re-read, rather than being edited here.
 */
export type NodeType = "file" | "folder";

export interface FSNode {
  id: string;
  name: string;
  type: NodeType;
  parentId: string | null;
  /**
   * Only present for files, and only once loaded: text is read when a file is
   * opened, so `undefined` on a file means "not read yet", not "empty".
   */
  content?: string;
}

export type FileSystem = Record<string, FSNode>;

export const ROOT_ID = "root";

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
  return { ...fs, [id]: { ...node, content } };
}

function isDescendant(fs: FileSystem, ancestorId: string, nodeId: string): boolean {
  let cursor = fs[nodeId];
  while (cursor?.parentId) {
    if (cursor.parentId === ancestorId) return true;
    cursor = fs[cursor.parentId];
  }
  return false;
}

/**
 * Guards a move. Dropping a folder into its own subtree has to be rejected
 * here: directories are relocated by recursive copy (OPFS gives them no
 * move()), so the copy would descend into the target it is creating and never
 * terminate.
 */
export function canMove(fs: FileSystem, id: string, newParentId: string): boolean {
  const node = fs[id];
  const target = fs[newParentId];
  if (!node || !target || target.type !== "folder") return false;
  if (node.parentId === newParentId) return false;
  if (id === newParentId) return false;
  return !isDescendant(fs, id, newParentId);
}

/** Storage path of a node, as raw name segments. */
export function segmentsOf(fs: FileSystem, id: string): string[] {
  const segments: string[] = [];
  let cursor: FSNode | undefined = fs[id];
  while (cursor && cursor.id !== ROOT_ID) {
    segments.unshift(cursor.name);
    cursor = cursor.parentId ? fs[cursor.parentId] : undefined;
  }
  return segments;
}

/** The same path, encoded for the URL bar. */
export function getNodePath(fs: FileSystem, id: string): string {
  return "/" + segmentsOf(fs, id).map(encodeURIComponent).join("/");
}

export function findNodeByPath(fs: FileSystem, path: string): FSNode | null {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  let parentId = ROOT_ID;
  let node: FSNode | undefined;
  for (const part of parts) {
    node = childrenOf(fs, parentId).find(n => n.name === part);
    if (!node) return null;
    parentId = node.id;
  }
  return node ?? null;
}

export function findFirstFile(fs: FileSystem, parentId: string = ROOT_ID): FSNode | null {
  for (const child of childrenOf(fs, parentId)) {
    if (child.type === "file") return child;
    const found = findFirstFile(fs, child.id);
    if (found) return found;
  }
  return null;
}
