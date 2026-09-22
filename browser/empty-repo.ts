/**
 * Connecting to a brand-new, empty repository.
 *
 * The most ordinary setup there is — create a repo, point webfs at it — and
 * it failed outright twice, because GitHub's empty-repo behaviour is not what
 * the obvious reading of its API suggests. The fake refuses exactly what the
 * real API refuses, which is the only reason the second failure was caught
 * here rather than by someone using it.
 */
import type { Browser } from "playwright";
import { Checks, FakeGitHub, connectThroughDialog, openApp, statusText, syncAndSettle, waitUntil } from "./harness";

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("an empty repository");
  checks.heading();

  // No seed: no commits, no branch, nothing.
  const host = new FakeGitHub("me/docs");
  const context = await browser.newContext();
  await host.route(context);
  const page = await openApp(context);
  await connectThroughDialog(page, "me/docs");
  await page.waitForTimeout(1500);

  const errored = (await page.locator(".sync-status-error").count()) > 0;
  checks.note(`status: ${JSON.stringify(await statusText(page))}`);
  checks.ok("connecting to an empty repository doesn't error", !errored, String(await statusText(page)));

  // A drive backed by a repository starts empty and fills itself by pulling,
  // so there is nothing to push until something is written here. Which is the
  // case worth testing anyway: the first commit a repo has ever had.
  // Two files, so the push has something to send *after* the Contents API
  // call that starts the repository — with only one, that call is the whole
  // commit and the git-object path this suite exists to cover never runs.
  await page.click('.sidebar-header-actions button[title="New file"]');
  await page.click('.sidebar-header-actions button[title="New file"]');
  await waitUntil("the first push", () => Object.keys(host.files).length > 1);
  await page.waitForTimeout(800);

  checks.ok("a file made here reached the empty repo", Object.keys(host.files).length > 0, Object.keys(host.files).join(", "));
  checks.ok("the repository was started through the Contents API", host.contentsPuts === 1, `puts=${host.contentsPuts}`);
  checks.ok(
    "no ref creation was attempted — GitHub refuses that on an empty repo",
    host.refCreates === 0,
    `creates=${host.refCreates}`,
  );
  checks.ok("the branch was then moved forward normally", host.refPatches >= 1, `patches=${host.refPatches}`);

  // The new file gets opened and re-serialised by Milkdown, so one more push
  // is expected. What matters is that it then stops.
  await syncAndSettle(page);
  const settled = { ...host.files };
  const commitsBefore = host.commits.size;

  await syncAndSettle(page);
  checks.ok("sync converges — an idle sync makes no commit", host.commits.size === commitsBefore, `${commitsBefore} -> ${host.commits.size}`);
  checks.ok(
    "an idle sync changes nothing on the repo",
    Object.keys(settled).length === Object.keys(host.files).length &&
      Object.keys(settled).every(path => host.files[path]?.equals(settled[path]!)),
  );
  checks.ok("still no error once the repo has commits", (await page.locator(".sync-status-error").count()) === 0, String(await statusText(page)));

  await context.close();
  return checks.failures;
}
