/**
 * Covers the rule that a file is only ever changed where the user typed.
 *
 * The cases are written the way they arise: `baseline` is what the serializer
 * makes of the original, `current` is that with an edit in it, and the answer
 * has to be the original's own bytes everywhere else.
 */
import { test, expect } from "bun:test";
import { preserveUnchanged } from "./src/preserve";

/** The reconstruction the editor would try first. */
const best = (original: string, baseline: string, current: string) => preserveUnchanged(original, baseline, current)[0]!;

/** A note as Obsidian writes it: tabs, `-` bullets, an unescaped tag. */
const ORIGINAL = "#classnotes\n\nRon Clijsen\n\n- Rezeptoren vs Sensoren\n\t- Sensor = ein Organ\n\t- Rezeptor = eine Struktur\n- Der Knochen\n";
/** The same note as the serializer would write it. */
const BASELINE = "\\#classnotes\n\nRon Clijsen\n\n* Rezeptoren vs Sensoren\n  * Sensor = ein Organ\n  * Rezeptor = eine Struktur\n* Der Knochen\n";

test("a note nobody edited comes back exactly as it was", () => {
  expect(best(ORIGINAL, BASELINE, BASELINE)).toBe(ORIGINAL);
});

test("only the edited line takes the serializer's dialect", () => {
  const current = BASELINE.replace("* Der Knochen", "* Der Knochen und der Knorpel");
  expect(best(ORIGINAL, BASELINE, current)).toBe(
    "#classnotes\n\nRon Clijsen\n\n- Rezeptoren vs Sensoren\n\t- Sensor = ein Organ\n\t- Rezeptor = eine Struktur\n* Der Knochen und der Knorpel\n",
  );
});

test("the tabs and the tag survive an edit somewhere else entirely", () => {
  const current = BASELINE.replace("Ron Clijsen", "Ron Clijsen, THIM");
  const result = best(ORIGINAL, BASELINE, current);
  expect(result).toContain("#classnotes\n");
  expect(result).not.toContain("\\#");
  expect(result).toContain("\t- Sensor = ein Organ");
  expect(result).toContain("Ron Clijsen, THIM");
});

test("an inserted line lands between untouched ones", () => {
  const current = BASELINE.replace("* Der Knochen", "* Der Knorpel\n* Der Knochen");
  expect(best(ORIGINAL, BASELINE, current)).toBe(
    "#classnotes\n\nRon Clijsen\n\n- Rezeptoren vs Sensoren\n\t- Sensor = ein Organ\n\t- Rezeptor = eine Struktur\n* Der Knorpel\n- Der Knochen\n",
  );
});

test("a deleted line takes only itself", () => {
  const current = BASELINE.replace("  * Sensor = ein Organ\n", "");
  expect(best(ORIGINAL, BASELINE, current)).toBe(
    "#classnotes\n\nRon Clijsen\n\n- Rezeptoren vs Sensoren\n\t- Rezeptor = eine Struktur\n- Der Knochen\n",
  );
});

test("a line the user deletes and types again is theirs now", () => {
  // The one case where a rewrite is right: it isn't the original line any more.
  const current = BASELINE.replace("  * Sensor = ein Organ", "  * Sensor = ein Organ!");
  expect(best(ORIGINAL, BASELINE, current)).toContain("  * Sensor = ein Organ!");
});

test("typing at the very end doesn't leave the old ending behind it", () => {
  const current = BASELINE.replace("* Der Knochen\n", "* Der Knochen\n\n* Das Blut\n");
  const result = best(ORIGINAL, BASELINE, current);
  expect(result.endsWith("* Das Blut\n")).toBe(true);
  expect(result).not.toContain("Das Blut\n\n- Der Knochen");
});

test("a line the serializer invented is dropped, not kept", () => {
  // remark puts a blank line between a paragraph and the list under it; the
  // vault runs them together, and that's the form to hand back.
  const original = "Text\n- item\n";
  const baseline = "Text\n\n* item\n";
  const current = baseline.replace("* item", "* item edited");
  expect(best(original, baseline, current)).toBe("Text\n* item edited\n");
});

test("a blank line the serializer dropped comes back", () => {
  const original = "one\n\n\n\ntwo\n";
  const baseline = "one\n\ntwo\n";
  expect(best(original, baseline, baseline)).toBe(original);
});

test("nothing to preserve falls back to what the editor said", () => {
  expect(best("", "", "typed\n")).toBe("typed\n");
  // No trailing newline in the original means none in the result.
  expect(best("a", "a\n", "a\n")).toBe("a");
});

test("a file with no trailing newline keeps not having one", () => {
  const result = best("- one\n- two", "* one\n* two\n", "* one\n* two\n* three\n");
  expect(result).toBe("- one\n- two\n* three");
});

test("the whole note is preserved when the edit is a single character", () => {
  const original = Array.from({ length: 200 }, (_, i) => `\t- line ${i}`).join("\n") + "\n";
  const baseline = Array.from({ length: 200 }, (_, i) => `  * line ${i}`).join("\n") + "\n";
  const current = baseline.replace("  * line 100", "  * line 100 X");
  const result = best(original, baseline, current);

  const lines = result.split("\n");
  expect(lines.filter(l => l.startsWith("\t- ")).length).toBe(199);
  expect(lines[100]).toBe("  * line 100 X");
});

test("a callout's checklist lines up despite the bullet behind the quote", () => {
  // An Obsidian `> [!todo]` is a blockquote; without matching through the
  // marker, an edit anywhere in a note ending in one rewrote the whole note.
  const original = "Notes\n\n> [!todo]\n> - [x] Lesen Kapitel 4 📅 25.09.2026\n> - [ ] Kapitel 5\n";
  const baseline = "Notes\n\n> \\[!todo]\n>\n> * [x] Lesen Kapitel 4 📅 25.09.2026\n>\n> * [ ] Kapitel 5\n";
  const current = baseline.replace("Notes", "Notes today");

  expect(best(original, baseline, current)).toBe(
    "Notes today\n\n> [!todo]\n> - [x] Lesen Kapitel 4 📅 25.09.2026\n> - [ ] Kapitel 5\n",
  );
});

test("a cautious second answer keeps the blank line new text needs", () => {
  // Typing a paragraph after a callout: the original has no blank line to
  // spare there, and handing it back exactly would tuck the new paragraph
  // inside the quote. The first answer is still the exact one — the caller
  // finds out which survives being read back.
  // The blank line at the end of `baseline` is Crepe's empty trailing
  // paragraph, which is where typing after a callout actually lands.
  const original = "Notes\n\n> [!todo]\n> - [x] Kapitel 4\n";
  const baseline = "Notes\n\n> \\[!todo]\n>\n> * [x] Kapitel 4\n\n";
  const current = "Notes\n\n> \\[!todo]\n>\n> * [x] Kapitel 4\n\nZ\n";

  const answers = preserveUnchanged(original, baseline, current);
  expect(answers[0]).toBe("Notes\n\n> [!todo]\n> - [x] Kapitel 4\nZ\n");
  expect(answers[1]).toBe("Notes\n\n> [!todo]\n> - [x] Kapitel 4\n\nZ\n");
  expect(answers.at(-1)).toBe(current);
});

test("the last answer is always the editor's own text", () => {
  expect(preserveUnchanged("", "", "typed\n").at(-1)).toBe("typed\n");
  expect(preserveUnchanged("- a\n", "* a\n", "* a\n* b\n").at(-1)).toBe("* a\n* b\n");
});
