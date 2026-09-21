/**
 * Covers the storage layer through its localStorage backend.
 *
 * The OPFS path can't run under `bun test` (no navigator.storage), but both
 * backends go through the same read/write/migrate code — only the medium
 * differs — so this exercises the logic that matters, above all the one-way
 * migration off the pre-OPFS blob, which runs against real user data exactly
 * once and can't be re-run if it's wrong.
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

const LEGACY = {
  root: { id: "root", name: "root", type: "folder", parentId: null },
  arch: { id: "arch", name: "Archive", type: "folder", parentId: "root" },
  note: { id: "note", name: "important.md", type: "file", parentId: "arch", content: "# keep me\n\nreal data" },
};

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

test("migrates the pre-OPFS blob, splitting it into tree plus per-file entries", async () => {
  fake.setItem("webfs:filesystem", JSON.stringify(LEGACY));

  const tree = await storage.readTree();
  expect(tree["note"]!.name).toBe("important.md");
  expect(tree["arch"]!.type).toBe("folder");
  expect(await storage.readFileContent("note")).toBe("# keep me\n\nreal data");
  expect(fake.keys()).toContain("webfs:file:note");
});

test("migration keeps the legacy blob as a backup rather than deleting it", async () => {
  fake.setItem("webfs:filesystem", JSON.stringify(LEGACY));
  await storage.readTree();
  expect(fake.getItem("webfs:filesystem")).not.toBeNull();
});

test("migration does not re-run once a tree exists, so it can't clobber newer edits", async () => {
  fake.setItem("webfs:filesystem", JSON.stringify(LEGACY));
  await storage.readTree();

  await storage.writeFileContent("note", "edited after migrating");
  const tree = await storage.readTree();

  expect(tree["note"]).toBeDefined();
  expect(await storage.readFileContent("note")).toBe("edited after migrating");
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
