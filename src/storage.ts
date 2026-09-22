/**
 * A thin layer over OPFS. The directory tree *is* the filesystem: everything
 * webfs persists is a name, a type, a position in the hierarchy or a file's
 * text, and a directory tree expresses all four natively. Whatever is on disk
 * is exactly what the app shows.
 *
 * Consequences worth knowing:
 * - Node identity is the path. Ids exist only in memory (see tree.ts) and are
 *   never written anywhere.
 * - Two entries can't share a name within a folder, because the filesystem
 *   won't allow it. `createFile`/`createDirectory` therefore return the name
 *   actually used, which may be uniquified.
 *
 * Locks are taken only around file writes, and give up quickly, so reading a
 * file another tab is saving never blocks.
 *
 * Everything here is reached through a `Store`, which is this API bound to a
 * mount point — the folder one drive's files live in (see drives.ts). Paths
 * passed to a store are relative to its mount, so nothing above this file has
 * to know where a drive sits; the mount is prefixed here and nowhere else.
 * Write locks are named by the absolute path, so two drives can't contend
 * over the same name.
 */

export type Path = readonly string[];

/**
 * Bytes backed by a plain ArrayBuffer.
 *
 * Narrower than `Uint8Array`'s default, whose buffer is `ArrayBufferLike` and
 * so could be a SharedArrayBuffer — which the DOM's write() and Blob()
 * signatures reject. Everything here comes from `file.arrayBuffer()` or
 * `TextEncoder`, both of which give a real ArrayBuffer, so naming it once
 * beats casting at every boundary.
 */
export type Bytes = Uint8Array<ArrayBuffer>;
export type WriteResult = "ok" | "busy";

/** How long a save waits on another tab before deferring. */
const LOCK_TIMEOUT_MS = 750;

/** Both are caught by name in App.tsx to explain the failure to the user. */
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
  if (!opfsAvailable()) throw new Error("OPFS with createWritable is unavailable");
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
async function walk(path: Path = []): Promise<WalkEntry[]> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await dirAt(path);
  } catch {
    // A drive whose mount hasn't been created yet, or whose storage was
    // evicted, is empty rather than broken — the registry outlives the files.
    return [];
  }
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

async function readFile(path: Path): Promise<string | null> {
  try {
    const dir = await dirAt(parentOf(path));
    return await (await (await dir.getFileHandle(nameOf(path))).getFile()).text();
  } catch {
    // Missing is a normal outcome — another tab may have deleted it.
    return null;
  }
}

/**
 * The file's bytes, undecoded.
 *
 * Text is the common case but not the only one: an image pasted into the
 * editor is a real file here, and reading it as text would replace bytes with
 * U+FFFD and write the damage back on the next save. Anything that might not
 * be text goes through this.
 */
