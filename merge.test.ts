import { test, expect } from "bun:test";
import { mergeText } from "./src/merge";

const doc = (...lines: string[]) => lines.join("\n");

test("no local edits takes the other tab's version wholesale", () => {
  const base = doc("one", "two");
  expect(mergeText(base, base, doc("one", "two", "three"))).toBe(doc("one", "two", "three"));
});

test("no remote change keeps what the user is typing", () => {
  const base = doc("one", "two");
  expect(mergeText(base, doc("one", "two edited"), base)).toBe(doc("one", "two edited"));
});

test("the other tab appending is lossless while you edit", () => {
  const base = doc("intro", "body");
  const mine = doc("intro edited", "body");
  const theirs = doc("intro", "body", "appended elsewhere");
  expect(mergeText(base, mine, theirs)).toBe(doc("intro edited", "body", "appended elsewhere"));
});

test("edits to different lines both survive", () => {
  const base = doc("a", "b", "c");
  const mine = doc("a MINE", "b", "c");
  const theirs = doc("a", "b", "c THEIRS");
  expect(mergeText(base, mine, theirs)).toBe(doc("a MINE", "b", "c THEIRS"));
});

test("a prepend by the other tab survives an edit further down", () => {
  const base = doc("a", "b", "c");
  const mine = doc("a", "b", "c MINE");
  const theirs = doc("new first", "a", "b", "c");
  expect(mergeText(base, mine, theirs)).toBe(doc("new first", "a", "b", "c MINE"));
});

test("both editing the same line keeps the local one, dropping theirs", () => {
  const base = doc("a", "shared", "c");
  const mine = doc("a", "shared MINE", "c");
  const theirs = doc("a", "shared THEIRS", "c");
  // Documented lossy case: the user's in-progress line wins.
  expect(mergeText(base, mine, theirs)).toBe(doc("a", "shared MINE", "c"));
});

test("overlapping structural edits fall back to local", () => {
  const base = doc("a", "b", "c");
  const mine = doc("a", "b MINE", "extra mine", "c");
  const theirs = doc("a", "b THEIRS", "c");
  expect(mergeText(base, mine, theirs)).toBe(mine);
});

test("identical concurrent edits collapse to one", () => {
  const base = doc("a", "b");
  const same = doc("a", "b!");
  expect(mergeText(base, same, same)).toBe(same);
});

test("merging is stable, so two tabs converge instead of ping-ponging", () => {
  const base = doc("a", "b", "c");
  const mine = doc("a MINE", "b", "c");
  const theirs = doc("a", "b", "c THEIRS");
  const merged = mergeText(base, mine, theirs);
  // Feeding the result back through must not keep producing new text.
  expect(mergeText(theirs, merged, theirs)).toBe(merged);
  expect(mergeText(merged, merged, merged)).toBe(merged);
});

test("empty documents and whole-file replacement do not throw", () => {
  expect(mergeText("", "", "")).toBe("");
  expect(mergeText("", "typed", "")).toBe("typed");
  expect(mergeText("old", "", "old")).toBe("");
  expect(typeof mergeText("a\nb", "totally different", "other thing")).toBe("string");
});
