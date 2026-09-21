# webfs

A single-page file explorer + markdown editor. Everything is client-side —
the "filesystem" (`src/fs.ts`) is a flat `Record<id, FSNode>` persisted to
OPFS (see Storage below), there is no backend API. `src/index.ts`
(`Bun.serve()`) just serves `src/index.html` for local dev/preview;
production is a static export (see Deployment below), not this server.

Key files: `App.tsx` (top-level state + URL routing + cross-tab
reconciliation), `Sidebar.tsx` (file tree, rename/move UI), `Editor.tsx`
(Milkdown integration), `storage.ts` (thin OPFS layer), `tree.ts` (projects
OPFS into the in-memory record; owns session ids), `fs.ts` (pure queries over
that record), `merge.ts` (three-way line merge).

## Git workflow

Single-maintainer hobby project, no PR review process. Commit and push
directly to `main` for every change — don't create feature branches, and
don't open pull requests. `main` is also the GitHub Pages deploy trigger
(see Deployment below), so a push there goes live immediately; that's the
intended workflow here, not an oversight — the point is to be able to pull
up the GitHub Pages URL right after a change and see it live, without a PR
merge step in between.

## Editor (Milkdown / Crepe)

`Editor.tsx` mounts a `@milkdown/crepe` `Crepe` instance per file (remounted
via React `key` rather than fed new content on prop changes — it's an
uncontrolled component; content flows *out* via the `markdownUpdated`
listener into `fs`, never back in after creation). The key is
`` `${file.id}:${externalEdit}` ``: `externalEdit` is a counter `App.tsx`
bumps *only* when another tab's edit has been merged in, since remounting is
the one way to push text into an uncontrolled editor. It costs the cursor
position and undo history, so never bump it for local typing.

- Import individual `@milkdown/crepe/theme/common/*.css` files, **not** the
  `theme/common/style.css` bundle — that bundle `@import`s `latex.css`,
  which pulls in KaTeX's full font set (~1.4MB of base64 fonts) even with
  the Latex feature disabled. The Latex feature itself is turned off via
  `features: { [Crepe.Feature.Latex]: false }` in the `Crepe` constructor.
- To reach ProseMirror/Milkdown config Crepe doesn't expose directly (e.g.
  the `spellcheck`/`autocorrect`/`autocapitalize` attributes on the
  contenteditable), call `crepe.editor.config(ctx => ctx.update(...))`
  before `crepe.create()`, importing the ctx slice from `@milkdown/kit/core`
  (a direct dependency, even though `@milkdown/crepe` alone would pull it in
  transitively — we import from it directly now).
- iOS Safari's keyboard accessory bar (line-nav arrows, "Done") is drawn by
  the OS for any editable region and can't be suppressed from the page; only
  the predictive-text suggestion strip responds to the attributes above.

## Mobile (iOS Safari) considerations

The sidebar becomes a slide-in drawer below 768px (see `.sidebar-open` /
`.mobile-topbar` / `.sidebar-scrim` in `index.css`), toggled from a topbar
hamburger button. Notes learned the hard way:
- Touch targets need real sizing (44px), not desktop hover-revealed
  affordances — `.tree-actions` are hover-only on desktop but forced visible
  on mobile.
- Showing every row action (rename/move/delete) inline at once crushed file
  names down to a few visible characters at phone widths; they're collapsed
  behind a single `⋯` toggle per row that expands on tap instead.
- Double-click (rename) and HTML5 drag-and-drop (move) don't work on mobile
  Safari; both have explicit tap-friendly alternatives (a rename button, and
  a "Move to…" `<select>` listing every folder path) alongside the
  desktop-only double-click/drag affordances.
- Use `100dvh`, not `100vh` (Safari's address bar resizes the viewport), and
  `env(safe-area-inset-*)` padding for anything pinned to a screen edge.
- Crepe's default content padding/heading sizes are tuned for a wide desktop
  column and need phone-width overrides (see the `@media (max-width: 768px)`
  block in `index.css`).

## Storage (OPFS) and multiple tabs

**OPFS is the only store, and the directory tree is the filesystem.** There is
no index, no metadata file, no localStorage fallback. Everything webfs
persists is a name, a type, a position in the hierarchy or a file's text, and
a directory tree expresses all four — so `storage.ts` is a thin layer over
OPFS and nothing else. Whatever is on disk is exactly what the app shows;
there's no index to drift out of sync, and folders are inspectable and
exportable as real directories.

- **Identity is the path.** Ids exist only in memory (`tree.ts`) and are never
  written anywhere; they differ between tabs and between reloads. Anything
  crossing that boundary — BroadcastChannel messages, `storage.ts` calls —
  uses paths. `tree.ts`'s `repath()` carries an id (and its descendants')
  across a rename or move, which is what stops the editor remounting while you
  rename the file you're typing in. Verified in a browser: text survives.
