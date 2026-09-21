/**
 * A thin layer over OPFS. The directory tree *is* the filesystem — there is
 * no index, no metadata file and no second store. Everything webfs persists
 * is a name, a type, a position in the hierarchy or a file's text, and a
 * directory tree expresses all four natively.
 *
 * Consequences worth knowing:
 * - Node identity is the path. Ids exist only in memory (see tree.ts) and are
 *   never written anywhere.
 * - Two entries can't share a name within a folder, because the filesystem
 *   won't allow it. `createFile`/`createDirectory` therefore return the name
 *   actually used, which may be uniquified.
 * - Nothing here can be lost to a stale index, and the store is
 *   self-describing: whatever is on disk is exactly what the app shows.
 *
 * Locks are taken only around file writes, and give up quickly, so reading a
 * file another tab is saving never blocks.
 */

export type Path = readonly string[];
export type WriteResult = "ok" | "busy";

/** How long a save waits on another tab before deferring. */
export const LOCK_TIMEOUT_MS = 750;

/** Thrown when the browser can't back this app at all — see opfsAvailable. */
export class StorageUnavailableError extends Error {}
export class NameTakenError extends Error {}
export class InvalidNameError extends Error {}

/**
 * OPFS alone isn't enough: writing needs `createWritable`, which some browsers
 * with OPFS don't have (they expose only worker-side sync access handles).
 * There's no fallback store by design, so this gates the whole app.
 */
export function opfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    "createWritable" in FileSystemFileHandle.prototype
  );
}

// Everything else — spaces, colons, leading dots, non-ASCII — is a legal OPFS
// filename and round-trips byte-identically, so names are stored as typed
// rather than escaped into some encoding the user never sees.
const RESERVED = new Set(["", ".", ".."]);
export function isValidName(name: string): boolean {
  return !RESERVED.has(name) && !name.includes("/") && !name.includes("\\");
}

function requireValid(name: string): void {
  if (!isValidName(name)) throw new InvalidNameError(name);
}

async function rootDir(): Promise<FileSystemDirectoryHandle> {
  if (!opfsAvailable()) throw new StorageUnavailableError("OPFS with createWritable is unavailable");
  return navigator.storage.getDirectory();
}

async function dirAt(path: Path, create = false): Promise<FileSystemDirectoryHandle> {
  let dir = await rootDir();
  for (const segment of path) dir = await dir.getDirectoryHandle(segment, { create });
  return dir;
}

const parentOf = (path: Path) => path.slice(0, -1);
const nameOf = (path: Path) => path[path.length - 1]!;

async function entryExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    /* not a file */
  }
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** "notes.md" taken → "notes 2.md". Keeps the extension where there is one. */
async function uniqueName(dir: FileSystemDirectoryHandle, desired: string): Promise<string> {
  if (!(await entryExists(dir, desired))) return desired;
  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!(await entryExists(dir, candidate))) return candidate;
  }
}

// --- reading -----------------------------------------------------------------

export interface WalkEntry {
  name: string;
  kind: "file" | "directory";
  children: WalkEntry[];
}

/** Reads the whole tree. Cheap for a notes app; the only index that exists. */
export async function walk(path: Path = []): Promise<WalkEntry[]> {
  const dir = await dirAt(path);
  const entries: WalkEntry[] = [];
  for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    entries.push({
      name,
      kind: handle.kind,
      children: handle.kind === "directory" ? await walk([...path, name]) : [],
    });
  }
  return entries;
}

export async function readFile(path: Path): Promise<string | null> {
  try {
    const dir = await dirAt(parentOf(path));
    return await (await (await dir.getFileHandle(nameOf(path))).getFile()).text();
  } catch {
    // Missing is a normal outcome — another tab may have deleted it.
    return null;
  }
}

// --- writing -----------------------------------------------------------------

/**
 * Runs `write` holding a lock named for the file, or reports "busy" if another
 * tab holds it past LOCK_TIMEOUT_MS. Aborting only cancels *waiting*; a
 * granted lock always runs to completion, so this never reports a half-write.
 */
