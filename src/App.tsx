import { useCallback, useEffect, useRef, useState } from "react";
import "./index.css";
import {
  type FileSystem,
  createNode,
  deleteNode,
  findFirstFile,
  findNodeByPath,
  getNodePath,
  moveNode,
  nodeAndDescendants,
  renameNode,
  updateFileContent,
} from "./fs";
import { Sidebar } from "./Sidebar";
import { Editor } from "./Editor";
import { BASE_PATH } from "./basePath";
import { mergeText } from "./merge";
import {
  announce,
  deleteFileContents,
  readFileContent,
  readTree,
  subscribeToChanges,
  writeFileContent,
  writeTree,
} from "./storage";

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
  if (fs["notes-welcome"]) return "notes-welcome";
  return findFirstFile(fs)?.id ?? null;
}

/**
 * Applies a tree another tab wrote without discarding content this tab has
 * already loaded — the stored tree deliberately carries no content.
 */
function adoptTree(previous: FileSystem | null, incoming: FileSystem): FileSystem {
  const next: FileSystem = {};
  for (const node of Object.values(incoming)) {
    const loaded = previous?.[node.id]?.content;
    next[node.id] = loaded === undefined ? node : { ...node, content: loaded };
  }
  return next;
}

export function App() {
  const [fs, setFs] = useState<FileSystem | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /**
   * Bumped only when content arrives from *outside* the editor, to remount it
   * (see Editor.tsx — it's uncontrolled, so a remount is the one way to push
   * content in). Local typing must never bump this or every keystroke would
   * tear down the editor.
   */
  const [externalEdit, setExternalEdit] = useState(0);

  // Latest values for use inside listeners and timers, which are registered
  // once and would otherwise close over the first render's state.
  const fsRef = useRef<FileSystem | null>(null);
  fsRef.current = fs;
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  /** Content as last seen on disk — the common ancestor for three-way merges. */
  const baseContent = useRef(new Map<string, string>());
  const pendingWrites = useRef(new Map<string, string>());
  const writeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const flushWrite = useCallback(async (id: string) => {
    writeTimers.current.delete(id);
    const content = pendingWrites.current.get(id);
    if (content === undefined) return;

    const result = await writeFileContent(id, content);
    if (result === "busy") {
      // Another tab is mid-save. Nothing is lost; just come back to it.
      writeTimers.current.set(
        id,
        setTimeout(() => void flushWrite(id), WRITE_RETRY_MS),
      );
      return;
    }
    // Leave anything typed while the write was in flight queued for next time.
    if (pendingWrites.current.get(id) === content) pendingWrites.current.delete(id);
    baseContent.current.set(id, content);
    announce({ kind: "file", id });
  }, []);

  const scheduleWrite = useCallback(
    (id: string, content: string) => {
      pendingWrites.current.set(id, content);
      const existing = writeTimers.current.get(id);
      if (existing) clearTimeout(existing);
      writeTimers.current.set(
        id,
        setTimeout(() => void flushWrite(id), WRITE_DEBOUNCE_MS),
      );
    },
    [flushWrite],
  );

  const treeRetry = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Persists the tree, retrying if another tab holds the lock — a dropped
   * write here would silently lose a create, rename, move or delete.
   *
   * Note the tree is still written whole, so two tabs restructuring at the
   * same instant is last-writer-wins. Splitting storage per file protects
   * file *contents*, not the shape of the tree.
   */
  const persistTree = useCallback(function persist(next: FileSystem) {
    void writeTree(next).then(result => {
      if (result === "ok") {
        announce({ kind: "tree" });
        return;
      }
      if (treeRetry.current) clearTimeout(treeRetry.current);
      // Retry with whatever the tree looks like by then, not the stale copy.
      treeRetry.current = setTimeout(() => persist(fsRef.current ?? next), WRITE_RETRY_MS);
    });
  }, []);

  const commitTree = useCallback(
    (next: FileSystem) => {
      setFs(next);
      persistTree(next);
    },
    [persistTree],
  );

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    void readTree().then(tree => {
      if (cancelled) return;
      setFs(tree);
      setSelectedId(pickInitialSelection(tree));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pull in the selected file's content the first time it's opened.
  useEffect(() => {
    if (!fs || !selectedId) return;
    const node = fs[selectedId];
    if (!node || node.type !== "file" || node.content !== undefined) return;

    let cancelled = false;
    void readFileContent(selectedId).then(stored => {
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
          void readTree().then(tree => setFs(prev => adoptTree(prev, tree)));
          return;
        }

        const { id } = message;
        // Only files this tab has actually loaded need reconciling; anything
        // else is read fresh whenever it's next opened.
        if (fsRef.current?.[id]?.content === undefined) return;

        void readFileContent(id).then(stored => {
          const theirs = stored ?? "";
          const mine = fsRef.current?.[id]?.content;
          if (mine === undefined) return;

          const merged = mine === theirs ? theirs : mergeText(baseContent.current.get(id) ?? mine, mine, theirs);
          baseContent.current.set(id, theirs);

          if (merged !== mine) {
            setFs(prev => (prev ? updateFileContent(prev, id, merged) : prev));
            if (id === selectedRef.current) setExternalEdit(n => n + 1);
          }
          // Push the reconciled text back so the other tab converges on it too.
          // Merging is stable, so this settles rather than ping-ponging.
          if (merged !== theirs) scheduleWrite(id, merged);
        });
      }),
    [scheduleWrite],
  );

  // Don't let a debounced save die with the tab. Best-effort: the write is
  // async, so a page torn down immediately can still lose the last few
  // hundred milliseconds of typing.
  useEffect(() => {
    const flushAll = () => {
      for (const id of [...pendingWrites.current.keys()]) void flushWrite(id);
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
    const path = BASE_PATH + (selectedId ? getNodePath(fs, selectedId) : "/");
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
    commitTree(createNode(fs, parentId, type, type === "file" ? "untitled.md" : "New Folder"));
  };

  const handleDelete = (id: string) => {
    if (!fs) return;
    const removed = nodeAndDescendants(fs, id);
    commitTree(deleteNode(fs, id));
    for (const node of removed) {
      baseContent.current.delete(node.id);
      pendingWrites.current.delete(node.id);
      const timer = writeTimers.current.get(node.id);
      if (timer) clearTimeout(timer);
      writeTimers.current.delete(node.id);
    }
    void deleteFileContents(removed);
    if (selectedId === id) setSelectedId(null);
  };

  const handleRename = (id: string, name: string) => {
    if (fs) commitTree(renameNode(fs, id, name));
  };

  const handleMove = (id: string, newParentId: string) => {
    if (fs) commitTree(moveNode(fs, id, newParentId));
  };

  const handleContentChange = (content: string) => {
    if (!selectedId) return;
    setFs(prev => (prev ? updateFileContent(prev, selectedId, content) : prev));
    scheduleWrite(selectedId, content);
  };

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
