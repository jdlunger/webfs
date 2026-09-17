export type NodeType = "file" | "folder";

export interface FSNode {
  id: string;
  name: string;
  type: NodeType;
  parentId: string | null;
  content?: string;
}

export type FileSystem = Record<string, FSNode>;

export const ROOT_ID = "root";
const STORAGE_KEY = "webfs:filesystem";

export function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function makeNode(id: string, name: string, type: NodeType, parentId: string | null, content?: string): FSNode {
  return { id, name, type, parentId, content };
}

function createSeedFileSystem(): FileSystem {
  const nodes: FSNode[] = [
    makeNode(ROOT_ID, "root", "folder", null),
    makeNode("notes", "Notes", "folder", ROOT_ID),
    makeNode(
      "notes-welcome",
      "welcome.txt",
      "file",
      "notes",
      "Welcome to your text editor!\n\nThis is a simple file explorer + plain text editor.\nEverything you create is saved in your browser's local storage.\n\nTry editing this file, or use the sidebar buttons to add new files and folders.",
    ),
    makeNode(
      "notes-todo",
      "todo.txt",
      "file",
      "notes",
      "- Edit this file\n- Create a new folder\n- Create a new file inside it\n- Delete something you don't need",
    ),
    makeNode("projects", "Projects", "folder", ROOT_ID),
    makeNode("projects-ideas", "ideas.txt", "file", "projects", "Project ideas:\n\n1. \n2. \n3. "),
  ];
  const fs: FileSystem = {};
  for (const n of nodes) fs[n.id] = n;
  return fs;
}

export function loadFileSystem(): FileSystem {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as FileSystem;
      if (parsed && parsed[ROOT_ID]) return parsed;
    } catch {
      // fall through to seed
    }
  }
  const seeded = createSeedFileSystem();
  saveFileSystem(seeded);
  return seeded;
}

export function saveFileSystem(fs: FileSystem): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fs));
}

export function childrenOf(fs: FileSystem, parentId: string): FSNode[] {
  return Object.values(fs)
    .filter(n => n.parentId === parentId)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function collectDescendantIds(fs: FileSystem, id: string): string[] {
  const ids: string[] = [id];
  for (const child of Object.values(fs).filter(n => n.parentId === id)) {
    ids.push(...collectDescendantIds(fs, child.id));
  }
  return ids;
}

export function deleteNode(fs: FileSystem, id: string): FileSystem {
  const next = { ...fs };
  for (const descendantId of collectDescendantIds(fs, id)) {
    delete next[descendantId];
  }
  return next;
}

export function createNode(fs: FileSystem, parentId: string, type: NodeType, name: string): FileSystem {
  const id = generateId();
  return {
    ...fs,
    [id]: makeNode(id, name, type, parentId, type === "file" ? "" : undefined),
  };
}

export function renameNode(fs: FileSystem, id: string, name: string): FileSystem {
  const node = fs[id];
  if (!node) return fs;
  return { ...fs, [id]: { ...node, name } };
}

export function updateFileContent(fs: FileSystem, id: string, content: string): FileSystem {
  const node = fs[id];
  if (!node || node.type !== "file") return fs;
  return { ...fs, [id]: { ...node, content } };
}
