/**
 * Covers the in-memory projection of the OPFS tree.
 *
 * The OPFS calls themselves can't run headless, so the real filesystem
 * behaviour is verified by driving a browser. What's testable here is turning
 * a directory walk into the flat node record, and the path arithmetic that
 * replaced the old id registry now that a node's id *is* its path.
 */
import { test, expect } from "bun:test";
import {
  type SortBy,
  ROOT_ID,
  canMove,
  childrenOf,
  remapCreatedAt,
  findNodeByPath,
  getNodePath,
  idOf as idOf2,
  searchTree,
  segmentsOf,
  touchFile,
} from "./src/fs";
import { adoptContent, projectTree } from "./src/tree";
import { isValidName } from "./src/storage";
import type { WalkEntry } from "./src/storage";

const dir = (name: string, children: WalkEntry[] = []): WalkEntry => ({ name, kind: "directory", children });
const file = (name: string): WalkEntry => ({ name, kind: "file", children: [] });

const sample = (): WalkEntry[] => [dir("Notes", [file("todo.md"), file("welcome.md")]), dir("Projects", [file("ideas.md")])];

const idOf = (fs: ReturnType<typeof projectTree>, path: string) => findNodeByPath(fs, path)!.id;

test("a directory walk becomes a flat node record with parent links", () => {
  const fs = projectTree(sample());
  expect(childrenOf(fs, ROOT_ID).map(n => n.name)).toEqual(["Notes", "Projects"]);
  const notes = idOf(fs, "/Notes");
  expect(childrenOf(fs, notes).map(n => n.name)).toEqual(["todo.md", "welcome.md"]);
  expect(fs[idOf(fs, "/Notes/todo.md")]!.type).toBe("file");
});

test("an id is the path, so segments are a split rather than a tree walk", () => {
  const fs = projectTree(sample());
  expect(idOf(fs, "/Notes/todo.md")).toBe("Notes/todo.md");
  expect(segmentsOf("Notes/todo.md")).toEqual(["Notes", "todo.md"]);
  expect(segmentsOf(ROOT_ID)).toEqual([]);
  expect(idOf2(["Notes", "todo.md"])).toBe("Notes/todo.md");
});

test("URL paths encode each segment, and read back to the same node", () => {
  const fs = projectTree([dir("My Notes", [file("a b.md")])]);
  const id = idOf(fs, "/My Notes/a b.md");
  expect(getNodePath(id)).toBe("/My%20Notes/a%20b.md");
  expect(findNodeByPath(fs, getNodePath(id))!.id).toBe(id);
});

test("re-walking keeps the same id for the same path", () => {
  const before = projectTree(sample());
  const after = projectTree([...sample(), file("added.md")]);
  expect(idOf(after, "/Notes/todo.md")).toBe(idOf(before, "/Notes/todo.md"));
});

test("a renamed node is simply a different id, with no registry to update", () => {
  const before = projectTree(sample());
  expect(idOf(before, "/Notes/todo.md")).toBe("Notes/todo.md");

  const after = projectTree([dir("Notes", [file("later.md"), file("welcome.md")]), dir("Projects", [file("ideas.md")])]);
  expect(after["Notes/todo.md"]).toBeUndefined();
  expect(idOf(after, "/Notes/later.md")).toBe("Notes/later.md");
});

test("moving a folder reparents its children by prefix", () => {
  const after = projectTree([dir("Projects", [dir("Notes", [file("todo.md")]), file("ideas.md")])]);
  expect(after["Projects/Notes/todo.md"]!.parentId).toBe("Projects/Notes");
  expect(after["Projects/Notes"]!.parentId).toBe("Projects");
});

test("re-reading the tree keeps text already loaded in this tab", () => {
  const loaded = projectTree(sample());
  const id = idOf(loaded, "/Projects/ideas.md");
  loaded[id]!.content = "typed but not yet saved";

  const refreshed = adoptContent(loaded, projectTree(sample()));
  expect(refreshed[id]!.content).toBe("typed but not yet saved");
  // Files never opened stay unloaded rather than being faked as empty.
  expect(refreshed[idOf(refreshed, "/Notes/todo.md")]!.content).toBeUndefined();
});

