import { useEffect, useState } from "react";
import "./index.css";
import {
  type FileSystem,
  createNode,
  deleteNode,
  loadFileSystem,
  renameNode,
  saveFileSystem,
  updateFileContent,
} from "./fs";
import { Sidebar } from "./Sidebar";
import { Editor } from "./Editor";

export function App() {
  const [fs, setFs] = useState<FileSystem>(() => loadFileSystem());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    saveFileSystem(fs);
  }, [fs]);

  const selectedFile = selectedId && fs[selectedId]?.type === "file" ? fs[selectedId] : null;

  const handleCreate = (parentId: string, type: "file" | "folder") => {
    const name = type === "file" ? "untitled.txt" : "New Folder";
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

  const handleContentChange = (content: string) => {
    if (!selectedId) return;
    setFs(prev => updateFileContent(prev, selectedId, content));
  };

  return (
    <div className="app">
      <Sidebar
        fs={fs}
        selectedId={selectedId}
        onSelectFile={setSelectedId}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onRename={handleRename}
      />
      <Editor file={selectedFile} onChange={handleContentChange} />
    </div>
  );
}

export default App;
