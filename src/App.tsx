import { useCallback, useEffect, useRef, useState } from "react";
import "./index.css";
import {
  type FSNode,
  type FileSystem,
  canMove,
  findFirstFile,
  findNodeByPath,
  getNodePath,
  idOf,
  markFileBinary,
  remapId,
  segmentsOf,
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
import { decodeText } from "./github";
import { mergeText } from "./merge";
import {
  InvalidNameError,
  NameTakenError,
  announce,
  createDirectory,
  createFile,
  moveEntry,
  opfsAvailable,
  readBytes,
  readFile,
  removeEntry,
  renameEntry,
  subscribeToChanges,
  walk,
  writeFile,
} from "./storage";
import { adoptContent, loadTree, projectTree } from "./tree";
import { SyncPanel } from "./SyncPanel";
import { type Workspace, loadWorkspace, saveWorkspace } from "./workspace";
import { useGitHubSync } from "./useGitHubSync";
import type { SyncResult } from "./sync";
import { loadConfig } from "./syncConfig";

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

restoreRedirectedPath();

/** The file the URL names, if it still exists. */
function urlSelection(fs: FileSystem): string | null {
  const path = stripBasePath(decodeURIComponent(window.location.pathname));
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
function initialLayout(fs: FileSystem, saved: Workspace | null): PaneLayout {
  const url = urlSelection(fs);
  // Nothing remembered — a first visit — opens a file rather than a
  // placeholder. A remembered workspace is restored as it stands, empty or
  // not: closing every tab is a thing someone did on purpose.
  if (!saved) return singlePane(url ?? findFirstFile(fs)?.id ?? null);
  const restored = pruneMissing(saved.layout, id => fs[id]?.type === "file");
  return url ? openFile(restored, url) : restored;
}

export function App() {
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

  // Tabs and the split view are a large-screen affordance; a phone keeps
  // showing one file at a time, as it always has.
  const wide = useMediaQuery(WIDE_SCREEN);

  // Latest values for listeners and timers registered once, which would
  // otherwise close over the first render's state.
  const fsRef = useRef<FileSystem | null>(null);
  fsRef.current = fs;
  const openRef = useRef<string[]>([]);
  openRef.current = activeIds(layout);

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

  /** Re-reads the tree from OPFS, which is the source of truth for structure. */
  const refreshTree = useCallback(async () => {
    const entries = await walk();
    setFs(prev => adoptContent(prev, projectTree(entries)));
  }, []);

  const flushWrite = useCallback(async (id: string) => {
    const queued = pending.current.get(id);
    if (!queued) return;
    // Another tab may have deleted the file out from under us; don't
    // resurrect it.
    if (fsRef.current && !fsRef.current[id]) {
      pending.current.delete(id);
      return;
    }

    const result = await writeFile(segmentsOf(id), queued.content);
    if (result === "busy") {
      // Another tab is mid-save. Nothing is lost; come back to it.
      queued.timer = setTimeout(() => void flushWrite(id), WRITE_RETRY_MS);
      return;
    }
    // Leave anything typed while the write was in flight queued for next time.
    if (pending.current.get(id)?.content === queued.content) pending.current.delete(id);
    baseContent.current.set(id, queued.content);
    announce({ kind: "file", path: segmentsOf(id) });
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
      announce({ kind: "tree" });
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
        announce({ kind: "file", path: path.split("/") });
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
      announce({ kind: "tree" });
    },
    [bumpExternalEdit, refreshTree, scheduleWrite],
  );

  const sync = useGitHubSync({ flush: flushAll, onLocalChanges: applySyncResult });
  requestSync.current = sync.requestSync;

  // Initial load.
  useEffect(() => {
    if (!opfsAvailable()) {
      setFailure("This browser can't store files: it lacks OPFS write support (createWritable).");
      return;
    }
    let cancelled = false;
    // Starter files would otherwise be created on a synced device whose store
    // is empty simply because it hasn't pulled the repository yet.
    void loadTree({ seed: loadConfig() === null })
      .then(tree => {
        if (cancelled) return;
        const saved = loadWorkspace();
        setFs(tree);
        setLayout(initialLayout(tree, saved));
        if (saved) {
          setCollapsed(new Set(saved.collapsed));
          setTextViews(Object.fromEntries(saved.textViews.map(id => [id, true])));
        }
        // Only now may the effect below write: until the saved workspace has
        // been read, the state it would persist is this component's empty
        // initial one, which would erase what it is about to restore.
        workspaceLoaded.current = true;
      })
      .catch((err: Error) => {
        if (!cancelled) setFailure(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

      // Bytes, then decode: reading an image as text would hand the editor
      // U+FFFD soup, which its first save would write back over the original.
      void readBytes(segmentsOf(id)).then(stored => {
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
  }, [fs, openKey]);

  // A file can vanish while it's open — deleted here, in another tab, or by a
  // sync pulling someone else's deletion. Dropping the tab is the one place
  // that has to handle all three, so it watches the tree rather than each
  // path that could have caused it.
  useEffect(() => {
    if (!fs) return;
    setLayout(prev => pruneMissing(prev, id => fs[id]?.type === "file"));
  }, [fs]);

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
  useEffect(() => {
    const tree = fsRef.current;
    if (!workspaceLoaded.current || !tree) return;
    saveWorkspace({
      layout,
      // Ids of things that no longer exist would otherwise pile up forever: a
      // folder deleted here or on another device is never coming back to be
      // expanded again.
      collapsed: [...collapsed].filter(id => tree[id]?.type === "folder"),
      textViews: Object.keys(textViews).filter(id => textViews[id] && tree[id]?.type === "file"),
    });
  }, [layout, collapsed, textViews]);

  // React to writes from other tabs.
  useEffect(
    () =>
      subscribeToChanges(message => {
        if (message.kind === "tree") {
          void refreshTree();
          return;
        }

        const id = idOf(message.path);
        // Only reconcile files this tab has actually loaded; anything else is
        // read fresh whenever it's next opened.
        if (fsRef.current?.[id]?.content === undefined) return;

        void readFile(message.path).then(stored => {
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

  // The URL names the focused pane's file: with a split there are two files
  // on screen, and only one of them can be the one a reload comes back to.
  const selectedId = focusedFileId(layout);
  useEffect(() => {
    if (!fs) return;
    const path = BASE_PATH + (selectedId ? getNodePath(selectedId) : "/");
    if (decodeURIComponent(window.location.pathname) !== path) {
      window.history.replaceState(null, "", path);
    }
  }, [fs, selectedId]);

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

  const handleCreate = (parentId: string, type: "file" | "folder") => {
    if (!fs) return;
    const parent = segmentsOf(parentId);
    void mutate(async () => {
      if (type === "file") await createFile(parent, "untitled.md");
      else await createDirectory(parent, "New Folder");
    });
  };

  const handleDelete = (id: string) => {
    if (!fs) return;
    const segments = segmentsOf(id);
    const queued = pending.current.get(id);
    if (queued) clearTimeout(queued.timer);
    pending.current.delete(id);
    baseContent.current.delete(id);
    void mutate(() => removeEntry(segments));
  };

  const handleRename = (id: string, name: string) => {
    if (!fs) return;
    const from = segmentsOf(id);
    void mutate(async () => {
      await renameEntry(from, name);
      baseContent.current.delete(id);
      remapTabs(id, idOf([...from.slice(0, -1), name]));
    });
  };

  const handleMove = (id: string, newParentId: string) => {
    if (!fs || !canMove(fs, id, newParentId)) return;
    const from = segmentsOf(id);
    void mutate(async () => {
      await moveEntry(from, segmentsOf(newParentId));
      baseContent.current.delete(id);
      remapTabs(id, idOf([...segmentsOf(newParentId), from[from.length - 1]!]));
    });
  };

  /**
   * A pasted image was written straight to OPFS by the editor, bypassing
   * `mutate` — so the tree, the other tabs and the next sync all have to be
   * told, exactly as a structural change would tell them.
   */
  const handleAssetAdded = useCallback(() => {
    void refreshTree().then(() => {
      announce({ kind: "tree" });
      requestSync.current();
    });
  }, [refreshTree]);

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

  if (!fs) {
    return (
      <div className="app app-loading">
        <p>Loading…</p>
      </div>
    );
  }

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
        <span className="mobile-topbar-title">{selectedFile?.name ?? "webfs"}</span>
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
        fs={fs}
        selectedId={selectedId}
        openIds={allOpenIds(layout)}
        collapsed={collapsed}
        onToggleFolder={toggleFolder}
        onSelectFile={handleSelectFile}
        onOpenBeside={wide ? handleOpenBeside : null}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onRename={handleRename}
        onMove={handleMove}
        footer={<SyncPanel sync={sync} />}
      />
      <div className="panes">
        {/*
          Only the focused pane is rendered on a narrow screen. Hiding the
          other one in CSS wouldn't do: it would still mount a second Crepe
          instance over a second file and run its whole save loop behind a
          screen nobody can see.
        */}
        {(wide ? layout.panes : [layout.panes[layout.focused]!]).map((pane, index) => {
          const paneIndex = wide ? index : layout.focused;
          const file = pane.activeId && fs[pane.activeId]?.type === "file" ? fs[pane.activeId]! : null;
          return (
            <div
              key={paneIndex}
              className={`pane ${layout.focused === paneIndex ? "pane-focused" : ""}`}
              // Capture, so clicking into the editor focuses the pane before
              // anything inside it swallows the event.
              onPointerDownCapture={() => setLayout(prev => focusPane(prev, paneIndex))}
            >
              <TabStrip
                pane={pane}
                fs={fs}
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
                externalEdit={file ? externalEdits[file.id] ?? 0 : 0}
                onChange={handleContentChange}
                onAssetAdded={handleAssetAdded}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default App;