test("a folder cannot be moved into its own subtree", () => {
  const fs = projectTree([dir("Notes", [dir("Sub", [file("a.md")])])]);
  const notes = idOf(fs, "/Notes");
  const sub = idOf(fs, "/Notes/Sub");
  // Directories are relocated by recursive copy, so this would never terminate.
  expect(canMove(fs, notes, sub)).toBe(false);
  expect(canMove(fs, notes, notes)).toBe(false);
  expect(canMove(fs, sub, ROOT_ID)).toBe(true);
});

test("only names OPFS actually rejects are treated as invalid", () => {
  for (const bad of ["", ".", "..", "a/b.md", "a\\b.md"]) expect(isValidName(bad)).toBe(false);
  // These are all legal OPFS filenames and round-trip byte-identically,
  // including non-ASCII — verified against a real browser.
  for (const ok of ["notes.md", "café.md", "日本語.md", "what: is? this*", ".hidden", "trailing "]) {
    expect(isValidName(ok)).toBe(true);
  }
});

// --- what the sidebar lists, and in what order -------------------------------

const timed = (name: string, lastModified: number): WalkEntry => ({ name, kind: "file", children: [], lastModified });

test("a file's modified time is carried through the projection", () => {
  const fs = projectTree([dir("Notes", [timed("todo.md", 1200)])]);
  expect(fs[idOf(fs, "/Notes/todo.md")]!.lastModified).toBe(1200);
  // Directories have no timestamp in OPFS, so the node carries none either
  // rather than inventing one that sorting would then believe.
  expect(fs[idOf(fs, "/Notes")]!.lastModified).toBeUndefined();
});

test("a write moves a file's timestamp without waiting for the next walk", () => {
  const fs = projectTree([dir("Notes", [timed("a.md", 100), timed("z.md", 900)])]);
  const notes = idOf(fs, "/Notes");
  const a = idOf(fs, "/Notes/a.md");

  expect(childrenOf(fs, notes, "modified").map(n => n.name)).toEqual(["z.md", "a.md"]);
  expect(childrenOf(touchFile(fs, a, 1000), notes, "modified").map(n => n.name)).toEqual(["a.md", "z.md"]);
  // The same record back when nothing changes, so an effect keyed on `fs`
  // can't drive itself in a circle — as for `markFileBinary`.
  expect(touchFile(fs, a, 100)).toBe(fs);
  expect(touchFile(fs, notes, 100)).toBe(fs);
  expect(touchFile(fs, "Notes/gone.md", 100)).toBe(fs);
});

test("sorting reorders a folder's files but never lifts one above a folder", () => {
  const fs = projectTree([dir("Notes", [timed("a.md", 100), timed("z.md", 900), dir("Sub")])]);
  const notes = idOf(fs, "/Notes");
  const names = (sortBy: SortBy) => childrenOf(fs, notes, sortBy).map(n => n.name);

  expect(names("name")).toEqual(["Sub", "a.md", "z.md"]);
  expect(names("name-desc")).toEqual(["Sub", "z.md", "a.md"]);
  expect(names("modified")).toEqual(["Sub", "z.md", "a.md"]);
  // A folder stays put and stays first whichever way the files are turned.
  expect(names("modified-asc")).toEqual(["Sub", "a.md", "z.md"]);
});

test("each date sorts both ways", () => {
  const fs = projectTree([dir("Notes", [timed("a.md", 100), timed("z.md", 900)])]);
  const notes = idOf(fs, "/Notes");
  const a = idOf(fs, "/Notes/a.md");
  const z = idOf(fs, "/Notes/z.md");
  const names = (sortBy: SortBy) => childrenOf(fs, notes, sortBy, { [a]: 900, [z]: 100 }).map(n => n.name);

  expect(names("modified")).toEqual(["z.md", "a.md"]);
  expect(names("modified-asc")).toEqual(["a.md", "z.md"]);
  // Created runs the other way round here, so an order that quietly read the
  // modified time would pass the two above and fail these.
  expect(names("created")).toEqual(["a.md", "z.md"]);
  expect(names("created-asc")).toEqual(["z.md", "a.md"]);
});

