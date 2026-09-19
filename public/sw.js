// Minimal offline app-shell cache. There's no build-time asset manifest to
// precache against (build.ts content-hashes the JS/CSS chunk filenames), so
// this caches opportunistically: the shell page + manifest are precached on
// install, and every other same-origin GET gets cached the first time it's
// actually fetched. That's enough for a repeat visit (including offline) to
// load entirely from cache, since the index.html a browser has cached always
// references the chunk files that were cached alongside it.
//
// Bump this on any change to this file's caching *behavior* (not required
// for routine deploys — the browser re-checks sw.js for byte changes on its
// own and activate() below clears the previous version's cache).
const CACHE_NAME = "webfs-shell-v1";
const SHELL_URL = new URL("./", self.location).href;
const PRECACHE_URLS = [SHELL_URL, new URL("./manifest.webmanifest", self.location).href];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
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

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch (err) {
    return (await caches.match(request)) ?? (await caches.match(SHELL_URL)) ?? Promise.reject(err);
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(request.mode === "navigate" ? networkFirst(request) : cacheFirst(request));
});
