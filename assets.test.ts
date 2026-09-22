/**
 * Covers where a pasted image goes and how its markdown link maps back onto
 * the store — the arithmetic that has to agree with GitHub's own resolution,
 * since the same relative link is read by both.
 */
import { test, expect } from "bun:test";
import { assetCandidates, assetName, isAbsoluteUrl, mimeOf, resolveAssetPath } from "./src/assets";
import { branchUrl } from "./src/DrivePanel";

test("a link resolves against the folder of the note it appears in", () => {
  // Exactly what GitHub does for Notes/todo.md referencing assets/shot.png.
  expect(resolveAssetPath("Notes/todo.md", "assets/shot.png")).toEqual(["Notes", "assets", "shot.png"]);
  expect(resolveAssetPath("todo.md", "assets/shot.png")).toEqual(["assets", "shot.png"]);
  expect(resolveAssetPath("a/b/c.md", "assets/x.png")).toEqual(["a", "b", "assets", "x.png"]);
});

test("percent-encoding is undone, since the store holds names as typed", () => {
  expect(resolveAssetPath("Notes/todo.md", "assets/screen%20shot.png")).toEqual(["Notes", "assets", "screen shot.png"]);
  expect(resolveAssetPath("Notes/todo.md", "assets/caf%C3%A9.png")).toEqual(["Notes", "assets", "café.png"]);
});

test("a link can walk up, but never out of the store", () => {
  expect(resolveAssetPath("a/b/c.md", "../shared/x.png")).toEqual(["a", "shared", "x.png"]);
  // One level above the root is nowhere, and must not resolve to something.
  expect(resolveAssetPath("a/c.md", "../../escape.png")).toBeNull();
  expect(resolveAssetPath("c.md", "../escape.png")).toBeNull();
});

test("a malformed or empty link resolves to nothing rather than guessing", () => {
  expect(resolveAssetPath("Notes/todo.md", "%E0%A4%A")).toBeNull();
  expect(resolveAssetPath("Notes/todo.md", "")).toBeNull();
  expect(resolveAssetPath("Notes/todo.md", "./")).toBeNull();
});

test("a link that resolves nowhere is looked for in Media, second", () => {
  // Where the link points is tried first, always: the fallback exists for
  // vaults written in Obsidian, and must never win over a real file.
  expect(assetCandidates("Notes/todo.md", "assets/shot.png")).toEqual([
    ["Notes", "assets", "shot.png"],
    ["Media", "shot.png"],
  ]);
  // An Obsidian embed names the file and nothing else, from any depth.
  expect(assetCandidates("Physiologie/Sa 05.09.2026.md", "Pasted image 20260905101712.png")).toEqual([
    ["Physiologie", "Pasted image 20260905101712.png"],
    ["Media", "Pasted image 20260905101712.png"],
  ]);
});

test("the Media fallback isn't offered twice for a file already in it", () => {
  expect(assetCandidates("note.md", "Media/shot.png")).toEqual([["Media", "shot.png"]]);
  // From a note inside Media, the relative link already resolves there.
  expect(assetCandidates("Media/note.md", "shot.png")).toEqual([["Media", "shot.png"]]);
});

test("a link with nothing to fall back on offers nothing", () => {
  expect(assetCandidates("Notes/todo.md", "")).toEqual([]);
  expect(assetCandidates("Notes/todo.md", "./")).toEqual([]);
  expect(assetCandidates("Notes/todo.md", "%E0%A4%A")).toEqual([]);
  // Out of the store by the direct route; the name is still worth a look.
  expect(assetCandidates("c.md", "../escape.png")).toEqual([["Media", "escape.png"]]);
});

test("URLs the browser can already load are left alone", () => {
  expect(isAbsoluteUrl("https://example.com/a.png")).toBe(true);
  expect(isAbsoluteUrl("http://example.com/a.png")).toBe(true);
  expect(isAbsoluteUrl("data:image/png;base64,AAAA")).toBe(true);
  expect(isAbsoluteUrl("blob:https://example.com/abc")).toBe(true);
  expect(isAbsoluteUrl("//example.com/a.png")).toBe(true);
  expect(isAbsoluteUrl("/webfs/a.png")).toBe(true);
  // The only kind webfs has to resolve itself.
  expect(isAbsoluteUrl("assets/shot.png")).toBe(false);
  expect(isAbsoluteUrl("../shared/shot.png")).toBe(false);
});

test("a pasted file keeps its name where it has a usable one", () => {
  expect(assetName("screen shot.png")).toBe("screen shot.png");
  expect(assetName("café.jpeg")).toBe("café.jpeg");
  // A path is not a name; the store forbids separators in one.
  expect(assetName("/tmp/a/b/shot.png")).toBe("shot.png");
  expect(assetName("C:\\\\pics\\\\shot.png")).toBe("shot.png");
});

test("a file with no usable name gets invented one", () => {
  for (const nameless of ["", "   ", ".", ".."]) {
    expect(assetName(nameless)).toMatch(/^image-\d+\.png$/);
  }
});

test("the content type follows the extension, and is never guessed as text", () => {
  expect(mimeOf("a/b/shot.PNG")).toBe("image/png");
  expect(mimeOf("shot.jpg")).toBe("image/jpeg");
  expect(mimeOf("drawing.svg")).toBe("image/svg+xml");
  expect(mimeOf("mystery.bin")).toBe("application/octet-stream");
  expect(mimeOf("noextension")).toBe("application/octet-stream");
});

test("the sidebar link points at the branch being synced, not just the repo", () => {
  expect(branchUrl({ owner: "jdlunger", repo: "docs", branch: "main" })).toBe(
    "https://github.com/jdlunger/docs/tree/main",
  );
  // A branch's own slashes are path separators; encoding them would 404.
  expect(branchUrl({ owner: "me", repo: "my notes", branch: "notes/phone" })).toBe(
    "https://github.com/me/my%20notes/tree/notes/phone",
  );
});
