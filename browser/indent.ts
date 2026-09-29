/**
 * Indenting a list item on a screen with no Tab key.
 *
 * Milkdown binds sink/lift-list-item to Tab and Shift-Tab only, and iOS's
 * on-screen keyboard has no Tab key to press — so without a touch equivalent
 * there was no way to indent a list at all on a phone. What's being checked
 * is the floating pair of buttons that stand in for the keystroke: that they
 * appear only with the cursor actually in a list item, float above the line
 * it's on rather than sitting somewhere fixed, that tapping one actually
 * moves the line (rather than doing nothing, which is what it would do if the
 * tap had stolen focus — and with it the selection the command acts on —
 * before the command ran), and that none of it shows up at all on a screen
 * wide enough to have the keyboard shortcut in the first place.
 */
import type { Browser, Page } from "playwright";
import { Checks, asText, openApp, opfsFiles, waitUntil } from "./harness";

const TOOLBAR = ".indent-toolbar";
const OUTDENT = '.indent-toolbar-button[aria-label="Outdent list item"]';
const INDENT = '.indent-toolbar-button[aria-label="Indent list item"]';

/** The text OPFS holds for a path, or "" while it isn't there yet. */
async function stored(page: Page, path: string): Promise<string> {
  const file = (await opfsFiles(page))[path];
  return file === undefined ? "" : asText(file);
}

/** The line mentioning `word`, or undefined if there isn't one. */
async function lineWith(page: Page, path: string, word: string): Promise<string | undefined> {
  return (await stored(page, path)).split("\n").find(l => l.includes(word));
}

/**
 * A fresh, empty file, opened and focused, ready to type into.
 *
 * Not one of the seeded notes: `Control+End` isn't bound in the rich editor
 * the way it is in the plain-text view, so a click into an existing
 * multi-line note — where a sentence wraps across several lines at phone
 * width — can land mid-word, and everything typed after lands there too. An
 * empty document has nowhere else for a click to land. `createFile` takes
 * either the labelled button (wide) or the collapsed menu behind it
 * (narrow — the drawer never has room for the labelled one).
 */
