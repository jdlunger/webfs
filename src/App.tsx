import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./index.css";
import {
  type FSNode,
  type FileSystem,
  remapCreatedAt,
  type CreatedAt,
  type SortBy,
  DEFAULT_SORT,
  canMove,
  childrenOf,
  findFirstFile,
  findNodeByPath,
  getNodePath,
  idOf,
  markFileBinary,
  remapId,
  ROOT_ID,
  segmentsOf,
  touchFile,
  updateFileContent,
} from "./fs";
import { Sidebar } from "./Sidebar";
import { Editor, ViewToggle, type EditorView } from "./Editor";
import { TabStrip, VersionTag } from "./TabStrip";
import { WIDE_SCREEN, useMediaQuery } from "./useMediaQuery";
import {
  type PaneLayout,
  MAX_PANES,
  activeId as focusedFileId,
  activeIds,
  closePane,
  closeTab,
  focusPane,
  openBeside,
  openFile,
  openIds as allOpenIds,
  pruneMissing,
  remapPaths,
  singlePane,
  splitPane,
} from "./panes";
import { BASE_PATH } from "./basePath";
import { importName, neverText } from "./assets";
import { findOpenTasks, setTaskChecked } from "./tasks";
import { decodeText } from "./github";
import { mergeText } from "./merge";
import {
  InvalidNameError,
  NameTakenError,
  announce,
  ensureDirectory,
  opfsAvailable,
  storeAt,
  subscribeToChanges,
} from "./storage";
import { adoptContent, loadTree, projectTree } from "./tree";
import { loadCreated, remapCreated, stampCreated } from "./createdAt";
import { DrivePanel } from "./DrivePanel";
import { AcceptDriveDialog } from "./AcceptDrive";
import { parseShareLink } from "./shareLink";
import { type Workspace, initialCollapsed, loadWorkspace, saveWorkspace } from "./workspace";
import { useDriveSync } from "./useDriveSync";
import type { SyncResult } from "./sync";
import { loadDrives, loadLastDrive, markSeeded, saveDrives, saveLastDrive, shouldSeed } from "./driveConfig";
import {
  DRIVES_DIR,
  describeDrive,
  driveId,
  driveUrl,
  findDrive,
  mountOf,
  parseDrivePath,
  type Drive,
  type GitHubDrive,
} from "./drives";

/** Content saves coalesce over this window rather than firing per keystroke. */
const WRITE_DEBOUNCE_MS = 400;
/** How soon to try again when another tab held the file's lock. */
const WRITE_RETRY_MS = 250;

function stripBasePath(pathname: string): string {
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) {
    const rest = pathname.slice(BASE_PATH.length);
    return rest === "" ? "/" : rest;
  }
  return pathname;
}

// GitHub Pages has no server-side rewrite for a client-side router, so a
// fresh load of a deep link (e.g. /webfs/Notes/todo.md) 404s; public/404.html
// bounces it back here with the real path in ?redirect=. Restore it before
// anything reads the URL.
function restoreRedirectedPath(): void {
  const params = new URLSearchParams(window.location.search);
  const redirect = params.get("redirect");
  if (redirect === null) return;
  window.history.replaceState(null, "", BASE_PATH + redirect);
}

/**
 * A drive offered by a share link, taken out of the URL before anything reads
 * it.
 *
 * The fragment holds a write-scoped token in full (see shareLink.ts), so the
 * first thing done with it is to get it out of the address bar — and so out
 * of the history entry, out of whatever gets bookmarked next, and off the
 * screen of anyone looking at it. Captured before `restoreRedirectedPath`,
 * which rewrites the URL without a fragment and would otherwise drop it.
 *
 * Nothing is added here: this only *offers*. `AcceptDriveDialog` asks.
 */
function takeInvitation(): GitHubDrive | null {
  const offered = parseShareLink(window.location.hash);
  if (offered) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return offered;
}

const invitation = takeInvitation();

restoreRedirectedPath();

/**
 * The drive named by the address bar, and the path inside it.
 *
 * The pathname is left percent-encoded: `parseDrivePath` decodes only the two
 * segments naming the drive, and the rest is decoded once, by whoever resolves
 * it against a tree. Null for a drive this device doesn't have — a link from
 * another device to a repository that hasn't been added here.
 */
function locationDrive(drives: readonly Drive[]): { drive: Drive | null; path: string | null } {
  const parsed = parseDrivePath(stripBasePath(window.location.pathname));
  if (!parsed) return { drive: null, path: null };
  return { drive: findDrive(drives, parsed.id), path: parsed.path };
}

/** The registry, and which of its drives is on screen, at startup. */
function initialDrives(): { drives: Drive[]; activeId: string | null } {
  const drives = loadDrives();
  // The URL wins over the remembered drive: a link is a statement about what
  // to open, where the last drive is only a guess for when nothing says.
  const active = locationDrive(drives).drive ?? loadLastDrive(drives);
  return { drives, activeId: active === null ? null : driveId(active) };
}

/** A tree with nothing in it: what the sidebar shows when there's no drive. */
const EMPTY_TREE: FileSystem = { [ROOT_ID]: { id: ROOT_ID, name: "root", type: "folder", parentId: null } };

/** The file the URL names within this drive, if it still exists. */
function urlSelection(fs: FileSystem, path: string | null): string | null {
  if (path && path !== "/") {
    const match = findNodeByPath(fs, path);
    if (match && match.type === "file") return match.id;
  }
  return null;
}

