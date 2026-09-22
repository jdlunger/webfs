/**
 * Runs the browser suites. `bun run browser`, or `bun run browser sync` for one.
 *
 * Needs a Chromium: `bunx playwright install chromium` once, or point
 * WEBFS_CHROMIUM at an existing binary. The dev server is started here, so
 * nothing needs to be running first.
 */
import { launchBrowser, startServer } from "./harness";
import sync from "./sync";
import emptyRepo from "./empty-repo";
import images from "./images";
import panes from "./panes";

const suites = { sync, "empty-repo": emptyRepo, images, panes } as const;

const requested = process.argv.slice(2);
const unknown = requested.filter(name => !(name in suites));
if (unknown.length > 0) {
  console.error(`No such suite: ${unknown.join(", ")}. Known: ${Object.keys(suites).join(", ")}`);
  process.exit(2);
}
const selected = (requested.length > 0 ? requested : Object.keys(suites)) as Array<keyof typeof suites>;

const stopServer = await startServer();
const browser = await launchBrowser();
let failures = 0;

try {
  for (const name of selected) failures += await suites[name](browser);
} finally {
  await browser.close();
  stopServer();
}

console.log(failures === 0 ? "\nAll browser checks passed." : `\n${failures} browser check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
