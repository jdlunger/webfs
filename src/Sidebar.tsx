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

interface MoveTarget {
  id: string;
  label: string;
}

// Drag-and-drop (used below) has no touch equivalent on mobile Safari, so
// this gives every row a "Move to…" picker that works by tap or click too.
function listMoveTargets(fs: FileSystem, node: FSNode): MoveTarget[] {
  const blocked = new Set<string>();
  if (node.type === "folder") {
    const collectDescendantFolders = (id: string) => {
      blocked.add(id);
      for (const child of childrenOf(fs, id)) {
        if (child.type === "folder") collectDescendantFolders(child.id);
      }
    };
    collectDescendantFolders(node.id);
  }

  const targets: MoveTarget[] = [];
  if (!blocked.has(ROOT_ID) && node.parentId !== ROOT_ID) {
    targets.push({ id: ROOT_ID, label: "/" });
  }
  const walk = (parentId: string, path: string) => {
    for (const child of childrenOf(fs, parentId)) {
      if (child.type !== "folder") continue;
      if (!blocked.has(child.id) && child.id !== node.parentId) {
        targets.push({ id: child.id, label: `${path}${child.name}` });
      }
      walk(child.id, `${path}${child.name}/`);
    }
  };
  walk(ROOT_ID, "/");
  return targets;
}

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
  const [actionsOpen, setActionsOpen] = useState(false);

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

  const nameSection = renaming ? (
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
  );

  const actionsSection = renaming ? null : (
    <div className="tree-actions" onClick={e => e.stopPropagation()}>
      {actionsOpen ? (
        <>
          <button
            title="Rename"
            onClick={() => {
              setRenaming(true);
              setActionsOpen(false);
            }}
          >
            ✎
          </button>
          <select
            className="tree-move-select"
            title="Move to…"
            value=""
            onChange={e => {
              const targetId = e.target.value;
              if (targetId) onMove(node.id, targetId);
              setActionsOpen(false);
            }}
          >
            <option value="" disabled>
              ⇄
            </option>
            {listMoveTargets(fs, node).map(target => (
              <option key={target.id} value={target.id}>
                {target.label}
              </option>
            ))}
          </select>
          <button
            title="Delete"
            onClick={() => {
              setActionsOpen(false);
              onDelete(node.id);
            }}
          >
            ×
          </button>
        </>
      ) : (
        <button title="More actions" onClick={() => setActionsOpen(true)}>
          ⋯
        </button>
      )}
    </div>
  );

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
          {nameSection}
          {actionsSection}
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
      {nameSection}
      {actionsSection}
    </div>
  );
}
