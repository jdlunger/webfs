/**
 * What comes back out of localStorage is the one input to this app that
 * nobody typed and nothing this run produced: it can be a build old, edited
 * by hand, or half-written. These cover it being read back as a layout the
 * rest of the app can trust — or not at all.
 */
import { test, expect } from "bun:test";
import { openIds, singlePane, splitPane, openBeside } from "./src/panes";
import { type Workspace, parseWorkspace, serializeWorkspace } from "./src/workspace";

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  layout: singlePane("Notes/todo.md"),
  collapsed: [],
  textViews: [],
  ...overrides,
});

test("a workspace survives the round trip through storage", () => {
  const original = workspace({
    layout: openBeside(splitPane(singlePane("Notes/todo.md")), "Projects/ideas.md"),
    collapsed: ["Notes"],
    textViews: ["Projects/ideas.md"],
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
