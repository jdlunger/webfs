# webfs

A single-page file explorer + markdown editor. Everything is client-side —
the "filesystem" (`src/fs.ts`) is a flat `Record<id, FSNode>` persisted to
OPFS (see Storage below), there is no backend API. `src/index.ts`
(`Bun.serve()`) just serves `src/index.html` for local dev/preview;
production is a static export (see Deployment below), not this server.

Key files: `App.tsx` (top-level state + URL routing + cross-tab
reconciliation), `Sidebar.tsx` (file tree, rename/move UI), `Editor.tsx`
(Milkdown integration), `storage.ts` (thin OPFS layer), `tree.ts` (projects
OPFS into the in-memory record), `fs.ts` (pure queries over that record),
`panes.ts` (which files are open, in which pane), `merge.ts` (three-way line
merge). Tests are `*.test.ts` at the root (`bun test`) plus `browser/` for
what only a real browser can exercise (`bun run browser`).

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

## Tabs, the split view, and the context menu

`panes.ts` (pure layout arithmetic, `panes.test.ts`), `TabStrip.tsx`,
`ContextMenu.tsx`, `useMediaQuery.ts`, and the pane rendering at the bottom of
`App.tsx`. Driven end to end by `bun run browser panes`.

- **`panes.ts` owns every decision about what's open where** — which tab
  closing lands on, where a rename moves an open file to, what a split does.
  It's pure, like `fs.ts`, so those rules are testable without a browser. Two
  invariants the rest of the app leans on are written out at the top of the
  file; read them before changing it.
- **A file is open in at most one pane.** Two Crepe instances over one file
  would each own an uncontrolled copy of the document, hear nothing of each
  other's edits, and the second one to save would write its stale text over
  the first. Opening a file that's already open focuses it where it is.
- **Splitting opens an *empty* pane** rather than duplicating what you were
  looking at (see above) — click a file to fill it. For the same reason panes
  never collapse on their own: `pruneMissing` runs on every tree refresh and
  couldn't tell "you closed the last tab" from "you just split", so it would
  swallow the new pane the instant it appeared.
- **`externalEdit` is per file now**, a `Record<id, number>` rather than one
  counter, because two panes can show two files and a sync can land in either.
- **Only the focused pane is rendered on a narrow screen**, decided in
  JavaScript (`useMediaQuery`), not CSS. `display: none` would still mount a
  second Crepe instance over a second file and run its whole save loop behind
  a screen nobody can see. The `768px` breakpoint is therefore written twice —
  `WIDE_SCREEN` in `useMediaQuery.ts` and the media blocks in `index.css`.
- **The URL follows the focused pane's file.** With a split there are two
  files on screen and only one of them can be what a reload comes back to.
- **A tab is dropped by watching the tree, not the deletion.** A file can
  vanish because it was deleted here, in another tab, or by a sync pulling
  someone else's deletion; `pruneMissing` against a refreshed `fs` covers all
  three at once, which is why it has to return the *same* layout when nothing
  changed or it would re-render forever.
- **The context menu is portalled to `<body>`.** The mobile sidebar is
  `transform`ed, which makes it the containing block for `position: fixed`
  descendants — rendered in place, the menu would be clipped to the drawer and
  slide away with it.
- **A row's long-press trigger stops `pointerdown` from propagating.** The
  tree behind it arms a trigger of its own for the empty-area menu; without
  that, both fire and the outer one wins, so a long press on a file showed
  "New File / New Folder".
- **The click after a long press is swallowed** (`onClickCapture` on the row),
  or long-pressing a file would also open it. `opened` is cleared on every
  `pointerdown`, including a mouse's, because a right-click sets it and sends
  no click — the *next* left click would otherwise be eaten.
- **Crepe's content padding needs a second override** beside the phone one:
  120px a side in a half-width pane leaves a strip barely wider than the
  margins. See `.panes:has(.pane + .pane)` in `index.css`.

## Mobile (iOS Safari) considerations