test("a file with no date sorts last in *both* directions, since unknown isn't new — or old", () => {
  const fs = projectTree([dir("Notes", [file("mystery.md"), timed("old.md", 1)])]);
  const notes = idOf(fs, "/Notes");
  const old = idOf(fs, "/Notes/old.md");
  const names = (sortBy: SortBy) => childrenOf(fs, notes, sortBy, { [old]: 1 }).map(n => n.name);

  // Reversing the order must not promote the unknown one to the top, which
  // is what standing a missing date in as ±Infinity would do.
  expect(names("modified")).toEqual(["old.md", "mystery.md"]);
  expect(names("modified-asc")).toEqual(["old.md", "mystery.md"]);
  expect(names("created")).toEqual(["old.md", "mystery.md"]);
  expect(names("created-asc")).toEqual(["old.md", "mystery.md"]);
});

test("files with no date at all fall back to name rather than to nothing", () => {
  const fs = projectTree([dir("Notes", [file("z.md"), file("a.md")])]);
  const notes = idOf(fs, "/Notes");
  expect(childrenOf(fs, notes, "created").map(n => n.name)).toEqual(["a.md", "z.md"]);
  expect(childrenOf(fs, notes, "created-asc").map(n => n.name)).toEqual(["a.md", "z.md"]);
});

test("a rename carries a creation date with it, a folder's whole subtree included", () => {
  const dates = { "Notes/todo.md": 100, "Notes/Sub/deep.md": 200, "Other/keep.md": 300 };

  expect(remapCreatedAt(dates, "Notes/todo.md", "Notes/done.md")).toEqual({
    "Notes/done.md": 100,
    "Notes/Sub/deep.md": 200,
    "Other/keep.md": 300,
  });
  // A folder moving takes everything under it along: prefix in, prefix out.
  expect(remapCreatedAt(dates, "Notes", "Archive/Notes")).toEqual({
    "Archive/Notes/todo.md": 100,
    "Archive/Notes/Sub/deep.md": 200,
    "Other/keep.md": 300,
  });
  // The same object back when nothing moved, so a render keyed on it settles.
  expect(remapCreatedAt(dates, "Nothing", "Else")).toBe(dates);
});

test("an empty query means the whole tree, not an empty one", () => {
  const fs = projectTree(sample());
  expect(searchTree(fs, "")).toBeNull();
  expect(searchTree(fs, "   ")).toBeNull();
});

test("a matching file brings the folders it takes to reach it", () => {
  const fs = projectTree(sample());
  const visible = searchTree(fs, "TODO")!;
  // Case-insensitive, and the ancestors are in so the match is reachable.
  expect([...visible].sort()).toEqual(["Notes", "Notes/todo.md"]);
  expect(visible.has(ROOT_ID)).toBe(false);
});

test("a matching folder brings its whole subtree, since that's what was asked", () => {
  const fs = projectTree([dir("Notes", [dir("Trip", [file("packing.md")]), file("todo.md")])]);
  const visible = searchTree(fs, "trip")!;
  expect([...visible].sort()).toEqual(["Notes", "Notes/Trip", "Notes/Trip/packing.md"]);
});

test("matching is on the name, not the path it sits at", () => {
  const fs = projectTree([dir("Trip", [file("notes.md")])]);
  // "p/n" is in the id "Trip/notes.md" and in neither name: a query only ever
  // means a name, so it can't quietly span a separator.
  expect(searchTree(fs, "p/n")!.size).toBe(0);
  expect(searchTree(fs, "nothing here")!.size).toBe(0);
});
