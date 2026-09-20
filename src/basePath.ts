/**
 * Where the app is mounted, and how to build URLs against it.
 *
 * Bun inlines process.env.BUN_PUBLIC_BASE_PATH to "/webfs" for the static
 * GitHub Pages build (see build.ts). Everywhere else (bun dev / bun start,
 * served at the domain root) it's never defined, and the un-inlined
 * `process.env.X` is left as literal source referencing the bare `process`
 * global — which doesn't exist in a browser, so the access *throws* rather
 * than quietly evaluating to undefined. Hence the try/catch.
 */
function readBasePath(): string {
  try {
    return process.env.BUN_PUBLIC_BASE_PATH || "";
  } catch {
    return "";
  }
}

export const BASE_PATH = readBasePath().replace(/\/$/, "");

/**
 * Resolves `path` against the app root ("/" in dev, "/webfs/" on Pages).
 *
 * Static assets outside the module graph — the service worker, the manifest,
 * the icons — must go through this rather than a bare "./" href. Relative
 * URLs resolve against document.baseURI, and the router moves that around
 * with history.replaceState: on a deep link like /webfs/Notes/todo.md,
 * "./sw.js" resolves to /webfs/Notes/sw.js, which 404s (and, being served
 * index.html by the SPA fallback, fails registration on MIME type).
 */
export function appUrl(path: string): string {
  return new URL(path, new URL(`${BASE_PATH}/`, window.location.origin)).href;
}