async function withWriteLock(name: string, write: () => Promise<void>): Promise<WriteResult> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    await write();
    return "ok";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCK_TIMEOUT_MS);
  try {
    await navigator.locks.request(name, { signal: controller.signal }, async () => {
      await write();
    });
    return "ok";
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "AbortError") return "busy";
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function writeFile(path: Path, content: string): Promise<WriteResult> {
  return withWriteLock(`webfs:${path.join("/")}`, async () => {
    const dir = await dirAt(parentOf(path), true);
    const handle = await dir.getFileHandle(nameOf(path), { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(content);
    } finally {
      // close() is what commits the swap file.
      await writable.close();
    }
  });
}

export async function createFile(parent: Path, desired: string): Promise<string> {
  requireValid(desired);
  const dir = await dirAt(parent, true);
  const name = await uniqueName(dir, desired);
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.close();
  return name;
}

export async function createDirectory(parent: Path, desired: string): Promise<string> {
  requireValid(desired);
  const dir = await dirAt(parent, true);
  const name = await uniqueName(dir, desired);
  await dir.getDirectoryHandle(name, { create: true });
  return name;
}

export async function removeEntry(path: Path): Promise<void> {
  const dir = await dirAt(parentOf(path));
  await dir.removeEntry(nameOf(path), { recursive: true });
}

async function copyTree(from: FileSystemDirectoryHandle, name: string, to: FileSystemDirectoryHandle, as: string): Promise<void> {
  let source: FileSystemDirectoryHandle;
  try {
    source = await from.getDirectoryHandle(name);
  } catch {
    const file = await (await from.getFileHandle(name)).getFile();
    const writable = await (await to.getFileHandle(as, { create: true })).createWritable();
    try {
      await writable.write(await file.text());
    } finally {
      await writable.close();
    }
    return;
  }
  const target = await to.getDirectoryHandle(as, { create: true });
  for await (const [childName] of source as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    await copyTree(source, childName, target, childName);
  }
}

/**
 * Relocates an entry, optionally renaming it.
 *
 * Files use FileSystemFileHandle.move() where available. Directories have no
 * move() at all, so they're copied and then deleted — deliberately in that
 * order, so an interrupted move leaves the original intact (a duplicate is
 * recoverable; a hole isn't).
 */
async function relocate(path: Path, newParent: Path, newName: string): Promise<void> {
  requireValid(newName);
  const fromDir = await dirAt(parentOf(path));
  const toDir = await dirAt(newParent, true);
  const name = nameOf(path);
  if (parentOf(path).join("/") === newParent.join("/") && name === newName) return;
  if (await entryExists(toDir, newName)) throw new NameTakenError(newName);

  try {
    const file = await fromDir.getFileHandle(name);
    if ("move" in file) {
      await (file as FileSystemFileHandle & { move: (a: unknown, b?: string) => Promise<void> }).move(toDir, newName);
      return;
    }
  } catch (err) {
    if (err instanceof NameTakenError) throw err;
    // Not a file, or no move() — fall through to copy + delete.
  }
  await copyTree(fromDir, name, toDir, newName);
  await fromDir.removeEntry(name, { recursive: true });
}

export function renameEntry(path: Path, newName: string): Promise<void> {
  return relocate(path, parentOf(path), newName);
}

export function moveEntry(path: Path, newParent: Path): Promise<void> {
  return relocate(path, newParent, nameOf(path));
}

// --- cross-tab notification --------------------------------------------------

export type ChangeMessage = { kind: "tree" } | { kind: "file"; path: string[] };

const tabId = Math.random().toString(36).slice(2);
let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("webfs:changes");
  return channel;
}

/** Announce only after a write lands, never before. */
export function announce(message: ChangeMessage): void {
  getChannel()?.postMessage({ ...message, from: tabId });
}

export function subscribeToChanges(handler: (message: ChangeMessage) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as (ChangeMessage & { from?: string }) | null;
    if (!data || data.from === tabId) return;
    handler(data);
  };
  ch.addEventListener("message", listener);
  return () => ch.removeEventListener("message", listener);
}
