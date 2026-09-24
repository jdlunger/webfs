/**
 * Two-way sync, driven through the real app against a fake branch.
 *
 * This is the suite that covers what unit tests can't reach: OPFS, a live
 * Milkdown editor, and sync.ts reconciling between them.
 */
import type { Browser } from "playwright";
import { asText, Checks, chooseFromContextMenu, connectedContext, createdIndex, expandFolder, FakeGitHub, openApp, openFile, opfsFiles, readOpfsFile, setOpfs, statusText, syncAndSettle, typeInEditor, waitUntil, writeOpfsFile } from "./harness";

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("two-way sync");
  checks.heading();

  const host = new FakeGitHub();
  // Two files, not one: a drive is exactly its branch now, and a suite whose
  // branch holds a single file can't delete it without emptying the store —
  // which trips the eviction guard (an empty store with a base is read as
  // lost data, not as a deletion) and tests something else entirely.
  await host.seed({
    "Shared/from-github.md": "# written on another device",
    "Notes/keep.md": "# a file nothing here touches",
  });

  const context = await connectedContext(browser, host);
  const page = await openApp(context);
  await waitUntil("the first sync", async () => !!(await statusText(page))?.match(/pulled|pushed|Up to date/i));

  const local = await opfsFiles(page);
  checks.ok(
    "the first sync pulls the repo's file into OPFS",
    asText(local["Shared/from-github.md"] ?? "") === "# written on another device",
    Object.keys(local).join(", "),
  );
  // OPFS has no creation time, so a pulled file's only date is the one this
  // device writes down when it arrives — which is the case the whole
  // "Created" order exists for, since a synced drive is how most files get
  // here in the first place.
  const dates = await waitUntil("a creation date for the pulled file", async () => {
    const index = await createdIndex(page, "me/notes");
    return index["Shared/from-github.md"] !== undefined;
  });
  checks.ok("a file pulled from GitHub is dated when it arrived here", dates, JSON.stringify(await createdIndex(page, "me/notes")));

  // A drive backed by a repository holds the repository and nothing else: no
  // starter notes are seeded into one, so this is what it should have.
  checks.ok(
    "and nothing else: the drive is the branch",
    JSON.stringify(Object.keys(local).sort()) === JSON.stringify(Object.keys(host.files).sort()),
    Object.keys(local).join(", "),
  );
  // A drive opened for the first time folds its tree away, and a pulled
  // repository is the case that exists for: what arrives is someone's whole
  // folder structure, expanded, with no way to collapse it in one go. The
  // fold waits for a tree with something in it — this drive's store was empty
  // until the pull landed — so it settles a render after the files appear.
  const folded = await waitUntil("the pulled tree to fold", async () => {
    const folder = await page.locator('.tree-row.tree-folder:has-text("Shared")').count();
    const file = await page.locator('.tree-row:has-text("from-github.md")').count();
    return folder > 0 && file === 0;
  });
  checks.ok("a drive pulled from a repository arrives folded", folded);

  await page.click('.tree-row.tree-folder:has-text("Shared")');
  checks.ok(
    "the pulled file shows up in the sidebar once its folder is opened",
    (await page.locator('.tree-row:has-text("from-github.md")').count()) > 0,
  );

  // A local edit reaches the branch.
  await openFile(page, "from-github.md");
  await typeInEditor(page, " edited in the browser");
  const landed = await waitUntil("the edit to reach OPFS", async () =>
    asText((await opfsFiles(page))["Shared/from-github.md"] ?? "").includes("edited in the browser"),
  );
  checks.ok("typing in the editor is written to OPFS", landed);
  await syncAndSettle(page);
  checks.ok("a local edit is pushed", host.text("Shared/from-github.md").includes("edited in the browser"));

  // A remote edit comes back down, and into the open editor.
  await host.seed({ "Shared/from-github.md": `${host.text("Shared/from-github.md")}\n\nappended on GitHub` });
  await syncAndSettle(page);
  checks.ok(
    "a remote edit is pulled into OPFS",
    asText((await opfsFiles(page))["Shared/from-github.md"] ?? "").includes("appended on GitHub"),
  );
  checks.ok(
    "the open editor re-renders with the pulled text",
    await waitUntil("the editor to re-render", async () =>
      (await page.locator(".milkdown-root .ProseMirror").innerText()).includes("appended on GitHub"),
    ),
  );

  // Both sides edit at once.
  await host.seed({ "Shared/from-github.md": `${host.text("Shared/from-github.md")}\n\ntail from GitHub` });
  const before = await readOpfsFile(page, "Shared/from-github.md");
  await writeOpfsFile(page, "Shared/from-github.md", `head edited locally\n${before.split("\n").slice(1).join("\n")}`);
  await syncAndSettle(page);
  const merged = host.text("Shared/from-github.md");
  checks.ok(
    "a two-sided edit keeps both changes",
    merged.includes("head edited locally") && merged.includes("tail from GitHub"),
    merged.replace(/\n/g, "\\n").slice(0, 160),
  );

  // Deleting here deletes there.
  await chooseFromContextMenu(page, '.tree-row:has-text("from-github.md")', "Delete");
  await waitUntil("the file to leave OPFS", async () => !(await opfsFiles(page))["Shared/from-github.md"]);
  await syncAndSettle(page);
  checks.ok("deleting here deletes there", host.files["Shared/from-github.md"] === undefined, Object.keys(host.files).join(", "));

  // A file added on the branch appears in the tree.
  await host.seed({ "Shared/new-on-github.md": "# made elsewhere" });
  await syncAndSettle(page);
  checks.ok(
    "a file added on GitHub shows up in the file tree",
    (await page.locator('.tree-row:has-text("new-on-github.md")').count()) > 0,
  );

  // Two files changed at once, which is what a commit title abbreviates.
  await writeOpfsFile(page, "Shared/one.md", "# one");
  await writeOpfsFile(page, "Shared/two.md", "# two");
  await syncAndSettle(page);
  checks.ok(
    "two files changed at once go up in one commit",
    !!host.files["Shared/one.md"] && !!host.files["Shared/two.md"],
    Object.keys(host.files).join(", "),
  );

  // Commit titles.
  const titles = host.titles();
  checks.note(`commit titles written: ${titles.map(t => JSON.stringify(t)).join(", ")}`);
  checks.ok("every commit title starts with a date and time", titles.length > 0 && titles.every(t => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S/.test(t)), titles.join(" | "));
  checks.ok("a single-file commit names it without an ellipsis", titles.some(t => /^\S+ \S+ [^ ]+$/.test(t)), titles.join(" | "));
  checks.ok("a multi-file commit ends with an ellipsis", titles.some(t => t.endsWith(" …")), titles.join(" | "));

  // A second device converges on the same tree.
  const second = await connectedContext(browser, host);
  const page2 = await openApp(second);
  const converged = await waitUntil("the second device to converge", async () =>
    JSON.stringify(Object.keys(await opfsFiles(page2)).sort()) === JSON.stringify(Object.keys(host.files).sort()),
  );
  checks.ok("a second device converges to exactly the repo's files", converged, Object.keys(await opfsFiles(page2)).sort().join(", "));
  checks.ok("nothing the repo held was lost on the way", host.text("Shared/new-on-github.md").includes("made elsewhere"));

  // A device that lost its store refills, rather than emptying the branch.
  await setOpfs(page2, {});
  await page2.reload();
  await page2.waitForSelector(".drive-switch", { timeout: 15_000 });
  const refilled = await waitUntil("the wiped device to refill", async () =>
    JSON.stringify(Object.keys(await opfsFiles(page2)).sort()) === JSON.stringify(Object.keys(host.files).sort()),
  );
  checks.ok("a wiped but connected device refills from the repo without re-seeding", refilled);

  // Auto-sync, without pressing anything. This device opened the drive for
  // the first time, so its tree came up folded — and stays that way across
  // the wipe above, since the workspace that recorded it is in localStorage
  // rather than the store that was emptied.
  await expandFolder(page2, "Shared");
  await openFile(page2, "new-on-github.md");
  await typeInEditor(page2, " — typed on device two");
  checks.ok(
    "auto-sync pushes an edit a few seconds after typing stops",
    await waitUntil("auto-sync", () => host.text("Shared/new-on-github.md").includes("typed on device two"), 25_000),
    host.text("Shared/new-on-github.md"),
  );

  // The token must not travel anywhere else.
  const leaked: string[] = [];
  page.on("request", request => {
    if (!request.url().startsWith("https://api.github.com") && (request.postData() ?? "").includes("token-for-tests")) {
      leaked.push(request.url());
    }
  });
  await syncAndSettle(page);
  checks.ok("the token is sent nowhere but the GitHub API", leaked.length === 0, leaked.join(", "));

  // --- offline ----------------------------------------------------------------

  // Everything is in OPFS, so the app keeps working with the network gone —
  // which is exactly why it has to *say* the network is gone. Silence reads
  // as "synced", and the one thing worth knowing then is how stale this
  // device is.
  await context.setOffline(true);
  const wentOffline = await waitUntil("the strip to notice", async () =>
    ((await statusText(page)) ?? "").startsWith("Offline"),
  );
  checks.ok("going offline says so in the strip", wentOffline, (await statusText(page)) ?? "");
  checks.ok(
    "and says when this device last got through",
    /last synced (today|yesterday|\d)/.test((await statusText(page)) ?? ""),
    (await statusText(page)) ?? "",
  );
  // A press would run a pass that refuses itself, which from outside is a
  // button that does nothing.
  checks.ok("the sync button is disabled rather than silently doing nothing", await page.isDisabled(".sync-now"));

  // The time has to outlive the session, because the case it exists for is
  // the installed app opened on a train: nothing has synced to put it in
  // memory. That reload can't be driven here — offline it is the service
  // worker that serves the shell, and `bun dev` never registers one — so what
  // is checked is that the value a fresh load would read is really on disk.
  const stored = await page.evaluate(() => localStorage.getItem("webfs:sync:at:me/notes#main"));
  const age = stored === null ? NaN : Date.now() - Number(stored);
  checks.ok("the time is written down, so a fresh load can say it too", age >= 0 && age < 120_000, String(stored));

  await context.setOffline(false);
  const recovered = await waitUntil("the strip to recover", async () => {
    const text = (await statusText(page)) ?? "";
    return text.length > 0 && !text.startsWith("Offline");
  });
  checks.ok("the connection coming back clears it, and syncs", recovered, (await statusText(page)) ?? "");
  // Not read once: coming back online starts a sync, and the button is
  // legitimately disabled for as long as that runs.
  checks.ok(
    "and the button works again once that sync is done",
    await waitUntil("the button to come back", async () => !(await page.isDisabled(".sync-now"))),
  );

  await context.close();
  await second.close();
  return checks.failures;
}