The sidebar becomes a slide-in drawer below 768px (see `.sidebar-open` /
`.mobile-topbar` / `.sidebar-scrim` in `index.css`), toggled from a topbar
hamburger button. Notes learned the hard way:
- Touch targets need real sizing (44px), not desktop hover-revealed
  affordances — the context menu's rows are padded out at phone widths.
- Row actions were once buttons *in* the row (rename/move/delete, later
  collapsed behind a `⋯` toggle because shown at once they crushed file names
  down to a few visible characters). They're a context menu now — long press,
  or right-click on desktop — so the row is just the name again and nothing
  has to be squeezed in beside it.
- Double-click (rename) and HTML5 drag-and-drop (move) don't work on mobile
  Safari; both have tap-friendly equivalents in that menu (Rename, and a
  "Move to…" submenu listing every folder path) alongside the desktop-only
  double-click/drag affordances.
- Use `100dvh`, not `100vh` (Safari's address bar resizes the viewport), and
  `env(safe-area-inset-*)` padding for anything pinned to a screen edge.
- Crepe's default content padding/heading sizes are tuned for a wide desktop
  column and need phone-width overrides (see the `@media (max-width: 768px)`
  block in `index.css`).

## Storage (OPFS) and multiple tabs

**OPFS is the only store, and the directory tree is the filesystem.**
Everything webfs persists is a name, a type, a position in the hierarchy or a
file's text, and a directory tree expresses all four — so `storage.ts` is a
thin layer over OPFS and nothing else. Whatever is on disk is exactly what the
app shows, and folders are inspectable and exportable as real directories.

- **A node's id is its path.** At any instant a file has exactly one path, and
  `isValidName` forbids `/` in a segment, so the record is keyed by the
  segments joined with `/` and there is no separate identity to allocate,
  track or translate. `segmentsOf` is a split, not a walk up the parents;
  "is this inside that folder" is a prefix test; a BroadcastChannel message's
  path *is* the key. An earlier version allocated session ids and re-pointed
  them on every rename — resist adding that back. It bought only a preserved
  undo stack when renaming the open file, and cost an id registry plus an
  O(n) scan to answer "which node is this message about".
- **Structural changes flush queued writes first** (`mutate()` in `App.tsx`).
  A queued write is keyed by the path it was queued for, so a rename landing
  mid-debounce would otherwise strand the text at the old name and recreate
  the file there. Flushing first closes that window outright, which is
  simpler than trying to follow a path as it moves. `flushWrite` also drops a
  write whose node has since vanished, so a file deleted in another tab isn't
  resurrected by a local edit still in flight.
- **Renaming the open file remounts the editor**, because its id changed;
  the text is re-read from the new path and Crepe's undo history is lost.
  Acceptable because the rename input takes focus (`autoFocus`), so the caret
  has already left the editor before any rename can happen.
- **Names are stored as typed, not escaped.** OPFS rejects only `""`, `.`,
  `..`, and names containing `/` or `\` (`isValidName`). Spaces, colons,
  leading dots, trailing spaces and non-ASCII are all legal and round-trip
  byte-identically — confirmed against a real browser, including `café.md` and
  `日本語.md`. If you ever see non-ASCII names fail locally, check your locale
  first: under `LC_CTYPE=POSIX` Chromium reports a bogus `TypeMismatchError`.
- **Two entries can't share a name in a folder** — the filesystem forbids it.
  `createFile`/`createDirectory` therefore uniquify ("notes 2.md") and return
  the name actually used; always use the returned name. Note this applies to
  folders too: creating the same folder twice yields a second, empty one
  rather than reusing it, so `loadTree`'s seed groups files by directory.
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
  changes aren't locked: they're single OPFS calls with no shared index to
  race over, so two tabs restructuring concurrently don't clobber each other.
- **Content loads lazily**, when a file is opened. `FSNode.content` being
  `undefined` means "not read yet", not "empty" — `Editor.tsx` renders a
  loading state for that case. It has to: Crepe reads `defaultValue` once at
  construction and never again, so mounting before the text arrives would
  leave an empty document on screen that the real content never reaches.
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
- **`opfsAvailable()` gates the whole app.** OPFS alone isn't enough — writing
  needs `createWritable`, which some browsers with OPFS lack. With a single
  store there's nothing to fall back to, so the app shows an error screen
  instead. **This has not been verified on real iOS Safari; if
  `createWritable` is missing there, the app does not work on that device.**
- **Bad names surface as a `window.alert`** (`mutate()` in `App.tsx` catches
  `NameTakenError` and `InvalidNameError`). That's a placeholder, not a
  considered design — it blocks the main thread and is the one piece here with
  no UX thought applied. Worth replacing with inline validation in the rename
  input. Both cases must stay handled: unhandled, a rename to a taken or
  illegal name just silently does nothing.
- **OPFS is the only *local* store**, but no longer the only replica: a
  GitHub branch can hold the same tree (see GitHub sync below). OPFS stays the
  source of truth for what the app shows; sync reconciles into it and reads
  back out of it, never around it.
- **Seeding is deduplicated across overlapping calls** (`loading` in
  `tree.ts`). "Is the store empty, and if so fill it" isn't atomic: two calls
  both walk an empty store and both seed it, and since `createDirectory`
  uniquifies rather than reusing, a first visit ended up with `Projects` *and*
  `Projects 2`. React's StrictMode does exactly that in development, so this
  reproduced on the first load of `bun dev` and in every browser suite.
- `bun test` covers `merge.ts` (`merge.test.ts`), `tree.ts`
  (`tree.test.ts`: projection, id stability across rename/move, name
  validation) and `panes.ts` (`panes.test.ts`). OPFS itself can't run headless, so seeding, rename, folder
  moves, two-tab merging and offline are verified by driving real Chromium
  tabs — see Browser suites below.

## GitHub sync (two-way, personal access token)

A branch in a GitHub repository is a second replica of the store, kept in
step with OPFS in both directions. `github.ts` (REST client), `sync.ts` (the
algorithm), `syncConfig.ts` (localStorage), `useGitHubSync.ts` (when it runs)
and `SyncPanel.tsx` (the strip at the foot of the sidebar).

- **It's the same three-way model as `merge.ts`**, with the other tab replaced
  by a branch: `base` is a path → blob-sha snapshot of what was last in sync,
  `local` is OPFS now, `remote` is the branch now. `planSync` is pure and is
  where every decision lives; read it before changing anything here. Two-way
  sync without a base can only guess which side changed.
- **Nothing is compared by content.** Git's blob sha *is* a content hash, a
  recursive tree listing hands one over for every remote file, and
  `gitBlobSha` computes the same hash locally (sha1 of `blob <len>\0` + the
  UTF-8 bytes, verified against `git hash-object` in `sync.test.ts`). A sync
  with nothing to do costs one tree listing and downloads no file contents.
- **Deletion never beats an edit.** A file deleted on one side but edited on
  the other comes back. An unwanted file is one keystroke to remove; lost
  writing is gone for good.
- **Two files that share only a path are both kept**, the remote one landing
  next to the local one as `notes (github).md`. There's no honest merge
  without a shared base, and silently preferring a side would drop writing
  that exists nowhere else. The three-way merge (via `mergeText`) is only used
  when a base *is* known — and it fetches the base blob back from the repo,
  which is reachable precisely because the last sync pushed it.
- **An empty store with a non-empty base means lost data, not deletion.**
  Safari evicts unused site storage, and OPFS can go without localStorage
  going with it; taken literally that reads as "delete everything on GitHub".
  The base is dropped instead and the device refills from the repository.
  `syncOnce` still refuses outright to push an empty tree, as a backstop.
- **A push sends the complete tree**, so deletions are just absences and no
  separate bookkeeping tracks them. Entries webfs can't represent (symlinks,
  submodules) are carried through verbatim — without that, the push would
  delete them. Blobs already present remotely are referenced by sha, so only
  genuinely new text is uploaded.
- **Bytes are the medium; text is a view.** `LocalFs` and the push/pull path
  deal in `Bytes` (`Uint8Array<ArrayBuffer>`, named in `storage.ts` because
  the DOM rejects the default `ArrayBufferLike`), and `decodeText` is applied
  only where text is actually required — the three-way merge, and the content
  the editor shows. Decoding anywhere else would turn an image into U+FFFD
  soup and push the damage. Two consequences: a binary file changed on both
  sides takes the keep-both route rather than being merged (two versions of a
  photo have no middle ground), and `SyncResult.written` carries
  `content: null` for a file that isn't text.
- **The git-object endpoints, not `/contents`.** Sync needs the whole tree in
  one request to diff it, and needs a set of changes to land as one commit;
  `/contents` is a request per file and a commit per file.
- **The ref update is never forced.** The commit parents on the head that was
  read, so a non-fast-forward means another writer moved the branch; the hook
  retries the whole pass once, which re-reads everything.
- **A branch that doesn't exist is forked from the default branch**, so
  pointing webfs at a new branch of an existing repo starts from that repo's
  files rather than orphaning them.
- **An empty repository can't be written to with the git-object endpoints at
  all**, so `commit()` starts one through the Contents API
  (`PUT /contents/{path}`) and parents the real push on what that returns.
  Blobs, trees and commits all 409 while a repo has no history, and GitHub
  refuses the last step outright — "You are unable to create new references
  for empty repositories, even if the commit SHA-1 hash used exists." There
  is no arrangement of the git-object calls that works; the Contents API is
  the only endpoint that does, and one call to it creates the first branch
  and commit. It writes a file the push was sending anyway, so the full tree
  that follows simply supersedes it — at the cost of two commits on a first
  sync, unless there is only one file, which is handled by returning early.
- **"No head" arrives as either a 404 or a 409, and the difference isn't the
  branch.** A missing branch in a repository that has commits is a 404; a
  repository with *no commits at all* answers 409 on its git endpoints, since
  there's no history to talk about. Every brand-new empty repo is in that
  state, so reading only the 404 as absent made the most ordinary setup there
  is — create a repo, point webfs at it — fail outright with nothing synced.
  Worth knowing that `github.test.ts` faked that case as a 404 and passed
  while the real path was broken; it now uses the status GitHub actually
  sends. The empty-repo fakes — in that file and in the browser run — refuse
  everything the real API refuses, which is the only reason the second half
  of this bug (the write path) was caught rather than shipped again.
- **Every API call sets `cache: "no-store"`.** GitHub sends
  `cache-control: private, max-age=60` on reads, so the browser will happily
  answer a branch-head GET with a sha up to a minute old — and a stale head
  is the one thing this client can't have, because the push parents its
  commit on whatever that read returned. An out-of-date parent makes the ref
  update a non-fast-forward, which comes back as 422 "Update is not a fast
  forward", and the retry can't clear it while the cache keeps serving the
  same stale answer.
- **GitHub's own message is always appended to a failure.** The canned
  summaries are ours and they get stale; `message` is GitHub's and it is the
  only thing that identifies an unexpected failure. The 409 above reached a
  bug report as "odd state (409)" while GitHub had been saying "Git
  Repository is empty." the whole time.
- **The token lives in localStorage, not OPFS** — OPFS is what gets pushed, so
  a token stored there would be committed to the repository it grants access
  to. That still leaves a token readable by any script on this origin, and
  there's no way around it for a backend-less app: no server, so no session
  cookie to hide behind and no OAuth secret that could stay secret. The
  settings dialog says so.
- **The repo name in the strip is a link to the branch on GitHub**
  (`branchUrl`), pointing at `/tree/<branch>` rather than the repo root so it
  lands on what's actually being synced. Settings moved to their own `⚙`
  button when the name became a link — the name now leads where it says.
- **The dialog links to a pre-filled token page** (`tokenSetupUrl` in
  `SyncPanel.tsx`). GitHub's fine-grained token form takes a template URL, so
  `contents=write` (which implies read; GitHub adds `metadata:read` itself),
  `target_name`, `name` and `expires_in` are all filled in from what the
  dialog already knows. Two things to keep in mind before editing it: there
  is *no* parameter for the repository — only `target_name`, its owner — so
  the dialog says to pick that on the page rather than implying the link does
  everything; and the expiry is set explicitly because the page's own default
  is 30 days, which would quietly stop sync working in a month. These are
  GitHub's parameter names, not ours, so a renamed one fails silently (an
  empty form, no error) — `syncPanel.test.ts` pins them. See
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- **Seeding is skipped when sync is configured** (`loadTree({ seed })`). A
  synced device's store is empty because it hasn't pulled yet, and seeding
  would push three starter notes into someone's established notes repo.
- **A sync is serialized across tabs** with a Web Lock (`ifAvailable`, so a
  second tab skips rather than queues), flushes pending editor writes first
  for the same reason `mutate()` does, and applies what it changed through
  `applySyncResult` in `App.tsx` — which bumps `externalEdit` for the open
  file and announces on the BroadcastChannel, since other tabs have no other
  way to hear about a write made outside their own edit loop.
- **The commit title is built in `syncOnce`, not passed to it** (`commitTitle`):
  only that function knows which paths the push actually changes, which is
  what the title names — `2026-09-21 14:32 Notes/todo.md`, with a trailing
  `…` when more than one changed. The time is local, because the commit
  already carries an authoritative timestamp and this one exists to be
  recognised; the path is full, because two `todo.md`s in different folders
  are ordinary here. Deletions count as changes worth naming. Names are
  sorted, so the same set of changes always titles the same way.
- **Timing:** on load, 4s after edits settle, every 60s, on tab-visible and on
  `online`, plus the button. Auto-sync is a checkbox; the button always works.
- **Keystrokes that land mid-sync are merged, not dropped.** A sync reads OPFS
  at the start and writes it back seconds later; anything typed in between is
  in memory but not in what it merged, and letting the queued write flush on
  top would put the remote change back where it came from. `applySyncResult`
  runs the same `mergeText` the cross-tab path does and re-queues the result.
  For the same class of reason, `opfsLocalFs.write` retries and then *throws*
  on `"busy"` rather than ignoring it: a base recording text that never
  reached disk would push the old version on the next pass.
- **Two things git can't represent, and webfs doesn't work around.** An empty
  folder has no place in a tree, so it exists on this device only and won't
  appear on another. And a path that is a file on one side and a folder on the
  other can't be a single tree entry: GitHub rejects the push with a 422, which
  surfaces in the status strip. Both are rare enough to leave alone; renaming
  one side fixes the second.
- `bun test` covers the algorithm against an in-memory branch and store
  (`sync.test.ts`), the REST wiring against a stubbed `fetch`
  (`github.test.ts`), and the dialog's two pure pieces — repository parsing
  and the token link — in `syncPanel.test.ts`. What none of them covers is
  those pieces touching real OPFS and a real editor: that's `bun run browser`
  (see Browser suites below), which drives Chromium against an intercepted
  `api.github.com`.

## Images pasted into a note

`assets.ts` (path arithmetic), `Editor.tsx` (the Crepe hooks).

- **Crepe's default loses the image.** Left alone it keeps the pasted `File`
  in memory behind a `blob:` URL and writes that into the markdown. That URL
  dies with the document — verified: after a reload the `<img>` still *looks*
  loaded, which is Chromium's in-memory image cache, but `fetch()` on the URL
  fails, and in a new tab it fails too. The note ends up linking to nothing,
  and GitHub never had a chance of seeing it.
- **So a pasted image becomes a real file**, written to `<note's folder>/assets/`
  by `onUpload`/`blockOnUpload`/`inlineOnUpload`, with the markdown holding a
  *relative* link (`assets/screen%20shot.png`). That is deliberately the same
  string GitHub resolves when it renders the note, which is what makes one
  link work in both places. The name is percent-encoded, because a space
  would otherwise end the URL as far as markdown is concerned.
- **`proxyDomURL` is what makes it visible here.** The browser can't fetch
  OPFS, so the stored relative path is resolved against the note's folder,
  read as bytes, and handed to the DOM as an object URL — revoked when the
  editor unmounts. Absolute URLs (`http:`, `data:`, `blob:`, `/…`) are passed
  through untouched, so pasted *links* keep working exactly as before.
- **`data:` URIs were never an option.** GitHub's markdown sanitizer strips
  them, so inlining base64 would look right here and stay broken there — and
  it would bloat every note containing a photo.
- **A file that isn't text is shown, not opened.** `FSNode.binary` has to be
  checked by the read effect in `App.tsx` *and* carried through
  `adoptContent`, not just set: a binary file never gets `content`, so an
  effect guarded on content alone re-reads it on every `fs` change — and
  marking it binary is itself an `fs` change. That chased its own tail at
  ~150 OPFS reads a second for as long as an image was selected. Crepe would render the
  bytes as text and write that reading back on the first keystroke, so an
  image opened from the sidebar would be destroyed by looking at it.
  `FSNode.binary` is set when a read fails to decode, and `Editor` renders a
  preview instead. This is why `App.tsx` reads the selected file with
  `readBytes` + `decodeText` rather than `readFile`.
- **`resolveAssetPath` refuses to leave the store**, so a link with enough
  `..` in it resolves to null rather than to something outside. It also
  requires the link to name something: without that, an empty link resolved
  to the note's own folder, which is a directory. `assets.test.ts` covers
  both, which is how the second one was found.

## Obsidian embeds (`![[image.png]]`)

`wikilinks.ts` (the syntax, pure), the node registered in `Editor.tsx`, and
`assetCandidates` in `assets.ts`. Driven by `bun run browser wikilinks`.

A vault written in Obsidian links its images with `![[Pasted image
20260905101712.png|541]]`, which is not markdown — and that is the whole
problem.

- **Without this, opening such a note destroys it.** CommonMark has no such
  construct, so remark parses the embed as literal text and remark-stringify
  escapes it on the way back out: `!\[\[Pasted image…]]`, which Obsidian no
  longer renders. Crepe writes the document back on the first keystroke, so a
  single character typed in a note was enough to break every image in it — and
  sync would push the damage. Recognising the syntax is what stops that; the
  rendering is almost a side effect.
- **`raw` is the text between the brackets, verbatim**, and serializing puts
  it back unchanged. Nothing normalises `x.png | center | 623` into
  `x.png|center|623`: the target and the display options are re-derived from
  `raw` every time they're needed. A note that came back subtly different from
  how it went in would turn merely *opening* a file into a sync change, across
  a whole vault at once.
- **It takes a remark plugin *and* a node schema**, because remark owns both
  ends. The plugin cuts embeds out of the text nodes remark produced *and*
  pushes a `toMarkdownExtensions` handler — without the handler,
  remark-stringify refuses to serialize a node type it has never heard of.
  `$remark` and `$node` come from `@milkdown/kit/utils`; Crepe's own Latex
  feature is the worked example to copy if this needs extending.
- **Only images are claimed.** Obsidian embeds notes and PDFs with the same
  syntax; turning one into an `<img>` would show a broken image where a legible
  name used to be. Those (and bare `[[links]]`, which webfs doesn't handle at
  all) are still escaped on save — the corruption above, unfixed for everything
  that isn't an image. Worth knowing before pointing webfs at a vault that
  uses them.
- **`toDOM` is synchronous and the bytes aren't**, so the node renders a span
  with an empty `<img>` and fills in `src` when the read lands. A link that
  resolves to nothing shows its own source (`![[missing.png]]`) rather than
  leaving a gap, so it's clear *which* embed is broken.
- **Object URLs are cached per link within an editor** (`loading` in
  `Editor.tsx`). ProseMirror re-runs `toDOM` when a node is re-created, and a
  note here can hold seven embeds; without the cache each render minted new
  URLs for pictures already on screen and they accumulated until unmount.

### The `Media/` fallback

`assetCandidates` returns the paths to try, best interpretation first: where
the link actually points, then `Media/<name>`.

- **A vault keeps every attachment in one folder at the root** and refers to it
  by bare filename from any depth, so `![[Pasted image…png]]` in
  `Physiologie/Sa 05.09.2026.md` means `Media/Pasted image…png`. webfs resolves
  links the way GitHub does — relative to the note — which makes that a file
  beside the note that isn't there.
- **It is a fallback, never a preference.** The direct path is always read
  first, so webfs's own `assets/` links (which GitHub also resolves) keep
  working unchanged; `Media/` is only reached once the honest interpretation
  has found nothing. That also means it costs one extra miss on a link that
  was broken anyway.
- **The name is hardcoded rather than configured.** It's Obsidian's default
  and the only value this has ever needed; a setting would be a second thing
  to keep in step with the attachment folder in `.obsidian/app.json`, which
  webfs doesn't read.

## Browser suites (`bun run browser`)

`browser/` drives the real app in Chromium, because the half of webfs that
matters most can't run headless: OPFS, a live Milkdown editor, a service
worker, and sync reconciling between all three. `bun test` has never covered
any of that, and every bug that reached a user came from exactly there — an
empty repo's 409, a stale service-worker shell, a runaway read loop.

- **Running them:** `bun run browser`, or `bun run browser sync` for one
  (`sync`, `empty-repo`, `images`, `panes`, `wikilinks`). The dev server is started by the
  runner, so nothing needs to be up first. Chromium comes from
  `bunx playwright install chromium`, or point `WEBFS_CHROMIUM` at a binary
  that already exists. Not in CI — they take about a minute and want a real
  browser — so run them by hand after touching sync, storage or the editor.
- **`FakeGitHub` refuses what the real API refuses**, which is the point of
  it rather than a detail: git-object endpoints 409 while a repo has no
  commits, and ref creation is rejected outright. An earlier fake answered
  404 where GitHub answers 409, and a broken empty-repo path passed its own
  test twice because of it. If you extend the fake, copy GitHub's failures as
  carefully as its successes.
- **A long press is driven through CDP touch events**, not a synthesised
  `contextmenu`: what's being tested is the browser's own handling of a finger
  held still, including the click it sends afterwards. `page.dispatchEvent`
  can't express that, and a suite that fakes it would pass over a broken one.
- **Poll outcomes, never the status line.** It shows what the *last* sync
  did, so asserting on it right after clicking Sync reads the previous run
  and passes for the wrong reason — which it did, hiding a real failure.
  `waitUntil` and `syncAndSettle` exist for this.
- **Wait for the thing you mean.** A pasted image writes its file
  immediately but its link goes through the editor's save debounce, so
  waiting on the asset alone catches the note mid-write.
- **`opfsFiles` skips entries that vanish under it.** The app writes while
  the walker reads; a half-created file is not an answer worth returning.
- Browsers make things *look* fine that aren't: a `blob:` image still renders
  after a reload from the in-memory image cache while the URL itself is dead.
  Assert on the thing (`fetch` the URL, compare bytes), not on the pixels.

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
  Caching each asset lazily on first fetch — the obvious cheaper option —
  cannot cover a first visit: the page's own chunk requests happen before the
  worker has claimed the client, so nothing intercepts them, and the app would
  need a *second* online load before it survived going offline.
- Navigations are network-first (so an online load always gets the current
  deploy) **and fetch with `cache: "no-cache"`**, without which they aren't
  really network-first at all: Pages serves `index.html` with `max-age=600`,
  and this fetch is the *worker's*, which a hard reload in the page does not
  bypass. That combination stranded someone on the previous build with no way
  to shift it — ctrl-shift-R included. `sw.test.ts` records the cache mode of
  every fetch the worker makes, and the test file reads `CACHE_NAME` out of
  `sw.js` rather than hardcoding it, so a deliberate bump doesn't take four
  unrelated tests down with it. Navigations are cached under the shell URL,
  never the requested URL: every
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
