/**
 * Covers the two questions about checkboxes the editor asks: which lines are
 * ones, and what order a list should be in. The ordering tests earn their
 * keep on one property in particular — a list already in order comes back
 * untouched, which is what keeps the sort button from rewriting a note every
 * time it's pressed.
 */
import { test, expect } from "bun:test";
import {
  findOpenTasks,
  inScope,
  isIdentity,
  openTasksIn,
  orderByDone,
  parseTaskLine,
} from "./src/tasks";
import type { FileSystem, FSNode } from "./src/fs";

test("a checkbox line is taken apart, and everything else isn't one", () => {
  expect(parseTaskLine("- [ ] Buy milk")).toEqual({ indent: "", marker: "-", checked: false, text: "Buy milk" });
  expect(parseTaskLine("  * [x] Done")).toEqual({ indent: "  ", marker: "*", checked: true, text: "Done" });
  expect(parseTaskLine("\t+ [X] Shouty")).toEqual({ indent: "\t", marker: "+", checked: true, text: "Shouty" });
  expect(parseTaskLine("1. [ ] Numbered")).toEqual({ indent: "", marker: "1.", checked: false, text: "Numbered" });
  expect(parseTaskLine("- Just a bullet")).toBeNull();
  expect(parseTaskLine("Some prose [ ] in it")).toBeNull();
  // A bracket pair that isn't a checkbox is not one.
  expect(parseTaskLine("- [todo] later")).toBeNull();
});

test("finished items go to the end, and nothing else moves", () => {
  expect(orderByDone([false, true, false, true, false])).toEqual([0, 2, 4, 1, 3]);
  // Stable in both halves: the order someone chose among their own work stays.
  expect(orderByDone([true, true, false])).toEqual([2, 0, 1]);
});

test("a list already in order is left exactly as it is", () => {
  expect(isIdentity(orderByDone([false, false, true, true]))).toBe(true);
  expect(isIdentity(orderByDone([]))).toBe(true);
  expect(isIdentity(orderByDone([true, false]))).toBe(false);
});

test("unfinished checkboxes come back with the line they're on", () => {
  const text = ["# Notes", "", "- [ ] First", "- [x] Second", "  - [ ] Nested", ""].join("\n");
  expect(openTasksIn(text)).toEqual([
    { line: 3, text: "First" },
    { line: 5, text: "Nested" },
  ]);
});

test("a checkbox inside a code fence is an example, not a task", () => {
  const text = ["- [ ] Real", "", "```markdown", "- [ ] Written about", "```", "", "- [ ] Also real"].join("\n");
  expect(openTasksIn(text)).toEqual([
    { line: 1, text: "Real" },
    { line: 7, text: "Also real" },
  ]);
});

test("a fence only closes on the character it opened with", () => {
  const text = ["~~~", "- [ ] Hidden", "```", "- [ ] Still hidden", "~~~", "- [ ] Out"].join("\n");
  expect(openTasksIn(text)).toEqual([{ line: 6, text: "Out" }]);
});

test("an empty checkbox has nothing to list", () => {
  expect(openTasksIn("- [ ] \n- [ ] Something")).toEqual([{ line: 2, text: "Something" }]);
});

test("a scope is a path, and an empty one is the whole drive", () => {
  expect(inScope("Notes/todo.md", "")).toBe(true);
  expect(inScope("Notes/todo.md", "Notes")).toBe(true);
  expect(inScope("Notes/todo.md", "Notes/")).toBe(true);
  expect(inScope("Notes/todo.md", "Notes/todo.md")).toBe(true);
  expect(inScope("Notes/todo.md", "Projects")).toBe(false);
  // Not a bare prefix test: a folder called Note doesn't contain Notes/.
  expect(inScope("Notes/todo.md", "Note")).toBe(false);
});

const file = (id: string, content?: string): FSNode => ({
  id,
  name: id.split("/").pop() ?? id,
  type: "file",
  parentId: id.includes("/") ? id.split("/").slice(0, -1).join("/") : "",
  ...(content === undefined ? {} : { content }),
});

const treeOf = (...nodes: FSNode[]): FileSystem => Object.fromEntries(nodes.map(n => [n.id, n]));

test("every unfinished checkbox in the drive, in the sidebar's own order", async () => {
  // `localeCompare`, the same comparison the tree is listed with, so the
  // block reads in the order the files do rather than by code point.
  const fs = treeOf(file("beta.md"), file("Alpha/a.md"));
  const disk: Record<string, string> = {
    "beta.md": "- [ ] From beta",
    "Alpha/a.md": "- [x] Done\n- [ ] From alpha",
  };
  expect(await findOpenTasks(fs, "", async id => disk[id] ?? null)).toEqual({
    tasks: [
      { file: "Alpha/a.md", line: 2, text: "From alpha" },
      { file: "beta.md", line: 1, text: "From beta" },
    ],
    more: 0,
  });
});

test("the text a tab is holding wins over what is on disk", async () => {
  // Saves are debounced, so the file being edited is behind the record. A
  // block that listed a checkbox you just ticked would be wrong in the one
  // place anyone is looking at it.
  const fs = treeOf(file("open.md", "- [x] Just ticked"));
  expect(await findOpenTasks(fs, "", async () => "- [ ] Just ticked")).toEqual({ tasks: [], more: 0 });
});

test("only text files are read, and only inside the scope", async () => {
  const fs = treeOf(file("Notes/a.md"), file("Notes/shot.png"), file("Other/b.md"));
  const read = async (id: string) => (id.endsWith(".md") ? "- [ ] " + id : "binary");
  const { tasks } = await findOpenTasks(fs, "Notes", read);
  expect(tasks.map(t => t.file)).toEqual(["Notes/a.md"]);
});

test("past the limit it counts rather than lists", async () => {
  const fs = treeOf(file("big.md", ["- [ ] one", "- [ ] two", "- [ ] three"].join("\n")));
  expect(await findOpenTasks(fs, "", async () => null, 2)).toEqual({
    tasks: [
      { file: "big.md", line: 1, text: "one" },
      { file: "big.md", line: 2, text: "two" },
    ],
    more: 1,
  });
});
