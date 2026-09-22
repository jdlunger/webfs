/**
 * Several drives on one device.
 *
 * A drive is a whole filesystem, and the thing that can go wrong is that two
 * of them aren't: a path means something different in each, so a write that
 * lands in the drive you aren't looking at, or a tree that comes back from
 * the last one, shows up as data appearing where nobody put it. None of that
 * is visible from the pure tests — the mount only exists in OPFS — so it has
 * to be driven here.
 */
import type { Browser } from "playwright";
import { APP_URL, Checks, addLocalDrive, asText, openApp, openFile, opfsFiles, switchToDrive, typeInEditor, waitUntil } from "./harness";

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("several drives");
  checks.heading();

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openApp(context);
  await page.waitForSelector(".tree-row", { timeout: 15_000 });

  // --- the drive a first visit lands in ---------------------------------------

  checks.ok("a first visit lands in a drive, not a dialog", (await page.locator(".drive-switch").innerText()).includes("notes"));
  checks.ok(
    "its starter notes are there",
    Boolean((await opfsFiles(page, "opfs/notes"))["Notes/welcome.md"]),
    Object.keys(await opfsFiles(page, "opfs/notes")).join(", "),
  );
  await openFile(page, "welcome.md");
  checks.ok(
    "the URL names the drive and then the file",
    new URL(page.url()).pathname === "/opfs/notes/Notes/welcome.md",
    page.url(),
  );

  // --- a second drive ----------------------------------------------------------

  await addLocalDrive(page, "work");
  await page.waitForTimeout(800);
  checks.ok("adding a drive goes to it", (await page.locator(".drive-switch").innerText()).includes("work"));
  checks.ok("the URL follows", new URL(page.url()).pathname === "/opfs/work", page.url());
  // Starter notes are for the drive webfs makes for itself, not for every
  // folder anyone adds afterwards.
  checks.ok("a drive you add starts empty", (await page.locator(".tree-row").count()) === 0);

  await page.click('.sidebar-header-actions button[title="New file"]');
  await page.waitForSelector(".tree-row", { timeout: 10_000 });
  await openFile(page, "untitled.md");
  await typeInEditor(page, "written in the work drive");
  const written = await waitUntil("the text to reach the work drive", async () =>
    asText((await opfsFiles(page, "opfs/work"))["untitled.md"] ?? "").includes("written in the work drive"),
  );
  checks.ok("typing in it writes into that drive's folder", written);
  checks.ok(
    "and leaves the other drive alone",
    (await opfsFiles(page, "opfs/notes"))["untitled.md"] === undefined,
    Object.keys(await opfsFiles(page, "opfs/notes")).join(", "),
  );

  // --- one path, two drives ----------------------------------------------------

  await switchToDrive(page, "notes");
  await page.waitForSelector('.tree-row:has-text("welcome.md")', { timeout: 10_000 });
  checks.ok("switching back brings the first drive's files back", (await page.locator('.tree-row:has-text("welcome.md")').count()) > 0);
  checks.ok("and not the other drive's", (await page.locator('.tree-row:has-text("untitled.md")').count()) === 0);

  await page.click('.sidebar-header-actions button[title="New file"]');
  await page.waitForSelector('.tree-row:has-text("untitled.md")', { timeout: 10_000 });
  await openFile(page, "untitled.md");
  await typeInEditor(page, "written in the notes drive");
  await waitUntil("the second file to be written", async () =>
    asText((await opfsFiles(page, "opfs/notes"))["untitled.md"] ?? "").includes("written in the notes drive"),
  );
  // The same path in both drives: the one thing a shared root couldn't do.
  checks.ok(
    "the same path in two drives holds two different files",
    asText((await opfsFiles(page, "opfs/notes"))["untitled.md"] ?? "").includes("notes drive") &&
      asText((await opfsFiles(page, "opfs/work"))["untitled.md"] ?? "").includes("work drive"),
  );

  // --- what each drive remembers ------------------------------------------------

  // A workspace is a set of paths within one drive, so each drive keeps its
  // own: sharing one entry would restore tabs onto whatever happens to sit at
  // those paths in the next drive.
  await openFile(page, "todo.md");
  await page.waitForTimeout(400);
  const notesTabs = await page.locator(".pane-focused .tab").allInnerTexts();
  await switchToDrive(page, "work");
  await page.waitForTimeout(800);
  const workTabs = await page.locator(".pane-focused .tab").allInnerTexts();
  checks.ok(
    "each drive keeps its own tabs, not the other's",
    notesTabs.length > workTabs.length && !workTabs.some(tab => tab.includes("todo.md")),
    `notes: ${notesTabs.join("|")} — work: ${workTabs.join("|")}`,
  );

  await switchToDrive(page, "notes");
  await page.waitForTimeout(800);
  checks.ok(
    "and gets them back on the way in",
    JSON.stringify(await page.locator(".pane-focused .tab").allInnerTexts()) === JSON.stringify(notesTabs),
    (await page.locator(".pane-focused .tab").allInnerTexts()).join("|"),
  );

  await page.reload();
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  await page.waitForTimeout(1200);
  checks.ok(
    "a reload comes back to the same drive and the same tabs",
    (await page.locator(".drive-switch").innerText()).includes("notes") &&
      JSON.stringify(await page.locator(".pane-focused .tab").allInnerTexts()) === JSON.stringify(notesTabs),
    `${await page.locator(".drive-switch").innerText()} — ${(await page.locator(".pane-focused .tab").allInnerTexts()).join("|")}`,
  );

  // --- a link into a drive -----------------------------------------------------

  const deep = await openApp(context, "/opfs/work/untitled.md");
  await deep.waitForSelector(".tree-row", { timeout: 15_000 });
  await deep.waitForTimeout(1200);
  checks.ok("a link opens the drive it names", (await deep.locator(".drive-switch").innerText()).includes("work"));
  checks.ok(
    "and the file inside it",
    (await deep.locator(".pane-focused .text-editor, .pane-focused .milkdown-root .ProseMirror").innerText()).includes(
      "work drive",
    ),
  );
  await deep.close();

  // --- removing one ------------------------------------------------------------

  await switchToDrive(page, "work");
  await page.waitForTimeout(500);
  await page.click(".drive-settings");
  await page.waitForSelector(".modal", { timeout: 10_000 });
  await page.click(".modal-danger");
  await page.waitForTimeout(1200);
  checks.ok("removing the drive you're in lands you in another", (await page.locator(".drive-switch").innerText()).includes("notes"));
  await page.click(".drive-switch");
  checks.ok("and it's gone from the picker", (await page.locator('.drive-picker-item:has-text("work")').count()) === 0);
  await page.keyboard.press("Escape");
  await page.click(".drive-picker-scrim");

  // Removing a drive is about this device's list. Deleting the folder as well
  // would make "remove" mean "delete everything", with no warning and no undo.
  checks.ok(
    "its files are still on disk, not deleted with it",
    asText((await opfsFiles(page, "opfs/work"))["untitled.md"] ?? "").includes("work drive"),
  );

  await context.close();
  return checks.failures;
}
