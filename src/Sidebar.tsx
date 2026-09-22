import { useCallback, useState, type DragEvent, type ReactNode } from "react";
import { type FileSystem, type FSNode, ROOT_ID, childrenOf } from "./fs";
import { ContextMenu, useContextMenuTrigger, type MenuItem, type MenuPosition } from "./ContextMenu";

interface SidebarProps {
  fs: FileSystem;
  /** The file the focused pane is showing. */
  selectedId: string | null;
  /** Every open file, so tabs in the other pane are marked in the tree too. */
  openIds: string[];
  onSelectFile: (id: string) => void;
  /** Opens a file in the other pane. Null on narrow screens, which don't split. */
  onOpenBeside: ((id: string) => void) | null;
  onCreate: (parentId: string, type: "file" | "folder") => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, newParentId: string) => void;
  /** Rendered under the tree — the GitHub sync strip. */
  footer?: ReactNode;
}

const DRAG_MIME = "application/x-webfs-node-id";

interface MoveTarget {
  id: string;
  label: string;
}

// Drag-and-drop (used below) has no touch equivalent on mobile Safari, so the
// context menu carries a "Move to…" submenu listing every folder it could go
// to, which works by tap or click just as well.
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

/** An open menu: `node` is null for the one the empty tree area opens. */
interface OpenMenu {
  node: FSNode | null;
  position: MenuPosition;
}

export function Sidebar(props: SidebarProps) {
  const [rootDragOver, setRootDragOver] = useState(false);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // Held here rather than in the row, so the menu can start a rename and so
  // two rows can't end up editing at once.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  const openNodeMenu = useCallback((node: FSNode, position: MenuPosition) => setMenu({ node, position }), []);
  const backgroundTrigger = useContextMenuTrigger(
    useCallback((position: MenuPosition) => setMenu({ node: null, position }), []),
  );

  const menuItems = (node: FSNode | null): MenuItem[] => {
    if (!node) {
      return [
        { label: "New File", onSelect: () => props.onCreate(ROOT_ID, "file") },
        { label: "New Folder", onSelect: () => props.onCreate(ROOT_ID, "folder") },
      ];
    }

    const items: MenuItem[] = [];
    if (node.type === "folder") {
      items.push({ label: "New File", onSelect: () => props.onCreate(node.id, "file") });
      items.push({ label: "New Folder", onSelect: () => props.onCreate(node.id, "folder") });
    } else {
      items.push({ label: "Open", onSelect: () => props.onSelectFile(node.id) });
      if (props.onOpenBeside) {
        items.push({ label: "Open to the Side", onSelect: () => props.onOpenBeside?.(node.id) });
      }
    }
    items.push({ label: "Rename", dividerBefore: true, onSelect: () => setRenamingId(node.id) });
    items.push({
      label: "Move to…",
      submenu: listMoveTargets(props.fs, node).map(target => ({
        label: target.label,
        onSelect: () => props.onMove(node.id, target.id),
      })),
    });
    items.push({ label: "Delete", dividerBefore: true, danger: true, onSelect: () => props.onDelete(node.id) });
    return items;
  };

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
        {...backgroundTrigger}
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
            openIds={props.openIds}
            renamingId={renamingId}
            onSelectFile={props.onSelectFile}
            onRename={props.onRename}
            onMove={props.onMove}
            onStartRename={setRenamingId}
            onOpenMenu={openNodeMenu}
          />
        ))}
      </div>
      {props.footer}
      {menu ? <ContextMenu position={menu.position} items={menuItems(menu.node)} onClose={closeMenu} /> : null}
    </div>
  );
}

interface TreeNodeProps {
  node: FSNode;
  depth: number;
  fs: FileSystem;
  selectedId: string | null;
  openIds: string[];
  renamingId: string | null;
  onSelectFile: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, newParentId: string) => void;
  onStartRename: (id: string | null) => void;
  onOpenMenu: (node: FSNode, position: MenuPosition) => void;
}

function TreeNode(props: TreeNodeProps) {
  const { node, depth, fs, selectedId, openIds, renamingId, onSelectFile, onRename, onMove, onStartRename } = props;
  const [expanded, setExpanded] = useState(true);
  const [draftName, setDraftName] = useState(node.name);
  const [dragOver, setDragOver] = useState(false);

  const renaming = renamingId === node.id;
  const menuTrigger = useContextMenuTrigger(
    useCallback((position: MenuPosition) => props.onOpenMenu(node, position), [props.onOpenMenu, node]),
  );

  const startRename = () => {
    setDraftName(node.name);
    onStartRename(node.id);
  };

  const commitRename = () => {
    onStartRename(null);
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
          onStartRename(null);
        }
      }}
    />
  ) : (
    <span
      className="tree-name"
      onDoubleClick={e => {
        e.stopPropagation();
        startRename();
      }}
    >
      {node.name}
    </span>
  );

  // The rename input owns the pointer while it's up: a long press inside it
  // would otherwise steal the caret placement it's there for.
  const rowTrigger = renaming ? {} : menuTrigger;

  if (node.type === "folder") {
    const kids = childrenOf(fs, node.id);
    return (
      <div>
        <div
          className={`tree-row tree-folder ${dragOver ? "drop-target" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => setExpanded(e => !e)}
          {...rowTrigger}
          {...dragHandlers}
        >
          <span className="tree-icon">{expanded ? "▾" : "▸"}</span>
          {nameSection}
        </div>
        {expanded &&
          kids.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              fs={fs}
              selectedId={selectedId}
              openIds={openIds}
              renamingId={renamingId}
              onSelectFile={onSelectFile}
              onRename={onRename}
              onMove={onMove}
              onStartRename={onStartRename}
              onOpenMenu={props.onOpenMenu}
            />
          ))}
      </div>
    );
  }

  const classes = [
    "tree-row",
    "tree-file",
    selectedId === node.id ? "tree-file-selected" : "",
    selectedId !== node.id && openIds.includes(node.id) ? "tree-file-open" : "",
    dragOver ? "drop-target" : "",
  ];

  return (
    <div
      className={classes.filter(Boolean).join(" ")}
      style={{ paddingLeft: `${depth * 16 + 24}px` }}
      onClick={() => onSelectFile(node.id)}
      {...rowTrigger}
      {...dragHandlers}
    >
      <span className="tree-icon">·</span>
      {nameSection}
    </div>
  );
}
