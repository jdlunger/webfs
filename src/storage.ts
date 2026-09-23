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

import { decodeSegment, encodeSegment, isCanonical } from "./names";

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

/**
 * Every path below is a *logical* one — the names the app and the repository
 * use. This is where they become the names OPFS sees, and the only place the
 * two are allowed to differ: see names.ts for why they have to.
 */
async function dirAt(path: Path, create = false): Promise<FileSystemDirectoryHandle> {
  let dir = await rootDir();
  for (const segment of path) dir = await dir.getDirectoryHandle(encodeSegment(segment), { create });
  return dir;
}

const parentOf = (path: Path) => path.slice(0, -1);
const nameOf = (path: Path) => path[path.length - 1]!;
/** The last segment as OPFS holds it. Pairs with `dirAt` for the rest. */
const storedName = (path: Path) => encodeSegment(nameOf(path));

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
  /**
   * Files only, and best-effort. Directories have no timestamp in OPFS, and a
   * file can be deleted between being listed and being opened.
   */
  lastModified?: number;
}

/**
 * When a file was last written, or undefined if it wouldn't say.
 *
 * This costs a `getFile()` per file on every walk — and the whole tree is
 * re-walked after every structural change — which is the price of being able
 * to sort by date at all: nothing else here records one, and a timestamp kept
 * on the side would be one more thing to hold in step with the directory that
 * is meant to be the only index.
 */
async function modifiedTime(dir: FileSystemDirectoryHandle, name: string): Promise<number | undefined> {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).lastModified;
  } catch {
    // Vanished under the walk, or a handle that won't open. Sorting treats an
    // unknown time as oldest rather than guessing one.
    return undefined;
  }
}

/**
 * Reads the whole tree. Cheap for a notes app; the only index that exists.
 *
 * Recurses on the handle the listing already handed over rather than building
 * a path and resolving it again. That saves a lookup per folder, and it means
 * a folder whose stored name isn't canonical yet — one written before names.ts
 * existed — is still walked rather than silently missed.
 */
async function walkDir(dir: FileSystemDirectoryHandle): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = [];
  for await (const [stored, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    const name = decodeSegment(stored);
    entries.push(
      handle.kind === "directory"
        ? { name, kind: "directory", children: await walkDir(handle as FileSystemDirectoryHandle) }
        : { name, kind: "file", children: [], lastModified: await modifiedTime(dir, stored) },
    );
  }
  return entries;
}

async function walk(path: Path = []): Promise<WalkEntry[]> {
  try {
    return await walkDir(await dirAt(path));
  } catch {
    // A drive whose mount hasn't been created yet, or whose storage was
    // evicted, is empty rather than broken — the registry outlives the files.
    return [];
  }
}

async function readFile(path: Path): Promise<string | null> {
  try {
    const dir = await dirAt(parentOf(path));
    return await (await (await dir.getFileHandle(storedName(path))).getFile()).text();
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
    const file = await (await dir.getFileHandle(storedName(path))).getFile();
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
    const handle = await dir.getFileHandle(storedName(path), { create: true });
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
  // Uniquified in stored space, because that's what the directory holds — and
  // decoded on the way back, because the caller deals in logical names.
  const name = await uniqueName(dir, encodeSegment(desired));
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.close();
  return decodeSegment(name);
}

async function createDirectory(parent: Path, desired: string): Promise<string> {
  requireValid(desired);
  const dir = await dirAt(parent, true);
  const name = await uniqueName(dir, encodeSegment(desired));
  await dir.getDirectoryHandle(name, { create: true });
  return decodeSegment(name);
}

async function removeEntry(path: Path): Promise<void> {
  const dir = await dirAt(parentOf(path));
  await dir.removeEntry(storedName(path), { recursive: true });
}

/** Names here are the stored ones, copied across as they are. */
async function copyTree(from: FileSystemDirectoryHandle, name: string, to: FileSystemDirectoryHandle, as: string): Promise<void> {
  let source: FileSystemDirectoryHandle;
  try {
    source = await from.getDirectoryHandle(name);
  } catch {
    const file = await (await from.getFileHandle(name)).getFile();
    const writable = await (await to.getFileHandle(as, { create: true })).createWritable();
    try {
      // The File itself, not its text: a folder being moved can hold a pasted
      // image, and decoding those bytes as text would replace them with U+FFFD
      // and write the damage to the copy.
      await writable.write(file);
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
  const stored = storedName(path);
  const target = encodeSegment(newName);
  if (parentOf(path).join("/") === newParent.join("/") && nameOf(path) === newName) return;
  // Reported with the name the user typed, not the one on disk.
  if (await entryExists(toDir, target)) throw new NameTakenError(newName);

  try {
    const file = await fromDir.getFileHandle(stored);
    if ("move" in file) {
      await (file as FileSystemFileHandle & { move: (a: unknown, b?: string) => Promise<void> }).move(toDir, target);
      return;
    }
  } catch (err) {
    if (err instanceof NameTakenError) throw err;
    // Not a file, or no move() — fall through to copy + delete.
  }
  await copyTree(fromDir, stored, toDir, target);
  await fromDir.removeEntry(stored, { recursive: true });
}

function renameEntry(path: Path, newName: string): Promise<void> {
  return relocate(path, parentOf(path), newName);
}

function moveEntry(path: Path, newParent: Path): Promise<void> {
  return relocate(path, newParent, nameOf(path));
}

/**
 * Renames whatever was stored before names.ts existed.
 *
 * `walk` still *lists* a legacy name, because it recurses on handles — but a
 * lookup by that name now escapes it and misses, so the file would appear in
 * the tree and fail to open. One sweep per mount fixes that, and it only
 * touches names that aren't already what the escaping would have written:
 * for a vault of 35 notes that was nine files and one folder.
 *
 * Idempotent, and safe to interrupt: each rename stands alone, and a second
 * run finishes whatever the first didn't. Children are renamed before their
 * parent so a folder is already canonical inside by the time it moves.
 */
async function adoptNames(dir: FileSystemDirectoryHandle): Promise<number> {
  // Listed in full first: renaming entries while iterating the directory that
  // holds them is not something the API promises anything about.
  const entries: Array<[string, FileSystemHandle]> = [];
  for await (const pair of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) entries.push(pair);

  let renamed = 0;
  for (const [stored, handle] of entries) {
    if (handle.kind === "directory") renamed += await adoptNames(handle as FileSystemDirectoryHandle);
    if (isCanonical(stored)) continue;

    const target = encodeSegment(decodeSegment(stored));
    // Both spellings present is the damage this whole change exists to stop.
    // Merging them is a guess about which is wanted; leaving the legacy one
    // alone keeps it visible and costs nothing that isn't already lost.
    if (await entryExists(dir, target)) continue;

    try {
      const file = await dir.getFileHandle(stored);
      if ("move" in file) {
        await (file as FileSystemFileHandle & { move: (a: unknown, b?: string) => Promise<void> }).move(dir, target);
        renamed++;
        continue;
      }
    } catch {
      // A directory, or a file handle without move(): copy and delete instead.
    }
    await copyTree(dir, stored, dir, target);
    await dir.removeEntry(stored, { recursive: true });
    renamed++;
  }
  return renamed;
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
  /** Brings names written before names.ts into line. Returns how many moved. */
  adoptNames(): Promise<number>;
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
    adoptNames: async () => {
      try {
        return await adoptNames(await dirAt(at([])));
      } catch {
        return 0; // No mount yet is nothing to adopt.
      }
    },
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
