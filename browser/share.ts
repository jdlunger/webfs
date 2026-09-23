/**
 * Handing a GitHub drive to a second device.
 *
 * Two halves, and the second one is the security-relevant one: the link
 * carries a write-scoped token in its fragment, and the device that opens it
 * has to take the token out of its own address bar before anything else can
 * see it. That can only be checked in a browser — it is a claim about
 * `window.history`, not about a function's return value.
 */
import type { Browser } from "playwright";
import { Checks, FakeGitHub, connectedContext, openApp, waitUntil } from "./harness";

const TOKEN = "token-for-tests";

/**
 * The registry as this device stores it.
 *
 * Parsed rather than string-matched: a drive is `{owner: "me", repo: "notes"}`
 * in there, so asserting that the JSON "contains me/notes" is a check that
 * passes whatever happens.
 */
const storedDrives = (page: import("playwright").Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("webfs:drives") ?? "[]") as Array<Record<string, string>>);

const hasNotes = (drives: Array<Record<string, string>>) =>
  drives.some(drive => drive.owner === "me" && drive.repo === "notes");

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("sharing a drive");
  checks.heading();

  const host = new FakeGitHub();
  const first = await connectedContext(browser, host, "me/notes");
  const page = await openApp(first);
  await page.waitForSelector(".drive-switch", { timeout: 15_000 });

  // Settings → Share…, which is where the token it hands over already lives.
  await page.click(".drive-settings");
  await page.waitForSelector(".modal", { timeout: 5_000 });
  await page.click(".drive-share");
  await page.waitForSelector(".share-modal", { timeout: 5_000 });

  const modules = await page.locator(".share-qr rect").count();
  checks.ok("the QR code is drawn", modules > 20, `${modules} rects`);
  checks.ok("the warning is above the code, not below it", await warningComesFirst(page), "");

  const link = await page.inputValue(".share-link");
  checks.note(`link: ${link.replace(TOKEN, "<token>")}`);
  checks.ok("the link carries the token", link.includes(TOKEN));
  checks.ok("the token is in the fragment, not the query string", link.split("#")[1]?.includes(TOKEN) === true, link);
  checks.ok("nothing before the # holds it", !link.split("#")[0]!.includes(TOKEN), link);

  // A second device: its own storage, no drives, same fake GitHub.
  const second = await browser.newContext();
  await host.route(second);
  const page2 = await second.newPage();
  await page2.goto(link);

  await page2.waitForSelector(".accept-modal", { timeout: 15_000 });
  checks.ok("the second device asks before storing anything", true);
  const offered = await page2.locator(".accept-drive").innerText();
  checks.ok("and names the repository and branch it was given", offered.includes("me/notes") && offered.includes("main"), offered);

  // The token must be out of the URL before it can be read, bookmarked or
  // shoulder-surfed — stripped on arrival, not on accept.
  const parked = page2.url();
  checks.ok("the token is out of the address bar already", !parked.includes(TOKEN), parked);
  checks.ok("and the fragment with it", !parked.includes("add-drive"), parked);

  // Declining stores nothing.
  await page2.click(".accept-modal .modal-actions button:not(.modal-primary)");
  await page2.waitForSelector(".accept-modal", { state: "detached", timeout: 5_000 });
  const declined = await storedDrives(page2);
  checks.ok("declining adds no drive", !hasNotes(declined), JSON.stringify(declined));

  // Accepting does.
  await page2.goto(link);
  await page2.waitForSelector(".accept-modal", { timeout: 15_000 });
  await page2.click(".accept-modal .modal-primary");
  const added = await waitUntil("the drive to be stored", async () => hasNotes(await storedDrives(page2)));
  checks.ok("accepting adds the drive", added);

  const stored = await storedDrives(page2);
  checks.ok(
    "with the token it was given, so it can actually sync",
    stored.some(drive => drive.owner === "me" && drive.token === TOKEN),
    JSON.stringify(stored).replace(TOKEN, "<token>"),
  );
  checks.ok("and the app switches to it", (await page2.locator(".drive-name").innerText()).includes("me/notes"));
  checks.ok("the URL still holds no token afterwards", !page2.url().includes(TOKEN), page2.url());

  // The same link again is not a second drive, and replaces nothing.
  await page2.goto(link);
  await page2.waitForSelector(".accept-modal", { timeout: 15_000 });
  const repeat = await page2.locator(".accept-modal h2").innerText();
  checks.ok("opening it twice offers to open, not to add again", repeat.toLowerCase().includes("open"), repeat);

  await first.close();
  await second.close();
  return checks.failures;
}

/** The warning has to be read before the code under it is photographed. */
async function warningComesFirst(page: import("playwright").Page): Promise<boolean> {
  return page.evaluate(() => {
    const warning = document.querySelector(".share-modal .share-warning");
    const code = document.querySelector(".share-modal .share-qr-frame");
    if (!warning || !code) return false;
    return (warning.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
}
