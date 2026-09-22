/**
 * The sidebar's search field and sort menu.
 *
 * Both are decided by pure code (`searchTree` and `childrenOf` in `fs.ts`,
 * covered by `tree.test.ts`), so what's left for a browser is everything that
 * touches the outside: the timestamps sorting reads come from OPFS, which has
 * no headless stand-in, and the order chosen is remembered through a real
 * reload and a real localStorage.
 */
import type { Browser, Page } from "playwright";
import { Checks, openApp, openFile, typeInEditor, waitUntil } from "./harness";

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
    await sortBy(page, "Last modified");
    const names = await rowNames(page);
    const sorted = names.join("/") === "Notes/welcome.md/todo.md/Projects/ideas.md";
    await sortBy(page, "Name (A–Z)");
    return sorted;
  });
  await sortBy(page, "Last modified");
  checks.ok(
    "by last modified, the file just edited comes first",
    (await rowNames(page)).join("/") === "Notes/welcome.md/todo.md/Projects/ideas.md",
    (await rowNames(page)).join(", "),
  );

  // --- and it is remembered ----------------------------------------------------

  checks.ok(
    "the button says which order is in effect",
    ((await page.locator(SORT).getAttribute("title")) ?? "").includes("Last modified"),
    (await page.locator(SORT).getAttribute("title")) ?? "",
  );
  await page.click(SORT);
  await page.waitForSelector(".context-menu", { timeout: 5_000 });
  checks.ok(
    "and the menu marks it",
    (await page.locator(".context-menu-item.is-selected").innerText()).includes("Last modified"),
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

  await context.close();
  return checks.failures;
}
