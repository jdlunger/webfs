/**
 * Covers the in-memory projection of the OPFS tree.
 *
 * The OPFS calls themselves can't run headless, so the real filesystem
 * behaviour is verified by driving a browser. What's testable here is the part
 * with actual logic in it: turning a directory walk into the flat node record,
 * and keeping session ids stable across renames and moves — which is what
 * stops the editor tearing down while you rename the file you're typing in.
 */
import { test, expect } from "bun:test";
import { ROOT_ID, canMove, childrenOf, findNodeByPath, segmentsOf } from "./src/fs";
import { adoptContent, projectTree, repath } from "./src/tree";
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

test("storage paths round-trip back to raw name segments", () => {
  const fs = projectTree(sample());
  expect(segmentsOf(fs, idOf(fs, "/Notes/todo.md"))).toEqual(["Notes", "todo.md"]);
  expect(segmentsOf(fs, ROOT_ID)).toEqual([]);
});

test("re-walking keeps the same id for the same path", () => {
  const before = projectTree(sample());
  const after = projectTree([...sample(), file("added.md")]);
  expect(idOf(after, "/Notes/todo.md")).toBe(idOf(before, "/Notes/todo.md"));
});

test("a rename carries the id across, so the editor doesn't remount", () => {
  const before = projectTree(sample());
  const original = idOf(before, "/Notes/todo.md");

  repath(["Notes", "todo.md"], ["Notes", "later.md"]);
  const after = projectTree([dir("Notes", [file("later.md"), file("welcome.md")]), dir("Projects", [file("ideas.md")])]);

  expect(idOf(after, "/Notes/later.md")).toBe(original);
});

test("moving a folder carries its children's ids too", () => {
  const before = projectTree(sample());
  const folder = idOf(before, "/Notes");
  const child = idOf(before, "/Notes/todo.md");

  repath(["Notes"], ["Projects", "Notes"]);
  const after = projectTree([dir("Projects", [dir("Notes", [file("todo.md"), file("welcome.md")]), file("ideas.md")])]);

  expect(idOf(after, "/Projects/Notes")).toBe(folder);
  expect(idOf(after, "/Projects/Notes/todo.md")).toBe(child);
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
