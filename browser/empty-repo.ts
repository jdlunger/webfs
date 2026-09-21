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

  await waitUntil("the first push", () => Object.keys(host.files).length > 0);
  await page.waitForTimeout(800);

  const errored = (await page.locator(".sync-status-error").count()) > 0;
  checks.note(`status: ${JSON.stringify(await statusText(page))}`);
  checks.ok("the first sync doesn't error on an empty repository", !errored, String(await statusText(page)));
  checks.ok("the local notes reached the empty repo", Object.keys(host.files).length > 0, Object.keys(host.files).join(", "));
  checks.ok("the repository was started through the Contents API", host.contentsPuts === 1, `puts=${host.contentsPuts}`);
  checks.ok(
    "no ref creation was attempted — GitHub refuses that on an empty repo",
    host.refCreates === 0,
    `creates=${host.refCreates}`,
  );
  checks.ok("the branch was then moved forward normally", host.refPatches >= 1, `patches=${host.refPatches}`);

  // The open file gets re-serialised by Milkdown on mount ("* [ ]" where the
  // seed said "- [ ]"), so one more push is expected. What matters is that it
  // then stops.
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
