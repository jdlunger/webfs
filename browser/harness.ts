/**
 * Shared machinery for the browser suites.
 *
 * These suites exist because the half of webfs that matters most can't run
 * headless: OPFS, a real Milkdown editor, a service worker, and the sync
 * algorithm actually touching all three. Everything here is a stand-in for
 * the one thing that can't be faked — the browser itself is real.
 *
 * Run them with `bun run browser` (see browser/run.ts).
 */
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";

export const PORT = Number(process.env.WEBFS_BROWSER_PORT ?? 3123);
export const APP_URL = `http://localhost:${PORT}`;

// --- reporting ---------------------------------------------------------------

export class Checks {
  failures = 0;

  constructor(private readonly suite: string) {}

  /** `detail` is printed only on failure, where it's the whole value. */
  ok(name: string, passed: boolean, detail = ""): void {
    console.log(`${passed ? "  ok  " : "FAIL  "} ${name}${passed ? "" : ` — ${detail}`}`);
    if (!passed) this.failures++;
  }

  note(text: string): void {
    console.log(`        ${text}`);
  }

  heading(): void {
    console.log(`\n── ${this.suite} ${"─".repeat(Math.max(0, 56 - this.suite.length))}`);
  }
}

/** Polls a condition, because most of what these suites assert is async. */
export async function waitUntil(what: string, condition: () => Promise<boolean> | boolean, timeout = 20_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await condition()) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  console.log(`        (timed out waiting for ${what})`);
  return false;
}

// --- the app under test ------------------------------------------------------

/** Starts `bun src/index.ts`, and returns a function that stops it. */
export async function startServer(): Promise<() => void> {
  const server = Bun.spawn(["bun", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "development" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const up = await waitUntil("the dev server", async () => {
    try {
      return (await fetch(APP_URL)).ok;
    } catch {
      return false;
    }
  }, 30_000);
  if (!up) {
    server.kill();
    throw new Error(`The dev server never came up on ${APP_URL}`);
  }
  return () => server.kill();
}

export function launchBrowser(): Promise<Browser> {
  // Playwright finds its own Chromium; the override is for environments that
  // keep one somewhere else (PLAYWRIGHT_BROWSERS_PATH doesn't always suffice).
  const executablePath = process.env.WEBFS_CHROMIUM;
  return chromium.launch(executablePath ? { executablePath } : {});
}

/** Starts a context with the sync connection already configured. */
export async function connectedContext(browser: Browser, host: FakeGitHub, repo = "me/notes"): Promise<BrowserContext> {
  const [owner, name] = repo.split("/");
  const context = await browser.newContext();
  await host.route(context);
  await context.addInitScript(
    ([o, r]) =>
      localStorage.setItem(
        "webfs:github:config",
        JSON.stringify({ owner: o, repo: r, branch: "main", token: "token-for-tests", auto: true }),
      ),
    [owner, name],
  );
  return context;
}

// --- reading and writing OPFS from the page ----------------------------------

/** Every file in the page's OPFS, as path → base64. Binary-safe. */
export function opfsFiles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const files: Record<string, string> = {};
    const walk = async (dir: any, prefix: string) => {
      for await (const [name, handle] of dir) {
        try {
          if (handle.kind === "directory") await walk(handle, `${prefix}${name}/`);
          else {
            const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            files[`${prefix}${name}`] = btoa(binary);
          }
        } catch {
          // The app is writing while this reads — an entry can be gone by the
          // time it's opened. Skipping it is right: the caller is polling, and
          // a half-created file is not an answer worth returning.
        }
      }
    };
    await walk(await navigator.storage.getDirectory(), "");
    return files;
  });
}

export const asText = (base64: string) => Buffer.from(base64, "base64").toString("utf-8");

