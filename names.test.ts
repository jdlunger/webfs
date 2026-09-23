/**
 * The escaping that keeps a filesystem from editing webfs's names.
 *
 * The cases that matter are the ones that actually happened: a vault's nine
 * non-ASCII paths, and the round trip that has to be exact for a note to still
 * be findable after being written.
 */
import { test, expect } from "bun:test";
import { decodePath, decodeSegment, encodePath, encodeSegment, isCanonical } from "./src/names";

/** The two spellings of `ü` that started this. */
const NFC = "Einführung";
const NFD = "Einführung";

test("a name the platform can't touch is stored as itself", () => {
  for (const name of ["todo.md", "Geshundheit & Bewegung", "Pasted image 20260905101712.png", ".obsidian", "a (1).md"]) {
    expect(encodeSegment(name)).toBe(name);
  }
});

test("anything non-ASCII is escaped, whatever the engine would have done to it", () => {
  expect(encodeSegment(NFC)).toBe("Einf%C3%BChrung");
  expect(encodeSegment("Fähigkeit")).toBe("F%C3%A4higkeit");
  expect(encodeSegment("café.md")).toBe("caf%C3%A9.md");
  expect(encodeSegment("日本語.md")).toBe("%E6%97%A5%E6%9C%AC%E8%AA%9E.md");
});

test("the two spellings of ü stay distinct, which is the whole point", () => {
  // Same text, different normalisation: the escape keeps them apart rather
  // than letting the platform decide they're the same, or aren't.
  expect(NFC).not.toBe(NFD);
  expect(encodeSegment(NFC)).not.toBe(encodeSegment(NFD));
  expect(encodeSegment(NFD)).toBe("Einfu%CC%88hrung");
});

test("every name round-trips exactly", () => {
  const names = [NFC, NFD, "todo.md", "café.md", "日本語.md", "a%b.md", "100% done.md", "Sa. 19.09.2026 Fähigkeit.md", "~tmp", "a'b\"c.md"];
  for (const name of names) expect(decodeSegment(encodeSegment(name))).toBe(name);
});

test("the escape character escapes itself, or decoding would be a guess", () => {
  expect(encodeSegment("100%")).toBe("100%25");
  expect(decodeSegment("100%25")).toBe("100%");
  // A name that already looks encoded stays distinct from what it looks like.
  expect(encodeSegment("Einf%C3%BChrung")).toBe("Einf%25C3%25BChrung");
  expect(decodeSegment(encodeSegment("Einf%C3%BChrung"))).toBe("Einf%C3%BChrung");
});

test("characters filesystems object to are escaped", () => {
  expect(encodeSegment("a:b.md")).toBe("a%3Ab.md");
  expect(encodeSegment("what?.md")).toBe("what%3F.md");
  expect(encodeSegment("a|b")).toBe("a%7Cb");
  expect(encodeSegment("a\u0001b")).toBe("a%01b");
});

test("edges that get silently trimmed are escaped, and a leading dot isn't", () => {
  expect(encodeSegment("notes.")).toBe("notes%2E");
  expect(encodeSegment("notes ")).toBe("notes%20");
  expect(encodeSegment(" notes")).toBe("%20notes");
  // Dots and spaces in the middle are ordinary, and so is a leading dot.
  expect(encodeSegment("a.b.md")).toBe("a.b.md");
  expect(encodeSegment("a b.md")).toBe("a b.md");
  expect(encodeSegment(".obsidian")).toBe(".obsidian");
});

test("decoding is total, so a name written before any of this survives", () => {
  // Legacy names: no escapes at all, or a stray % that begins nothing.
  expect(decodeSegment(NFC)).toBe(NFC);
  expect(decodeSegment("Geshundheit & Bewegung")).toBe("Geshundheit & Bewegung");
  expect(decodeSegment("50% off")).toBe("50% off");
  expect(decodeSegment("%")).toBe("%");
  expect(decodeSegment("%ZZ")).toBe("%ZZ");
  expect(decodeSegment("%C3")).toBe("�"); // Half a character is not a crash.
});

test("isCanonical is what tells a migration what to rename", () => {
  expect(isCanonical("Einf%C3%BChrung")).toBe(true);
  expect(isCanonical("todo.md")).toBe(true);
  expect(isCanonical("Geshundheit & Bewegung")).toBe(true);
  // Written before the escaping existed — these are the ones to rename.
  expect(isCanonical(NFC)).toBe(false);
  expect(isCanonical(NFD)).toBe(false);
  expect(isCanonical("notes.")).toBe(false);
});

test("a path is just its segments, each on its own", () => {
  expect(encodePath([NFC, "Sa 29.08.2026 Studienführer.md"])).toEqual([
    "Einf%C3%BChrung",
    "Sa 29.08.2026 Studienf%C3%BChrer.md",
  ]);
  expect(decodePath(["Einf%C3%BChrung", "Sa 29.08.2026 Studienf%C3%BChrer.md"])).toEqual([
    NFC,
    "Sa 29.08.2026 Studienführer.md",
  ]);
});
