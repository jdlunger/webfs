/**
 * Tabs, the split view, and the sidebar's context menu.
 *
 * `panes.test.ts` already pins the layout arithmetic, which is pure. What it
 * can't reach is the half that only exists in a browser: two live Crepe
 * instances editing two different files at once, each one's debounced save
 * landing in OPFS under the right name — and a menu that has to be summoned
 * by a real right-click before rename or delete can be reached at all.
 */
import type { Browser, Page } from "playwright";
import { Checks, chooseFromContextMenu, asText, openApp, openFile, opfsFiles, typeInEditor, waitUntil } from "./harness";

const tabNames = (page: Page) => page.locator(".tab-name").allInnerTexts();

/**
 * The paths of the open tabs, which is what a rename, a move or a delete
 * actually has to move.
 *
 * A tab's title is its id, straight from the layout, so this says what the
 * tab points at rather than what it's labelled. The label comes from the
 * tree instead (`fs[id]?.name ?? id`) and lags it by a render — after a
 * delete there is a frame where the file is gone from the tree but the tab
 * is still there, labelled with its whole path. Asserting on names caught
 * that frame and read it as the tab having closed.
 */
const tabIds = (page: Page) =>
  page.locator(".tab").evaluateAll(tabs => tabs.map(tab => tab.getAttribute("title") ?? ""));
const paneCount = (page: Page) => page.locator(".pane").count();

