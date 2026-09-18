import { useState, type DragEvent } from "react";
import { type FileSystem, type FSNode, ROOT_ID, childrenOf } from "./fs";

interface SidebarProps {
  fs: FileSystem;
  selectedId: string | null;
  onSelectFile: (id: string) => void;
  onCreate: (parentId: string, type: "file" | "folder") => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, newParentId: string) => void;
}

const DRAG_MIME = "application/x-webfs-node-id";

export function Sidebar(props: SidebarProps) {
  const [rootDragOver, setRootDragOver] = useState(false);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>Files</span>
        <div className="sidebar-header-actions">
          <button title="New file" onClick={() => props.onCreate(ROOT_ID, "file")}>
            + File
          </button>
          <button title="New folder" onClick={() => props.onCreate(ROOT_ID, "folder")}>
            + Folder
          </button>
        </div>
      </div>
      <div
        className={`sidebar-tree ${rootDragOver ? "drop-target" : ""}`}
        onDragOver={e => {
          if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
          e.preventDefault();
          setRootDragOver(true);
        }}
        onDragLeave={() => setRootDragOver(false)}
        onDrop={e => {
          e.preventDefault();
          setRootDragOver(false);
          const id = e.dataTransfer.getData(DRAG_MIME);
          if (id) props.onMove(id, ROOT_ID);
        }}
      >
        {childrenOf(props.fs, ROOT_ID).map(node => (
          <TreeNode
            key={node.id}
            node={node}
            depth={0}
            fs={props.fs}
            selectedId={props.selectedId}
            onSelectFile={props.onSelectFile}
            onDelete={props.onDelete}
            onRename={props.onRename}
            onMove={props.onMove}
          />
        ))}
      </div>
    </div>
  );
}

interface TreeNodeProps extends Omit<SidebarProps, "onCreate"> {
  node: FSNode;
  depth: number;
}

function TreeNode({ node, depth, fs, selectedId, onSelectFile, onDelete, onRename, onMove }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  const [dragOver, setDragOver] = useState(false);

  const commitRename = () => {
    setRenaming(false);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== node.name) onRename(node.id, trimmed);
    else setDraftName(node.name);
  };

  const dragHandlers = {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DRAG_MIME, node.id);
    },
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      e.stopPropagation();
      setDragOver(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const draggedId = e.dataTransfer.getData(DRAG_MIME);
      if (!draggedId) return;
      const destinationFolderId = node.type === "folder" ? node.id : node.parentId ?? ROOT_ID;
      onMove(draggedId, destinationFolderId);
    },
  };

  if (node.type === "folder") {
    const kids = childrenOf(fs, node.id);
    return (
      <div>
        <div
          className={`tree-row tree-folder ${dragOver ? "drop-target" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => setExpanded(e => !e)}
          {...dragHandlers}
        >
          <span className="tree-icon">{expanded ? "▾" : "▸"}</span>
          {renaming ? (
            <input
              autoFocus
              className="rename-input"
              value={draftName}
              onClick={e => e.stopPropagation()}
              onChange={e => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={e => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setDraftName(node.name);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <span
              className="tree-name"
              onDoubleClick={e => {
                e.stopPropagation();
                setRenaming(true);
              }}
            >
              {node.name}
            </span>
          )}
          <div className="tree-actions" onClick={e => e.stopPropagation()}>
            <button title="Delete" onClick={() => onDelete(node.id)}>
              ×
            </button>
          </div>
        </div>
        {expanded && kids.map(child => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            fs={fs}
            selectedId={selectedId}
            onSelectFile={onSelectFile}
            onDelete={onDelete}
            onRename={onRename}
            onMove={onMove}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`tree-row tree-file ${selectedId === node.id ? "tree-file-selected" : ""} ${dragOver ? "drop-target" : ""}`}
      style={{ paddingLeft: `${depth * 16 + 24}px` }}
      onClick={() => onSelectFile(node.id)}
      {...dragHandlers}
    >
      <span className="tree-icon">·</span>
      {renaming ? (
        <input
          autoFocus
          className="rename-input"
          value={draftName}
          onClick={e => e.stopPropagation()}
          onChange={e => setDraftName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraftName(node.name);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <span
          className="tree-name"
          onDoubleClick={e => {
            e.stopPropagation();
            setRenaming(true);
          }}
        >
          {node.name}
        </span>
      )}
      <div className="tree-actions" onClick={e => e.stopPropagation()}>
        <button title="Delete" onClick={() => onDelete(node.id)}>
          ×
        </button>
      </div>
    </div>
  );
}