/** Replaces the page's OPFS wholesale — used to stand in for an evicted store. */
export function setOpfs(page: Page, files: Record<string, string>): Promise<void> {
  return page.evaluate(async entries => {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root as any) await root.removeEntry(name, { recursive: true });
    for (const [path, content] of Object.entries(entries)) {
      const segments = path.split("/");
      let dir = root;
      for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment, { create: true });
      const writable = await (await dir.getFileHandle(segments.at(-1)!, { create: true })).createWritable();
      await writable.write(content as string);
      await writable.close();
    }
  }, files);
}

// --- a stand-in for GitHub ---------------------------------------------------

async function blobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

interface FakeCommit {
  tree: string;
  parents: string[];
  message: string;
}

/**
 * An in-memory branch, answering the endpoints github.ts calls.
 *
 * It refuses everything the real API refuses on a repository with no commits
 * — the git-object endpoints 409, and ref creation is rejected outright. That
 * is not incidental: faking those as successes is exactly what let a broken
 * empty-repo path pass its own tests once already.
 */
export class FakeGitHub {
  files: Record<string, Buffer> = {};
  blobs = new Map<string, Buffer>();
  trees = new Map<string, unknown[]>();
  commits = new Map<string, FakeCommit>();
  head: string | null = null;
  /** Counted so a suite can tell *how* the first commit was made. */
  contentsPuts = 0;
  refCreates = 0;
  refPatches = 0;

  constructor(readonly repo = "me/notes") {}

  /** The commit titles the app wrote, oldest first. */
  titles(): string[] {
    return [...this.commits.values()].map(c => c.message).filter(m => m !== "<seeded>");
  }

  text(path: string): string {
    return this.files[path]?.toString("utf-8") ?? "";
  }

  /** Puts files on the branch without the app having pushed them. */
  async seed(files: Record<string, string | Buffer>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      this.files[path] = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    }
    const entries = [];
    for (const [path, buffer] of Object.entries(this.files)) {
      const sha = await blobSha(new Uint8Array(buffer));
      this.blobs.set(sha, buffer);
      entries.push({ path, mode: "100644", type: "blob", sha });
    }
    const tree = `tree${this.trees.size}`;
    this.trees.set(tree, entries);
    const commit = `commit${this.commits.size}`;
    this.commits.set(commit, { tree, parents: [], message: "<seeded>" });
    this.head = commit;
  }

  async route(context: BrowserContext): Promise<void> {
    await context.route("https://api.github.com/**", route => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname + url.search;
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()!) : undefined;
    const json = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    const base = `/repos/${this.repo}`;

    if (path === base) return json({ default_branch: "main", permissions: { push: true } });

    if (path === `${base}/git/ref/heads/main`) {
      // An empty repository has no history for its git endpoints to describe,
      // and says so with 409 rather than 404.
      if (this.head === null) return json({ message: "Git Repository is empty." }, 409);
      return json({ object: { sha: this.head } });
    }

    // Nothing below this line works on a repository without commits.
    if (this.head === null && method === "POST" && /\/git\/(blobs|trees|commits|refs)$/.test(url.pathname)) {
      if (url.pathname.endsWith("/git/refs")) {
        return json({ message: "Reference cannot be created for an empty repository." }, 422);
      }
      return json({ message: "Git Repository is empty." }, 409);
    }

    let match = path.match(new RegExp(`^${base}/contents/(.+)$`));
    if (match && method === "PUT") {
      // The one endpoint that works on an empty repo, and so the only way to
      // give it a first branch and commit.
      const filePath = decodeURIComponent(match[1]!);
      const content = Buffer.from(body.content, "base64");
      const sha = await blobSha(new Uint8Array(content));
      this.files[filePath] = content;
      this.blobs.set(sha, content);
      const tree = `tree${this.trees.size}`;
      this.trees.set(tree, [{ path: filePath, mode: "100644", type: "blob", sha }]);
      const commit = `commit${this.commits.size}`;
      this.commits.set(commit, { tree, parents: [], message: body.message });
      this.head = commit;
      this.contentsPuts++;
      return json({ commit: { sha: commit } });
    }

    match = path.match(new RegExp(`^${base}/git/commits/(.+)$`));
    if (match && method === "GET") return json({ tree: { sha: this.commits.get(match[1]!)!.tree } });

    match = path.match(new RegExp(`^${base}/git/trees/([^?]+)`));
    if (match && method === "GET") return json({ tree: this.trees.get(match[1]!) ?? [] });

    match = path.match(new RegExp(`^${base}/git/blobs/(.+)$`));
    if (match && method === "GET") {
      const blob = this.blobs.get(match[1]!);
      return blob
        ? json({ encoding: "base64", content: blob.toString("base64") })
        : json({ message: "Not Found" }, 404);
    }

    if (path === `${base}/git/blobs` && method === "POST") {
      const content = Buffer.from(body.content, "base64");
      const sha = await blobSha(new Uint8Array(content));
      this.blobs.set(sha, content);
      return json({ sha });
    }

    if (path === `${base}/git/trees` && method === "POST") {
      const sha = `tree${this.trees.size}`;
      this.trees.set(sha, body.tree);
      return json({ sha });
    }

    if (path === `${base}/git/commits` && method === "POST") {
      const sha = `commit${this.commits.size}`;
      this.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      const files: Record<string, Buffer> = {};
      for (const entry of this.trees.get(body.tree) as Array<{ path: string; sha: string }>) {
        files[entry.path] = this.blobs.get(entry.sha)!;
      }
      this.files = files;
      return json({ sha });
    }

    if (path.startsWith(`${base}/git/refs/heads/main`) && method === "PATCH") {
      this.refPatches++;
      this.head = body.sha;
      return json({ object: { sha: body.sha } });
    }

    if (path === `${base}/git/refs` && method === "POST") {
      this.refCreates++;
      this.head = body.sha;
      return json({ object: { sha: body.sha } });
    }

    return json({ message: `the fake GitHub has no route for ${method} ${path}` }, 500);
  }
}