/**
 * What's on screen on a fresh load: the panes as they were left, with the
 * URL's file opened into them.
 *
 * The two normally agree — the URL is written from the focused pane on every
 * change — so there's only something to reconcile when the URL came from
 * somewhere else: a deep link, a bookmark, a link someone sent. That file is
 * what the visitor asked for, so it's opened (or focused where it already is)
 * rather than the remembered layout quietly winning.
 *
 * Tabs are pruned against the tree that actually loaded, the same way they are
 * when a file vanishes while the app is open: it may have been deleted on
 * another device since, and on a synced device the store can still be empty
 * here because nothing has been pulled yet.
 */
function initialLayout(fs: FileSystem, saved: Workspace | null, path: string | null): PaneLayout {
  const url = urlSelection(fs, path);
  // Nothing remembered — a first visit — opens a file rather than a
  // placeholder. A remembered workspace is restored as it stands, empty or
  // not: closing every tab is a thing someone did on purpose.
  if (!saved) return singlePane(url ?? findFirstFile(fs)?.id ?? null);
  const restored = pruneMissing(saved.layout, id => fs[id]?.type === "file");
  return url ? openFile(restored, url) : restored;
}

export function App() {
  /**
   * The drives this device knows about, and which one is on screen.
   *
   * One piece of state rather than two: the active drive is an index into the
   * registry, and a removal that left the pointer behind would name a drive
   * that no longer exists.
   */
  const [{ drives, activeId: activeDriveId }, setDrives] = useState(initialDrives);
  /** The share link this tab was opened with, until it's accepted or dismissed. */
  const [invited, setInvited] = useState(invitation);

  // A share link tapped while webfs is already open changes only the
  // fragment, which is a navigation the browser handles without reloading —
  // so the module-level read above never runs again. Ordinary enough to need
  // covering: the link is in a note, or a chat app reuses the tab.
  useEffect(() => {
    const onHashChange = () => {
      const offered = takeInvitation();
      if (offered) setInvited(offered);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const [fs, setFs] = useState<FileSystem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [layout, setLayout] = useState<PaneLayout>(() => singlePane(null));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /**
   * Per file, bumped only when content arrives from *outside* that file's
   * editor, to remount it (Crepe is uncontrolled, so a remount is the one way
   * to push content in). Local typing must never bump this or every keystroke
   * would tear the editor down. Keyed by id because two panes can be showing
   * two different files, and a sync can land in either.
   */
  const [externalEdits, setExternalEdits] = useState<Record<string, number>>({});
  /**
   * Which files are being shown as markdown source rather than in Crepe.
   *
   * Keyed by file rather than by pane so the toggle acts on the document you
   * can see: a split can show one file rendered and another as text, and
   * closing a pane doesn't shuffle anyone's view out from under them.
   */
  const [textViews, setTextViews] = useState<Record<string, boolean>>({});
  /**
   * Folders the tree draws closed, held here rather than in each row so it
   * survives the rows being rebuilt on every tree refresh — and so there is
   * one place that persists it, follows a rename, and can be read back.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Set when a drive is opened for the first time, cleared once the tree it
   * applies to has arrived and been folded. State rather than a ref because
   * the save below has to wait for it: a workspace written while this is
   * pending would be read back as a drive that has already been visited, and
   * its folders would open wide after all.
   */
  const [foldPending, setFoldPending] = useState(false);
  /**
   * How the sidebar orders a folder's files. Up here with `collapsed` because
   * it is the same kind of thing — a way of looking at this drive, remembered
   * per drive — and because the sidebar's rows are rebuilt too often to hold
   * it themselves.
   */
  const [sortBy, setSortBy] = useState<SortBy>(DEFAULT_SORT);

  /**
   * When each file first appeared here, for the "Created" orders
   * (`createdAt.ts`). Beside the tree rather than in it, because the tree is
   * a projection of OPFS and OPFS has no creation time to project.
   */
  const [created, setCreated] = useState<CreatedAt>({});

  // Tabs and the split view are a large-screen affordance; a phone keeps
  // showing one file at a time, as it always has.
  const wide = useMediaQuery(WIDE_SCREEN);

  const drive = activeDriveId === null ? null : findDrive(drives, activeDriveId);
  const driveKey = drive === null ? "" : driveId(drive);

  /**
   * The active drive's files. Memoized because it keys the editor's mount: a
   * new object every render would tear Crepe down on every keystroke. Keyed on
   * the drive's *id*, because the mount is a function of the id alone — a
   * fresh token or a different branch is the same folder, and remounting the
   * editor over it would cost the undo history for nothing.
   *
   * With no drive there is nothing to show and nothing to write, so this
   * points at the drives directory itself rather than the OPFS root — a store
   * nothing reaches, but one that couldn't scatter files across the root if
   * something ever did.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const store = useMemo(() => storeAt(drive ? mountOf(drive) : [DRIVES_DIR]), [driveKey]);

  // Latest values for listeners and timers registered once, which would
  // otherwise close over the first render's state.
  const fsRef = useRef<FileSystem | null>(null);
  fsRef.current = fs;
  const createdRef = useRef<CreatedAt>({});
  createdRef.current = created;
  const openRef = useRef<string[]>([]);
  openRef.current = activeIds(layout);
  const storeRef = useRef(store);
  storeRef.current = store;
  const driveRef = useRef(driveKey);
  driveRef.current = driveKey;
  const activeDrive = useRef(drive);
  activeDrive.current = drive;
  const drivesRef = useRef(drives);
  drivesRef.current = drives;

  /** Remounts a file's editor, if it's one of the files actually on screen. */
  const bumpExternalEdit = useCallback((id: string) => {
    if (!openRef.current.includes(id)) return;
    setExternalEdits(prev => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

  /**
   * Set once the sync hook exists, which is after the callbacks that want to
   * nudge it. Calling through a ref keeps those callbacks stable.
   */
  const requestSync = useRef<() => void>(() => {});

  /** Guards the workspace from being saved before it has been restored. */
  const workspaceLoaded = useRef(false);

  /** Text as last seen on disk, keyed by path — the base for three-way merges. */
  const baseContent = useRef(new Map<string, string>());
  const pending = useRef(new Map<string, { content: string; timer: ReturnType<typeof setTimeout> }>());

  /**
   * Files in `next` that weren't in the tree a moment ago, dated as having
   * arrived now (`createdAt.ts`).
   *
   * Watching the tree covers every way a file can appear — created here,
   * pasted as an image, pulled by a sync, written by another tab — where
   * hooking each of those call sites would cover the ones anyone remembered.
   *
   * The *first* tree a drive produces is the baseline rather than an arrival,
   * which is the whole reason this reads as "first seen here" and not "the
   * day this feature shipped": a store that was already full when it landed
   * keeps no dates at all, and an unknown date sorts last. A GitHub drive
   * loads empty and fills from the pull, so there the two amount to the same
   * thing — which is what makes a pulled file dated at all.
   */
  const noticeArrivals = useCallback((next: FileSystem) => {
    const previous = fsRef.current;
    if (previous === null) return;
    const fresh = Object.values(next)
      .filter(node => node.type === "file" && previous[node.id] === undefined && createdRef.current[node.id] === undefined)
      .map(node => node.id);
    if (fresh.length === 0) return;
    const drive = driveRef.current;
    void stampCreated(drive, fresh).then(dates => {
      // A drive switch while that was in flight: those dates are about a
      // filesystem this tab is no longer showing.
      if (driveRef.current === drive) setCreated(prev => ({ ...prev, ...dates }));
    });
  }, []);

  /** Re-reads the drive's tree, which is the source of truth for structure. */
  const refreshTree = useCallback(async () => {
    const entries = await storeRef.current.walk();
    const next = projectTree(entries);
    noticeArrivals(next);
    setFs(prev => adoptContent(prev, next));
  }, [noticeArrivals]);

  const flushWrite = useCallback(async (id: string) => {
    const queued = pending.current.get(id);
    if (!queued) return;
    // Another tab may have deleted the file out from under us; don't
    // resurrect it.
    if (fsRef.current && !fsRef.current[id]) {
      pending.current.delete(id);
      return;
    }

    const result = await storeRef.current.writeFile(segmentsOf(id), queued.content);
    if (result === "busy") {
      // Another tab is mid-save. Nothing is lost; come back to it.
      queued.timer = setTimeout(() => void flushWrite(id), WRITE_RETRY_MS);
      return;
    }
    // Leave anything typed while the write was in flight queued for next time.
    if (pending.current.get(id)?.content === queued.content) pending.current.delete(id);
    baseContent.current.set(id, queued.content);
    // Every local write lands here — a keystroke's, a cross-tab merge's, a
    // sync result re-queued — so this is the one place the sidebar's "last
    // modified" order has to be told the file moved.
    setFs(prev => (prev ? touchFile(prev, id, Date.now()) : prev));
    announce({ kind: "file", drive: driveRef.current, path: segmentsOf(id) });
    requestSync.current();
  }, []);

  const scheduleWrite = useCallback(
    (id: string, content: string) => {
      const existing = pending.current.get(id);
      if (existing) clearTimeout(existing.timer);
      pending.current.set(id, { content, timer: setTimeout(() => void flushWrite(id), WRITE_DEBOUNCE_MS) });
    },
    [flushWrite],
  );

  const flushAll = useCallback(async () => {
    for (const [id, queued] of [...pending.current]) {
      clearTimeout(queued.timer);
      await flushWrite(id);
    }
  }, [flushWrite]);

  /**
   * Follows every open tab — and each file's chosen view, and every collapsed
   * folder — when the node it points at is renamed or moved. All three are
   * keyed by id, an id is a path, and `remapId` takes a whole subtree with it.
   */
  const remapTabs = useCallback((from: string, to: string) => {
    setLayout(prev => remapPaths(prev, from, to));
    setTextViews(prev => Object.fromEntries(Object.entries(prev).map(([id, text]) => [remapId(id, from, to), text])));
    setCollapsed(prev => new Set([...prev].map(id => remapId(id, from, to))));
  }, []);

  /** Runs a structural change, then re-reads the tree and tells other tabs. */
  const mutate = useCallback(
    async (change: () => Promise<void>) => {
      // Settle queued text before the tree moves under it: a write is keyed by
      // the path it was queued for, so this is what keeps a rename from
      // stranding it at the old name.
      await flushAll();
      // Whatever is being pulled in can still fold itself away, but a folder
      // someone makes by hand is one they want open.
      setFoldPending(false);
      try {
        await change();
      } catch (err) {
        if (err instanceof NameTakenError) {
          window.alert(`"${err.message}" already exists in that folder.`);
        } else if (err instanceof InvalidNameError) {
          // Without this the rename just silently does nothing.
          window.alert(`"${err.message}" isn't a usable name — it can't be empty or contain a slash.`);
        } else {
          console.error(err);
        }
        return;
      }
      await refreshTree();
      announce({ kind: "tree", drive: driveRef.current });
      requestSync.current();
    },
    [flushAll, refreshTree],
  );

  /**
   * Folds what a sync changed on disk back into this tab, the same way a
   * BroadcastChannel message from another tab would: the text is already
   * merged and written, so this only has to catch the UI up — and tell the
   * other tabs, which have no other way to hear about a write this tab made
   * outside their own edit loop.
   */
  const applySyncResult = useCallback(
    (result: SyncResult) => {
      for (const { path, content } of result.written) {
        // A file that isn't text — an image pasted on another device — has
        // nothing for the editor to show. The tree refresh below is all it
        // needs; the bytes are already on disk.
        if (content === null) continue;
        const id = idOf(path.split("/"));
        const mine = fsRef.current?.[id]?.content;
        // A sync reads OPFS at the start and writes it seconds later, so
        // keystrokes can land in between. They're in memory but not in what
        // the sync merged, and letting the queued write flush on top would
        // put the remote change back exactly where it came from. Same
        // three-way merge the cross-tab path uses, for the same reason.
        const raced = pending.current.has(id) && mine !== undefined && mine !== content;
        const next = raced ? mergeText(baseContent.current.get(id) ?? mine!, mine!, content) : content;

        baseContent.current.set(id, content);
        if (mine !== undefined && next !== mine) {
          setFs(prev => (prev ? updateFileContent(prev, id, next) : prev));
          // Crepe only reads its content at construction, so a file open
          // right now has to be remounted to show what arrived.
          bumpExternalEdit(id);
        }
        // Whatever the merge produced still has to reach disk and the repo.
        if (raced && next !== content) scheduleWrite(id, next);
        announce({ kind: "file", drive: driveRef.current, path: path.split("/") });
      }
      for (const path of result.removed) {
        const id = idOf(path.split("/"));
        const queued = pending.current.get(id);
        if (queued) clearTimeout(queued.timer);
        pending.current.delete(id);
        baseContent.current.delete(id);
        // The tab it may be open in is closed by the prune below, once the
        // refreshed tree shows the file is gone.
      }
      void refreshTree();
      announce({ kind: "tree", drive: driveRef.current });
    },
    [bumpExternalEdit, refreshTree, scheduleWrite],
  );

  const sync = useDriveSync({ drive, store, flush: flushAll, onLocalChanges: applySyncResult });
  requestSync.current = sync.requestSync;

  // Load, and reload whenever the drive changes. A drive is a whole
  // filesystem, so arriving at one is the same work as starting the app.
  useEffect(() => {
    if (!opfsAvailable()) {
      setFailure("This browser can't store files: it lacks OPFS write support (createWritable).");
      return;
    }

    // What was open in the drive being left has already been written under
    // its own key by the effect below; until this drive's workspace has been
    // read in turn, nothing may be written at all — the state in hand is the
    // cleared one, and saving it would erase what is about to be restored.
    workspaceLoaded.current = false;

    const current = activeDrive.current;
    if (current === null) {
      setFs(null);
      return;
    }

    // Everything below is keyed by a path *within* a drive, and the same path
    // means a different file in the next one.
    for (const queued of pending.current.values()) clearTimeout(queued.timer);
    pending.current.clear();
    baseContent.current.clear();
    setExternalEdits({});
    setTextViews({});
    setCollapsed(new Set());
    setCreated({});
    // A fold still waiting on the drive being left must not land on the one
    // being arrived at, whose own workspace may say its folders are open.
    setFoldPending(false);
    setSortBy(DEFAULT_SORT);
    // Not the old drive's tree, for however long the new one takes to read.
    setFs(null);

    let cancelled = false;

    // Merged rather than assigned: the tree can load and notice arrivals
    // before this read comes back, and assigning would drop what it learned.
    // Nothing conflicts — a path already in hand was read back from these
    // same rows — so which side wins doesn't matter, only that neither is
    // lost.
    void loadCreated(driveKey).then(dates => {
      if (!cancelled) setCreated(prev => ({ ...dates, ...prev }));
    });

    // Only the drive the URL actually names gets its file from the URL; a
    // switch made from the picker leaves the address bar pointing at the
    // drive being left until the effect below rewrites it.
    const fromUrl = locationDrive(drivesRef.current);
    const path = fromUrl.drive && driveId(fromUrl.drive) === driveKey ? fromUrl.path : null;

    // Read before the load, which marks the drive seeded on the way through.
    const seeding = shouldSeed(current);

    void ensureDirectory(mountOf(current))
      // Starter notes are for the drive webfs made on a first visit, and
      // nothing else — see `shouldSeed`.
      .then(() => loadTree(storeRef.current, { seed: seeding }))
      .then(tree => {
        markSeeded(current);
        if (cancelled) return;
        const saved = loadWorkspace(current);
        setFs(tree);
        setLayout(initialLayout(tree, saved, path));
        if (saved) {
          setCollapsed(new Set(saved.collapsed));
          setTextViews(Object.fromEntries(saved.textViews.map(id => [id, true])));
          setSortBy(saved.sortBy);
        } else if (!seeding) {
          // No workspace: this drive is being opened for the first time, so
          // its tree arrives folded (see `initialCollapsed`). Not the drive
          // webfs is seeding, though — that tree is three starter notes this
          // app just wrote, and folding away its own welcome is silly.
          setFoldPending(true);
        }
        // Only now may the effect below write: until this drive's saved
        // workspace has been read, the state it would persist is the empty
        // one left by the switch, which would erase what it is about to
        // restore.
        workspaceLoaded.current = true;
      })
      .catch((err: Error) => {
        if (!cancelled) setFailure(err.message);
      });
    return () => {
      cancelled = true;
    };
    // The drive's *identity* is the only thing that means "load another
    // filesystem". Editing the drive in place — a new branch, a fresh token —
    // must not tear the tree down and put "Loading…" on screen, so everything
    // else this reads comes from a ref rather than the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveKey]);

  // What the bare app root comes back to next time.
  useEffect(() => {
    if (drive) saveLastDrive(drive);
  }, [drive, driveKey]);

  // Read each pane's file the first time it's opened.
  const openFiles = activeIds(layout);
  const openKey = JSON.stringify(openFiles);
  useEffect(() => {
    if (!fs) return;
    let cancelled = false;
    for (const id of openFiles) {
      const node = fs[id];
      // `binary` as well as `content`: a file that isn't text never gets
      // content, so without it this re-reads on every fs change — and marking
      // it binary *is* an fs change, so the two chase each other forever.
      if (!node || node.type !== "file" || node.content !== undefined || node.binary) continue;

      // A format that is never text is marked as such without being read at
      // all. `decodeText` is a good proxy and not a guarantee — a small
      // uncompressed PDF can be valid UTF-8 — and a false "this is text" is
      // the expensive way to be wrong: Crepe would render the bytes and save
      // its reading of them over the file.
      if (neverText(node.name)) {
        setFs(prev => (prev ? markFileBinary(prev, id) : prev));
        continue;
      }

      // Bytes, then decode: reading an image as text would hand the editor
      // U+FFFD soup, which its first save would write back over the original.
      void store.readBytes(segmentsOf(id)).then(stored => {
        if (cancelled) return;
        const content = stored === null ? "" : decodeText(stored);
        if (content === null) {
          setFs(prev => (prev ? markFileBinary(prev, id) : prev));
          return;
        }
        baseContent.current.set(id, content);
        setFs(prev => (prev ? updateFileContent(prev, id, content) : prev));
      });
    }
    return () => {
      cancelled = true;
    };
    // `openFiles` is what `openKey` encodes: the array is a fresh one every
    // render, the paths in it are not. Serialising rather than joining on a
    // separator, because a file name may legally contain anything but "/".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs, openKey, store]);

  // A file can vanish while it's open — deleted here, in another tab, or by a
  // sync pulling someone else's deletion. Dropping the tab is the one place
  // that has to handle all three, so it watches the tree rather than each
  // path that could have caused it.
  useEffect(() => {
    if (!fs) return;
    setLayout(prev => pruneMissing(prev, id => fs[id]?.type === "file"));
  }, [fs]);

  // A device that has never been here before starts with its folders closed,
  // which is the difference between a readable sidebar and someone's whole
  // vault structure at once.
  //
  // It waits for a tree with something in it rather than acting on the one
  // that loads: a synced device's store is empty at that point — the
  // repository hasn't been pulled yet — and there would be nothing to fold
  // away. An empty repository stays pending until the first file exists, and
  // the workspace isn't saved meanwhile, so a reload in that window is still a
  // first visit rather than a device that has already made its choices.
  useEffect(() => {
    if (!fs || !foldPending || childrenOf(fs, ROOT_ID).length === 0) return;
    setFoldPending(false);
    setCollapsed(new Set(initialCollapsed(fs, allOpenIds(layout))));
  }, [fs, layout, foldPending]);

  // Remember what's open, so a reload comes back to it. Written as it changes
  // rather than on the way out: `pagehide` is not reliably delivered on iOS,
  // and this is a few hundred bytes of JSON.
  //
  // `fs` is deliberately not a dependency — it changes on every keystroke, and
  // nothing here needs to be up to the millisecond. Reading it through the ref
  // means the ids are filtered against a tree that may be a moment old, which
  // costs at most one stale entry that the next change sweeps up.
  //
  // Two tabs share one entry, so the last one to change something wins. There
  // is nothing to merge — a layout is what one window is showing — and the
  // alternative, a per-tab store, would forget everything the moment the
  // browser closed, which is the case this exists for.
  //
  // Per drive, because every id in here is a path *within* one: restoring a
  // layout of another drive's files would open tabs on whatever happens to
  // sit at those paths here.
  useEffect(() => {
    const tree = fsRef.current;
    const drive = activeDrive.current;
    if (!workspaceLoaded.current || !tree || !drive || foldPending) return;
    saveWorkspace(drive, {
      layout,
      // Ids of things that no longer exist would otherwise pile up forever: a
      // folder deleted here or on another device is never coming back to be
      // expanded again.
      collapsed: [...collapsed].filter(id => tree[id]?.type === "folder"),
      textViews: Object.keys(textViews).filter(id => textViews[id] && tree[id]?.type === "file"),
      // Not filtered against the tree the way the two lists above are: it
      // names an order, not a node, so there is nothing here that can go
      // stale when a file disappears.
      sortBy,
    });
  }, [layout, collapsed, textViews, sortBy, foldPending]);

  // React to writes from other tabs.
  useEffect(
    () =>
      subscribeToChanges(message => {
        // Another tab added or removed a drive. The registry is the same
        // localStorage either way; this only catches the UI up.
        if (message.kind === "drives") {
          setDrives(prev => {
            const next = loadDrives();
            // The drive this tab is in may be the one that was removed, in
            // which case it has to land somewhere rather than on a tree that
            // no drive owns.
            const stillThere = prev.activeId !== null && findDrive(next, prev.activeId) !== null;
            const activeId = stillThere ? prev.activeId : next[0] ? driveId(next[0]) : null;
            return { drives: next, activeId };
          });
          return;
        }
        // A message about a drive this tab isn't showing. The path would name
        // a different file here, so re-reading it is worse than ignoring it.
        if (message.drive !== driveRef.current) return;

        if (message.kind === "tree") {
          void refreshTree();
          return;
        }

        const id = idOf(message.path);
        // Only reconcile files this tab has actually loaded; anything else is
        // read fresh whenever it's next opened.
        if (fsRef.current?.[id]?.content === undefined) return;

        void storeRef.current.readFile(message.path).then(stored => {
          const theirs = stored ?? "";
          // Only text files are reconciled here; a binary one has no merge.
          const mine = fsRef.current?.[id]?.content;
          if (mine === undefined) return;

          const merged = mine === theirs ? theirs : mergeText(baseContent.current.get(id) ?? mine, mine, theirs);
          baseContent.current.set(id, theirs);

          if (merged !== mine) {
            setFs(prev => (prev ? updateFileContent(prev, id, merged) : prev));
            bumpExternalEdit(id);
          }
          // Push the reconciled text back so the other tab converges too.
          // Merging is stable, so this settles rather than ping-ponging.
          if (merged !== theirs) scheduleWrite(id, merged);
        });
      }),
    [bumpExternalEdit, refreshTree, scheduleWrite],
  );

  // Don't let a debounced save die with the tab. Best-effort: writes are
  // async, so a page torn down instantly can still lose the last few hundred ms.
  useEffect(() => {
    const flushAll = () => {
      for (const id of [...pending.current.keys()]) void flushWrite(id);
    };
    const flushIfHiding = () => {
      if (document.hidden) flushAll();
    };
    window.addEventListener("pagehide", flushAll);
    document.addEventListener("visibilitychange", flushIfHiding);
    return () => {
      window.removeEventListener("pagehide", flushAll);
      document.removeEventListener("visibilitychange", flushIfHiding);
    };
  }, [flushWrite]);

  // The URL names the drive and, within it, the focused pane's file: with a
  // split there are two files on screen, and only one of them can be the one
  // a reload comes back to. The drive comes first because it has to be
  // resolved before a path inside it means anything.
  const selectedId = focusedFileId(layout);
  useEffect(() => {
    if (!fs && drive) return;
    const path = drive ? BASE_PATH + driveUrl(drive) + (selectedId ? getNodePath(selectedId) : "") : BASE_PATH + "/";
    // Both sides encoded: `driveUrl` and `getNodePath` encode, and so does
    // the browser's own pathname. Decoding one of them made every render of a
    // file with a non-ASCII name look like a change and rewrite the URL.
    if (window.location.pathname !== path) {
      window.history.replaceState(null, "", path);
    }
  }, [drive, driveKey, fs, selectedId]);

  const selectedFile = selectedId && fs?.[selectedId]?.type === "file" ? fs[selectedId] : null;

  /** How a file is shown, and null for one that has no text form at all. */
  const viewOf = (file: FSNode | null): EditorView | null =>
    !file || file.binary ? null : textViews[file.id] ? "text" : "rich";

  const toggleView = (id: string) => setTextViews(prev => ({ ...prev, [id]: !prev[id] }));
  const selectedView = viewOf(selectedFile);

  const toggleFolder = (id: string) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      // `delete` reports whether it removed anything, which is the same
      // question as "was this folder collapsed".
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const handleSelectFile = (id: string) => {
    // `replace` on a phone: there's no tab strip to steer there, so opening a
    // file swaps out the one before it rather than piling up invisibly.
    setLayout(prev => openFile(prev, id, { replace: !wide }));
    setSidebarOpen(false);
  };

  const handleOpenBeside = (id: string) => {
    setLayout(prev => openBeside(prev, id));
    setSidebarOpen(false);
  };

  /**
   * Switches drives, settling this one first.
   *
   * The flush has to happen here rather than in the effect that follows,
   * because by then `store` is already the new drive's — and a write queued
   * against a path in the old one would land at the same path in the new.
   */
  const handleSelectDrive = (id: string) => {
    if (id === activeDriveId) {
      setSidebarOpen(false);
      return;
    }
    void flushAll().then(() => {
      setDrives(prev => (findDrive(prev.drives, id) ? { ...prev, activeId: id } : prev));
      setSidebarOpen(false);
    });
  };

  /** Adds a drive and goes to it: adding one is always in order to use it. */
  const handleAddDrive = (added: Drive) => {
    void flushAll().then(() => {
      // Marked before it is ever loaded: a drive someone asked for starts
      // empty, where the one webfs makes for itself arrives with notes in it.
      markSeeded(added);
      setDrives(prev => {
        const next = [...prev.drives.filter(d => driveId(d) !== driveId(added)), added];
        saveDrives(next);
        return { drives: next, activeId: driveId(added) };
      });
      announce({ kind: "drives" });
    });
  };

  /**
   * Re-points a drive that's already there — a new branch, a fresh token.
   *
   * Keyed by id, which a repository keeps across a branch change, so this
   * edits in place rather than adding a second drive. The base snapshot is
   * keyed by branch as well, so the new branch starts from no base and the
   * old one's is still there if the drive is pointed back at it.
   */
  const handleUpdateDrive = (updated: Drive) => {
    setDrives(prev => {
      const next = prev.drives.map(d => (driveId(d) === driveId(updated) ? updated : d));
      saveDrives(next);
      return { ...prev, drives: next };
    });
    announce({ kind: "drives" });
  };

  /**
   * Forgets a drive. Its folder and its sync base are both left exactly as
   * they are: removing a drive is about this device's list, and "remove" that
   * quietly meant "delete everything, with no undo" is not a button to put
   * next to a drive's name. Leaving the base as well is what makes re-adding
   * the same repository pick up where it left off rather than re-deciding
   * every file with nothing to decide from.
   */
  const handleRemoveDrive = (id: string) => {
    setDrives(prev => {
      const next = prev.drives.filter(d => driveId(d) !== id);
      saveDrives(next);
      const activeId = prev.activeId === id ? (next[0] ? driveId(next[0]) : null) : prev.activeId;
      return { drives: next, activeId };
    });
    announce({ kind: "drives" });
  };

  const handleCreate = (parentId: string, type: "file" | "folder") => {
    if (!fs) return;
    const parent = segmentsOf(parentId);
    void mutate(async () => {
      if (type === "file") await store.createFile(parent, "untitled.md");
      else await store.createDirectory(parent, "New Folder");
    });
  };

  /**
   * Writes files chosen on this device into a folder.
   *
   * The only other way bytes get in is a sync pulling them, so without this a
   * PDF could be read here but never put here — and on a local drive, never
   * at all. Goes through `mutate` like any other structural change, which is
   * what refreshes the tree, tells the other tabs and dates the arrivals.
   */
  const handleImport = (parentId: string, files: readonly File[]) => {
    if (!fs || files.length === 0) return;
    const parent = segmentsOf(parentId);
    void mutate(async () => {
      for (const file of files) {
        // `createFile` returns the name actually used, which may have been
        // uniquified — importing the same photo twice is not a mistake to
        // resolve by overwriting the first one.
        const name = await store.createFile(parent, importName(file.name));
        await store.writeFile([...parent, name], new Uint8Array(await file.arrayBuffer()));
      }
    });
  };

  const handleDelete = (id: string) => {
    if (!fs) return;
    const segments = segmentsOf(id);
    const queued = pending.current.get(id);
    if (queued) clearTimeout(queued.timer);
    pending.current.delete(id);
    baseContent.current.delete(id);
    void mutate(() => store.removeEntry(segments));
  };

  const handleRename = (id: string, name: string) => {
    if (!fs) return;
    const from = segmentsOf(id);
    void mutate(async () => {
      await store.renameEntry(from, name);
      baseContent.current.delete(id);
      const to = idOf([...from.slice(0, -1), name]);
      // Before `mutate` re-reads the tree, which would otherwise see the new
      // path as a file that has just arrived and date it today.
      await remapCreated(driveRef.current, id, to);
      setCreated(prev => remapCreatedAt(prev, id, to));
      remapTabs(id, to);
    });
  };

  const handleMove = (id: string, newParentId: string) => {
    if (!fs || !canMove(fs, id, newParentId)) return;
    const from = segmentsOf(id);
    void mutate(async () => {
      await store.moveEntry(from, segmentsOf(newParentId));
      baseContent.current.delete(id);
      const to = idOf([...segmentsOf(newParentId), from[from.length - 1]!]);
      await remapCreated(driveRef.current, id, to);
      setCreated(prev => remapCreatedAt(prev, id, to));
      remapTabs(id, to);
    });
  };

  /**
   * A pasted image was written straight to OPFS by the editor, bypassing
   * `mutate` — so the tree, the other tabs and the next sync all have to be
   * told, exactly as a structural change would tell them.
   */
  const handleAssetAdded = useCallback(() => {
    void refreshTree().then(() => {
      announce({ kind: "tree", drive: driveRef.current });
      requestSync.current();
    });
  }, [refreshTree]);

  /**
   * What a `todo` fence in the editor lists.
   *
   * Here rather than in the editor because it reads every note in the drive,
   * and the tree is App's — including, crucially, the text open tabs are
   * holding, which the debounce means hasn't reached disk yet. Reading it all
   * from the store instead would list a checkbox you ticked a second ago.
   *
   * Through the refs, so this identity never changes: the editor closes over
   * it for its whole life, and a new function every render must not be a
   * reason to rebuild Crepe.
   */
  const findTasks = useCallback(
    (scope: string) =>
      findOpenTasks(fsRef.current ?? EMPTY_TREE, scope, id => storeRef.current.readFile(segmentsOf(id))),
    [],
  );

  /**
   * Ticks a checkbox a `todo` block is listing, in a file that may not be the
   * one on screen. Answers whether it actually happened.
   *
   * The block hands back the line and the text it listed, and `setTaskChecked`
   * refuses unless the file still says exactly that — the list can be seconds
   * old, and a line number from a stale one is how you tick the wrong box.
   * A refusal isn't an error: the block reloads either way, so what comes back
   * is the truth rather than the answer it was hoping for.
   *
   * Then it goes out the way *any* text this app didn't type goes out, which
   * is the part that makes this safe to do to a file someone else's editor may
   * be holding: into the record, into the write queue, and — if that file is
   * on screen — a remount, because a Crepe instance owns an uncontrolled copy
   * of its document and would write the old text back over this on its next
   * save. That is the same route a sync's changes take (`applySyncResult`),
   * for exactly the same reason. It costs the undo history of the note being
   * ticked, which is the price of not needing to reach into another pane's
   * editor and hope.
   */
  const completeTask = useCallback(
    async (file: string, line: number, text: string): Promise<boolean> => {
      const node = fsRef.current?.[file];
      if (node?.type !== "file") return false;
      // What this tab holds, which is ahead of disk while a save is pending;
      // the store only for a file it has never opened.
      const current = node.content ?? (await storeRef.current.readFile(segmentsOf(file)));
      if (current === null || current === undefined) return false;

      const next = setTaskChecked(current, line, text, true);
      if (next === null) return false;

      // The ref as well as the state, and this is not belt and braces: the
      // block reloads the moment this resolves, and what it reloads *from* is
      // this ref — which React only reassigns on the next render. Without it
      // the list comes back still showing the row that was just ticked, which
      // is the one thing the reload exists to prevent. Both are computed from
      // the same tree, so they can't disagree.
      const tree = fsRef.current;
      if (tree) fsRef.current = updateFileContent(tree, file, next);
      setFs(prev => (prev ? updateFileContent(prev, file, next) : prev));
      scheduleWrite(file, next);
      bumpExternalEdit(file);
      return true;
    },
    [bumpExternalEdit, scheduleWrite],
  );

  const handleContentChange = (id: string, content: string) => {
    setFs(prev => (prev ? updateFileContent(prev, id, content) : prev));
    scheduleWrite(id, content);
  };

  if (failure) {
    return (
      <div className="app app-loading">
        <p>{failure}</p>
      </div>
    );
  }

  // With no drive there is no tree, and the whole app is the switcher in the
  // corner. Rendering the usual chrome around an empty one puts "Add a
  // drive…" exactly where it will be every time after this, rather than on a
  // welcome screen that is never seen again.
  const tree = fs ?? EMPTY_TREE;

  return (
    <div className={`app ${sidebarOpen ? "sidebar-open" : ""}`}>
      <div className="mobile-topbar">
        <button
          className="mobile-menu-button"
          aria-label="Toggle file list"
          onClick={() => setSidebarOpen(open => !open)}
        >
          ☰
        </button>
        <span className="mobile-topbar-title">
          {selectedFile?.name ?? (drive ? describeDrive(drive) : "webfs")}
        </span>
        {/* Where the tab strip's copy would be, for a screen that has no tab
            strip. There's one pane here, so it acts on the file on screen. */}
        {selectedFile && selectedView ? (
          <ViewToggle
            view={selectedView}
            className="mobile-view-button"
            onToggle={() => toggleView(selectedFile.id)}
          />
        ) : null}
        <VersionTag />
      </div>
      <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
      <Sidebar
        fs={tree}
        selectedId={selectedId}
        openIds={allOpenIds(layout)}
        collapsed={collapsed}
        onToggleFolder={toggleFolder}
        sortBy={sortBy}
        created={created}
        onChangeSort={setSortBy}
        onSelectFile={handleSelectFile}
        onOpenBeside={wide ? handleOpenBeside : null}
        onCreate={handleCreate}
        onImport={handleImport}
        onDelete={handleDelete}
        onRename={handleRename}
        onMove={handleMove}
        footer={
          <DrivePanel
            drives={drives}
            drive={drive}
            sync={sync}
            onSelect={handleSelectDrive}
            onAdd={handleAddDrive}
            onUpdate={handleUpdateDrive}
            onRemove={handleRemoveDrive}
          />
        }
      />
      {invited && (
        <AcceptDriveDialog
          drive={invited}
          drives={drives}
          onAccept={accepted => {
            setInvited(null);
            // Already here: go to it rather than replacing what's stored. A
            // link can't know whether this device's token is the better one.
            if (findDrive(drives, driveId(accepted))) handleSelectDrive(driveId(accepted));
            else handleAddDrive(accepted);
          }}
          onClose={() => setInvited(null)}
        />
      )}
      <div className="panes">
        {!drive || !fs ? (
          <div className="pane pane-focused">
            <div className="editor editor-empty">
              <p>{drive ? "Loading…" : "Add a drive to get started."}</p>
            </div>
          </div>
        ) : null}
        {/*
          Only the focused pane is rendered on a narrow screen. Hiding the
          other one in CSS wouldn't do: it would still mount a second Crepe
          instance over a second file and run its whole save loop behind a
          screen nobody can see.
        */}
        {!drive || !fs ? [] : (wide ? layout.panes : [layout.panes[layout.focused]!]).map((pane, index) => {
          const paneIndex = wide ? index : layout.focused;
          const file = pane.activeId && fs[pane.activeId]?.type === "file" ? fs[pane.activeId]! : null;
          return (
            <div
              // The drive is in the key because a pane's contents are named by
              // paths, and the same path is a different file in the next
              // drive: without it React would keep the editor instance and
              // hand it the new drive's store for the old drive's document.
              key={`${driveKey}:${paneIndex}`}
              className={`pane ${layout.focused === paneIndex ? "pane-focused" : ""}`}
              // Capture, so clicking into the editor focuses the pane before
              // anything inside it swallows the event.
              onPointerDownCapture={() => setLayout(prev => focusPane(prev, paneIndex))}
            >
              <TabStrip
                pane={pane}
                fs={tree}
                focused={layout.focused === paneIndex}
                last={paneIndex === layout.panes.length - 1}
                canSplit={layout.panes.length < MAX_PANES}
                view={viewOf(file)}
                onSelect={id => setLayout(prev => openFile(prev, id))}
                onClose={id => setLayout(prev => closeTab(prev, paneIndex, id))}
                onSplit={() => setLayout(prev => splitPane(prev))}
                onClosePane={() => setLayout(prev => closePane(prev, paneIndex))}
                onToggleView={() => file && toggleView(file.id)}
              />
              <Editor
                file={file}
                view={viewOf(file) ?? "rich"}
                store={store}
                externalEdit={file ? externalEdits[file.id] ?? 0 : 0}
                onChange={handleContentChange}
                onAssetAdded={handleAssetAdded}
                findTasks={findTasks}
                onCompleteTask={completeTask}
                onOpenFile={handleSelectFile}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default App;
