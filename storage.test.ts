/**
 * Covers the storage layer through its localStorage backend.
 *
 * The OPFS path can't run under `bun test` (no navigator.storage), but both
 * backends go through the same read/write code — only the medium differs — so
 * this exercises the seeding, per-file isolation and failure handling that
 * matter either way.
 */
import { test, expect, beforeEach } from "bun:test";

class FakeLocalStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  key(i: number) {
    return [...this.store.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.store.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  clear() {
    this.store.clear();
  }
  keys() {
    return [...this.store.keys()].sort();
  }
}

const fake = new FakeLocalStorage();
(globalThis as { localStorage?: unknown }).localStorage = fake;

const storage = await import("./src/storage");
const { ROOT_ID } = await import("./src/fs");

beforeEach(() => fake.clear());

test("uses the localStorage backend when OPFS is unavailable", () => {
  expect(storage.storageBackend()).toBe("localStorage");
});

test("seeds a starter tree on a completely fresh profile", async () => {
  const tree = await storage.readTree();
  expect(tree[ROOT_ID]).toBeDefined();
  expect(await storage.readFileContent("notes-welcome")).toContain("Welcome");
});

test("the stored tree carries structure only, never content", async () => {
  await storage.readTree();
  const raw = JSON.parse(fake.getItem("webfs:tree")!);
  expect(raw["notes-welcome"].name).toBe("welcome.md");
  expect(raw["notes-welcome"].content).toBeUndefined();
});

test("a pre-OPFS blob is ignored, not imported", async () => {
  // Migration was dropped on purpose: a browser still holding the old
  // whole-filesystem blob starts fresh from the seed rather than carrying it
  // over. Pinned so nobody reintroduces an import path by accident.
  fake.setItem(
    "webfs:filesystem",
    JSON.stringify({
      root: { id: "root", name: "root", type: "folder", parentId: null },
      note: { id: "note", name: "legacy.md", type: "file", parentId: "root", content: "old data" },
    }),
  );

  const tree = await storage.readTree();
  expect(tree["note"]).toBeUndefined();
  expect(tree["notes-welcome"]).toBeDefined();
  expect(await storage.readFileContent("note")).toBeNull();
});

test("a corrupt tree falls back to seeding instead of throwing", async () => {
  fake.setItem("webfs:tree", "{not json");
  const tree = await storage.readTree();
  expect(tree[ROOT_ID]).toBeDefined();
});

test("one unreadable file does not take the rest of the filesystem with it", async () => {
  await storage.readTree();
  fake.setItem("webfs:file:notes-todo", "\u0000 corrupt-ish");
  // The tree and every other file still load — the blast radius is one note.
  const tree = await storage.readTree();
  expect(Object.keys(tree).length).toBeGreaterThan(3);
  expect(await storage.readFileContent("notes-welcome")).toContain("Welcome");
});

test("writes are per file, so saving one note leaves the others untouched", async () => {
  await storage.readTree();
  const before = fake.getItem("webfs:file:notes-welcome");
  expect(await storage.writeFileContent("notes-todo", "only this one changed")).toBe("ok");
  expect(fake.getItem("webfs:file:notes-welcome")).toBe(before);
  expect(await storage.readFileContent("notes-todo")).toBe("only this one changed");
});

test("deleting removes content entries for files but tolerates folders", async () => {
  await storage.readTree();
  await storage.deleteFileContents([
    { id: "notes-todo", name: "todo.md", type: "file", parentId: "notes" },
    { id: "notes", name: "Notes", type: "folder", parentId: ROOT_ID },
  ]);
  expect(fake.keys()).not.toContain("webfs:file:notes-todo");
  expect(await storage.readFileContent("notes-todo")).toBeNull();
});

test("reading a file that was never written returns null, not a throw", async () => {
  expect(await storage.readFileContent("does-not-exist")).toBeNull();
});
