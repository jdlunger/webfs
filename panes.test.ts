import { describe, expect, test } from "bun:test";
import {
  type PaneLayout,
  MAX_PANES,
  activeId,
  activeIds,
  closePane,
  closeTab,
  focusPane,
  openBeside,
  openFile,
  openIds,
  pruneMissing,
  remapPaths,
  singlePane,
  splitPane,
} from "./src/panes";

/** Compact rendering of a layout, so a failure reads as what's on screen. */
function shape(layout: PaneLayout): string {
  return layout.panes
    .map((pane, i) => {
      const tabs = pane.tabs.map(tab => (tab === pane.activeId ? `[${tab}]` : tab)).join(" ");
      return `${i === layout.focused ? "*" : ""}${tabs}`;
    })
    .join(" | ");
}

describe("opening files", () => {
  test("a file opens as a new tab in the focused pane", () => {
    let layout = singlePane("a.md");
    layout = openFile(layout, "b.md");
    expect(shape(layout)).toBe("*a.md [b.md]");
    expect(activeId(layout)).toBe("b.md");
  });

  test("replace mode keeps one tab, which is what a phone shows", () => {
    let layout = singlePane("a.md");
    layout = openFile(layout, "b.md", { replace: true });
    expect(shape(layout)).toBe("*[b.md]");
  });

  // Two Crepe instances over one file would each hold an uncontrolled copy of
  // the document, and the second to save would write its stale text over the
  // first — so the same file is never open twice.
  test("a file already open in the other pane is focused, not duplicated", () => {
    let layout = openBeside(singlePane("a.md"), "b.md");
    layout = focusPane(layout, 0);
    layout = openFile(layout, "b.md");
    expect(shape(layout)).toBe("[a.md] | *[b.md]");
    expect(openIds(layout)).toEqual(["a.md", "b.md"]);
  });

  test("opening the file a pane already shows only moves the focus", () => {
    const split = openBeside(singlePane("a.md"), "b.md");
    const again = openFile(focusPane(split, 0), "b.md");
    expect(shape(again)).toBe("[a.md] | *[b.md]");
  });
});

describe("closing tabs", () => {
  test("closing the active tab lands on the one to its right", () => {
    let layout = openFile(openFile(singlePane("a.md"), "b.md"), "c.md");
    layout = openFile(layout, "b.md");
    expect(shape(closeTab(layout, 0, "b.md"))).toBe("*a.md [c.md]");
  });

  test("closing the last tab lands on the one to its left", () => {
    const layout = openFile(openFile(singlePane("a.md"), "b.md"), "c.md");
    expect(shape(closeTab(layout, 0, "c.md"))).toBe("*a.md [b.md]");
  });

  test("closing an inactive tab leaves the shown file alone", () => {
    const layout = openFile(openFile(singlePane("a.md"), "b.md"), "c.md");
    expect(shape(closeTab(layout, 0, "a.md"))).toBe("*b.md [c.md]");
  });

  // An emptied pane stays put: collapsing it can't be told apart from a
  // freshly split one, which would vanish the instant it appeared.
  test("a pane emptied of tabs stays, showing nothing", () => {
    const layout = openBeside(singlePane("a.md"), "b.md");
    expect(shape(closeTab(layout, 1, "b.md"))).toBe("[a.md] | *");
    expect(activeIds(closeTab(layout, 1, "b.md"))).toEqual(["a.md"]);
  });
});

describe("splitting", () => {
  test("a split adds an empty, focused pane", () => {
    const layout = splitPane(singlePane("a.md"));
    expect(shape(layout)).toBe("[a.md] | *");
    expect(layout.panes.length).toBe(MAX_PANES);
  });

  test("there is only ever one split", () => {
    const layout = splitPane(singlePane("a.md"));
    expect(splitPane(layout)).toBe(layout);
  });

  test("opening to the side splits first, then opens there", () => {
    expect(shape(openBeside(singlePane("a.md"), "b.md"))).toBe("[a.md] | *[b.md]");
  });

  test("opening to the side moves a file out of the pane holding it", () => {
    const layout = openFile(openBeside(singlePane("a.md"), "b.md"), "c.md");
    expect(shape(layout)).toBe("[a.md] | *b.md [c.md]");
    expect(shape(openBeside(layout, "c.md"))).toBe("*a.md [c.md] | [b.md]");
  });

  test("closing a pane keeps its tabs open in the one that remains", () => {
    const layout = openFile(openBeside(singlePane("a.md"), "b.md"), "c.md");
    expect(shape(closePane(layout, 1))).toBe("*[a.md] b.md c.md");
  });

  test("a single pane can't be closed", () => {
    const layout = singlePane("a.md");
    expect(closePane(layout, 0)).toBe(layout);
  });
});

describe("following the tree", () => {
  test("a rename follows the open tab", () => {
    const layout = remapPaths(singlePane("Notes/todo.md"), "Notes/todo.md", "Notes/done.md");
    expect(shape(layout)).toBe("*[Notes/done.md]");
  });

  // An id *is* a path, so a folder moving takes everything under it along.
  test("a folder move follows every tab inside it", () => {
    let layout = openFile(singlePane("Notes/a.md"), "Notes/sub/b.md");
    layout = remapPaths(layout, "Notes", "Archive/Notes");
    expect(shape(layout)).toBe("*Archive/Notes/a.md [Archive/Notes/sub/b.md]");
  });

  test("a rename that touches nothing open returns the same layout", () => {
    const layout = singlePane("a.md");
    expect(remapPaths(layout, "b.md", "c.md")).toBe(layout);
  });

  test("a deleted file loses its tab", () => {
    const layout = openFile(openFile(singlePane("a.md"), "b.md"), "c.md");
    const pruned = pruneMissing(layout, id => id !== "c.md");
    expect(shape(pruned)).toBe("*a.md [b.md]");
  });

  test("a deletion in the other pane leaves the focused one alone", () => {
    const layout = openBeside(singlePane("a.md"), "b.md");
    expect(shape(pruneMissing(layout, id => id !== "a.md"))).toBe(" | *[b.md]");
  });

  // This runs against every tree refresh, so an unchanged layout has to come
  // back identical or it would re-render (and re-prune) forever.
  test("pruning nothing returns the very same layout", () => {
    const layout = openBeside(singlePane("a.md"), "b.md");
    expect(pruneMissing(layout, () => true)).toBe(layout);
  });
});