- **Names are stored as typed, not escaped.** OPFS rejects only `""`, `.`,
  `..`, and names containing `/` or `\` (`isValidName`). Spaces, colons,
  leading dots, trailing spaces and non-ASCII are all legal and round-trip
  byte-identically — confirmed against a real browser, including `café.md` and
  `日本語.md`. If you ever see non-ASCII names fail locally, check your locale
  first: under `LC_CTYPE=POSIX` Chromium reports a bogus `TypeMismatchError`.
- **Two entries can't share a name in a folder** — the filesystem forbids it.
  `createFile`/`createDirectory` therefore uniquify ("notes 2.md") and return
  the name actually used; always use the returned name. Creating the same
  folder twice uniquifies rather than reusing it, which is how a stray empty
  "Notes 2" got seeded once — group by directory when seeding.
- **Directories have no `move()`** (files do, and it's used). Folder moves are
  a recursive copy *then* a delete, deliberately in that order so an
  interrupted move leaves the original intact — a duplicate is recoverable, a
  hole isn't. `canMove()` in `fs.ts` rejects moving a folder into its own
  subtree; without that the copy descends into the target it's creating and
  never terminates.
- **Locks are taken only around file writes**, via Web Locks, giving up after
  `LOCK_TIMEOUT_MS` (750ms). Reads never lock, so a file another tab is
  mid-save is still instantly viewable. A write that loses the race returns
  `"busy"` and `App.tsx` retries with the text still queued. Structural
  changes aren't locked: they're single OPFS calls, and there's no shared
  index for them to race over — which is the main thing having no `tree.json`
  buys. Two tabs restructuring concurrently no longer clobber each other.
- **Content loads lazily**, when a file is opened. `FSNode.content` being
  `undefined` means "not read yet", not "empty".
- **Saves are debounced** (`WRITE_DEBOUNCE_MS`, 400ms) and flushed on
  `pagehide`/hide. Best-effort: writes are async, so a page torn down
  instantly can still lose the last few hundred ms.
- **Structural changes re-read the whole tree** (`walk()` → `projectTree()` →
  `adoptContent()`), rather than being patched in memory. `adoptContent`
  preserves text this tab has already loaded. Walking is cheap at notes-app
  scale and keeps OPFS unambiguously the source of truth.
- **Cross-tab sync is a `BroadcastChannel`** (`webfs:changes`), announced only
  after a write lands. File messages carry the path; receivers re-read and
  reconcile through `merge.ts`.
- **`merge.ts` is deliberately lossy.** Each side reduces to the one run of
  lines it changed; both apply when they don't overlap, local wins when they
  do. No real diff, no conflict markers. It is *stable* — merging a merged
  result changes nothing — which is what stops two tabs ping-ponging writes.
- **No migration, and no fallback store.** Nothing is imported from the old
  `webfs:filesystem` blob. And because there's no second backend, a browser
  with OPFS but without `createWritable` gets an explicit error screen rather
  than silent degradation (`opfsAvailable()` gates the app). **This has not
  been verified on real iOS Safari — if `createWritable` is missing there, the
  app does not work on that device.** That's the known risk of the
  single-store design; check `opfsAvailable()` on device before assuming.
- `bun test` covers `merge.ts` and `tree.ts` (projection, id stability across
  rename/move, name validation). OPFS itself can't run headless, so seeding,
  rename, folder moves, two-tab merging and offline were verified by driving
  real Chromium tabs — not in CI, so re-run by hand after touching this area.

## Deployment (GitHub Pages)

`.github/workflows/deploy-pages.yml` builds with `bun run build` (→
`build.ts`, a static `Bun.build()` export to `dist/`) and deploys via
`actions/deploy-pages`. The Pages source must be set to "GitHub Actions" in
repo Settings → Pages (already done); every push to `main` redeploys.

The site is served under `/webfs/`, not the domain root, which two things
depend on knowing:
- **Client-side routing** (`App.tsx` reflects the selected file in the URL
  via `history.replaceState`) needs that `/webfs` prefix stripped when
  reading `location.pathname` and re-added when writing it. `build.ts`
  `define`s `process.env.BUN_PUBLIC_BASE_PATH` to `"/webfs"` *only* for that
  static export; `bun dev`/`bun start` (Bun.serve, served at the root) never
  set it. Reading it is wrapped in try/catch in `App.tsx`, because an
  un-inlined `process.env.X` reference is left as literal source referencing
  the bare `process` global, which doesn't exist in a browser and throws —
  confirmed by testing `Bun.build` directly; don't assume an unset env var
  quietly becomes `undefined`.
- **Deep links 404 on a fresh load/refresh** because GitHub Pages has no
  server-side rewrite for a client-side router. `public/404.html` (copied
  into `dist/` by the workflow, not processed by `build.ts`'s
  `src/**/*.html` glob) redirects back to the app with the real path in
  `?redirect=`; `App.tsx` restores it via `history.replaceState` before
  anything reads the URL.

If the deploy target or path ever changes, both the `"/webfs"` literal in
`build.ts` and in `public/404.html` need updating together.

## PWA (Add to Home Screen)

`public/manifest.webmanifest`, `public/sw.js`, and `public/icons/*.png` make
this installable as a standalone iOS/Android app. They're plain static files
under `public/`, copied into `dist/` by the deploy workflow (`cp -r public/.
dist/`) alongside `404.html`, and served explicitly by `src/index.ts` for
local dev — not left for the SPA wildcard route or Bun's HTML bundler:
- The `<link rel="manifest">` / `apple-touch-icon` / `icon` tags are inserted
  at runtime in `frontend.tsx`, not written as static `<link>` tags in
  `index.html`. Bun's HTML bundler resolves the `href` of *every* `<link>`
  tag it finds as a module to bundle, not just stylesheets — a static tag
  pointing at a `public/` file (outside the module graph) fails to resolve
  at build time.
- Those hrefs, and the `navigator.serviceWorker.register()` argument, go
  through `appUrl()` from `src/basePath.ts` rather than being written as
  plain `"./manifest.webmanifest"` / `"./sw.js"`. A relative URL resolves
  against `document.baseURI`, and the router moves that around with
  `history.replaceState` — so on a deep link like `/webfs/Notes/todo.md`,
  `"./sw.js"` resolves to `/webfs/Notes/sw.js`, which 404s and then fails
  registration on MIME type (the SPA fallback serves it `index.html`).
  `basePath.ts` also owns the `BASE_PATH` constant `App.tsx` routes with.
- `src/index.ts` lists the three icon files individually rather than via a
  `{ dir: "./public/icons" }` route: pairing a directory route with an HTML
  import route makes this Bun version (1.3.11) misdetect the dev server as
  a React Server Components framework project and refuse to start
  (`Failed to resolve 'react-server-dom-bun/server'`).
- `manifest.webmanifest`'s `start_url`/`scope` are `"."`, resolved relative
  to the manifest's own URL (not the document's) — that's what makes the
  same file correct both at the domain root (`bun dev`) and under `/webfs/`
  (production) without needing a build-time-injected base path the way
  `App.tsx` needs one for routing.
- `sw.js` can't precache a fixed asset list, because `build.ts`
  content-hashes the JS/CSS chunk filenames and there's no build-time
  manifest to read. It scrapes them instead: on install it fetches the shell
  HTML and pulls the `<script src>` / `<link href>` URLs out of it with a
  regex. That scrape is what makes *one* online visit enough to go offline.
  Caching each asset lazily on first fetch (the obvious cheaper option, and
  what this did originally) cannot cover a first visit — the page's own
  chunk requests happen before the worker has claimed the client, so nothing
  intercepts them, and the app needs a *second* online load before it
  survives going offline.
- Navigations are network-first (so an online load always gets the current
  deploy) and are cached under the shell URL, never the requested URL: every
  client-side route renders the same document. A successful navigation also
  re-scrapes the shell, which is what picks up newly-hashed chunks after a
  deploy and prunes the previous deploy's — again within one online visit.
  Assets are cache-first, which is safe precisely because their names are
  content-hashed. Sourcemaps are excluded on purpose: `sourcemap: "linked"`
  emits a ~10MB `.map`, several times the bundle it maps.
- **Offline deep links redirect rather than render in place.** Serving the
  cached shell *at* `/webfs/Notes/todo.md` produces a blank page:
  `index.html` references its chunks relatively (`./chunk-x.js`), so they'd
  resolve to `/webfs/Notes/chunk-x.js` and miss. Online this never comes up,
  because Pages 404s the deep link and `public/404.html` bounces to the app
  root first; offline there's no server to do that, so the worker issues the
  same `?redirect=` bounce itself and `App.tsx` restores the path exactly as
  it does online. Worth knowing before "simplifying" that branch away — it
  only reproduces with a genuinely unreachable origin, not with devtools'
  offline toggle, which doesn't always apply to worker-initiated fetches.
- Registered from `frontend.tsx` only when `NODE_ENV === "production"`, so it
  never fights `bun --hot`'s HMR. `bun run start` builds with
  `NODE_ENV=production`, so that's how to exercise the worker locally;
  `sw.test.ts` (`bun test`) drives its lifecycle against a fake Cache Storage
  and network, including the first-visit, deep-link and redeploy paths.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