/** The text OPFS holds for a path, or "" while it isn't there yet. */
async function stored(page: Page, path: string): Promise<string> {
  const file = (await opfsFiles(page))[path];
  return file === undefined ? "" : asText(file);
}

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("tabs and panes");
  checks.heading();

  // Wide enough for the large-screen layout; the app renders one pane and no
  // tab strip below 768px, and this suite is about what's above it.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openApp(context);
  await page.waitForSelector(".tree-row", { timeout: 15_000 });

  // --- tabs ------------------------------------------------------------------

  // The app opens the first file in the tree by itself, so the strip starts
  // with one tab rather than none.
  checks.ok("the file the app opens on load is a tab", (await tabNames(page)).join(",") === "todo.md", (await tabNames(page)).join(","));

  await openFile(page, "welcome.md");
  checks.ok("opening a second file adds a tab rather than replacing one", (await tabNames(page)).join(",") === "todo.md,welcome.md", (await tabNames(page)).join(","));
  checks.ok("the file just opened is the active tab", (await page.locator(".tab-active .tab-name").innerText()) === "welcome.md");

  // A file open in one pane must never open in another: two uncontrolled
  // editors over one document would overwrite each other.
  await openFile(page, "todo.md");
  checks.ok("re-opening a file focuses its tab instead of duplicating it", (await tabNames(page)).length === 2, (await tabNames(page)).join(","));
  checks.ok("re-opening a file shows it", (await page.locator(".tab-active .tab-name").innerText()) === "todo.md");
  await openFile(page, "welcome.md");

  // --- splitting -------------------------------------------------------------

  await page.click('.tab-strip-button[aria-label="Split editor"]');
  checks.ok("the split button gives a second pane", (await paneCount(page)) === 2, String(await paneCount(page)));
  checks.ok("the new pane starts empty", (await page.locator(".pane").nth(1).locator(".editor-empty").count()) === 1);

  await openFile(page, "ideas.md");
  checks.ok("a file clicked after splitting opens in the new pane", (await page.locator(".pane").nth(1).locator(".tab-name").innerText()) === "ideas.md");
  checks.ok("the first pane keeps the tabs it had", (await page.locator(".pane").nth(0).locator(".tab-name").count()) === 2);

  // The point of the whole feature: two editors, two files, at once.
  const editors = await page.locator(".milkdown-root .ProseMirror").count();
  checks.ok("both panes have a live editor", editors === 2, String(editors));

  await typeInEditor(page, "\nright pane wrote this");
  await page.locator(".pane").nth(0).locator(".milkdown-root .ProseMirror").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nleft pane wrote this");

  const bothLanded = await waitUntil("both panes' text to reach OPFS", async () => {
    const files = await opfsFiles(page);
    return (
      asText(files["Projects/ideas.md"] ?? "").includes("right pane wrote this") &&
      asText(files["Notes/welcome.md"] ?? "").includes("left pane wrote this")
    );
  });
  checks.ok("each pane saves to its own file", bothLanded, await stored(page, "Projects/ideas.md"));
  checks.ok(
    "neither pane's text leaks into the other's file",
    !(await stored(page, "Notes/welcome.md")).includes("right pane wrote this") &&
      !(await stored(page, "Projects/ideas.md")).includes("left pane wrote this"),
  );

  // --- closing ---------------------------------------------------------------

  await page.locator(".pane").nth(0).locator('.tab:has-text("todo.md") .tab-close').click();
  checks.ok("closing a tab removes it", !(await tabNames(page)).includes("todo.md"), (await tabNames(page)).join(","));
  checks.ok("closing a tab doesn't touch the file", (await stored(page, "Notes/todo.md")).length > 0);

  await page.locator(".pane").nth(1).locator('.tab-strip-button[aria-label="Close this pane"]').click();
  checks.ok("closing a pane leaves one", (await paneCount(page)) === 1, String(await paneCount(page)));
  checks.ok("its tabs stay open in the pane that remains", (await tabNames(page)).join(",") === "welcome.md,ideas.md", (await tabNames(page)).join(","));

  // --- the context menu ------------------------------------------------------

  const menuGone = async () => (await page.locator(".context-menu").count()) === 0;

  await page.locator('.tree-row:has-text("ideas.md")').click({ button: "right" });
  await page.waitForSelector(".context-menu", { timeout: 5_000 });
  checks.ok("a right-click opens a menu", (await page.locator(".context-menu-item").count()) > 0);
  await page.keyboard.press("Escape");
  checks.ok("Escape closes it", await menuGone());

  await chooseFromContextMenu(page, '.tree-row:has-text("ideas.md")', "Rename");
  await page.fill(".rename-input", "plans.md");
  await page.keyboard.press("Enter");
  const renamed = await waitUntil("the rename to land in OPFS", async () => Boolean((await opfsFiles(page))["Projects/plans.md"]));
  checks.ok("Rename from the menu renames the file", renamed);
  // The tab follows on the next tree refresh, not with the keypress, so every
  // assertion from here down has to wait for one rather than read once.
  const tabRenamed = await waitUntil("the tab to follow the rename", async () =>
    (await tabIds(page)).includes("Projects/plans.md"),
  );
  checks.ok("an open tab follows the rename", tabRenamed, (await tabIds(page)).join(","));
  checks.ok("the renamed file keeps its text", (await stored(page, "Projects/plans.md")).includes("right pane wrote this"));

  // "Move to…" is a submenu, and the only way to move by touch.
  await page.locator('.tree-row:has-text("plans.md")').click({ button: "right" });
  await page.locator('.context-menu-item:has-text("Move to…")').click();
  await page.locator(".context-submenu .context-menu-item").first().waitFor({ timeout: 5_000 });
  await page.locator('.context-submenu .context-menu-item:has-text("/Notes")').click();
  const moved = await waitUntil("the move to land in OPFS", async () => Boolean((await opfsFiles(page))["Notes/plans.md"]));
  checks.ok("Move to… moves the file", moved, Object.keys(await opfsFiles(page)).join(", "));
  const tabMoved = await waitUntil("the tab to follow the move", async () => (await tabIds(page)).includes("Notes/plans.md"));
  checks.ok("an open tab follows the move", tabMoved, (await tabIds(page)).join(","));

  await chooseFromContextMenu(page, '.tree-row:has-text("plans.md")', "Delete");
  const deleted = await waitUntil("the delete to land in OPFS", async () => !(await opfsFiles(page))["Notes/plans.md"]);
  checks.ok("Delete from the menu deletes the file", deleted);
  // The whole strip, not the absence of one name: mid-refresh the tab is still
  // open under its full path, which "plans.md is not among the names" reads as
  // success. This flaked about one run in four for exactly that reason.
  const tabClosed = await waitUntil("the deleted file's tab to close", async () =>
    (await tabIds(page)).join(",") === "Notes/welcome.md",
  );
  checks.ok("the deleted file's tab closes with it", tabClosed, (await tabIds(page)).join(","));

  await context.close();
  await checkTouch(browser, checks);
  await checkRestore(browser, checks);
  return checks.failures;
}

