/**
 * The plain-text view and the toggle that reaches it.
 *
 * Nothing here is pure: what's being checked is that two editors can take
 * turns over one file without either losing what the other wrote. Crepe reads
 * its content once at construction and serialises the document it parsed, so
 * a round trip through it is exactly where text goes missing — and only a
 * real browser has a Crepe to round-trip through.
 */
import type { Browser, Page } from "playwright";
import { Checks, asText, openApp, openFile, opfsFiles, waitUntil } from "./harness";

const TO_TEXT = '.pane-focused .tab-strip-button[aria-label="Edit as plain text"]';
const TO_RICH = '.pane-focused .tab-strip-button[aria-label="Back to the formatted editor"]';
const SOURCE = ".pane-focused .text-editor";

/** The text OPFS holds for a path, or "" while it isn't there yet. */
async function stored(page: Page, path: string): Promise<string> {
  const file = (await opfsFiles(page))[path];
  return file === undefined ? "" : asText(file);
}

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("plain-text view");
  checks.heading();

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openApp(context);
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  await openFile(page, "welcome.md");

  // --- switching over --------------------------------------------------------

  await page.click(TO_TEXT);
  await page.waitForSelector(SOURCE, { timeout: 5_000 });
  const source = await page.locator(SOURCE).inputValue();
  checks.ok("the toggle shows the markdown behind the document", source.includes("# Welcome"), source.slice(0, 40));
  checks.ok("the rendered editor goes away with it", (await page.locator(".pane-focused .milkdown-root").count()) === 0);

  // --- editing it ------------------------------------------------------------

  await page.click(SOURCE);
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n\n## Written as source");
  const landed = await waitUntil("the source edit to reach OPFS", async () =>
    (await stored(page, "Notes/welcome.md")).includes("## Written as source"),
  );
  checks.ok("typing in it saves to the same file", landed, await stored(page, "Notes/welcome.md"));

  // --- and back --------------------------------------------------------------

  await page.click(TO_RICH);
  await page.waitForSelector(".pane-focused .milkdown-root .ProseMirror", { timeout: 10_000 });
  await page.waitForTimeout(500);
  const rendered = await page.locator(".pane-focused .milkdown-root .ProseMirror").innerText();
  checks.ok("toggling back renders what was typed as source", rendered.includes("Written as source"), rendered.slice(0, 80));
  // The heading is markup in one view and a heading in the other; seeing the
  // "##" here would mean the source had been pasted in as literal text.
  checks.ok("and renders it, rather than showing the markup", !rendered.includes("## Written as source"), rendered.slice(0, 80));
  checks.ok("the source view is gone", (await page.locator(SOURCE).count()) === 0);

  await page.click(".pane-focused .milkdown-root .ProseMirror");
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nand rich again");
  const bothKept = await waitUntil("the round trip to settle in OPFS", async () => {
    const text = await stored(page, "Notes/welcome.md");
    return text.includes("Written as source") && text.includes("and rich again");
  });
  checks.ok("a round trip loses neither editor's writing", bothKept, await stored(page, "Notes/welcome.md"));

  // --- the view belongs to the file, not the pane ----------------------------

  await page.click(TO_TEXT);
  await page.waitForSelector(SOURCE, { timeout: 5_000 });
  await openFile(page, "todo.md");
  checks.ok("another file opens rendered, whatever the last one was showing", (await page.locator(SOURCE).count()) === 0);
  await page.locator('.pane-focused .tab:has-text("welcome.md")').click();
  await page.waitForTimeout(300);
  checks.ok("and the first one is still as it was left", (await page.locator(SOURCE).count()) === 1);

  // Renaming an open file changes its id, which is the key the view is held
  // under; without remapping it the file would snap back to rendered.
  await page.locator('.tree-row:has-text("welcome.md")').click({ button: "right" });
  await page.waitForSelector(".context-menu", { timeout: 5_000 });
  await page.locator('.context-menu-item:has-text("Rename")').first().click();
  await page.fill(".rename-input", "readme.md");
  await page.keyboard.press("Enter");
  const renamed = await waitUntil("the rename to land in OPFS", async () => Boolean((await opfsFiles(page))["Notes/readme.md"]));
  checks.ok("the rename lands", renamed);
  await page.waitForTimeout(500);
  checks.ok("a renamed file stays in the view it was being read in", (await page.locator(SOURCE).count()) === 1);

  await context.close();
  await checkTouch(browser, checks);
  return checks.failures;
}

/**
 * The phone: no tab strip to hold the toggle, so the topbar has it instead.
 */
async function checkTouch(browser: Browser, checks: Checks): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const page = await openApp(context);
  // The tree, not the topbar: the topbar is part of the chrome now and is on
  // screen before a drive has finished loading, so waiting on it would ask
  // about the toggle before there is a file for it to act on.
  await page.waitForSelector(".tree-row", { timeout: 15_000 });

  checks.ok("the topbar carries the toggle", (await page.locator(".mobile-view-button").count()) === 1);
  await page.click(".mobile-view-button");
  await page.waitForSelector(".text-editor", { timeout: 5_000 });
  const source = await page.locator(".text-editor").inputValue();
  checks.ok("it shows the open file as source", source.includes("- [ ]"), source.slice(0, 40));

  await page.click(".mobile-view-button");
  await page.waitForSelector(".milkdown-root .ProseMirror", { timeout: 10_000 });
  checks.ok("and switches back", (await page.locator(".text-editor").count()) === 0);

  await context.close();
}
