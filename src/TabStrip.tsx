import { ViewToggle, type EditorView } from "./Editor";
import type { FileSystem } from "./fs";
import type { Pane } from "./panes";

/**
 * A pane's row of open files, and the button that splits or closes it.
 *
 * Desktop only: below the mobile breakpoint the app shows one file at a time
 * and the topbar already names it, so index.css hides this strip entirely.
 */
export function TabStrip({
  pane,
  fs,
  focused,
  canSplit,
  view,
  onSelect,
  onClose,
  onSplit,
  onClosePane,
  onToggleView,
}: {
  pane: Pane;
  fs: FileSystem;
  focused: boolean;
  /** False once a second pane exists, which turns the button into a ✕. */
  canSplit: boolean;
  /** How this pane's file is shown; null when it holds nothing with text. */
  view: EditorView | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onSplit: () => void;
  onClosePane: () => void;
  onToggleView: () => void;
}) {
  return (
    <div className={`tab-strip ${focused ? "tab-strip-focused" : ""}`}>
      <div className="tab-list">
        {pane.tabs.map(id => (
          <div
            key={id}
            className={`tab ${pane.activeId === id ? "tab-active" : ""}`}
            title={id}
            onClick={() => onSelect(id)}
            // Middle-click closes, as it does in every other tab strip.
            onAuxClick={event => {
              if (event.button !== 1) return;
              event.preventDefault();
              onClose(id);
            }}
          >
            <span className="tab-name">{fs[id]?.name ?? id}</span>
            <button
              className="tab-close"
              title="Close"
              aria-label={`Close ${fs[id]?.name ?? id}`}
              onClick={event => {
                event.stopPropagation();
                onClose(id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {/* Left of the pane controls: this one acts on the document, they act
          on the pane, and the ✕ stays where the muscle memory expects it. */}
      {view ? <ViewToggle view={view} className="tab-strip-button" onToggle={onToggleView} /> : null}
      {canSplit ? (
        <button className="tab-strip-button" title="Split editor" aria-label="Split editor" onClick={onSplit}>
          ▥
        </button>
      ) : (
        <button
          className="tab-strip-button"
          title="Close this pane"
          aria-label="Close this pane"
          onClick={onClosePane}
        >
          ✕
        </button>
      )}
    </div>
  );
}
