/**
 * An image pasted into a note.
 *
 * Crepe's default keeps it behind a `blob:` URL that dies with the document,
 * so the whole point is that it becomes a real file: it has to survive a
 * reload, reach the branch byte for byte, and come back down onto another
 * device intact — without ever being opened as text, which would destroy it.
 */
import type { Browser } from "playwright";
import { Checks, FakeGitHub, asText, connectedContext, openApp, openFile, opfsFiles, waitUntil } from "./harness";

/** A real 3×3 PNG, so the browser genuinely decodes it. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAFUlEQVR4nGP8z8DwnwEJMKEL0EoQAHFiAiFbTJ7fAAAAAElFTkSuQmCC";
const ASSET = "Notes/assets/screen shot.png";

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("pasted images");
  checks.heading();

  // The drive is the repository, so the note the image is pasted into has to
  // come from there — a GitHub drive starts empty and fills itself by pulling.
  const host = new FakeGitHub();
  await host.seed({ "Notes/welcome.md": "# Welcome\n\nA note to paste into.\n" });
  const context = await connectedContext(browser, host);
  const page = await openApp(context);
  await waitUntil("the first pull", async () => Boolean((await opfsFiles(page))["Notes/welcome.md"]));

  await openFile(page, "welcome.md");
  await page.click(".milkdown-root .ProseMirror");
  await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "screen shot.png", { type: "image/png" }));
    document
      .querySelector(".milkdown-root .ProseMirror")!
      .dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, PNG_BASE64);

  // Both halves have to land: the asset is written immediately, but the note
  // that links it goes through the editor's save debounce.
  await waitUntil("the image and its link", async () => {
    const files = await opfsFiles(page);
    return !!files[ASSET] && asText(files["Notes/welcome.md"] ?? "").includes("![");
  });
  const local = await opfsFiles(page);
  checks.ok("the pasted image became a real file beside its note", !!local[ASSET], Object.keys(local).join(", "));
  checks.ok("its bytes are the bytes that were pasted", local[ASSET] === PNG_BASE64);

  const markdown = asText(local["Notes/welcome.md"] ?? "");
  const link = markdown.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1];
  checks.note(`markdown link: ${JSON.stringify(link)}`);
  checks.ok("the note links it by a relative path, not a blob: URL", !!link && !link.startsWith("blob:") && !link.startsWith("data:"), String(link));
  checks.ok("the link is what GitHub resolves from the note's folder", link === "assets/screen%20shot.png", String(link));

  const displayed = () =>
    page.locator(".milkdown-root img").evaluateAll(images => images.some(i => (i as HTMLImageElement).naturalWidth > 0));
  checks.ok("the editor displays it", await displayed());

  // The original failure: a blob: URL is dead once the document is gone.
  await page.reload();
  await page.waitForSelector(".milkdown-root .ProseMirror", { timeout: 15_000 });
  await page.waitForTimeout(2000);
  checks.ok("it still displays after a reload", await waitUntil("the image after reload", displayed));

  await page.click(".sync-now");
  await waitUntil("the image to reach the branch", () => !!host.files[ASSET]);
  checks.ok("it reached GitHub as a file", !!host.files[ASSET], Object.keys(host.files).join(", "));
  checks.ok("byte-for-byte identical on GitHub", host.files[ASSET]?.toString("base64") === PNG_BASE64);

  // A second device pulls it down intact.
  const second = await connectedContext(browser, host);
  const page2 = await openApp(second);
  const arrived = await waitUntil("the image on device two", async () => (await opfsFiles(page2))[ASSET] === PNG_BASE64);
  checks.ok("a second device gets the image, unharmed", arrived);

  // Opening it must not rewrite it as text.
  await page2.click('.tree-row:has-text("screen shot.png")');
  await page2.waitForTimeout(1500);
  checks.ok("opening it shows a preview instead of editing bytes as text", (await page2.locator(".binary-file").count()) === 1);
  checks.ok("and opening it left the file untouched", (await opfsFiles(page2))[ASSET] === PNG_BASE64);

  // Selecting a binary file used to re-read it forever: marking it binary is
  // itself a state change, which re-triggered the read that marked it.
  await page2.evaluate(() => {
    (window as any).__reads = 0;
    const original = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = function (...args: unknown[]) {
      (window as any).__reads++;
      return (original as any).apply(this, args);
    };
  });
  await page2.waitForTimeout(2000);
  const reads = await page2.evaluate(() => (window as any).__reads as number);
  checks.ok("a selected image is not re-read on a loop", reads < 10, `${reads} OPFS reads while idle`);

  await context.close();
  await second.close();
  return checks.failures;
}
