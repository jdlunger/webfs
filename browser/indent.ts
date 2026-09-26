/**
 * Indenting a list item on a screen with no Tab key.
 *
 * Milkdown binds sink/lift-list-item to Tab and Shift-Tab only, and iOS's
 * on-screen keyboard has no Tab key to press — so without a touch equivalent
 * there was no way to indent a list at all on a phone. What's being checked
 * is the button that stands in for the keystroke: that tapping it actually
 * moves the line (rather than doing nothing, which is what it would do if the
 * `onPointerDown` had let the tap steal focus — and with it the selection the
 * command acts on — before the command ran), and that it's gone entirely on a
 * screen wide enough to have the keyboard shortcut in the first place.
 */
import type { Browser, Page } from "playwright";
import { Checks, asText, openApp, openFile, opfsFiles, waitUntil } from "./harness";

const OUTDENT = '.pane-focused .indent-toolbar-button[aria-label="Outdent list item"]';
const INDENT = '.pane-focused .indent-toolbar-button[aria-label="Indent list item"]';

/** The text OPFS holds for a path, or "" while it isn't there yet. */
async function stored(page: Page, path: string): Promise<string> {
  const file = (await opfsFiles(page))[path];
  return file === undefined ? "" : asText(file);
}

/** The line mentioning `word`, or undefined if there isn't one. */
async function lineWith(page: Page, path: string, word: string): Promise<string | undefined> {
  return (await stored(page, path)).split("\n").find(l => l.includes(word));
}

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("indenting a list on a phone");
  checks.heading();

  // --- a wide screen has a keyboard, so no buttons ----------------------------

  const wideContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const widePage = await openApp(wideContext);
  await widePage.waitForSelector(".tree-row", { timeout: 15_000 });
  await openFile(widePage, "welcome.md");
  checks.ok("no toolbar on a screen wide enough for Tab to work", (await widePage.locator(".indent-toolbar").count()) === 0);
  await wideContext.close();

  // --- the phone case ----------------------------------------------------------

  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const page = await openApp(context);
  await page.waitForSelector(".tree-row", { timeout: 15_000 });

  // A fresh, empty file rather than one of the seeded notes: `Control+End`
  // isn't bound in the rich editor the way it is in the plain-text view, so a
  // click into an existing multi-line note at phone width — where a sentence
  // wraps across several lines — can land mid-word, and everything typed
  // after lands there too. An empty document has nowhere else for a click to
  // land.
  await page.click(".mobile-menu-button");
  await page.waitForTimeout(400);
  // The drawer is always narrower than ROOM_FOR_LABELS, so "+ File" doesn't
  // exist here at all — only the collapsed "+" that opens the same menu a
  // long press on the empty tree area does.
  await page.click('button[title="New file, new folder, or import"]');
  await page.click('.context-menu-item:has-text("New File")');
  // openFile's own click waits out however long the tree takes to show the
  // new row, so nothing extra is needed before it.
  await openFile(page, "untitled.md");

  checks.ok("the toolbar shows on a phone", (await page.locator(".indent-toolbar-button").count()) === 2);

  const path = "untitled.md";
  await page.click(".pane-focused .milkdown-root .ProseMirror");
  // "- " triggers Milkdown's bullet-list input rule mid-word — a transaction
  // of its own, not just an inserted character — and typing straight through
  // it faster than that lands raced with the next few keystrokes. A small
  // delay is enough for it to settle between them.
  await page.keyboard.type("- one\n- two", { delay: 20 });
  const listed = await waitUntil("the list to reach OPFS", async () => (await lineWith(page, path, "two")) !== undefined);
  checks.ok("typing a list saves it", listed, await stored(page, path));

  // The cursor is in "two" — the line typing left it on — so indenting now has
  // to nest that item under "one" and leave "one" where it was.
  await page.click(INDENT);
  const indented = await waitUntil("the indent to reach OPFS", async () => {
    const line = await lineWith(page, path, "two");
    return !!line && /^\s+-\s/.test(line);
  });
  checks.ok("the indent button nests the item", indented, await stored(page, path));
  checks.ok(
    "the item above it is untouched",
    /^-\s+one\s*$/.test((await lineWith(page, path, "one")) ?? ""),
    await stored(page, path),
  );

  await page.click(OUTDENT);
  const outdented = await waitUntil("the outdent to reach OPFS", async () => {
    const line = await lineWith(page, path, "two");
    return !!line && /^-\s/.test(line);
  });
  checks.ok("the outdent button un-nests it again", outdented, await stored(page, path));

  await context.close();
  return checks.failures;
}
