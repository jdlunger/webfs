import { useCallback, useEffect, useRef, useState } from "react";
import "./index.css";
import { type FileSystem, canMove, findFirstFile, findNodeByPath, getNodePath, idOf, segmentsOf, updateFileContent } from "./fs";
import { Sidebar } from "./Sidebar";
import { Editor } from "./Editor";
import { BASE_PATH } from "./basePath";
import { mergeText } from "./merge";
import {
  InvalidNameError,
  NameTakenError,
  announce,
  createDirectory,
  createFile,
  moveEntry,
  opfsAvailable,
  readFile,
  removeEntry,
  renameEntry,
  subscribeToChanges,
  walk,
  writeFile,
} from "./storage";
import { adoptContent, loadTree, projectTree } from "./tree";

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

function pickInitialSelection(fs: FileSystem): string | null {
  const path = stripBasePath(decodeURIComponent(window.location.pathname));
  if (path && path !== "/") {
    const match = findNodeByPath(fs, path);
    if (match && match.type === "file") return match.id;
  }
  return findFirstFile(fs)?.id ?? null;
}

export function App() {
  const [fs, setFs] = useState<FileSystem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /**
   * Bumped only when content arrives from *outside* the editor, to remount it
   * (Crepe is uncontrolled, so a remount is the one way to push content in).
   * Local typing must never bump this or every keystroke would tear it down.
   */
  const [externalEdit, setExternalEdit] = useState(0);

  // Latest values for listeners and timers registered once, which would
  // otherwise close over the first render's state.
  const fsRef = useRef<FileSystem | null>(null);
  fsRef.current = fs;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

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

  /** Follows the selection when the node it points at is renamed or moved. */
  const remapSelection = useCallback((from: string, to: string) => {
    setSelectedId(prev => (prev === from ? to : prev?.startsWith(`${from}/`) ? to + prev.slice(from.length) : prev));
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
    },
    [flushAll, refreshTree],
  );

  // Initial load.
  useEffect(() => {
    if (!opfsAvailable()) {
      setFailure("This browser can't store files: it lacks OPFS write support (createWritable).");
      return;
    }
    let cancelled = false;
    void loadTree()
      .then(tree => {
        if (cancelled) return;
        setFs(tree);
        setSelectedId(pickInitialSelection(tree));
      })
      .catch((err: Error) => {
        if (!cancelled) setFailure(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Read the selected file's text the first time it's opened.
  useEffect(() => {
    if (!fs || !selectedId) return;
    const node = fs[selectedId];
    if (!node || node.type !== "file" || node.content !== undefined) return;

    let cancelled = false;
    const segments = segmentsOf(selectedId);
    void readFile(segments).then(stored => {
      if (cancelled) return;
      const content = stored ?? "";
      baseContent.current.set(selectedId, content);
      setFs(prev => (prev ? updateFileContent(prev, selectedId, content) : prev));
    });
    return () => {
      cancelled = true;
    };
  }, [fs, selectedId]);

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
          const mine = fsRef.current?.[id]?.content;
          if (mine === undefined) return;

          const merged = mine === theirs ? theirs : mergeText(baseContent.current.get(id) ?? mine, mine, theirs);
          baseContent.current.set(id, theirs);

          if (merged !== mine) {
            setFs(prev => (prev ? updateFileContent(prev, id, merged) : prev));
            if (id === selectedRef.current) setExternalEdit(n => n + 1);
          }
          // Push the reconciled text back so the other tab converges too.
          // Merging is stable, so this settles rather than ping-ponging.
          if (merged !== theirs) scheduleWrite(id, merged);
        });
      }),
    [refreshTree, scheduleWrite],
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

  useEffect(() => {
    if (!fs) return;
    const path = BASE_PATH + (selectedId ? getNodePath(selectedId) : "/");
    if (decodeURIComponent(window.location.pathname) !== path) {
      window.history.replaceState(null, "", path);
    }
  }, [fs, selectedId]);

  const selectedFile = selectedId && fs?.[selectedId]?.type === "file" ? fs[selectedId] : null;

  const handleSelectFile = (id: string) => {
    setSelectedId(id);
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
    if (selectedId === id) setSelectedId(null);
    void mutate(() => removeEntry(segments));
  };

  const handleRename = (id: string, name: string) => {
    if (!fs) return;
    const from = segmentsOf(id);
    void mutate(async () => {
      await renameEntry(from, name);
      baseContent.current.delete(id);
      remapSelection(id, idOf([...from.slice(0, -1), name]));
    });
  };

  const handleMove = (id: string, newParentId: string) => {
    if (!fs || !canMove(fs, id, newParentId)) return;
    const from = segmentsOf(id);
    void mutate(async () => {
      await moveEntry(from, segmentsOf(newParentId));
      baseContent.current.delete(id);
      remapSelection(id, idOf([...segmentsOf(newParentId), from[from.length - 1]!]));
    });
  };

  const handleContentChange = (content: string) => {
    if (!selectedId) return;
    setFs(prev => (prev ? updateFileContent(prev, selectedId, content) : prev));
    scheduleWrite(selectedId, content);
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
      </div>
      <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
      <Sidebar
        fs={fs}
        selectedId={selectedId}
        onSelectFile={handleSelectFile}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onRename={handleRename}
        onMove={handleMove}
      />
      <Editor file={selectedFile} externalEdit={externalEdit} onChange={handleContentChange} />
    </div>
  );
}

export default App;
