/**
 * Projects the OPFS directory tree into the flat record the UI works with.
 *
 * Nodes are keyed by path (see fs.ts), so this is a straight transcription of
 * the walk — there is no identity to allocate or track.
 */
import { ROOT_ID, idOf, type FileSystem, type NodeType } from "./fs";
import { createDirectory, createFile, walk, writeFile, type WalkEntry } from "./storage";

function addEntries(fs: FileSystem, entries: WalkEntry[], parentPath: string[], parentId: string): void {
  for (const entry of entries) {
    const path = [...parentPath, entry.name];
    const id = idOf(path);
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
 * Carries over content already read in this tab, so re-walking after a change
 * doesn't throw away the open file's text. A renamed file keeps no entry here
 * — its path changed, so it is simply re-read from its new location.
 */
export function adoptContent(previous: FileSystem | null, next: FileSystem): FileSystem {
  if (!previous) return next;
  for (const node of Object.values(next)) {
    if (node.type !== "file") continue;
    const before = previous[node.id];
    if (before?.content !== undefined) node.content = before.content;
    // Carried for the same reason as content: without it, every structural
    // change makes the app forget a file isn't text and read it again.
    if (before?.binary) node.binary = true;
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

/**
 * Reads the tree, writing starter content first if the store is empty.
 *
 * `seed: false` is how a device with GitHub sync configured starts up: its
 * store is empty because the files live in the repository, and seeding would
 * push three starter notes into someone's established notes repo (or collide
 * with files already at those paths) before the first sync could fill it.
 */
export async function loadTree({ seed = true }: { seed?: boolean } = {}): Promise<FileSystem> {
  let entries = await walk();
  if (entries.length === 0 && seed) {
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
