import { useEffect, useState } from "react";
import "./index.css";
import {
  type FileSystem,
  createNode,
  deleteNode,
  findFirstFile,
  findNodeByPath,
  getNodePath,
  loadFileSystem,
  moveNode,
  renameNode,
  saveFileSystem,
  updateFileContent,
} from "./fs";
import { Sidebar } from "./Sidebar";
import { Editor } from "./Editor";

function pickInitialSelection(fs: FileSystem): string | null {
  const path = decodeURIComponent(window.location.pathname);
  if (path && path !== "/") {
    const match = findNodeByPath(fs, path);
    if (match && match.type === "file") return match.id;
  }
  if (fs["notes-welcome"]) return "notes-welcome";
  return findFirstFile(fs)?.id ?? null;
}

export function App() {
  const [fs, setFs] = useState<FileSystem>(() => loadFileSystem());
  const [selectedId, setSelectedId] = useState<string | null>(() => pickInitialSelection(fs));
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    saveFileSystem(fs);
  }, [fs]);

  useEffect(() => {
    const path = selectedId ? getNodePath(fs, selectedId) : "/";
    if (decodeURIComponent(window.location.pathname) !== path) {
      window.history.replaceState(null, "", path);
    }
  }, [fs, selectedId]);

  const selectedFile = selectedId && fs[selectedId]?.type === "file" ? fs[selectedId] : null;

  const handleSelectFile = (id: string) => {
    setSelectedId(id);
    setSidebarOpen(false);
  };

  const handleCreate = (parentId: string, type: "file" | "folder") => {
    const name = type === "file" ? "untitled.md" : "New Folder";
    setFs(prev => {
      const next = createNode(prev, parentId, type, name);
      return next;
    });
  };

  const handleDelete = (id: string) => {
    setFs(prev => deleteNode(prev, id));
    if (selectedId === id) setSelectedId(null);
  };

  const handleRename = (id: string, name: string) => {
    setFs(prev => renameNode(prev, id, name));
  };

  const handleMove = (id: string, newParentId: string) => {
    setFs(prev => moveNode(prev, id, newParentId));
  };

  const handleContentChange = (content: string) => {
    if (!selectedId) return;
    setFs(prev => updateFileContent(prev, selectedId, content));
  };

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
      <Editor file={selectedFile} onChange={handleContentChange} />
    </div>
  );
}

export default App;
