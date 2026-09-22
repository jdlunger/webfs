/**
 * Obsidian's embed syntax, in a live editor.
 *
 * Two things can only be seen here. One is that the image actually renders:
 * the link names a file in `Media/` that sits nowhere near the note, so the
 * fallback has to be reached and the bytes handed to the DOM. The other is
 * that typing in the note leaves the embed alone — remark escapes the syntax
 * into `!\[\[…]]` unless the editor knows what it is, which would rewrite
 * every note in a vault the first time it was touched.
 */
import type { Browser } from "playwright";
import { Checks, asText, openApp, openFile, opfsFiles, typeInEditor, waitUntil } from "./harness";

/** A real 3×3 PNG, so the browser genuinely decodes it. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAFUlEQVR4nGP8z8DwnwEJMKEL0EoQAHFiAiFbTJ7fAAAAAElFTkSuQmCC";

/** A vault's shape: attachments in one folder at the root, linked by name. */
const NOTE = "Vault/Anatomie.md";
const EMBED = "![[Pasted image 20260905101712.png|20]]";
const MARKDOWN = `# Anatomie\n\n${EMBED}\n`;

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("Obsidian embeds");
  checks.heading();

  const context = await browser.newContext();
  const page = await openApp(context);
  await page.waitForSelector(".milkdown-root, .editor", { timeout: 15_000 });

  // Written straight into OPFS, the way a sync from an Obsidian vault would
  // leave them — the attachment nowhere near the note that links it.
  await page.evaluate(
    async ({ png, note, markdown }) => {
      const root = await navigator.storage.getDirectory();
      const write = async (path: string, bytes: Uint8Array<ArrayBuffer>) => {
        const segments = path.split("/");
        let dir = root;
        for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create: true });
        const writable = await (await dir.getFileHandle(segments.at(-1)!, { create: true })).createWritable();
        await writable.write(bytes);
        await writable.close();
      };
      await write("Media/Pasted image 20260905101712.png", Uint8Array.from(atob(png), c => c.charCodeAt(0)));
      await write(note, new TextEncoder().encode(markdown));
    },
    { png: PNG_BASE64, note: NOTE, markdown: MARKDOWN },
  );

  await page.reload();
  await page.waitForSelector(".tree-row", { timeout: 15_000 });
  await openFile(page, "Anatomie.md");

  const shown = () =>
    page
      .locator(".milkdown-root .wiki-image img")
      .evaluateAll(images => images.some(i => (i as HTMLImageElement).naturalWidth > 0));
  checks.ok("an embed whose file lives in Media renders as the image", await waitUntil("the embedded image", shown));

  const width = await page.locator(".milkdown-root .wiki-image img").first().evaluate(i => (i as HTMLElement).style.width);
  checks.ok("the |20 after the name is applied as a width", width === "20px", width);

  // The whole point: editing the note must not rewrite what it didn't touch.
  await typeInEditor(page, "Beckenmuskulatur");
  const saved = await waitUntil("the edit to be saved", async () =>
    asText((await opfsFiles(page))[NOTE] ?? "").includes("Beckenmuskulatur"),
  );
  const markdown = asText((await opfsFiles(page))[NOTE] ?? "");
  checks.ok("the edit was saved", saved);
  checks.note(`saved markdown: ${JSON.stringify(markdown)}`);
  checks.ok("the embed survives a keystroke elsewhere in the note", markdown.includes(EMBED), markdown);
  checks.ok("and was not escaped into something Obsidian no longer renders", !markdown.includes("!\\["), markdown);

  await context.close();
  return checks.failures;
}
