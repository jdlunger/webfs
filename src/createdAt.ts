/**
 * When each file first appeared on this device.
 *
 * OPFS has no creation time. A `File` carries `lastModified` and nothing
 * else, and a `FileSystemFileHandle` has no metadata API at all — checked in
 * a real browser rather than assumed. So a creation date can only exist here
 * if webfs records one, and this is where it goes.
 *
 * **It is "first seen here", not "created".** A note written on a laptop and
 * pulled onto a phone is dated when it reached the phone; a vault that was
 * already in the store when this shipped has no date at all, because nothing
 * watched it arrive. Both are honest about what was observed, which is why an
 * unknown date sorts *last* rather than being filled in: `lastModified` is
 * the obvious filler, and it would quietly turn "Created" into a second,
 * slightly wrong copy of "Modified".
 *
 * IndexedDB rather than localStorage, because this grows with the number of
 * files rather than being a handful of settings, and because it is written
 * from a tree refresh — where a synchronous multi-megabyte JSON round trip on
 * the main thread would be felt. It stays per-device, like everything else
 * webfs keeps outside OPFS: OPFS is what sync pushes to GitHub, and a sidecar
 * of timestamps has no business in someone's notes repository.
 */
import { remapId } from "./fs";

const DB_NAME = "webfs";
const DB_VERSION = 1;
const STORE = "created";

interface Row {
  drive: string;
  path: string;
  at: number;
}

let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>(resolve => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // Keyed by drive *and* path: two drives can both hold Notes/todo.md
        // and they are different files. The index is what makes "everything
        // for this drive" one read rather than a scan of every drive's rows.
        db.createObjectStore(STORE, { keyPath: ["drive", "path"] }).createIndex("drive", "drive");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

/**
 * Runs `body` in a transaction and resolves with what it collected, or with
 * `fallback` if there is no database to run it against.
 *
 * `body` returns a getter rather than a value, because a request's result
 * only exists once its own `onsuccess` has run; the getter is read on
 * `oncomplete`, by which time every request in the transaction has settled.
 *
 * A failure anywhere resolves to `fallback` instead of rejecting. A browser
 * with IndexedDB blocked — a private window, storage turned off — loses
 * creation dates and nothing else, which is a feature degrading rather than
 * an app breaking. (`opfsAvailable` makes the opposite call for the same kind
 * of question, because the store failing has nothing to fall back to.)
 */
async function withStore<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => () => T, fallback: T): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;
  return new Promise<T>(resolve => {
    try {
      const transaction = db.transaction(STORE, mode);
      const collected = body(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(collected());
      transaction.onerror = () => resolve(fallback);
      transaction.onabort = () => resolve(fallback);
    } catch {
      resolve(fallback);
    }
  });
}

/** Every date this drive has, as path → time. */
export function loadCreated(drive: string): Promise<Record<string, number>> {
  return withStore<Record<string, number>>(
    "readonly",
    store => {
      const request = store.index("drive").getAll(drive);
      return () => Object.fromEntries((request.result as Row[]).map(row => [row.path, row.at]));
    },
    {},
  );
}

/**
 * Dates `paths` as having arrived at `at`, and answers with the date each one
 * *now* has — which is not always the one offered.
 *
 * A path that already has a date keeps it, and two things lean on that:
 * another tab that noticed the same new file a moment earlier has already
 * recorded it, and a device whose OPFS was evicted re-pulls its whole store,
 * where overwriting would replace every real date with the moment of the
 * refill. Reading the existing date back rather than reporting nothing is
 * what lets this tab agree with that other tab without waiting for a reload.
 */
export function stampCreated(
  drive: string,
  paths: readonly string[],
  at: number = Date.now(),
): Promise<Record<string, number>> {
  if (paths.length === 0) return Promise.resolve({});
  return withStore<Record<string, number>>(
    "readwrite",
    store => {
      const dates: Record<string, number> = {};
      for (const path of paths) {
        // `add` rather than `put`: it fails on a key that exists, which is
        // exactly "someone got here first" — and an expected failure must not
        // take the whole transaction down with it.
        const request = store.add({ drive, path, at } satisfies Row);
        request.onsuccess = () => {
          dates[path] = at;
        };
        request.onerror = event => {
          event.preventDefault();
          event.stopPropagation();
          const existing = store.get([drive, path]);
          existing.onsuccess = () => {
            const row = existing.result as Row | undefined;
            if (row) dates[path] = row.at;
          };
        };
      }
      return () => dates;
    },
    {},
  );
}

/**
 * Follows a rename or a move, a folder's whole subtree included.
 *
 * Without this a rename reads as the old file vanishing and a new one
 * arriving, and the date would restart at today. `remapId` is the same prefix
 * rule the tabs and the collapsed folders follow, for the same reason: an id
 * here *is* a path.
 */
export function remapCreated(drive: string, from: string, to: string): Promise<Record<string, number>> {
  return withStore<Record<string, number>>(
    "readwrite",
    store => {
      const request = store.index("drive").getAll(drive);
      const moved: Record<string, number> = {};
      request.onsuccess = () => {
        for (const row of request.result as Row[]) {
          const path = remapId(row.path, from, to);
          if (path === row.path) continue;
          store.delete([drive, row.path]);
          // `put`, not `add`: a tree refresh may have already dated the
          // destination as a new arrival, and the date carried over from the
          // original is the one that should win.
          store.put({ drive, path, at: row.at } satisfies Row);
          moved[path] = row.at;
        }
      };
      return () => moved;
    },
    {},
  );
}

/**
 * Nothing deletes rows, deliberately.
 *
 * The tempting cleanup is to drop the dates of files that have left the tree,
 * which a refresh already knows. But "every file has left" is also what an
 * evicted OPFS looks like for the moment before sync refills it, and that
 * cleanup would take every real date with it — permanently, since there is
 * nothing to recover them from. The cost of not doing it is a path that is
 * deleted and later reused inheriting the old file's date, and a store that
 * grows by a path and a number per file ever seen. Both are small; losing
 * every date on a device is not.
 */
