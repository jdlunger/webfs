/**
 * The sidebar's search field and sort menu.
 *
 * Both are decided by pure code (`searchTree` and `childrenOf` in `fs.ts`,
 * covered by `tree.test.ts`), so what's left for a browser is everything that
 * touches the outside: the timestamps sorting reads come from OPFS, which has
 * no headless stand-in, the creation dates come from IndexedDB, which has
 * none either, and the order chosen is remembered through a real reload and a
 * real localStorage.
 */
import type { Browser, Page } from "playwright";
import { Checks, chooseFromContextMenu, createdIndex, openApp, openFile, typeInEditor, waitUntil } from "./harness";

/** The tree's rows, top to bottom — which is what an order is. */
const rowNames = (page: Page) => page.locator(".sidebar-tree .tree-name").allInnerTexts();

const SEARCH = '.sidebar-header-actions button[aria-label="Search files"]';
const SORT = '.sidebar-header-actions button[aria-label^="Sort by"]';

async function sortBy(page: Page, label: string): Promise<void> {
  await page.click(SORT);
  await page.waitForSelector(".context-menu", { timeout: 5_000 });
  await page.locator(`.context-menu-item:has-text("${label}")`).first().click();
  await page.waitForSelector(".context-menu", { state: "detached", timeout: 5_000 });
}

