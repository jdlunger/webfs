import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  type FileSystem,
  type FSNode,
  type CreatedAt,
  type SortBy,
  ROOT_ID,
  SORT_LABELS,
  childrenOf,
  searchTree,
} from "./fs";
import { ContextMenu, useContextMenuTrigger, type MenuItem, type MenuPosition } from "./ContextMenu";
import { WIDE_SCREEN, useMediaQuery } from "./useMediaQuery";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from "./sidebarWidth";

interface SidebarProps {
  fs: FileSystem;
  /** The file the focused pane is showing. */
  selectedId: string | null;
  /** Every open file, so tabs in the other pane are marked in the tree too. */
  openIds: string[];
  /**
   * Folder ids drawn closed. Held by `App.tsx` rather than by each row: it
   * outlives the rows, which are rebuilt on every tree refresh, and it is
   * remembered across reloads (`workspace.ts`).
   */
  collapsed: ReadonlySet<string>;
  onToggleFolder: (id: string) => void;
  /**
   * The order a folder's files are listed in. Held by `App.tsx` for the same
   * reason `collapsed` is: it outlives the rows and is remembered per drive.
   */
  sortBy: SortBy;
  /** When each file first appeared here; only the "Created" orders read it. */
  created: CreatedAt;
  onChangeSort: (sortBy: SortBy) => void;
  onSelectFile: (id: string) => void;
  /** Opens a file in the other pane. Null on narrow screens, which don't split. */
  onOpenBeside: ((id: string) => void) | null;
  onCreate: (parentId: string, type: "file" | "folder") => void;
  /** Writes files chosen on this device into a folder. */
  onImport: (parentId: string, files: readonly File[]) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, newParentId: string) => void;
  /** Rendered under the tree — the GitHub sync strip. */
  footer?: ReactNode;
}

const DRAG_MIME = "application/x-webfs-node-id";

/**
 * Whether a drag is carrying files from outside the browser rather than a row
 * from this tree. The two land on the same handlers and mean opposite things:
 * one is a move within the drive, the other is an import into it.
 */
const carriesFiles = (transfer: DataTransfer) => transfer.types.includes("Files");

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

/** How far one arrow key nudges the edge. */
const KEYBOARD_STEP = 16;

/**
 * The sidebar's width, restored from localStorage and re-clamped against the
 * window: a width saved on a wide monitor would otherwise leave no editor
 * when the same store is opened on a laptop. Only a deliberate drag is
 * written back, so shrinking the window doesn't overwrite the width the user
 * chose — widen it again and a reload brings that width back.
 */
function useSidebarWidth(wide: boolean) {
  const [width, setWidth] = useState(() => loadSidebarWidth(window.innerWidth));

  useEffect(() => {
    if (!wide) return;
    const onResize = () => setWidth(current => clampSidebarWidth(current, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [wide]);

  return [width, setWidth] as const;
}

interface ResizerProps {
  width: number;
  onWidth: (width: number) => void;
}

/**
 * The drag handle on the sidebar's right edge. Pointer events with capture
 * rather than window listeners, so a fast drag that outruns the cursor still
 * reports to the handle, and so a pointer lost to the OS (an alt-tab, a
 * cancelled touch) ends the drag by itself.
 *
 * It's a `separator` and it takes focus: the whole point of persisting a
 * width is that someone cares about it, and a drag handle is the one control
 * here that a keyboard otherwise couldn't reach at all.
 */
function SidebarResizer({ width, onWidth }: ResizerProps) {
  const start = useRef<{ x: number; width: number } | null>(null);

  const stop = () => {
    if (!start.current) return;
    start.current = null;
    // Selection is suppressed for the duration rather than only on the
    // handle: the pointer spends the drag over the editor, which is
    // contenteditable and would happily select text under it.
    document.body.classList.remove("resizing-sidebar");
    saveSidebarWidth(width);
  };

  const commit = (next: number) => {
    onWidth(next);
    saveSidebarWidth(next);
  };

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        document.body.classList.add("resizing-sidebar");
      }}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        if (!start.current) return;
        onWidth(clampSidebarWidth(start.current.width + e.clientX - start.current.x, window.innerWidth));
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => commit(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, window.innerWidth))}
      onKeyDown={e => {
        const step = e.key === "ArrowLeft" ? -KEYBOARD_STEP : e.key === "ArrowRight" ? KEYBOARD_STEP : 0;
        if (!step) return;
        e.preventDefault();
        commit(clampSidebarWidth(width + step, window.innerWidth));
      }}
    />
  );
}

/**
 * An open menu. Three of them share one slot because only one can be up at a
 * time: a row's, the one the empty tree area opens, and the sort picker —
 * which is a menu rather than a `<select>` so it can mark the order in effect
 * and size its rows for a fingertip like every other menu here.
 */
type OpenMenu =
  | { kind: "node"; node: FSNode; position: MenuPosition }
  | { kind: "background"; position: MenuPosition }
  | { kind: "sort"; position: MenuPosition };