/**
 * The phone half: no tabs, no split, and a long press where the right button
 * would be. Driven through CDP touch events rather than a synthesised
 * `contextmenu`, because what's being tested *is* the browser's own handling
 * of a finger held still — including the click it sends afterwards, which has
 * to be swallowed or long-pressing a file would also open it.
 */
async function checkTouch(browser: Browser, checks: Checks): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const page = await openApp(context);
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  await page.click(".mobile-menu-button");
  await page.waitForTimeout(400);

  checks.ok("a narrow screen shows no tab strip", (await page.locator(".tab-strip:visible").count()) === 0);
  const before = await page.locator(".mobile-topbar-title").innerText();

  const row = page.locator('.tree-row:has-text("ideas.md")').first();
  const box = (await row.boundingBox())!;
  const cdp = await context.newCDPSession(page);
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);

  const items = await page.locator(".context-menu-item").allInnerTexts();
  checks.ok("a long press opens the row's menu", items.some(item => item.startsWith("Rename")), items.join(" / "));
  // The tree behind the row arms a trigger of its own; the row's has to win,
  // or a long press on a file shows the empty-area menu instead.
  checks.ok("it's the file's menu, not the tree's", !items.some(item => item === "New Folder"), items.join(" / "));
  checks.ok("splitting isn't offered where there's no room for it", !items.some(item => item.includes("Side")), items.join(" / "));
  checks.ok(
    "the click after the press doesn't also open the file",
    (await page.locator(".mobile-topbar-title").innerText()) === before,
  );

  await context.close();
}


/**
 * What a reload comes back to. `workspace.test.ts` pins the validation, but
 * only a real browser has the part that actually matters: localStorage
 * written as the layout changes, read back before the tree is drawn, and
 * reconciled with a URL that names one of the files itself.
 */
async function checkRestore(browser: Browser, checks: Checks): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openApp(context);
  await page.waitForSelector(".tree-row", { timeout: 15_000 });

  await openFile(page, "welcome.md");
  await openFile(page, "ideas.md");
  await page.click('.tree-row.tree-folder:has-text("Projects")');
  checks.ok("clicking a folder collapses it", (await page.locator('.tree-row:has-text("ideas.md")').count()) === 0);

  // Ids, not labels: what has to come back is the file each tab points at,
  // and two notes in different folders can read the same.
  const before = (await tabIds(page)).join(",");
  await page.reload();
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  await page.waitForSelector(".tab-active", { timeout: 15_000 });

  checks.ok("every open tab comes back after a reload", (await tabIds(page)).join(",") === before, (await tabIds(page)).join(","));
  checks.ok(
    "the tab that was showing is the one showing again",
    (await page.locator(".tab-active").getAttribute("title")) === "Projects/ideas.md",
    (await page.locator(".tab-active").getAttribute("title")) ?? "",
  );
  checks.ok("a collapsed folder comes back collapsed", (await page.locator('.tree-row:has-text("ideas.md")').count()) === 0);

  // Expanding it again has to be remembered too, or the state is write-once.
  await page.click('.tree-row.tree-folder:has-text("Projects")');
  await page.reload();
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  checks.ok(
    "expanding it again is remembered as well",
    await waitUntil("the folder to come back open", async () => (await page.locator('.tree-row:has-text("ideas.md")').count()) === 1),
  );

  await context.close();
}
