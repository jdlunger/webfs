/**
 * Persistence for the file tree.
 *
 * Content lives in OPFS as one file per node (`files/<id>.md`) with the tree
 * structure alongside it in `tree.json`. Splitting them is the whole point of
 * moving off the single localStorage blob: a write touches only the file being
 * edited, so two tabs editing different files can't clobber each other, and a
 * corrupt file costs one note instead of the entire filesystem.
 *
 * The layout is flat rather than mirroring the tree onto real OPFS
 * directories. Nodes are addressed by id, so rename and move stay pure
 * metadata edits — no file moves, no name-collision rules — and ids survive
 * both. `tree.json` is the only thing that knows about hierarchy.
 *
 * Locks are taken *only* around writes (see withWriteLock) and give up
 * quickly: reading never blocks, so a second tab can always open and display a
 * file that another tab happens to be saving.
 *
 * OPFS needs `createWritable`, which not every browser that supports OPFS has.
 * When it's missing this falls back to localStorage using the same per-file
 * key layout, so the concurrency story is identical and only the medium and
 * the size limit change.
 */
import { ROOT_ID, createSeedFileSystem, type FileSystem, type FSNode } from "./fs";

const TREE_NAME = "tree.json";
const FILES_DIR = "files";
const LS_TREE_KEY = "webfs:tree";
const LS_FILE_PREFIX = "webfs:file:";

/**
 * How long a save waits for another tab's save of the same file. Short on
 * purpose: writes are debounced and retried, so giving up costs one round trip
 * rather than a lost edit, and a stuck lock can never freeze typing.
 */
export const LOCK_TIMEOUT_MS = 750;

export type WriteResult = "ok" | "busy";

function opfsUsable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function" &&
    typeof FileSystemFileHandle !== "undefined" &&
    "createWritable" in FileSystemFileHandle.prototype
  );
}

let useOpfs: boolean | null = null;
const opfsEnabled = () => (useOpfs ??= opfsUsable());

/** Which backend is live — surfaced for tests and debugging, not for logic. */
export const storageBackend = (): "opfs" | "localStorage" => (opfsEnabled() ? "opfs" : "localStorage");

// --- raw reads/writes, no locking --------------------------------------------

async function filesDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(FILES_DIR, { create });
  } catch {
    return null;
  }
}

async function readRaw(key: string, opfsName: string, dir: "root" | "files"): Promise<string | null> {
  if (!opfsEnabled()) return localStorage.getItem(key);
  try {
    const handle = dir === "root" ? await navigator.storage.getDirectory() : await filesDir(false);
    if (!handle) return null;
    const file = await handle.getFileHandle(opfsName);
    return await (await file.getFile()).text();
  } catch {
    // Missing file is the normal "nothing stored yet" path, not an error.
    return null;
  }
}

async function writeRaw(key: string, opfsName: string, dir: "root" | "files", text: string): Promise<void> {
  if (!opfsEnabled()) {
    localStorage.setItem(key, text);
    return;
  }
  const handle = dir === "root" ? await navigator.storage.getDirectory() : await filesDir(true);
  if (!handle) throw new Error("OPFS directory unavailable");
  const file = await handle.getFileHandle(opfsName, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(text);
  } finally {
    // close() is what commits the swap file; skipping it on error would leak.
    await writable.close();
  }
}

async function removeRaw(key: string, opfsName: string): Promise<void> {
  if (!opfsEnabled()) {
    localStorage.removeItem(key);
    return;
  }
  try {
    await (await filesDir(false))?.removeEntry(opfsName);
  } catch {
    // Already gone.
  }
}

// --- locking -----------------------------------------------------------------

/**
 * Runs `write` while holding a named lock, or returns "busy" if another tab
 * holds it past LOCK_TIMEOUT_MS. Only writes take locks; reads go straight
 * through so an open file is always viewable.
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
    // Aborting only ever cancels *waiting* for the lock; once granted the
    // write runs to completion, so this can't report a half-finished write.
    if ((err as { name?: string } | null)?.name === "AbortError") return "busy";
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- tree --------------------------------------------------------------------

function stripContent(fs: FileSystem): FileSystem {
  const out: FileSystem = {};
  for (const node of Object.values(fs)) {
    out[node.id] = { id: node.id, name: node.name, type: node.type, parentId: node.parentId };
  }
  return out;
}

function parseTree(raw: string | null): FileSystem | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FileSystem;
    return parsed && parsed[ROOT_ID] ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Loads the tree, seeding on first run. Nodes carry no content.
 *
 * There is deliberately no import path from the pre-OPFS `webfs:filesystem`
 * blob: anything stored under it is not carried over, and a browser holding
 * one simply starts fresh from the seed.
 */
export async function readTree(): Promise<FileSystem> {
  const existing = parseTree(await readRaw(LS_TREE_KEY, TREE_NAME, "root"));
  if (existing) return existing;

  const seeded = createSeedFileSystem();
  for (const node of Object.values(seeded)) {
    if (node.type === "file") await writeRaw(LS_FILE_PREFIX + node.id, `${node.id}.md`, "files", node.content ?? "");
  }
  await writeRaw(LS_TREE_KEY, TREE_NAME, "root", JSON.stringify(stripContent(seeded)));
  return stripContent(seeded);
}

export function writeTree(fs: FileSystem): Promise<WriteResult> {
  const payload = JSON.stringify(stripContent(fs));
  return withWriteLock("webfs:tree", () => writeRaw(LS_TREE_KEY, TREE_NAME, "root", payload));
}

// --- file content ------------------------------------------------------------

export function readFileContent(id: string): Promise<string | null> {
  return readRaw(LS_FILE_PREFIX + id, `${id}.md`, "files");
}

export function writeFileContent(id: string, content: string): Promise<WriteResult> {
  return withWriteLock(`webfs:file:${id}`, () => writeRaw(LS_FILE_PREFIX + id, `${id}.md`, "files", content));
}

export async function deleteFileContents(nodes: FSNode[]): Promise<void> {
  for (const node of nodes) {
    if (node.type === "file") await removeRaw(LS_FILE_PREFIX + node.id, `${node.id}.md`);
  }
}

// --- cross-tab notification --------------------------------------------------

export type ChangeMessage = { kind: "tree" } | { kind: "file"; id: string };

const CHANNEL_NAME = "webfs:changes";
const tabId = Math.random().toString(36).slice(2);

let channel: BroadcastChannel | null | undefined;
function getChannel(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** Tells other tabs something landed on disk. Call only after a write succeeds. */
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