async function createFile(page: Page, narrow: boolean): Promise<void> {
  if (narrow) {
    await page.click(".mobile-menu-button");
    await page.waitForTimeout(400);
    // The drawer is always narrower than ROOM_FOR_LABELS, so "+ File" doesn't
    // exist here at all — only the collapsed "+" that opens the same menu a
    // long press on the empty tree area does.
    await page.click('button[title="New file, new folder, or import"]');
    await page.click('.context-menu-item:has-text("New File")');
  } else {
    await page.click('button[title="New file"]');
  }
  await page.click('.tree-row:has-text("untitled.md")');
  await page.waitForSelector(".pane-focused .milkdown-root .ProseMirror", { timeout: 10_000 });
  await page.waitForTimeout(700);
  await page.click(".pane-focused .milkdown-root .ProseMirror");
}

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("indenting a list on a phone");
  checks.heading();

  // --- a wide screen has a keyboard, so no buttons, cursor in a list or not --

  const wideContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const widePage = await openApp(wideContext);
  await widePage.waitForSelector(".tree-row", { timeout: 15_000 });
  await createFile(widePage, false);
  await widePage.keyboard.type("- a list item", { delay: 20 });
  await waitUntil("the wide-screen list to reach OPFS", async () => (await lineWith(widePage, "untitled.md", "a list item")) !== undefined);
  checks.ok(
    "no toolbar on a screen wide enough for Tab to work, even with the cursor in a list",
    !(await widePage.locator(TOOLBAR).isVisible()),
  );
  await wideContext.close();

  // --- the phone case ----------------------------------------------------------

  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const page = await openApp(context);
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  await createFile(page, true);

  await page.keyboard.type("plain paragraph", { delay: 20 });
  await waitUntil("the paragraph to reach OPFS", async () => (await stored(page, "untitled.md")).includes("plain paragraph"));
  checks.ok("no toolbar with the cursor in an ordinary paragraph", !(await page.locator(TOOLBAR).isVisible()));

  const path = "untitled.md";
  // "- " triggers Milkdown's bullet-list input rule mid-word — a transaction
  // of its own, not just an inserted character — and typing straight through
  // it faster than that lands raced with the next few keystrokes. A small
  // delay is enough for it to settle between them.
  await page.keyboard.type("\n- one\n- two", { delay: 20 });
  const listed = await waitUntil("the list to reach OPFS", async () => (await lineWith(page, path, "two")) !== undefined);
  checks.ok("typing a list saves it", listed, await stored(page, path));

  // The cursor is in "two" — the line typing left it on.
  const shown = await waitUntil("the toolbar to appear over the list item", () => page.locator(TOOLBAR).isVisible());
  checks.ok("the toolbar appears once the cursor is in a list item", shown);

  const toolbarBox = await page.locator(TOOLBAR).boundingBox();
  const lineBox = await page.locator(".pane-focused .milkdown-root li", { hasText: "two" }).boundingBox();
  checks.ok(
    "it floats above the line the cursor is on, not below or over it",
    !!toolbarBox && !!lineBox && toolbarBox.y + toolbarBox.height <= lineBox.y + 2,
    JSON.stringify({ toolbarBox, lineBox }),
  );

  const nested = async () => /^\s+-\s/.test((await lineWith(page, path, "two")) ?? "");
  const flat = async () => /^-\s/.test((await lineWith(page, path, "two")) ?? "");
  /** Whether the caret is still in the editor, inside the "two" item. */
  const caretInTwo = () =>
    page.evaluate(() => {
      const editor = document.querySelector(".pane-focused .ProseMirror");
      const anchor = window.getSelection()?.anchorNode;
      const item = anchor instanceof Element ? anchor.closest("li") : anchor?.parentElement?.closest("li");
      return document.activeElement === editor && !!item?.querySelector("p")?.textContent?.includes("two");
    });

  // Tapped, not clicked: a finger is its own code path (see listIndentToolbar),
  // and it's the one a phone uses. Indenting has to nest "two" under "one"
  // and leave "one" where it was.
  await page.tap(INDENT);
  const indented = await waitUntil("the indent to reach OPFS", nested);
  checks.ok("the indent button nests the item", indented, await stored(page, path));
  checks.ok(
    "the item above it is untouched",
    /^-\s+one\s*$/.test((await lineWith(page, path, "one")) ?? ""),
    await stored(page, path),
  );
  // The toolbar used to work exactly once on iOS: the tap moved the caret to
  // the widget's anchor at the top of the note, outside the list, and the
  // toolbar hid itself behind the indent it had just made.
  checks.ok("the toolbar is still there after a tap", await page.locator(TOOLBAR).isVisible());
  checks.ok("and the caret is still in the item it indented", await caretInTwo());

  await page.tap(OUTDENT);
  const outdented = await waitUntil("the outdent to reach OPFS", flat);
  checks.ok("the outdent button un-nests it again", outdented, await stored(page, path));

  // And again, from the same toolbar without touching the text in between.
  await page.tap(INDENT);
  const again = await waitUntil("a second indent to reach OPFS", nested);
  await page.tap(OUTDENT);
  const back = again && (await waitUntil("a second outdent to reach OPFS", flat));
  checks.ok("it keeps working tap after tap", back, await stored(page, path));

  // A mouse is still the other route in.
  await page.click(INDENT);
  const clicked = await waitUntil("a clicked indent to reach OPFS", nested);
  checks.ok("a click works too", clicked && (await caretInTwo()), await stored(page, path));
  await page.click(OUTDENT);
  await waitUntil("a clicked outdent to reach OPFS", flat);

  // Moving the cursor back out of the list — into the paragraph above it —
  // takes the toolbar with it.
  await page.locator(".pane-focused .milkdown-root p", { hasText: "plain paragraph" }).click();
  const hidden = await waitUntil("the toolbar to disappear again", async () => !(await page.locator(TOOLBAR).isVisible()));
  checks.ok("and it's gone once the cursor leaves the list", hidden);

  await context.close();
  return checks.failures;
}