/** Opens a menu under a button, rather than at a pointer that has no position. */
function menuPositionBelow(button: HTMLElement | null): MenuPosition {
  const box = button?.getBoundingClientRect();
  return box ? { x: box.left, y: box.bottom + 4 } : { x: 0, y: 0 };
}

export function Sidebar(props: SidebarProps) {
  const wide = useMediaQuery(WIDE_SCREEN);
  const [width, setWidth] = useSidebarWidth(wide);
  const [rootDragOver, setRootDragOver] = useState(false);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // Held here rather than in the row, so the menu can start a rename and so
  // two rows can't end up editing at once.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // A search is deliberately *not* remembered across reloads, unlike the sort
  // order: filtering the tree is something you do for a moment, and coming
  // back to a tree with most of it missing and no memory of why is worse than
  // typing the query again.
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const sortButton = useRef<HTMLButtonElement>(null);

  /**
   * One file input for the whole tree, told which folder to import into.
   *
   * A hidden `<input type="file">` rather than the File System Access API's
   * picker: this has to work in Safari, which doesn't have that one, and the
   * bytes are all either way. It lives outside the menu it's opened from,
   * because the menu unmounts on the click that opens the picker and would
   * take the input with it before a file was ever chosen.
   */
  const fileInput = useRef<HTMLInputElement>(null);
  const importInto = useRef<string>(ROOT_ID);
  const chooseFiles = (parentId: string) => {
    importInto.current = parentId;
    fileInput.current?.click();
  };

  // Null when nothing is typed, which is what tells every row below to draw
  // the whole tree rather than a filtered one.
  const visible = useMemo(() => searchTree(props.fs, query), [props.fs, query]);

  const closeMenu = useCallback(() => setMenu(null), []);
  const openNodeMenu = useCallback((node: FSNode, position: MenuPosition) => setMenu({ kind: "node", node, position }), []);
  const backgroundTrigger = useContextMenuTrigger(
    useCallback((position: MenuPosition) => setMenu({ kind: "background", position }), []),
  );

  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  const menuItems = (open: OpenMenu): MenuItem[] => {
    if (open.kind === "sort") {
      return (Object.keys(SORT_LABELS) as SortBy[]).map(value => ({
        label: SORT_LABELS[value],
        selected: value === props.sortBy,
        onSelect: () => props.onChangeSort(value),
      }));
    }
    if (open.kind === "background") {
      return [
        { label: "New File", onSelect: () => props.onCreate(ROOT_ID, "file") },
        { label: "New Folder", onSelect: () => props.onCreate(ROOT_ID, "folder") },
        { label: "Import Files…", onSelect: () => chooseFiles(ROOT_ID) },
      ];
    }

    const node = open.node;
    const items: MenuItem[] = [];
    if (node.type === "folder") {
      items.push({ label: "New File", onSelect: () => props.onCreate(node.id, "file") });
      items.push({ label: "New Folder", onSelect: () => props.onCreate(node.id, "folder") });
      items.push({ label: "Import Files…", onSelect: () => chooseFiles(node.id) });
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
    // The width is a custom property rather than an inline `width`, because
    // the drawer the sidebar becomes below 768px is sized by CSS and an
    // inline width would win over it. There, the var is simply not read.
    <div className="sidebar" style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
      <div className="sidebar-header">
        <span>Files</span>
        <div className="sidebar-header-actions">
          <button
            className={`icon-button ${searching ? "icon-button-active" : ""}`}
            title="Search files"
            aria-label="Search files"
            aria-pressed={searching}
            onClick={() => (searching ? closeSearch() : setSearching(true))}
          >
            🔍
          </button>
          <button
            ref={sortButton}
            className="icon-button"
            title={`Sort by: ${SORT_LABELS[props.sortBy]}`}
            aria-label={`Sort by: ${SORT_LABELS[props.sortBy]}`}
            onClick={() => setMenu({ kind: "sort", position: menuPositionBelow(sortButton.current) })}
          >
            ⇅
          </button>
          <button title="New file" onClick={() => props.onCreate(ROOT_ID, "file")}>
            + File
          </button>
          <button title="New folder" onClick={() => props.onCreate(ROOT_ID, "folder")}>
            + Folder
          </button>
        </div>
      </div>
      {searching ? (
        <div className="sidebar-search">
          <input
            autoFocus
            // Not type="search": Chromium draws its own clear button inside
            // the field, right beside the one next to it.
            type="text"
            className="sidebar-search-input"
            placeholder="Filter by name…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            // Escape closes the field rather than only emptying it: an empty
            // search box left open is a row of chrome doing nothing.
            onKeyDown={e => {
              if (e.key === "Escape") closeSearch();
            }}
          />
          <button className="icon-button" title="Close search" aria-label="Close search" onClick={closeSearch}>
            ✕
          </button>
        </div>
      ) : null}
      <div
        className={`sidebar-tree ${rootDragOver ? "drop-target" : ""}`}
        {...backgroundTrigger}
        onDragOver={e => {
          if (!e.dataTransfer.types.includes(DRAG_MIME) && !carriesFiles(e.dataTransfer)) return;
          e.preventDefault();
          setRootDragOver(true);
        }}
        onDragLeave={() => setRootDragOver(false)}
        onDrop={e => {
          e.preventDefault();
          setRootDragOver(false);
          // Files from outside the browser are an import; anything else is a
          // row of this tree being moved.
          if (carriesFiles(e.dataTransfer)) {
            props.onImport(ROOT_ID, [...e.dataTransfer.files]);
            return;
          }
          const id = e.dataTransfer.getData(DRAG_MIME);
          if (id) props.onMove(id, ROOT_ID);
        }}
      >
        {childrenOf(props.fs, ROOT_ID, props.sortBy, props.created)
          .filter(node => !visible || visible.has(node.id))
          .map(node => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              fs={props.fs}
              selectedId={props.selectedId}
              openIds={props.openIds}
              collapsed={props.collapsed}
              sortBy={props.sortBy}
              created={props.created}
              visible={visible}
              renamingId={renamingId}
              onToggleFolder={props.onToggleFolder}
              onSelectFile={props.onSelectFile}
              onRename={props.onRename}
              onMove={props.onMove}
              onImport={props.onImport}
              onStartRename={setRenamingId}
              onOpenMenu={openNodeMenu}
            />
          ))}
        {visible && visible.size === 0 ? <p className="sidebar-empty">No files match “{query.trim()}”.</p> : null}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        className="import-input"
        onChange={event => {
          const files = [...(event.target.files ?? [])];
          // Cleared before the import runs, so picking the same file again
          // still fires a change event — the input keeps its value otherwise
          // and the second attempt does nothing at all.
          event.target.value = "";
          props.onImport(importInto.current, files);
        }}
      />
      {props.footer}
      {/* No handle on a phone: the sidebar is a fixed-width drawer there, and
          a drag target down its edge would fight the tree's own scrolling. */}
      {wide ? <SidebarResizer width={width} onWidth={setWidth} /> : null}
      {menu ? <ContextMenu position={menu.position} items={menuItems(menu)} onClose={closeMenu} /> : null}
    </div>
  );
}

