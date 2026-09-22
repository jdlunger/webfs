/**
 * A note written somewhere else, opened and edited here.
 *
 * Milkdown re-serializes the whole document on every change, so without the
 * preservation in `preserve.ts` a single keystroke rewrote the lot: measured
 * against a real Obsidian vault, 190 lines of a 179-line note. Worse, Crepe
 * changes the document once on its own after mounting, so *opening* a note was
 * enough — nobody had to type anything — and the next sync carried the whole
 * file to GitHub as the user's work.
 *
 * None of that shows up in `bun test`: it needs the real editor, the real
 * serializer and the real save loop. So it's asserted here, on a note written
 * in the dialect a vault is actually written in.
 */
import type { Browser } from "playwright";
import { Checks, asText, openApp, openFile, opfsFiles, waitUntil, writeOpfsBytes, writeOpfsFile } from "./harness";

const NOTE = [
  "#classnotes ",
  "",
  "Ron Clijsen unterrichtet",
  "",
  "- Rezeptoren vs Sensoren",
  "\t- Sensor = ein Organ",
  "\t- Rezeptor = eine Struktur",
  "",
  "See [[Osteologie Knie]] and ![[Studienführer.pdf]]",
  "",
  "![[Pasted image 20260905101712.png|20]]",
  "",
  "| Achse         | Ebene        |",
  "| ------------- | ------------ |",
  "| Longitudinale | Transversale |",
  "",
  "> [!todo]",
  "> - [x] Lesen Kapitel 4 📅 25.09.2026",
  "> - [ ] Kapitel 5",
  "",
].join("\n");

const PATH = "Vault/Physiologie.md";
const IMAGE = "Media/Pasted image 20260905101712.png";
/** A real 3×3 PNG, so the embed above has something to resolve to. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAFUlEQVR4nGP8z8DwnwEJMKEL0EoQAHFiAiFbTJ7fAAAAAElFTkSuQmCC";

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("a note from a vault");
  checks.heading();

  const context = await browser.newContext();
  const page = await openApp(context);
  await page.waitForSelector(".milkdown-root, .editor", { timeout: 15_000 });

  await writeOpfsFile(page, PATH, NOTE);
  await writeOpfsBytes(page, IMAGE, PNG_BASE64);

  await page.reload();
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  await openFile(page, "Physiologie.md");

  // Long enough that a save would have landed: the editor's own 200ms, the
  // 400ms write debounce, and room to spare.
  await page.waitForTimeout(2500);
  const opened = asText((await opfsFiles(page))[PATH] ?? "");
  checks.ok("opening a note doesn't write anything", opened === NOTE, JSON.stringify(opened.slice(0, 80)));

  // An edit in the middle of the note, where a caret really goes.
  await page.locator(".pane-focused .milkdown-root .ProseMirror p", { hasText: "Ron Clijsen unterrichtet" }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" heute");

  await waitUntil("the edit to be saved", async () => asText((await opfsFiles(page))[PATH] ?? "").includes("heute"));
  await page.waitForTimeout(600);
  const after = asText((await opfsFiles(page))[PATH] ?? "");

  const before = NOTE.split("\n");
  const now = after.split("\n");
  const changed = before.map((line, i) => (line === now[i] ? null : i)).filter(i => i !== null);
  checks.note(`lines changed: ${JSON.stringify(changed)}`);
  checks.ok("a keystroke changes the line it was typed on", now[2] === "Ron Clijsen unterrichtet heute", String(now[2]));
  checks.ok("and changes no other line in the note", changed.length === 1 && before.length === now.length, after);

  // Spelled out, because each of these is a different way of being rewritten.
  const kept = (what: string, line: string) => checks.ok(what, now.includes(line), JSON.stringify(line));
  kept("the tag keeps its #, rather than being escaped", "#classnotes ");
  kept("bullets keep their - marker", "- Rezeptoren vs Sensoren");
  kept("nested bullets keep their tabs", "\t- Sensor = ein Organ");
  kept("the table keeps its own spacing", "| Achse         | Ebene        |");
  kept("the callout and its tasks are untouched", "> - [x] Lesen Kapitel 4 📅 25.09.2026");
  kept("a wikilink and a non-image embed survive", "See [[Osteologie Knie]] and ![[Studienführer.pdf]]");
  kept("an image embed survives", "![[Pasted image 20260905101712.png|20]]");

  const shown = await page
    .locator(".milkdown-root .wiki-image img")
    .evaluateAll(images => images.some(i => (i as HTMLImageElement).naturalWidth > 0));
  checks.ok("and is on screen as the picture, not as its source", shown);

  await context.close();
  return checks.failures;
}
