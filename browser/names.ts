/**
 * What actually reaches OPFS, and what comes back.
 *
 * A vault synced from a phone had all nine of its non-ASCII paths rewritten by
 * the platform — `Einführung` written as U+00FC, read back as `u` + U+0308 —
 * and `planSync`, comparing paths as strings, pushed that to GitHub as nine
 * new files and nine deletions. Escaping names at the storage boundary is the
 * fix (see `src/names.ts`), and this is where it's checked against a real
 * OPFS rather than an idea of one.
 *
 * The assertion that matters most is engine-independent: **nothing but
 * printable ASCII is ever handed to the platform.** Whether *this* engine
 * would have normalised a name is then beside the point, which is just as
 * well — the engine that did it was WebKit on a phone, and these suites run
 * Chromium on Linux.
 */
import type { Browser } from "playwright";
import { Checks, asText, expandFolder, openApp, openFile, opfsFiles, waitUntil, writeOpfsFile } from "./harness";

/** The two spellings of `ü`. Identical on screen, different bytes. */
const NFC = "Einführung";
const NFD = "Einführung";

const NOTE = "Sa 29.08.2026 Studienführer.md";
const BODY = "#classnotes\n\nStudienführer, precomposed.\n";

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("names on disk");
  checks.heading();

  const context = await browser.newContext();
  const page = await openApp(context);
  await page.waitForSelector(".tree-row", { timeout: 15_000 });

  // Planted raw, the way a store written before the escaping existed holds
  // them — and the way another tool writing into OPFS still would.
  await writeOpfsFile(page, `${NFC}/${NOTE}`, BODY);
  await writeOpfsFile(page, `${NFD}/other.md`, "decomposed\n");

  const before = Object.keys(await opfsFiles(page));
  checks.ok("the planted names really are non-ASCII on disk", before.some(p => /[^\x20-\x7E]/.test(p)), before.join(", "));

  await page.reload();
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  await waitUntil("the sweep to rename them", async () =>
    Object.keys(await opfsFiles(page)).every(p => !/[^\x20-\x7E]/.test(p)),
  );

  const stored = Object.keys(await opfsFiles(page)).sort();
  checks.note(`stored: ${stored.join(", ")}`);

  // The invariant the whole change exists for.
  checks.ok(
    "every stored path is printable ASCII, so no engine has anything to normalise",
    stored.every(path => /^[\x20-\x7E]+$/.test(path)),
    stored.join(", "),
  );
  checks.ok(
    "no stored path holds a character a filesystem argues about",
    stored.every(path => !/[%<>:"|?*\\]/.test(path.replace(/%[0-9A-F]{2}/g, ""))),
    stored.join(", "),
  );
  checks.ok(
    "the umlaut folder is escaped, not renamed away",
    stored.includes(`Einf%C3%BChrung/Sa 29.08.2026 Studienf%C3%BChrer.md`),
    stored.join(", "),
  );
  checks.ok(
    "the two spellings stay two folders rather than colliding",
    stored.some(p => p.startsWith("Einf%C3%BChrung/")) && stored.some(p => p.startsWith("Einfu%CC%88hrung/")),
    stored.join(", "),
  );

  // Escaped on disk, and the user never sees it.
  const rows = await page.locator(".tree-row").allInnerTexts();
  checks.ok("the sidebar shows the name as it was written", rows.some(r => r.includes(NFC)), rows.join(" | "));
  checks.ok("and never shows an escape", !rows.some(r => r.includes("%C3")), rows.join(" | "));

  // The path the app holds has to find the file again, which is exactly what
  // the legacy store could no longer do.
  await expandFolder(page, NFC);
  await openFile(page, NOTE);
  const shown = await page.locator(".pane-focused .milkdown-root .ProseMirror").innerText();
  checks.ok("opening it finds the file behind the escaped name", shown.includes("Studienführer"), shown.slice(0, 80));

  const files = await opfsFiles(page);
  checks.ok(
    "and its bytes were never touched",
    asText(files["Einf%C3%BChrung/Sa 29.08.2026 Studienf%C3%BChrer.md"] ?? "") === BODY,
  );

  // The write path: a name typed into the app, not planted.
  await page.locator('.tree-row:has-text("welcome.md")').first().click({ button: "right" });
  await page.locator('.context-menu-item:has-text("Rename")').first().click();
  await page.fill(".rename-input", "Fähigkeit.md");
  await page.keyboard.press("Enter");

  const renamed = await waitUntil("the rename to land", async () =>
    Object.keys(await opfsFiles(page)).some(p => p.endsWith("F%C3%A4higkeit.md")),
  );
  checks.ok("a name typed into the app is escaped on the way to disk", renamed, Object.keys(await opfsFiles(page)).join(", "));
  const after = await page.locator(".tree-row").allInnerTexts();
  checks.ok("and reads back as what was typed", after.some(r => r.includes("Fähigkeit.md")), after.join(" | "));

  await context.close();
  return checks.failures;
}
