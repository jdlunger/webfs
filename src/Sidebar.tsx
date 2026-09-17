import { useState } from "react";
import { type FileSystem, type FSNode, childrenOf, ROOT_ID } from "./fs";

interface SidebarProps {
  fs: FileSystem;
  selectedId: string | null;
  onSelectFile: (id: string) => void;
  onCreate: (parentId: string, type: "file" | "folder") => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
}

export function Sidebar(props: SidebarProps) {
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
      <div className="sidebar-tree">
        {childrenOf(props.fs, ROOT_ID).map(node => (
          <TreeNode key={node.id} node={node} depth={0} {...props} />
        ))}
      </div>
    </div>
  );
}

interface TreeNodeProps extends SidebarProps {
  node: FSNode;
  depth: number;
}

function TreeNode({ node, depth, fs, selectedId, onSelectFile, onCreate, onDelete, onRename }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);

  const commitRename = () => {
    setRenaming(false);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== node.name) onRename(node.id, trimmed);
    else setDraftName(node.name);
  };

  if (node.type === "folder") {
    const kids = childrenOf(fs, node.id);
    return (
      <div>
        <div
          className="tree-row tree-folder"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => setExpanded(e => !e)}
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
            <button title="New file" onClick={() => onCreate(node.id, "file")}>
              +f
            </button>
            <button title="New folder" onClick={() => onCreate(node.id, "folder")}>
              +d
            </button>
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
            onCreate={onCreate}
            onDelete={onDelete}
            onRename={onRename}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`tree-row tree-file ${selectedId === node.id ? "tree-file-selected" : ""}`}
      style={{ paddingLeft: `${depth * 16 + 24}px` }}
      onClick={() => onSelectFile(node.id)}
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