async function search(page: Page, query: string): Promise<void> {
  await page.fill(".sidebar-search-input", query);
  await page.waitForTimeout(150);
}

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("sidebar search and sort");
  checks.heading();

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openApp(context);
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  // The starter tree: Notes/{todo.md, welcome.md} and Projects/ideas.md.
  await waitUntil("the seeded tree", async () => (await rowNames(page)).length === 5);

  // --- searching ---------------------------------------------------------------

  await page.click(SEARCH);
  await page.waitForSelector(".sidebar-search-input", { timeout: 5_000 });
  await search(page, "todo");
  checks.ok(
    "a match is shown under the folders it takes to reach it",
    (await rowNames(page)).join("/") === "Notes/todo.md",
    (await rowNames(page)).join(", "),
  );

  await search(page, "TODO");
  checks.ok("and case doesn't matter", (await rowNames(page)).join("/") === "Notes/todo.md");

  // A folder is how you ask what's in it, so its subtree comes along.
  await search(page, "projects");
  checks.ok(
    "a matching folder brings its contents",
    (await rowNames(page)).join("/") === "Projects/ideas.md",
    (await rowNames(page)).join(", "),
  );

  await search(page, "nothing is called this");
  checks.ok("nothing matching shows no rows", (await rowNames(page)).length === 0);
  // An empty tree with no explanation reads as lost files.
  checks.ok("and says so rather than looking empty", (await page.locator(".sidebar-empty").count()) === 1);

  // --- a search outranks a collapsed folder ------------------------------------

  await page.click(SEARCH); // close, clearing the query
  await page.locator('.tree-folder:has-text("Notes")').first().click();
  await waitUntil("Notes to fold", async () => !(await rowNames(page)).includes("todo.md"));
  checks.ok("a folder can be folded away", !(await rowNames(page)).includes("todo.md"));

  await page.click(SEARCH);
  await search(page, "todo");
  checks.ok(
    "a search reaches into it anyway — a fold that hid matches would defeat it",
    (await rowNames(page)).includes("todo.md"),
    (await rowNames(page)).join(", "),
  );

  // While searching, what's shown is the search's decision: the chevron is a
  // label, not a control.
  const before = (await rowNames(page)).join("/");
  await page.locator('.tree-folder:has-text("Notes")').first().click();
  await page.waitForTimeout(200);
  checks.ok("clicking the folder while searching changes nothing", (await rowNames(page)).join("/") === before);

  await page.click(SEARCH);
  await waitUntil("the tree to come back", async () => (await rowNames(page)).includes("Projects"));
  checks.ok(
    "clearing the search leaves the tree folded exactly as it was",
    !(await rowNames(page)).includes("todo.md"),
    (await rowNames(page)).join(", "),
  );
  await page.locator('.tree-folder:has-text("Notes")').first().click();
  await waitUntil("Notes to unfold", async () => (await rowNames(page)).includes("todo.md"));

  // --- ordering ----------------------------------------------------------------

  checks.ok(
    "the default order is by name, folders first",
    (await rowNames(page)).join("/") === "Notes/todo.md/welcome.md/Projects/ideas.md",
    (await rowNames(page)).join(", "),
  );

  await sortBy(page, "Name (Z–A)");
  checks.ok(
    "reversing the order reverses the files",
    (await rowNames(page)).join("/") === "Notes/welcome.md/todo.md/Projects/ideas.md",
    (await rowNames(page)).join(", "),
  );
  // Folders have no timestamp and sorting them by name backwards would move
  // them about for nothing, so they stay put whatever the files do.
  checks.ok("but leaves the folders where they were", (await rowNames(page)).indexOf("Notes") === 0);

  // --- ordering by a timestamp that OPFS actually wrote ------------------------

  await sortBy(page, "Name (A–Z)");
  await openFile(page, "welcome.md");
  await typeInEditor(page, "\n\ntouched, so this is now the most recently written file");
  // The editor's save is debounced; the tree is re-read after it lands.
  await waitUntil("the edit to be saved", async () => {
    await sortBy(page, "Modified (newest first)");
    const names = await rowNames(page);
    const sorted = names.join("/") === "Notes/welcome.md/todo.md/Projects/ideas.md";
    await sortBy(page, "Name (A–Z)");
    return sorted;
  });
  await sortBy(page, "Modified (newest first)");
  checks.ok(
    "by last modified, the file just edited comes first",
    (await rowNames(page)).join("/") === "Notes/welcome.md/todo.md/Projects/ideas.md",
    (await rowNames(page)).join(", "),
  );

  // --- and it is remembered ----------------------------------------------------

  checks.ok(
    "the button says which order is in effect",
    ((await page.locator(SORT).getAttribute("title")) ?? "").includes("Modified (newest first)"),
    (await page.locator(SORT).getAttribute("title")) ?? "",
  );
  await page.click(SORT);
  await page.waitForSelector(".context-menu", { timeout: 5_000 });
  checks.ok(
    "and the menu marks it",
    (await page.locator(".context-menu-item.is-selected").innerText()).includes("Modified (newest first)"),
  );
  await page.keyboard.press("Escape");

  await page.reload();
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  checks.ok(
    "a reload comes back in the order that was chosen",
    await waitUntil(
      "the restored order",
      async () => (await rowNames(page)).join("/") === "Notes/welcome.md/todo.md/Projects/ideas.md",
    ),
    (await rowNames(page)).join(", "),
  );
  // A search is a moment's act, not a state to come back to.
  checks.ok("but not with a search field open", (await page.locator(".sidebar-search-input").count()) === 0);

  // --- creation dates, which only exist because this app wrote them down -------

  // The seeded files were already in the store the first time the tree was
  // read, so nothing watched them arrive and they have no date. A file made
  // here does — that is the difference the whole feature rests on.
  const seeded = await createdIndex(page, "opfs/notes");
  checks.ok(
    "the files that were already there have no creation date",
    Object.keys(seeded).length === 0,
    JSON.stringify(seeded),
  );

  await page.click('.sidebar-header-actions button[title="New file"]');
  await waitUntil("the new file", async () => (await rowNames(page)).includes("untitled.md"));
  const dated = await waitUntil("a recorded creation date", async () => {
    const index = await createdIndex(page, "opfs/notes");
    return index["untitled.md"] !== undefined;
  });
  checks.ok("a file created here is dated when it appeared", dated, JSON.stringify(await createdIndex(page, "opfs/notes")));

  await sortBy(page, "Created (newest first)");
  checks.ok(
    "by created, the only dated file leads and the undated ones follow by name",
    (await rowNames(page)).join("/") === "Notes/todo.md/welcome.md/Projects/ideas.md/untitled.md",
    (await rowNames(page)).join(", "),
  );

  // Reversing must not promote the undated files over the dated one: unknown
  // is not "the oldest thing here" any more than it is the newest.
  await sortBy(page, "Created (oldest first)");
  checks.ok(
    "reversing it keeps the undated files last rather than lifting them to the top",
    (await rowNames(page)).join("/") === "Notes/todo.md/welcome.md/Projects/ideas.md/untitled.md",
    (await rowNames(page)).join(", "),
  );

  // A rename is the old path vanishing and a new one appearing, so without
  // the date being carried across the file would be dated today instead.
  const stamped = (await createdIndex(page, "opfs/notes"))["untitled.md"];
  await chooseFromContextMenu(page, '.tree-row:has-text("untitled.md")', "Rename");
  await page.fill(".rename-input", "renamed.md");
  await page.keyboard.press("Enter");
  await waitUntil("the rename", async () => (await rowNames(page)).includes("renamed.md"));
  const carried = await waitUntil("the date to follow the rename", async () => {
    const index = await createdIndex(page, "opfs/notes");
    return index["renamed.md"] === stamped && index["untitled.md"] === undefined;
  });
  checks.ok("a rename carries the creation date with it", carried, JSON.stringify(await createdIndex(page, "opfs/notes")));

  await context.close();
  return checks.failures;
}
