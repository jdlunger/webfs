/**
 * The crash screen, in a real browser.
 *
 * Everything crash.ts does is DOM: an element appended to a body, a class
 * that decides whether it covers the screen, a click that expands it. The unit
 * tests drive that against a fake DOM, which proves the logic and proves
 * nothing about whether anything is actually *visible* — and a panel that is
 * in the document but not on screen is the blank page it was written to
 * replace. So the assertions here are on visibility, and on the two paths that
 * only exist in a browser: an error thrown before React mounts, and one thrown
 * behind an app that is already up.
 */
import type { Browser } from "playwright";
import { APP_URL, Checks } from "./harness";

/**
 * The app's own script, as the dev server names it (the static build calls it
 * `chunk-<hash>.js`). Matching it is how a suite can be the thing that breaks.
 */
const BUNDLE = "**/_bun/client/*.js";

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("crash screen");
  checks.heading();

  // --- a failure before the app can draw ------------------------------------

  const early = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Holding the bundle back puts the failure in the window it is hardest to
  // catch: after index.html has run and before crash.ts exists. What is being
  // checked is the handover — the inline handler holds the error, and the
  // panel that eventually appears is the real one, with the buttons on it.
  await early.route(BUNDLE, async route => {
    await new Promise(resolve => setTimeout(resolve, 2500));
    await route.continue();
  });
  const earlyPage = await early.newPage();
  await earlyPage.addInitScript(() => {
    setTimeout(() => void Promise.reject(new Error("failed before the app started")), 300);
  });
  await earlyPage.goto(APP_URL);
  await earlyPage.waitForSelector(".crash", { timeout: 15_000 });
  const panel = earlyPage.locator(".crash");
  checks.ok("a failure at startup puts itself on the page", await panel.isVisible());
  const report = await earlyPage.locator(".crash-report").innerText();
  checks.ok("the report names what went wrong", report.includes("failed before the app started"), report.slice(0, 120));
  checks.ok("and says which build it happened on", /webfs (v\d+|dev)/.test(report), report.slice(0, 60));
  checks.ok("and which browser", report.includes("Mozilla/"), report.slice(0, 200));
  // Read through the element rather than as a bounding box: another error
  // arriving re-renders the panel, and a handle resolved a moment earlier
  // measures as null once it has been replaced.
  const height = await earlyPage.evaluate(() => document.querySelector(".crash-box")?.clientHeight ?? 0);
  checks.ok("it takes the screen, rather than hiding behind an empty app", height > 100, String(height));
  checks.ok(
    "the way out of a bad cached build is on it",
    (await earlyPage.locator('.crash-button:has-text("Clear cache and reload")').count()) === 1,
  );
  await early.close();

  // --- a bundle that doesn't load at all ------------------------------------

  // The failure this was written for: the service worker serves a shell whose
  // chunk is gone or broken, so nothing in src/ ever runs and there is no
  // crash.ts to report anything. index.html's own handler is all that is left,
  // and a blank screen is what happens if it isn't enough.
  const broken = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await broken.route(BUNDLE, route =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: 'throw new Error("the cached build is broken");' }),
  );
  const brokenPage = await broken.newPage();
  await brokenPage.goto(APP_URL);
  await brokenPage.waitForSelector(".crash", { timeout: 20_000 });
  const fallback = await brokenPage.locator(".crash").innerText();
  checks.ok("a bundle that never runs still says so on the page", fallback.includes("webfs couldn't start"), fallback.slice(0, 80));
  checks.ok("naming the error it died on", fallback.includes("the cached build is broken"), fallback.slice(0, 200));
  // Styled from an attribute, not the stylesheet: the stylesheet is part of
  // the same build that just failed to run.
  const legible = await brokenPage.locator(".crash").evaluate(node => getComputedStyle(node).position);
  checks.ok("and is legible without the app's stylesheet", legible === "fixed", legible);
  await broken.close();

  // --- a failure behind an app that is up -----------------------------------

  const late = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const latePage = await late.newPage();
  await latePage.goto(APP_URL);
  await latePage.waitForSelector(".tree-row", { timeout: 15_000 });
  await latePage.evaluate(() => {
    setTimeout(() => {
      throw new Error("something failed later on");
    }, 0);
  });
  await latePage.waitForSelector(".crash-bar", { timeout: 10_000 });
  checks.ok("a later error is a bar, not a takeover", await latePage.locator(".crash-bar").isVisible());
  checks.ok("the app is still usable behind it", await latePage.locator(".tree-row").first().isVisible());
  checks.ok("and isn't covered by the report", (await latePage.locator(".crash-box").isVisible()) === false);

  // Dispatched rather than clicked, for the dev server alone: `bun --hot`
  // puts its own error overlay (<bun-hmr>) over the page when something
  // throws, and a real click at these coordinates lands on that instead.
  // Nothing in the deployed build is above this panel.
  await latePage.locator(".crash-bar").dispatchEvent("click");
  await latePage.waitForSelector(".crash-box", { state: "visible", timeout: 5_000 });
  const expanded = await latePage.locator(".crash-report").innerText();
  checks.ok("tapping it opens the same report", expanded.includes("something failed later on"), expanded.slice(0, 120));

  await latePage.locator('.crash-button:has-text("Dismiss")').dispatchEvent("click");
  await latePage.waitForSelector(".crash", { state: "detached", timeout: 5_000 });
  checks.ok("and it can be put away", (await latePage.locator(".crash").count()) === 0);
  await late.close();

  return checks.failures;
}
