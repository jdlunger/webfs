/**
 * Two-way sync, driven through the real app against a fake branch.
 *
 * This is the suite that covers what unit tests can't reach: OPFS, a live
 * Milkdown editor, and sync.ts reconciling between them.
 */
import type { Browser } from "playwright";
import {
  Checks,
  FakeGitHub,
  asText,
  connectThroughDialog,
  openApp,
  openFile,
  opfsFiles,
  setOpfs,
  statusText,
  syncAndSettle,
  typeInEditor,
  waitUntil,
} from "./harness";

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("two-way sync");
  checks.heading();

  const host = new FakeGitHub();
  await host.seed({ "Shared/from-github.md": "# written on another device" });

  const context = await browser.newContext();
  await host.route(context);
  const page = await openApp(context);
  await connectThroughDialog(page);
  await waitUntil("the first sync", async () => !!(await statusText(page))?.match(/pulled|pushed|Up to date/i));

  const local = await opfsFiles(page);
  checks.ok(
    "the first sync pulls the repo's file into OPFS",
    asText(local["Shared/from-github.md"] ?? "") === "# written on another device",
    Object.keys(local).join(", "),
  );
  checks.ok("the first sync pushes the local notes to GitHub", !!host.files["Notes/welcome.md"], Object.keys(host.files).join(", "));
  checks.ok("the pulled file shows up in the sidebar", (await page.locator('.tree-row:has-text("from-github.md")').count()) > 0);

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
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("Shared");
    const handle = await dir.getFileHandle("from-github.md");
    const text = await (await handle.getFile()).text();
    const writable = await handle.createWritable();
    await writable.write(`head edited locally\n${text.split("\n").slice(1).join("\n")}`);
    await writable.close();
  });
  await syncAndSettle(page);
  const merged = host.text("Shared/from-github.md");
  checks.ok(
    "a two-sided edit keeps both changes",
    merged.includes("head edited locally") && merged.includes("tail from GitHub"),
    merged.replace(/\n/g, "\\n").slice(0, 160),
  );

  // Deleting here deletes there. (.tree-actions is hover-revealed on desktop.)
  const row = '.tree-row:has-text("from-github.md")';
  await page.locator(row).hover();
  await page.locator(`${row} .tree-actions button`).first().click();
  await page.locator(row).hover();
  await page.locator(`${row} .tree-actions button[title="Delete"]`).click();
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

  // Commit titles.
  const titles = host.titles();
  checks.note(`commit titles written: ${titles.map(t => JSON.stringify(t)).join(", ")}`);
  checks.ok("every commit title starts with a date and time", titles.length > 0 && titles.every(t => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S/.test(t)), titles.join(" | "));
  checks.ok("a single-file commit names it without an ellipsis", titles.some(t => /^\S+ \S+ [^ ]+$/.test(t)), titles.join(" | "));
  checks.ok("a multi-file commit ends with an ellipsis", titles.some(t => t.endsWith(" …")), titles.join(" | "));

  // A second device converges on the same tree.
  const second = await browser.newContext();
  await host.route(second);
  const page2 = await openApp(second);
  await connectThroughDialog(page2);
  const converged = await waitUntil("the second device to converge", async () =>
    JSON.stringify(Object.keys(await opfsFiles(page2)).sort()) === JSON.stringify(Object.keys(host.files).sort()),
  );
  checks.ok("a second device converges to exactly the repo's files", converged, Object.keys(await opfsFiles(page2)).sort().join(", "));
  checks.ok("nothing the repo held was lost on the way", host.text("Shared/new-on-github.md").includes("made elsewhere"));

  // A device that lost its store refills, rather than emptying the branch.
  await setOpfs(page2, {});
  await page2.reload();
  await page2.waitForSelector(".sync-repo", { timeout: 15_000 });
  const refilled = await waitUntil("the wiped device to refill", async () =>
    JSON.stringify(Object.keys(await opfsFiles(page2)).sort()) === JSON.stringify(Object.keys(host.files).sort()),
  );
  checks.ok("a wiped but connected device refills from the repo without re-seeding", refilled);

  // Auto-sync, without pressing anything.
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

  await context.close();
  await second.close();
  return checks.failures;
}