// --- driving the app ---------------------------------------------------------

export async function openApp(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(APP_URL);
  return page;
}

/** Fills in the sync dialog, as someone setting it up would. */
export async function connectThroughDialog(page: Page, repo = "me/notes"): Promise<void> {
  await page.waitForSelector(".sync-connect", { timeout: 15_000 });
  await page.click(".sync-connect");
  await page.fill('.modal label:has-text("Repository") input', repo);
  await page.fill('.modal label:has-text("Personal access token") input', "token-for-tests");
  await page.click(".modal-primary");
  await page.waitForSelector(".modal", { state: "detached", timeout: 15_000 });
}

/** Clicks Sync and waits for *that* run to finish, not a previous one. */
export async function syncAndSettle(page: Page): Promise<void> {
  const idle = () => !document.querySelector<HTMLButtonElement>(".sync-now")?.disabled;
  await page.waitForFunction(idle);
  await page.click(".sync-now");
  await page.waitForTimeout(300); // let the click's run start before waiting on it
  await page.waitForFunction(idle, { timeout: 20_000 });
  await page.waitForTimeout(300);
}

export const statusText = (page: Page) => page.locator(".sync-status").first().textContent();

export async function openFile(page: Page, name: string): Promise<void> {
  await page.click(`.tree-row:has-text("${name}")`);
  // Scoped to the focused pane: with the editor split there are two of these,
  // and a bare selector is a strict-mode violation rather than a guess.
  await page.waitForSelector(".pane-focused .milkdown-root .ProseMirror", { timeout: 10_000 });
  await page.waitForTimeout(700);
}

export async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.click(".pane-focused .milkdown-root .ProseMirror");
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

/**
 * Right-clicks a row and picks an item from the menu it opens.
 *
 * Rename/move/delete used to be buttons in the row itself; they're in this
 * menu now, which is the only way to reach them on a real pointer device.
 */
export async function chooseFromContextMenu(page: Page, row: string, item: string): Promise<void> {
  await page.locator(row).first().click({ button: "right" });
  await page.waitForSelector(".context-menu", { timeout: 5_000 });
  await page.locator(`.context-menu-item:has-text("${item}")`).first().click();
}