interface TreeNodeProps {
  node: FSNode;
  depth: number;
  fs: FileSystem;
  selectedId: string | null;
  openIds: string[];
  collapsed: ReadonlySet<string>;
  sortBy: SortBy;
  created: CreatedAt;
  /** Ids a search left standing, or null when nothing is being searched for. */
  visible: ReadonlySet<string> | null;
  renamingId: string | null;
  onToggleFolder: (id: string) => void;
  onSelectFile: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, newParentId: string) => void;
  onImport: (parentId: string, files: readonly File[]) => void;
  onStartRename: (id: string | null) => void;
  onOpenMenu: (node: FSNode, position: MenuPosition) => void;
}

function TreeNode(props: TreeNodeProps) {
  const { node, depth, fs, selectedId, openIds, collapsed, sortBy, created, visible, renamingId, onSelectFile, onRename, onMove, onImport, onStartRename } =
    props;
  // A folder is open unless it's been closed, so a folder that appears later —
  // created here, or pulled by a sync — shows its contents rather than hiding
  // them behind a state nobody chose.
  //
  // A search overrides that outright: a collapsed folder hiding a match would
  // defeat the thing entirely. `collapsed` isn't touched, so clearing the
  // query leaves the tree folded exactly as it was.
  const expanded = visible !== null || !collapsed.has(node.id);
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
      if (!e.dataTransfer.types.includes(DRAG_MIME) && !carriesFiles(e.dataTransfer)) return;
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
      // A file row stands for its folder here, the same way it does for a
      // move: dropping onto `todo.md` means "next to todo.md".
      const destinationFolderId = node.type === "folder" ? node.id : node.parentId ?? ROOT_ID;
      if (carriesFiles(e.dataTransfer)) {
        onImport(destinationFolderId, [...e.dataTransfer.files]);
        return;
      }
      const draggedId = e.dataTransfer.getData(DRAG_MIME);
      if (!draggedId) return;
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
    const kids = childrenOf(fs, node.id, sortBy, created).filter(child => !visible || visible.has(child.id));
    return (
      <div>
        <div
          className={`tree-row tree-folder ${dragOver ? "drop-target" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          // While searching, what is shown is the search's decision, so the
          // chevron is a label rather than a control — a click that visibly
          // did nothing would be worse than one that isn't offered.
          onClick={visible === null ? () => props.onToggleFolder(node.id) : undefined}
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
              collapsed={collapsed}
              sortBy={sortBy}
              created={created}
              visible={visible}
              renamingId={renamingId}
              onToggleFolder={props.onToggleFolder}
              onSelectFile={onSelectFile}
              onRename={onRename}
              onMove={onMove}
              onImport={onImport}
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
