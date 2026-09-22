import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";

/**
 * The menu the sidebar opens on right-click or long-press.
 *
 * It replaces the per-row `⋯` button that used to hold rename/move/delete.
 * That button had to live in the row, so every row paid for it: on a phone the
 * actions were forced visible and crushed the file names down to a few
 * characters. A menu is summoned instead, so the row is just the name again.
 */
export interface MenuItem {
  label: string;
  onSelect?: () => void;
  /** Opens to the side rather than running anything (see "Move to…"). */
  submenu?: MenuItem[];
  /** Draws a separator above this item. */
  dividerBefore?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuPosition {
  x: number;
  y: number;
}

/** Gap kept between the menu and the edge of the window when it's clamped. */
const VIEWPORT_MARGIN = 8;

export function ContextMenu({
  position,
  items,
  onClose,
}: {
  position: MenuPosition;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number; flip: boolean }>({
    left: position.x,
    top: position.y,
    flip: false,
  });
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);

  // Before paint, so a menu opened near an edge never shows in the wrong place
  // first: its own size isn't known until it's in the document.
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(position.x, maxLeft));
    const top = Math.max(VIEWPORT_MARGIN, Math.min(position.y, maxTop));
    // A submenu opens to the right unless there's no room for one there.
    setPlacement({ left, top, flip: left + width + SUBMENU_WIDTH + VIEWPORT_MARGIN > window.innerWidth });
  }, [position.x, position.y, items]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // The menu is anchored to a point in the viewport, not to the row, so
    // anything that moves the row out from under it has to dismiss it.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Portalled to the body: the mobile sidebar is `transform`ed, which makes it
  // the containing block for anything `position: fixed` inside it — the menu
  // would be clipped to the drawer and slide away with it.
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      style={{ left: placement.left, top: placement.top }}
      onContextMenu={event => event.preventDefault()}
    >
      {items.map((item, index) => (
        <MenuRow
          key={`${item.label}:${index}`}
          item={item}
          flip={placement.flip}
          open={openSubmenu === index}
          onOpenSubmenu={() => setOpenSubmenu(item.submenu ? index : null)}
          onClose={onClose}
        />
      ))}
    </div>,
    document.body,
  );
}

/** Kept in step with `.context-submenu`'s width in index.css. */
const SUBMENU_WIDTH = 200;

function MenuRow({
  item,
  flip,
  open,
  onOpenSubmenu,
  onClose,
}: {
  item: MenuItem;
  flip: boolean;
  open: boolean;
  onOpenSubmenu: () => void;
  onClose: () => void;
}) {
  const disabled = item.disabled || (item.submenu !== undefined && item.submenu.length === 0);

  const activate = () => {
    if (disabled) return;
    if (item.submenu) {
      // Opened by tap as well as by hover, since a touch has no hover.
      onOpenSubmenu();
      return;
    }
    onClose();
    item.onSelect?.();
  };

  return (
    <>
      {item.dividerBefore ? <div className="context-menu-divider" /> : null}
      <div
        className={`context-menu-item ${disabled ? "is-disabled" : ""} ${item.danger ? "is-danger" : ""}`}
        onMouseEnter={() => !disabled && onOpenSubmenu()}
        onClick={activate}
      >
        <span className="context-menu-label">{item.label}</span>
        {item.submenu ? <span className="context-menu-arrow">›</span> : null}
        {item.submenu && open && !disabled ? (
          <div className={`context-submenu ${flip ? "context-submenu-flip" : ""}`}>
            {item.submenu.map((sub, index) => (
              <div
                key={`${sub.label}:${index}`}
                className="context-menu-item"
                onClick={event => {
                  event.stopPropagation();
                  onClose();
                  sub.onSelect?.();
                }}
              >
                <span className="context-menu-label">{sub.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

/** How long a touch has to stay put before it counts as a long press. */
const LONG_PRESS_MS = 500;
/** How far it may drift first — past this it's a scroll, not a press. */
const LONG_PRESS_SLOP = 10;

/**
 * Spreadable handlers that open a menu on right-click *or* long-press.
 *
 * The long press is what mobile gets instead of a right button. Two things
 * make it behave: the timer is cancelled once the finger has moved far enough
 * to be a scroll, and the click that the browser sends after the press is
 * swallowed, so long-pressing a file doesn't also open it.
 */
export function useContextMenuTrigger(open: (position: MenuPosition) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<MenuPosition | null>(null);
  /** Set once a press has opened the menu, to eat the click that follows. */
  const opened = useRef(false);

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };

  useEffect(() => cancel, []);

  return {
    onPointerDown: (event: ReactPointerEvent) => {
      // A row's trigger beats the one on the tree behind it. Without this both
      // arm, the outer timer fires last, and a long press on a file ends up
      // showing the empty-area menu instead of the file's.
      event.stopPropagation();
      // Cleared for a mouse too: a right-click sets `opened` and no click
      // follows it, so without this the *next* left click would be eaten.
      opened.current = false;
      if (event.pointerType === "mouse") return;
      const position = { x: event.clientX, y: event.clientY };
      origin.current = position;
      timer.current = setTimeout(() => {
        cancel();
        opened.current = true;
        open(position);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const start = origin.current;
      if (!start) return;
      if (Math.abs(event.clientX - start.x) > LONG_PRESS_SLOP || Math.abs(event.clientY - start.y) > LONG_PRESS_SLOP) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }) => {
      event.preventDefault();
      event.stopPropagation();
      // Android fires this itself on a long press; ours would otherwise fire
      // a moment later and move the menu.
      cancel();
      opened.current = true;
      open({ x: event.clientX, y: event.clientY });
    },
    onClickCapture: (event: { preventDefault(): void; stopPropagation(): void }) => {
      if (!opened.current) return;
      opened.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
