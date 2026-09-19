/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

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
// resolve as an import. Relative hrefs resolve against document.baseURI,
// which already carries the "/webfs" prefix in production the same way a
// static <link> tag would.
function addLink(rel: string, href: string) {
  const link = document.createElement("link");
  link.rel = rel;
  link.href = href;
  document.head.appendChild(link);
}
addLink("manifest", "./manifest.webmanifest");
addLink("apple-touch-icon", "./icons/icon-180.png");
addLink("icon", "./icons/icon-192.png");

// Skipped under `bun --hot` (NODE_ENV isn't "production" there) so the
// service worker's cache-first fetches never fight HMR's live reloads.
// Wrapped in try/catch for the same reason App.tsx wraps its read of
// process.env.BUN_PUBLIC_BASE_PATH: an un-inlined `process.env.X` reference
// throws in the browser, it doesn't just evaluate to undefined.
try {
  if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js");
    });
  }
} catch {}
