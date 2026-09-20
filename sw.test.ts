/**
 * Exercises public/sw.js against a fake Cache Storage and a fake network.
 *
 * Offline behavior is invisible in normal use — it only shows up on a plane,
 * and only as a blank screen — so the lifecycle is driven here explicitly:
 * install, go offline, navigate.
 *
 * sw.js reaches for `self`, `caches` and `fetch` as globals, which is what it
 * is in a real worker (`self` *is* the global scope there). Rather than
 * contort the shipped file for testability, it's evaluated as a function of
 * those three.
 */
import { test, expect, beforeEach } from "bun:test";

const ORIGIN = "https://example.com";
const BASE = `${ORIGIN}/webfs/`;

const shellHtml = (js: string, css: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!-- Bun's HTML bundler resolves every <link href> as a module. -->
    <link rel="stylesheet" crossorigin href="./${css}"><script type="module" crossorigin src="./${js}"></script></head>
  <body><div id="root"></div></body>
</html>`;

/** The bits of the Cache Storage API that sw.js touches. */
class FakeCache {
  entries = new Map<string, Response>();
  constructor(private net: FakeNetwork) {}

  async put(request: Request | string, response: Response) {
    this.entries.set(urlOf(request), response);
  }
  async match(request: Request | string) {
    return this.entries.get(urlOf(request));
  }
  async add(request: Request | string) {
    const response = await this.net.fetch(urlOf(request));
    if (!response.ok) throw new Error(`add failed: ${response.status}`);
    await this.put(request, response);
  }
  async delete(request: Request | string) {
    return this.entries.delete(urlOf(request));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  constructor(private net: FakeNetwork) {}

  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) this.caches.set(name, (cache = new FakeCache(this.net)));
    return cache;
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
}

class FakeNetwork {
  online = true;
  routes = new Map<string, { body: string; type: string }>();
  requested: string[] = [];

  fetch = async (input: Request | string) => {
    const url = urlOf(input);
    this.requested.push(url);
    if (!this.online) throw new TypeError("Failed to fetch");

    const hit = this.routes.get(url);
    if (hit) return new Response(hit.body, { status: 200, headers: { "content-type": hit.type } });
    // What GitHub Pages does with a client-side-routing deep link.
    return new Response(this.routes.get(`${BASE}404.html`)?.body ?? "not found", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
  };
}

const urlOf = (request: Request | string) => (typeof request === "string" ? request : request.url);

/** Loads sw.js and returns handles to the listeners it registered. */
async function loadWorker(net: FakeNetwork, cacheStorage: FakeCacheStorage) {
  const listeners = new Map<string, (event: any) => void>();
  const self = {
    location: new URL(`${BASE}sw.js`),
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };

  const source = await Bun.file(new URL("./public/sw.js", import.meta.url)).text();
  new Function("self", "caches", "fetch", source)(self, cacheStorage, net.fetch);

  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    listeners.get(type)!({
      ...event,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      respondWith: (p: Promise<Response>) => (responded = p),
    });
    await Promise.all(pending);
    return responded;
  };

  return {
    install: () => dispatch("install", {}),
    activate: () => dispatch("activate", {}),
    navigate: (url: string) => dispatch("fetch", { request: navigationRequest(url) }),
    asset: (url: string) => dispatch("fetch", { request: new Request(url) }),
  };
}

// `mode` is read-only on a real Request, so stand in a plain object with the
// shape sw.js reads.
const navigationRequest = (url: string) => ({ url, method: "GET", mode: "navigate" }) as unknown as Request;

let net: FakeNetwork;
let cacheStorage: FakeCacheStorage;

beforeEach(() => {
  net = new FakeNetwork();
  cacheStorage = new FakeCacheStorage(net);
  net.routes.set(BASE, { body: shellHtml("chunk-aaa.js", "chunk-bbb.css"), type: "text/html" });
  net.routes.set(`${BASE}chunk-aaa.js`, { body: "console.log('v1')", type: "text/javascript" });
  net.routes.set(`${BASE}chunk-bbb.css`, { body: "body{}", type: "text/css" });
  net.routes.set(`${BASE}chunk-aaa.js.map`, { body: "{".repeat(1000), type: "application/json" });
  net.routes.set(`${BASE}manifest.webmanifest`, { body: "{}", type: "application/manifest+json" });
  for (const size of [180, 192, 512]) {
    net.routes.set(`${BASE}icons/icon-${size}.png`, { body: "png", type: "image/png" });
  }
  net.routes.set(`${BASE}404.html`, { body: "<html>redirecting</html>", type: "text/html" });
});

const cached = async () => [...(await cacheStorage.open("webfs-shell-v2")).entries.keys()].sort();

test("install caches the hashed chunks the shell references, not just the shell", async () => {
  const sw = await loadWorker(net, cacheStorage);
  await sw.install();

  expect(await cached()).toEqual(
    [
      BASE,
      `${BASE}chunk-aaa.js`,
      `${BASE}chunk-bbb.css`,
      `${BASE}icons/icon-180.png`,
      `${BASE}icons/icon-192.png`,
      `${BASE}icons/icon-512.png`,
      `${BASE}manifest.webmanifest`,
    ].sort(),
  );
});

test("the app loads offline after a single online visit", async () => {
  const sw = await loadWorker(net, cacheStorage);
  await sw.install();
  await sw.activate();

  net.online = false;

  const page = await sw.navigate(BASE);
  expect(await page!.text()).toContain("chunk-aaa.js");

  const js = await sw.asset(`${BASE}chunk-aaa.js`);
  expect(await js!.text()).toBe("console.log('v1')");
  const css = await sw.asset(`${BASE}chunk-bbb.css`);
  expect(css!.status).toBe(200);
});

test("an offline deep link bounces to the app root with ?redirect=", async () => {
  const sw = await loadWorker(net, cacheStorage);
  await sw.install();
  net.online = false;

  // Not the shell served in place: index.html's chunk hrefs are relative, so
  // at /webfs/notes/todo.md they'd resolve into a directory that has none.
  // The redirect is the same contract public/404.html uses online.
  const page = await sw.navigate(`${BASE}notes/todo.md`);
  expect(page!.status).toBe(302);
  expect(page!.headers.get("location")).toBe(`${BASE}?redirect=%2Fnotes%2Ftodo.md`);

  // ...and following it lands on the real shell.
  const landed = await sw.navigate(`${BASE}?redirect=%2Fnotes%2Ftodo.md`);
  expect(landed!.status).toBe(200);
  expect(await landed!.text()).toContain("chunk-aaa.js");
});

test("an offline load of the app root serves the shell directly, no redirect loop", async () => {
  const sw = await loadWorker(net, cacheStorage);
  await sw.install();
  net.online = false;

  const page = await sw.navigate(BASE);
  expect(page!.status).toBe(200);
  expect(await page!.text()).toContain("chunk-aaa.js");
});

test("a deep link's 404 is never cached as the app shell", async () => {
  const sw = await loadWorker(net, cacheStorage);
  await sw.install();

  const online = await sw.navigate(`${BASE}notes/todo.md`);
  expect(online!.status).toBe(404);

  net.online = false;
  const offline = await sw.navigate(BASE);
  expect(await offline!.text()).not.toContain("redirecting");
});

test("a deploy with new chunk hashes is picked up, and the old ones pruned", async () => {
  const sw = await loadWorker(net, cacheStorage);
  await sw.install();

  net.routes.set(BASE, { body: shellHtml("chunk-ccc.js", "chunk-ddd.css"), type: "text/html" });
  net.routes.set(`${BASE}chunk-ccc.js`, { body: "console.log('v2')", type: "text/javascript" });
  net.routes.set(`${BASE}chunk-ddd.css`, { body: "body{color:red}", type: "text/css" });
  await sw.navigate(BASE);

  const keys = await cached();
  expect(keys).toContain(`${BASE}chunk-ccc.js`);
  expect(keys).not.toContain(`${BASE}chunk-aaa.js`);
  expect(keys).toContain(`${BASE}manifest.webmanifest`);

  net.online = false;
  expect(await (await sw.asset(`${BASE}chunk-ccc.js`))!.text()).toBe("console.log('v2')");
});

test("an unchanged deploy does not re-download assets already cached", async () => {
  const sw = await loadWorker(net, cacheStorage);
  await sw.install();

  net.requested.length = 0;
  await sw.navigate(BASE);

  expect(net.requested).toEqual([BASE]);
});

test("the multi-megabyte sourcemap is left out of the cache", async () => {
  const sw = await loadWorker(net, cacheStorage);
  await sw.install();
  await sw.asset(`${BASE}chunk-aaa.js.map`);

  expect(await cached()).not.toContain(`${BASE}chunk-aaa.js.map`);
});

test("install survives assets that fail to fetch", async () => {
  net.routes.delete(`${BASE}icons/icon-512.png`);
  const sw = await loadWorker(net, cacheStorage);
  await sw.install();

  expect(await cached()).toContain(`${BASE}chunk-aaa.js`);
});

test("activate drops caches left by earlier worker versions", async () => {
  const stale = await cacheStorage.open("webfs-shell-v2");
  await stale.put(`${BASE}chunk-old.js`, new Response("old"));

  const sw = await loadWorker(net, cacheStorage);
  await sw.install();
  await sw.activate();

  expect(await cacheStorage.keys()).toEqual(["webfs-shell-v2"]);
});
