// Offline app shell for webfs.
//
// There's no build-time asset manifest to precache against — build.ts
// content-hashes the JS/CSS chunk filenames — so this worker discovers them
// the only way a service worker can: it fetches the shell HTML at install
// time and scrapes the <script src>/<link href> URLs out of it.
//
// That scrape is what makes *one* online visit enough to work offline. The
// obvious cheaper alternative (cache each asset the first time it's fetched)
// cannot cover a first visit: the page's own chunk requests happen before
// this worker has claimed the client, so nothing intercepts them, and the
// app needs a second online load before it survives going offline.
//
// Bump CACHE_NAME when this file's caching *behavior* changes. Routine
// deploys don't need it — the browser re-checks sw.js byte-for-byte on its
// own, and any navigation made while online re-scrapes the shell and tops up
// (and prunes) the cache for the newly-hashed chunks.
const CACHE_NAME = "webfs-shell-v2";

const SHELL_URL = new URL("./", self.location).href;
const SHELL_PATH = new URL(SHELL_URL).pathname;

// Everything the shell needs that isn't discoverable from its markup: the
// manifest and icon <link> tags are inserted at runtime by frontend.tsx, so
// scraping index.html will never turn them up.
const EXTRA_PRECACHE = [
  "./manifest.webmanifest",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
].map((path) => new URL(path, self.location).href);

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const ASSET_URL_RE = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

// Sourcemaps are only ever fetched with devtools open, and this app's is
// ~10MB — several times the bundle it maps. Never spend a phone's storage
// quota on one.
const isSourcemap = (url) => url.endsWith(".map");

function shellAssetUrls(html) {
  const urls = new Set();
  for (const [, href] of html.replace(HTML_COMMENT_RE, "").matchAll(ASSET_URL_RE)) {
    const url = new URL(href, SHELL_URL);
    if (url.origin !== self.location.origin) continue;
    if (isSourcemap(url.href)) continue;
    url.hash = "";
    urls.add(url.href);
  }
  return [...urls];
}

// Individual misses must not fail the whole install: a worker that caches
// most of the shell is strictly better than one that installs nothing.
function addAllSettled(cache, urls) {
  return Promise.allSettled(urls.map((url) => cache.add(url)));
}

// Cache the shell and everything it references, and drop assets no longer
// referenced (old chunk hashes from previous deploys, which nothing will
// ever request again). HTML that yields no assets at all is something other
// than a real shell — an interstitial, a captive portal — so it's ignored
// rather than cached over the good copy and used to prune against.
async function cacheShell(cache, response) {
  const html = await response.clone().text();
  const assets = shellAssetUrls(html);
  if (assets.length === 0) return;

  await cache.put(SHELL_URL, response.clone());
  const keep = new Set([SHELL_URL, ...EXTRA_PRECACHE, ...assets]);

  const missing = (await Promise.all(assets.map(async (url) => ((await cache.match(url)) ? null : url)))).filter(
    (url) => url !== null,
  );
  await addAllSettled(cache, missing);
  await Promise.all(
    (await cache.keys()).map(async (request) => {
      if (!keep.has(request.url)) await cache.delete(request);
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled([
        (async () => {
          // `cache: "reload"` so a stale HTTP-cached copy of the shell can't
          // seed us with chunk hashes from a previous deploy.
          const response = await fetch(SHELL_URL, { cache: "reload" });
          if (!response.ok) throw new Error(`shell precache failed: ${response.status}`);
          await cacheShell(cache, response);
        })(),
        addAllSettled(cache, EXTRA_PRECACHE),
      ]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Navigations are network-first so an online load always gets the current
// deploy. The response is stored under SHELL_URL rather than the requested
// URL: every client-side route renders the same document, so per-URL entries
// would be N copies of one file. It also keeps GitHub Pages' 404.html — what
// a deep link actually returns there before the SPA redirect kicks in — from
// being cached as if it were the app.
async function handleNavigate(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cacheShell(cache, response);
    return response;
  } catch (err) {
    const cached = await cache.match(SHELL_URL);
    if (!cached) throw err;

    // Serving the cached shell *at* a deep URL would render a blank page:
    // index.html references its chunks relatively ("./chunk-x.js"), so under
    // /webfs/Notes/todo.md they'd resolve to /webfs/Notes/chunk-x.js and
    // miss. Online this never comes up, because GitHub Pages 404s the deep
    // link and public/404.html bounces to the app root first. Offline there
    // is no server to do that, so take the identical route here — same
    // ?redirect= contract, restored by the same code in App.tsx.
    const { pathname } = new URL(request.url);
    if (pathname !== SHELL_PATH) {
      const path = pathname.slice(SHELL_PATH.length - 1) || "/";
      return Response.redirect(`${SHELL_URL}?redirect=${encodeURIComponent(path)}`, 302);
    }
    return cached;
  }
}

// Chunk filenames are content-hashed, so a cache hit can never be stale: a
// changed file is a different URL.
async function handleAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && !isSourcemap(new URL(request.url).pathname)) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(request.mode === "navigate" ? handleNavigate(request) : handleAsset(request));
});
