/**
 * Projects the OPFS directory tree into the flat `Record<id, FSNode>` the UI
 * works with.
 *
 * Storage identifies nodes by path; the UI wants a stable handle that doesn't
 * change when a file is renamed (React keys, the current selection, the
 * editor's remount key). So ids live here, in memory only, and are never
 * persisted — nothing on disk knows they exist. A rename calls `repath` to
 * carry the id across, which is what stops the editor tearing down mid-rename.
 *
 * Ids differ between tabs and between reloads. Anything crossing that boundary
 * — BroadcastChannel messages, storage calls — uses paths.
 */
import { ROOT_ID, type FileSystem, type NodeType } from "./fs";
import { createDirectory, createFile, walk, writeFile, type WalkEntry } from "./storage";

const SEP = "\u0000";
const keyOf = (path: readonly string[]) => path.join(SEP);

let counter = 0;
const idsByPath = new Map<string, string>();

/**
 * The one bridge from a storage path back to an id — used when another tab
 * announces a write, since messages carry paths and everything in the app
 * layer is keyed by id.
 */
export function idForPath(path: readonly string[]): string {
  if (path.length === 0) return ROOT_ID;
  const key = keyOf(path);
  let id = idsByPath.get(key);
  if (id === undefined) {
    id = `n${++counter}`;
    idsByPath.set(key, id);
  }
  return id;
}

/**
 * Moves an id (and every id beneath it) to a new path, so a rename or move
 * keeps the same identity instead of looking like a delete plus a create.
 */
export function repath(from: readonly string[], to: readonly string[]): void {
  const fromKey = keyOf(from);
  const prefix = fromKey + SEP;
  for (const [key, id] of [...idsByPath]) {
    if (key !== fromKey && !key.startsWith(prefix)) continue;
    idsByPath.delete(key);
    const rest = key === fromKey ? [] : key.slice(prefix.length).split(SEP);
    idsByPath.set(keyOf([...to, ...rest]), id);
  }
}

function addEntries(fs: FileSystem, entries: WalkEntry[], parentPath: string[], parentId: string): void {
  for (const entry of entries) {
    const path = [...parentPath, entry.name];
    const id = idForPath(path);
    const type: NodeType = entry.kind === "directory" ? "folder" : "file";
    fs[id] = { id, name: entry.name, type, parentId };
    if (entry.kind === "directory") addEntries(fs, entry.children, path, id);
  }
}

export function projectTree(entries: WalkEntry[]): FileSystem {
  const fs: FileSystem = { [ROOT_ID]: { id: ROOT_ID, name: "root", type: "folder", parentId: null } };
  addEntries(fs, entries, [], ROOT_ID);
  return fs;
}

/**
 * Carries over content already read in this tab, so re-walking after any
 * change doesn't throw away the open file's text (or trigger a reload of it).
 */
export function adoptContent(previous: FileSystem | null, next: FileSystem): FileSystem {
  if (!previous) return next;
  for (const node of Object.values(next)) {
    const loaded = previous[node.id]?.content;
    if (loaded !== undefined && node.type === "file") node.content = loaded;
  }
  return next;
}

// Grouped by directory on purpose: creating the same folder twice would
// uniquify the second one into a stray empty "Notes 2".
const SEED: Array<{ dir: string; files: Array<{ name: string; body: string }> }> = [
  {
    dir: "Notes",
    files: [
      {
        name: "welcome.md",
        body: "# Welcome to your markdown editor!\n\nThis is a simple file explorer + **markdown** editor.\nEverything you create is saved in your browser, on this device.\n\nTry editing this file, or use the sidebar buttons to add new files and folders.",
      },
      {
        name: "todo.md",
        body: "- [ ] Edit this file\n- [ ] Create a new folder\n- [ ] Create a new file inside it\n- [ ] Delete something you don't need",
      },
    ],
  },
  { dir: "Projects", files: [{ name: "ideas.md", body: "# Project ideas\n\n1. \n2. \n3. " }] },
];

/** Reads the tree, writing starter content first if the store is empty. */
export async function loadTree(): Promise<FileSystem> {
  let entries = await walk();
  if (entries.length === 0) {
    for (const { dir, files } of SEED) {
      const dirName = await createDirectory([], dir);
      for (const { name, body } of files) {
        const fileName = await createFile([dirName], name);
        await writeFile([dirName, fileName], body);
      }
    }
    entries = await walk();
  }
  return projectTree(entries);
}
