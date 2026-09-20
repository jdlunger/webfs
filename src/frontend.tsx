/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { appUrl } from "./basePath";

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// https://bun.com/docs/bundler/hot-reloading#import-meta-hot-data
(import.meta.hot.data.root ??= createRoot(elem)).render(app);

// The manifest/icon links are added here, at runtime, rather than as
// <link> tags in index.html: Bun's HTML bundler resolves *every* <link
// href> as a module to bundle (not just stylesheets), but these are plain
// static files in public/, not part of the module graph, and would fail to
// resolve as an import.
//
// The hrefs go through appUrl() rather than being written "./manifest..."
// directly: a relative href resolves against document.baseURI, which the
// router has already moved to the selected file's path by this point, so on
// a deep link a bare "./" would point into a directory that doesn't exist.
function addLink(rel: string, href: string) {
  const link = document.createElement("link");
  link.rel = rel;
  link.href = href;
  document.head.appendChild(link);
}
addLink("manifest", appUrl("manifest.webmanifest"));
addLink("apple-touch-icon", appUrl("icons/icon-180.png"));
addLink("icon", appUrl("icons/icon-192.png"));

// Registering the worker is what makes the app usable offline; it caches the
// shell and its content-hashed chunks on install (see public/sw.js).
//
// Skipped under `bun --hot` (NODE_ENV isn't "production" there) so the
// service worker's cache-first fetches never fight HMR's live reloads. To
// exercise it locally, run `bun run start` instead, which builds with
// NODE_ENV=production. Wrapped in try/catch for the same reason basePath.ts
// wraps its read: an un-inlined `process.env.X` reference throws in the
// browser, it doesn't just evaluate to undefined.
try {
  if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register(appUrl("sw.js"));
    });
  }
} catch {}
