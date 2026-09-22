/**
 * What comes back out of localStorage is the one input to this app that
 * nobody typed and nothing this run produced: it can be a build old, edited
 * by hand, or half-written. These cover it being read back as a layout the
 * rest of the app can trust — or not at all.
 */
import { test, expect } from "bun:test";
import { openIds, singlePane, splitPane, openBeside } from "./src/panes";
import { type Workspace, initialCollapsed, parseWorkspace, serializeWorkspace } from "./src/workspace";
import { DEFAULT_SORT } from "./src/fs";
import { projectTree } from "./src/tree";
import type { WalkEntry } from "./src/storage";

const dir = (name: string, children: WalkEntry[] = []): WalkEntry => ({ name, kind: "directory", children });
const file = (name: string): WalkEntry => ({ name, kind: "file", children: [] });

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  layout: singlePane("Notes/todo.md"),
  collapsed: [],
  textViews: [],
  sortBy: DEFAULT_SORT,
  ...overrides,
});

test("a workspace survives the round trip through storage", () => {
  const original = workspace({
    layout: openBeside(splitPane(singlePane("Notes/todo.md")), "Projects/ideas.md"),
    collapsed: ["Notes"],
    textViews: ["Projects/ideas.md"],
    sortBy: "modified",
  });
  expect(parseWorkspace(serializeWorkspace(original))).toEqual(original);
});

test("nothing stored is nothing restored, rather than an empty workspace", () => {
  expect(parseWorkspace(null)).toBeNull();
  expect(parseWorkspace("")).toBeNull();
});

test("an entry that isn't a workspace is dropped rather than half-read", () => {
  expect(parseWorkspace("not json at all")).toBeNull();
  expect(parseWorkspace('"a string"')).toBeNull();
  expect(parseWorkspace(JSON.stringify({ version: 1 }))).toBeNull();
  expect(parseWorkspace(JSON.stringify({ version: 1, panes: [], focused: 0 }))).toBeNull();
  expect(parseWorkspace(JSON.stringify({ version: 1, panes: [{ tabs: [42], activeId: null }], focused: 0 }))).toBeNull();
});

test("a version this build doesn't know is dropped, not guessed at", () => {
  const stored = JSON.parse(serializeWorkspace(workspace()));
  expect(parseWorkspace(JSON.stringify({ ...stored, version: 2 }))).toBeNull();
  expect(parseWorkspace(JSON.stringify({ ...stored, version: undefined }))).toBeNull();
});

test("a file stored as open in both panes comes back open in one", () => {
  const restored = parseWorkspace(
    JSON.stringify({
      version: 1,
      panes: [
        { tabs: ["a.md", "b.md"], activeId: "b.md" },
        { tabs: ["b.md", "c.md"], activeId: "b.md" },
      ],
      focused: 1,
    }),
  );
  expect(openIds(restored!.layout)).toEqual(["a.md", "b.md", "c.md"]);
  // The pane that loses the duplicate loses its active tab with it, so it
  // falls back to one it still has rather than showing a file it isn't holding.
  expect(restored!.layout.panes[1]).toEqual({ tabs: ["c.md"], activeId: "c.md" });
});

test("more panes than the app has room for are cut down to it", () => {
  const restored = parseWorkspace(
    JSON.stringify({
      version: 1,
      panes: [
        { tabs: ["a.md"], activeId: "a.md" },
        { tabs: ["b.md"], activeId: "b.md" },
        { tabs: ["c.md"], activeId: "c.md" },
      ],
      focused: 2,
    }),
  );
  expect(restored!.layout.panes).toHaveLength(2);
  // The pane it named is gone, so the focus lands somewhere that exists.
  expect(restored!.layout.focused).toBe(0);
});

test("an active tab that isn't in the pane is corrected, not trusted", () => {
  const restored = parseWorkspace(
    JSON.stringify({ version: 1, panes: [{ tabs: ["a.md"], activeId: "gone.md" }], focused: 0 }),
  );
  expect(restored!.layout.panes[0]).toEqual({ tabs: ["a.md"], activeId: "a.md" });
});

test("an empty pane keeps its empty active tab", () => {
  const restored = parseWorkspace(JSON.stringify({ version: 1, panes: [{ tabs: [], activeId: null }], focused: 0 }));
  expect(restored!.layout.panes[0]).toEqual({ tabs: [], activeId: null });
});

test("a bad list of folders or views costs only itself, not the layout", () => {
  const restored = parseWorkspace(
    JSON.stringify({
      version: 1,
      panes: [{ tabs: ["a.md"], activeId: "a.md" }],
      focused: 0,
      collapsed: "Notes",
      textViews: [1, 2],
    }),
  );
  expect(restored).toEqual(workspace({ layout: singlePane("a.md") }));
});

const vault = () =>
  projectTree([
    dir("Notes", [file("todo.md"), dir("Archive", [file("2025.md")])]),
    dir("Projects", [file("ideas.md")]),
    file("README.md"),
  ]);

test("a first visit starts with every folder closed", () => {
  expect(initialCollapsed(vault(), []).sort()).toEqual(["Notes", "Notes/Archive", "Projects"]);
});

test("the folders an open file sits in stay open, or it couldn't be found", () => {
  // Every ancestor, not just the immediate parent: a file three deep inside a
  // closed folder is as invisible as one directly in it.
  expect(initialCollapsed(vault(), ["Notes/Archive/2025.md"]).sort()).toEqual(["Projects"]);
  expect(initialCollapsed(vault(), ["Projects/ideas.md"]).sort()).toEqual(["Notes", "Notes/Archive"]);
  // A file at the root has no folder to keep open.
  expect(initialCollapsed(vault(), ["README.md"]).sort()).toEqual(["Notes", "Notes/Archive", "Projects"]);
});

test("a tree with nothing pulled into it yet collapses nothing", () => {
  // The case this has to get right on a synced device: the store is empty
  // when the app loads, and folding away what isn't there would leave the
  // repository to arrive wide open.
  expect(initialCollapsed(projectTree([]), [])).toEqual([]);
});

// The order is advisory like the two lists, and for a reason worth pinning:
// it's what lets another order be added later without bumping VERSION and
// throwing away everyone's tabs to deliver it.
test("an order this build doesn't know falls back rather than dropping the entry", () => {
  const entry = (sortBy: unknown) =>
    JSON.stringify({ version: 1, panes: [{ tabs: ["a.md"], activeId: "a.md" }], focused: 0, sortBy });
  for (const bad of ["size", 7, null, undefined]) {
    expect(parseWorkspace(entry(bad))).toEqual(workspace({ layout: singlePane("a.md") }));
  }
  expect(parseWorkspace(entry("name-desc"))?.sortBy).toBe("name-desc");
});