async function readBytes(path: Path): Promise<Bytes | null> {
  try {
    const dir = await dirAt(parentOf(path));
    const file = await (await dir.getFileHandle(nameOf(path))).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
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

/** Text or bytes: OPFS writables take either, and both are files here. */
function writeFile(path: Path, content: string | Bytes): Promise<WriteResult> {
  return withWriteLock(`webfs:${path.join("/")}`, async () => {
    const dir = await dirAt(parentOf(path), true);
    const handle = await dir.getFileHandle(nameOf(path), { create: true });
    const writable = await handle.createWritable();
    try {
      // Bytes go through a Blob: FileSystemWritableFileStream accepts one,
      // and it sidesteps the ArrayBuffer-vs-ArrayBufferLike mismatch between
      // a plain Uint8Array and the DOM's write() signature.
      await writable.write(typeof content === "string" ? content : new Blob([content]));
    } finally {
      // close() is what commits the swap file.
      await writable.close();
    }
  });
}

async function createFile(parent: Path, desired: string): Promise<string> {
  requireValid(desired);
  const dir = await dirAt(parent, true);
  const name = await uniqueName(dir, desired);
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.close();
  return name;
}

async function createDirectory(parent: Path, desired: string): Promise<string> {
  requireValid(desired);
  const dir = await dirAt(parent, true);
  const name = await uniqueName(dir, desired);
  await dir.getDirectoryHandle(name, { create: true });
  return name;
}

async function removeEntry(path: Path): Promise<void> {
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

function renameEntry(path: Path, newName: string): Promise<void> {
  return relocate(path, parentOf(path), newName);
}

function moveEntry(path: Path, newParent: Path): Promise<void> {
  return relocate(path, newParent, nameOf(path));
}

// --- stores ------------------------------------------------------------------

/**
 * The filesystem as one drive sees it: the API above, rooted at a mount.
 *
 * An interface rather than a set of free functions because there is now more
 * than one of them on screen at once — a sync writes into the drive it is
 * syncing while the editor writes into the drive you are looking at, and
 * neither should be able to reach the other by passing a path.
 */
export interface Store {
  /** Where this store is rooted, from the OPFS root. Empty for the root itself. */
  readonly mount: Path;
  walk(path?: Path): Promise<WalkEntry[]>;
  readFile(path: Path): Promise<string | null>;
  readBytes(path: Path): Promise<Bytes | null>;
  writeFile(path: Path, content: string | Bytes): Promise<WriteResult>;
  createFile(parent: Path, desired: string): Promise<string>;
  createDirectory(parent: Path, desired: string): Promise<string>;
  removeEntry(path: Path): Promise<void>;
  renameEntry(path: Path, newName: string): Promise<void>;
  moveEntry(path: Path, newParent: Path): Promise<void>;
}

export function storeAt(mount: Path): Store {
  const at = (path: Path) => [...mount, ...path];
  return {
    mount,
    walk: (path = []) => walk(at(path)),
    readFile: path => readFile(at(path)),
    readBytes: path => readBytes(at(path)),
    writeFile: (path, content) => writeFile(at(path), content),
    createFile: (parent, desired) => createFile(at(parent), desired),
    createDirectory: (parent, desired) => createDirectory(at(parent), desired),
    removeEntry: path => removeEntry(at(path)),
    renameEntry: (path, newName) => renameEntry(at(path), newName),
    moveEntry: (path, newParent) => moveEntry(at(path), at(newParent)),
  };
}

/**
 * The whole of OPFS. Only drive bookkeeping uses this — creating a mount,
 * deleting a drive's folder, finding what predates the drives directory.
 * Everything else works through a drive's own store.
 */
export const rootStore: Store = storeAt([]);

/**
 * Creates a directory at exactly this path, or does nothing if it's there.
 *
 * `createDirectory` can't serve: it uniquifies, which is right for a folder
 * the user asked for and wrong for a mount — a second visit would land in
 * `notes 2` and find it empty.
 */
export async function ensureDirectory(path: Path): Promise<void> {
  await dirAt(path, true);
}

/**
 * The names directly inside a directory, without descending into it.
 *
 * `walk` reads the whole subtree, which is the right shape for building a
 * tree and the wrong one for answering "is there anything in here" — the
 * question drive bookkeeping asks about the OPFS root.
 */
export async function listNames(path: Path): Promise<string[]> {
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await dirAt(path);
  } catch {
    return [];
  }
  const names: string[] = [];
  for await (const [name] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) names.push(name);
  return names;
}

// --- cross-tab notification --------------------------------------------------

/**
 * What one tab tells the others.
 *
 * Every message names the drive it is about, because two tabs can be looking
 * at two different drives: without it, a write in one would make the other
 * re-read a path that means something else entirely in the tree it is
 * showing. `drives` is the registry itself changing — a drive added or
 * removed — which is the one message that isn't about a drive's contents.
 */
export type ChangeMessage =
  | { kind: "tree"; drive: string }
  | { kind: "file"; drive: string; path: string[] }
  | { kind: "drives" };

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
