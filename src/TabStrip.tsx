import { ViewToggle, type EditorView } from "./Editor";
import type { FileSystem } from "./fs";
import type { Pane } from "./panes";
import { versionLabel, versionTitle } from "./version";

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
  last,
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
  /** Whether this is the rightmost pane, and so the window's top corner. */
  last: boolean;
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
      {/* Only the rightmost strip: the version is the app's, not a pane's, and
          a split would otherwise show it twice. */}
      {last ? <VersionTag /> : null}
    </div>
  );
}

/**
 * The build number, in the corner.
 *
 * Deliberately inert and dim — it is metadata, not a control, and the one
 * time anyone needs it (checking whether a phone is running the current
 * deploy) they will be looking for it rather than noticing it. Rendered here
 * and in the mobile topbar, the two places this app puts its upper-right
 * affordances, so it lands in the window's top corner either way.
 */
export function VersionTag() {
  return (
    <span className="app-version" title={versionTitle()}>
      {versionLabel()}
    </span>
  );
}
