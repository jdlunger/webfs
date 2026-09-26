/**
 * Checkboxes: the ⇅ beside a list, and the ```todo fence that gathers what's
 * left of them.
 *
 * Neither half can be seen in `bun test`. Sorting is a ProseMirror transaction
 * whose result has to survive the serializer and the save loop before it is
 * worth anything, and the one thing that would make the button dangerous —
 * rewriting a note that was already in order — is invisible on screen: the
 * only way to catch it is to read the bytes back. The fence needs the real
 * remark pipeline, because being *drawn* as a list and being *written back* as
 * a fence are two different plugins that have to agree.
 */
import type { Browser } from "playwright";
import { Checks, asText, openApp, openFile, opfsFiles, waitUntil, writeOpfsFile } from "./harness";

const CHORES = "Chores.md";
const CHORES_TEXT = [
  "# Chores",
  "",
  "- [x] Take the bins out",
  "- [ ] Water the plants",
  "- [x] Book the dentist",
  "- [ ] Change the filter",
  "",
].join("\n");

const REPORT = "Work/Reports.md";
// The `<br />` is what an empty line inside a list looks like once an editor
// has been near it, and it turned up as a row of its own in a real block.
const REPORT_TEXT = ["# Reports", "", "- [ ] Send the Q3 numbers", "- [ ] <br />", "- [ ]", ""].join("\n");

const BOARD = "Board.md";
const BOARD_TEXT = [
  "# Everything left",
  "",
  "Everything I have not got to yet.",
  "",
  "```todo",
  "```",
  "",
  "## Only work",
  "",
  "```todo Work",
  "```",
  "",
].join("\n");

