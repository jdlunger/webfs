/**
 * A PDF: getting one in, and reading it here.
 *
 * Both halves need a real browser. Importing goes through a file picker and
 * a drop of something from outside the page, and showing one is the
 * browser's own viewer over an object URL — there is nothing to assert about
 * either without one. The third thing checked here is that *nothing*
 * happened: a PDF whose bytes would decode as text is the one that gets
 * opened in the editor and saved back as the editor's reading of it, so the
 * file is read again after being looked at.
 */
import type { Browser } from "playwright";
import { Checks, asText, chooseFromContextMenu, openApp, opfsFiles, waitUntil } from "./harness";

/**
 * A valid one-page PDF, built rather than pasted so its xref offsets are
 * right. Deliberately all-ASCII and free of NUL bytes: that is exactly the
 * PDF `decodeText` would call text, and so the one that proves the guard in
 * front of it does something.
 */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 30 100 Td (${text}) Tj ET\n`;
  const bodies = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>stream\n${stream}endstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${bodies.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

export default async function run(browser: Browser): Promise<number> {
  const checks = new Checks("PDFs");
  checks.heading();

  const pdf = tinyPdf("Hello from webfs");
  const base64 = pdf.toString("base64");
  checks.note(`the test PDF is ${pdf.length} bytes, and decodes as text: ${JSON.stringify(pdf.toString("ascii").slice(0, 8))}…`);

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await openApp(context);
  await page.waitForSelector(".tree-row", { timeout: 15_000 });

  // --- importing through the picker ---------------------------------------------

  const chooser = page.waitForEvent("filechooser");
  await chooseFromContextMenu(page, '.tree-row.tree-folder:has-text("Notes")', "Import Files…");
  await (await chooser).setFiles({ name: "thesis.pdf", mimeType: "application/pdf", buffer: pdf });

  const imported = await waitUntil("the PDF to land in the drive", async () =>
    (await opfsFiles(page))["Notes/thesis.pdf"] === base64,
  );
  checks.ok("a file picked from the device is written into the folder it was asked for", imported,
    Object.keys(await opfsFiles(page)).join(", "));
  checks.ok("and it appears in the tree", (await page.locator('.tree-row:has-text("thesis.pdf")').count()) > 0);

  // --- reading it ----------------------------------------------------------------

  await page.click('.tree-row:has-text("thesis.pdf")');
  await page.waitForSelector(".pane-focused .pdf-frame", { timeout: 10_000 });
  checks.ok("opening it shows a PDF frame", (await page.locator(".pane-focused .pdf-frame").count()) === 1);

  // The bytes the browser's viewer is being handed, rather than the pixels it
  // draws from them: what this app is responsible for is the object URL.
  const src = await page.locator(".pane-focused .pdf-frame").getAttribute("src");
  checks.ok("the frame is fed an object URL, not a path the browser can't reach", Boolean(src?.startsWith("blob:")), String(src));
  const served = await page.evaluate(async url => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, src!);
  checks.ok("and that URL serves the file, byte for byte", served === base64);

  // The iOS escape hatch. It is the only way to read the document there, so
  // it is not allowed to quietly disappear.
  checks.ok(
    "a link to open it outside the frame is always offered",
    (await page.locator(".pane-focused .pdf-note a").getAttribute("href")) === src,
  );

  // --- and not opened as text -----------------------------------------------------

  checks.ok("it is not opened in the editor", (await page.locator(".pane-focused .milkdown-root").count()) === 0);
  // Both debounces, the way the vault suite waits them out: the damage this
  // is about lands a moment after the file is on screen, not on a keystroke.
  await page.waitForTimeout(2500);
  const after = (await opfsFiles(page))["Notes/thesis.pdf"];
  checks.ok("and looking at it leaves the file byte-identical", after === base64,
    `${asText(after ?? "").slice(0, 40)}…`);

  // --- the other two ways in --------------------------------------------------------

  // The header button, which is the one you can find without knowing to
  // right-click. It imports into the drive's root.
  const headerChooser = page.waitForEvent("filechooser");
  await page.click('.sidebar-header-actions button[aria-label="Import files from this device"]');
  await (await headerChooser).setFiles({ name: "from-header.pdf", mimeType: "application/pdf", buffer: pdf });
  checks.ok(
    "the header's import button writes into the drive's root",
    await waitUntil("the header import", async () => (await opfsFiles(page))["from-header.pdf"] === base64),
    Object.keys(await opfsFiles(page)).join(", "),
  );

  // A *file* row, which imports beside that file — the same thing dropping
  // onto one means. Without this the menu you'd naturally open is the one
  // that doesn't offer it.
  const rowChooser = page.waitForEvent("filechooser");
  await chooseFromContextMenu(page, '.tree-row:has-text("thesis.pdf")', "Import Files…");
  await (await rowChooser).setFiles({ name: "beside.pdf", mimeType: "application/pdf", buffer: pdf });
  checks.ok(
    "a file row imports into that file's folder, not the root",
    await waitUntil("the row import", async () => (await opfsFiles(page))["Notes/beside.pdf"] === base64),
    Object.keys(await opfsFiles(page)).join(", "),
  );

  // --- dropping one in -------------------------------------------------------------

  // A synthesized drop: what's under test is the handler telling an external
  // file apart from a row of this tree being moved, which is the branch a
  // dropped file actually takes.
  await page.evaluate(async ([b64, name]) => {
    const bytes = Uint8Array.from(atob(b64!), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name!, { type: "application/pdf" }));
    document
      .querySelector(".sidebar-tree")!
      .dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, [base64, "dropped.pdf"]);

  const dropped = await waitUntil("the dropped PDF", async () => (await opfsFiles(page))["dropped.pdf"] === base64);
  checks.ok("a file dropped onto the tree is imported rather than ignored", dropped,
    Object.keys(await opfsFiles(page)).join(", "));

  await context.close();
  return checks.failures;
}