const OWN = "Own.md";
/** A block and a checkbox in one note: the case where ticking has to remount. */
const OWN_TEXT = ["# Mine", "", "```todo Own.md", "```", "", "- [ ] Tidy the board", ""].join("\n");

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("checkbox lists and the todo fence");
  checks.heading();

  const context = await browser.newContext();
  const page = await openApp(context);
  await page.waitForSelector(".milkdown-root, .editor", { timeout: 15_000 });

  await writeOpfsFile(page, CHORES, CHORES_TEXT);
  await writeOpfsFile(page, REPORT, REPORT_TEXT);
  await writeOpfsFile(page, BOARD, BOARD_TEXT);

  await page.reload();
  await page.waitForSelector(".tree-row", { timeout: 15_000 });

  // --- sorting ---------------------------------------------------------------

  await openFile(page, CHORES);
  // Long enough for a save to have landed: the write debounce plus room.
  await page.waitForTimeout(2500);
  const opened = asText((await opfsFiles(page))[CHORES] ?? "");
  checks.ok("a handle appearing beside a list doesn't write the note", opened === CHORES_TEXT, JSON.stringify(opened));

  const handles = page.locator(".pane-focused .task-sort-button");
  checks.ok("a checkbox list gets exactly one handle", (await handles.count()) === 1, String(await handles.count()));

  await handles.first().click();
  const sorted = await waitUntil("the sort to be saved", async () =>
    asText((await opfsFiles(page))[CHORES] ?? "").split("\n")[2] === "- [ ] Water the plants",
  );
  checks.ok("sorting saves", sorted);

  const lines = asText((await opfsFiles(page))[CHORES] ?? "").split("\n");
  checks.note(`sorted note: ${JSON.stringify(lines)}`);
  checks.ok(
    "the unfinished ones come first, in the order they were in",
    lines[2] === "- [ ] Water the plants" && lines[3] === "- [ ] Change the filter",
    JSON.stringify(lines.slice(2, 4)),
  );
  checks.ok(
    "and the finished ones are at the end, in the order they were in",
    lines[4] === "- [x] Take the bins out" && lines[5] === "- [x] Book the dentist",
    JSON.stringify(lines.slice(4, 6)),
  );

  // The one that matters: pressing it again has nothing to do, so it must do
  // nothing at all. A transaction here would re-serialize the note and offer
  // the whole file to the next sync as somebody's work.
  const before = asText((await opfsFiles(page))[CHORES] ?? "");
  await handles.first().click();
  await page.waitForTimeout(2000);
  const after = asText((await opfsFiles(page))[CHORES] ?? "");
  checks.ok("sorting a list that is already sorted writes nothing", after === before, JSON.stringify(after));

  // --- the fence -------------------------------------------------------------

  await openFile(page, BOARD);
  const blocks = page.locator(".pane-focused .todo-block");
  checks.ok("a ```todo fence is drawn as a block, not as a code editor", (await blocks.count()) === 2, String(await blocks.count()));

  const textsOf = (index: number) => blocks.nth(index).locator(".todo-block-text").allTextContents();
  const filled = await waitUntil("the block to fill", async () => (await textsOf(0)).length > 0);
  checks.ok("it fills with what it found", filled);

  const everything = await textsOf(0);
  checks.note(`listed: ${JSON.stringify(everything)}`);
  checks.ok(
    "an unscoped fence lists the unfinished checkboxes from every note",
    everything.includes("Water the plants") &&
      everything.includes("Change the filter") &&
      everything.includes("Send the Q3 numbers"),
    JSON.stringify(everything),
  );
  checks.ok(
    "and lists nothing that is already done",
    !everything.includes("Take the bins out") && !everything.includes("Book the dentist"),
    JSON.stringify(everything),
  );
  // A checkbox with nothing in it is scaffolding, not work: a row offering
  // `<br />` is a row you cannot do.
  checks.ok(
    "and nothing for the blank checkboxes",
    everything.every(text => text.trim() !== "" && !text.includes("<br")),
    JSON.stringify(everything),
  );

  const work = await textsOf(1);
  checks.ok(
    "a fence with a folder after it lists only that folder",
    work.length === 1 && work[0] === "Send the Q3 numbers",
    JSON.stringify(work),
  );

  await page.waitForTimeout(2000);
  const board = asText((await opfsFiles(page))[BOARD] ?? "");
  checks.ok("opening a note with fences in it writes nothing", board === BOARD_TEXT, JSON.stringify(board));

  // --- following a row -------------------------------------------------------

  await blocks.nth(0).locator('.todo-block-item:has-text("Water the plants")').click();
  const arrived = await waitUntil(
    "the note the checkbox is in to open",
    async () => (await page.locator(".pane-focused .tab-active").first().getAttribute("title")) === CHORES,
  );
  checks.ok("clicking a row opens the note the checkbox is in", arrived);

  // --- ticking one off -------------------------------------------------------

  // The row's checkbox writes to a file the block isn't showing, which is the
  // whole difficulty: it goes through the record and the write queue, the same
  // way a sync's changes do.
  await openFile(page, BOARD);
  await waitUntil("the block to fill again", async () => (await textsOf(0)).length > 0);
  const row = (text: string) => blocks.nth(0).locator(`li:has(.todo-block-text:text-is("${text}"))`);

  // Read before rather than comparing against the fixture: the ⇅ above has
  // already reordered this note, and what is being asserted is "only the one
  // line changed", not "the file is what it was when the suite started".
  const beforeTick = asText((await opfsFiles(page))[CHORES] ?? "");
  await row("Change the filter").locator(".todo-block-tick").click();

  const ticked = await waitUntil("the checkbox to be ticked in the file it lives in", async () =>
    asText((await opfsFiles(page))[CHORES] ?? "").includes("- [x] Change the filter"),
  );
  checks.ok("ticking a row writes [x] into the note that holds it", ticked, asText((await opfsFiles(page))[CHORES] ?? ""));
  // The bytes, not the row: the one failure that matters here is ticking the
  // *wrong* box, and on screen that looks exactly like ticking the right one.
  const afterTick = asText((await opfsFiles(page))[CHORES] ?? "");
  checks.ok(
    "and leaves every other line of it exactly as it was",
    afterTick === beforeTick.replace("- [ ] Change the filter", "- [x] Change the filter"),
    JSON.stringify(afterTick),
  );
  checks.ok(
    "the row goes away, because the block asks again rather than striking it out",
    await waitUntil("the row to go", async () => !(await textsOf(0)).includes("Change the filter")),
    JSON.stringify(await textsOf(0)),
  );

  // Now the hard case: the checkbox is in the note the block itself is in, so
  // the editor on screen is holding an uncontrolled copy of that document. It
  // has to be remounted, or its next save would put the unticked text back.
  // Its own note rather than Board.md, which later checks read byte for byte.
  await writeOpfsFile(page, OWN, OWN_TEXT);
  await page.reload();
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  await openFile(page, OWN);
  await waitUntil("the block to list the note's own checkbox", async () => (await textsOf(0)).includes("Tidy the board"));
  await row("Tidy the board").locator(".todo-block-tick").click();

  const own = await waitUntil("the note's own checkbox to be ticked", async () =>
    asText((await opfsFiles(page))[OWN] ?? "").includes("- [x] Tidy the board"),
  );
  checks.ok("ticking a checkbox in the note you are looking at works too", own, asText((await opfsFiles(page))[OWN] ?? ""));
  // Crepe draws a task checkbox as an icon span, not an `<input>` — so this
  // reads its `checked`/`unchecked` class rather than a checkbox's state.
  // (The only `<input type=checkbox>` inside the editor is the block's own
  // tick, which is why looking for one found the wrong thing first.)
  const label = ".pane-focused .milkdown-root .ProseMirror .label";
  checks.ok(
    "and the editor on screen shows it ticked, rather than writing the old text back",
    await waitUntil(
      "the editor to come back ticked",
      async () =>
        (await page.locator(`${label}.checked`).count()) === 1 &&
        (await page.locator(`${label}.unchecked`).count()) === 0,
    ),
  );

  // --- and the fence survives being typed around -----------------------------

  // The fence has to come back out of the serializer as a fence, or a note
  // would lose its blocks the first time anyone typed in it — the same failure
  // `![[…]]` had. Typed into a paragraph rather than wherever the editor
  // happens to be focused: the blocks fill most of this note, and a click in
  // the middle of it lands on one of them rather than in the text.
  await openFile(page, BOARD);
  await page
    .locator(".pane-focused .milkdown-root .ProseMirror p", { hasText: "Everything I have not got to yet." })
    .first()
    .click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Really.");

  const saved = await waitUntil("the edit to be saved", async () =>
    asText((await opfsFiles(page))[BOARD] ?? "").includes("Really."),
  );
  await page.waitForTimeout(600);
  const edited = asText((await opfsFiles(page))[BOARD] ?? "");
  checks.ok("the edit was saved", saved, JSON.stringify(edited));
  checks.ok("a keystroke leaves the fence as a fence", edited.includes("```todo\n```"), JSON.stringify(edited));
  checks.ok("and leaves the one with a folder after it alone", edited.includes("```todo Work\n```"), JSON.stringify(edited));
  checks.ok(
    "and changes only the line it was typed on",
    edited === BOARD_TEXT.replace("Everything I have not got to yet.", "Everything I have not got to yet. Really."),
    JSON.stringify(edited),
  );

  // --- writing one from the slash menu ---------------------------------------

  // The menu filters on the label, so this is also the check that typing the
  // name of the thing finds the item that writes it.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/todo");
  await page.waitForSelector(".milkdown-slash-menu", { timeout: 10_000 });
  const item = page.locator('.milkdown-slash-menu li:has-text("Todo list")').first();
  checks.ok("typing /todo finds the item that writes one", (await item.count()) === 1);
  await item.click();

  const written = await waitUntil("the new fence to be saved", async () =>
    (asText((await opfsFiles(page))[BOARD] ?? "").match(/```todo/g) ?? []).length === 3,
  );
  const three = asText((await opfsFiles(page))[BOARD] ?? "");
  checks.ok("choosing it writes a fence into the note", written, JSON.stringify(three));
  checks.ok(
    "and leaves no `/todo` paragraph where the menu was",
    !three.includes("/todo"),
    JSON.stringify(three),
  );
  checks.ok("and it is drawn as a block like the others", (await blocks.count()) === 3, String(await blocks.count()));

  await context.close();
  return checks.failures;
}
