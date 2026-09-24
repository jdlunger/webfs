# webfs

A single-page file explorer + markdown editor. Everything is client-side —
the "filesystem" (`src/fs.ts`) is a flat `Record<id, FSNode>` persisted to
OPFS (see Storage below), there is no backend API. `src/index.ts`
(`Bun.serve()`) just serves `src/index.html` for local dev/preview;
production is a static export (see Deployment below), not this server.

Key files: `App.tsx` (top-level state + URL routing + cross-tab
reconciliation), `Sidebar.tsx` (file tree, rename/move UI, search and sort),
`Editor.tsx` (Milkdown integration), `drives.ts` (what a drive is, and where its files
live), `storage.ts` (thin OPFS layer, rooted at a drive's mount), `tree.ts`
(projects a drive's folder into the in-memory record), `fs.ts` (pure queries
over that record), `panes.ts` (which files are open, in which pane),
`workspace.ts` (that layout remembered per drive in localStorage),
`createdAt.ts` (when each file first appeared here, in IndexedDB),
`tasks.ts` (what a checkbox is and what order they go in), `fences.ts` (the
triple-backtick commands), `merge.ts` (three-way line merge). Tests are `*.test.ts` at the root
(`bun test`) plus `browser/` for what only a real browser can exercise
(`bun run browser`).

## Git workflow

Single-maintainer hobby project, no PR review process. Commit and push
directly to `main` for every change — don't create feature branches, and
don't open pull requests. `main` is also the GitHub Pages deploy trigger
(see Deployment below), so a push there goes live immediately; that's the
intended workflow here, not an oversight — the point is to be able to pull
up the GitHub Pages URL right after a change and see it live, without a PR
merge step in between.

**Several agents work on this repo at once, so `main` moves underneath you.**
Before pushing, `git fetch origin main` and look at where it is. If it has
moved, rebase your work onto it and run the checks again before pushing.

- **Never force-push.** A rejected push means someone else's commits are on
  `main`; forcing over them throws that work away. The rejection is the safety
  net doing its job, not an obstacle — `main` here is shared, and rewriting its
  history is not the "follow the repo's convention" that applies to a branch
  you made yourself.
- **Re-run the checks after rebasing, rather than trusting the run from
  before.** What landed while you were working can touch the same surface: the
  plain-text view added a button to the tab strip in the middle of a fix to the
  `panes` suite, and that fix's assertions read the tab strip. Rebasing is
  clean when the diffs don't overlap and still changes what your tests see.
- Worth a `git fetch` before starting something long, too, not only before
  pushing — it's cheaper to begin from the current `main` than to reconcile
  with it an hour later.

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

## The plain-text view

The toggle at the top right of a pane (`ViewToggle` in `Editor.tsx`, rendered
by `TabStrip.tsx`, and by the mobile topbar in `App.tsx` where there is no tab
strip) swaps Crepe for a textarea holding the file's markdown.

- **The mode belongs to the file, not the pane or the app** (`textViews` in
  `App.tsx`, keyed by id). The toggle then acts on the document you can
  actually see, a split can hold one file rendered and another as source, and
  closing a pane doesn't shuffle anyone's view. Being keyed by id, it has to
  follow a rename the way tabs do — `remapTabs` remaps it, the tabs and the
  collapsed folders together, through `remapId` in `fs.ts`, which `panes.ts`
  uses for the same rule.
- **The textarea is controlled, where Crepe is uncontrolled.** So an edit
  merged in from another tab or a sync simply lands in it, and `externalEdit`
  has nothing to remount — that counter is for Crepe alone.
- **Switching views is a swap of one editor for the other**, which is safe for
  the same reason bumping `externalEdit` is: content has already flowed into
  `fs` (both `markdownUpdated` and the textarea's `onChange` update it
  synchronously), so whichever editor comes up starts from the current text.
  There is no third copy of the document anywhere.
- **It shows what a save would write, not the bytes the file arrived with.**
  Once a document has been through Crepe, what's on disk is Crepe's
  re-serialisation of it — so the source view is where that normalisation
  becomes visible, rather than where it happens.
- A binary file has no toggle: `viewOf` returns null for it, and the button
  isn't rendered.
- `bun run browser view` drives the round trip (source → Crepe → source) in a
  real browser, which is the only place a lost paragraph would show up.

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

## What a reload comes back to (`workspace.ts`)

Which files are open in which pane, which folders are collapsed, which files
are shown as source, and the order the tree is listed in are remembered in
localStorage
(`webfs:workspace:<drive id>`) and restored on load. `workspace.ts` is the
store and its validation; `App.tsx` holds the state and decides what to do
with what comes back.

- **One entry per drive.** Every id in here is a path *within* a drive, and
  two drives can both hold `Notes/todo.md` — a shared entry would restore
  tabs onto whatever happened to sit at those paths. Switching drives is
  therefore a save of the one being left (already written, since the entry is
  written as it changes) and a restore of the one arrived at, with the gate
  below closed in between so the cleared state can't be written over either.
- **localStorage, not OPFS**, for the reason `driveConfig.ts` is there: OPFS is
  the tree that gets pushed to GitHub, and none of this belongs in someone's
  notes repository. It is also per-device *on purpose* — which files you had
  open on a phone is not a fact about the notes, and syncing it would have two
  devices fighting over one answer.
- **Collapsed folders are stored, not expanded ones.** A tree opens expanded,
  so an empty list has to mean "as it has always looked", and a folder that
  arrives later — created here, or pulled by a sync — has to appear open
  rather than hidden inside an entry written before it existed.
- **A drive opened for the first time folds its tree away** (`initialCollapsed`
  in `workspace.ts`): every folder closed but the ones the opened file sits
  inside, written as that drive's starting `collapsed` list and then edited
  like any other. Adding a GitHub drive is how someone else's vault arrives
  here, and expanded it is a wall of folder names with no "collapse all" to
  answer it. Four things this has to get right, all of them in `App.tsx`:
  - **Not the drive webfs seeded.** `shouldSeed` is read *before* the load,
    which marks it; a tree of three starter notes this app just wrote is not
    someone's vault, and folding away its own welcome would be silly.
  - **It waits for a tree with something in it.** A GitHub drive's store is
    empty when it loads — the repository hasn't been pulled yet — so the fold
    is pending state (`foldPending`) that applies when the files land, a render
    after the tree refresh.
  - **Nothing is saved while it's pending**, or a reload in that window would
    read back a drive that has already made its choices and the folders would
    open wide after all. A drive switch clears the flag too, so a fold waiting
    on the drive being left can't land on the one arrived at.
  - **A folder made by hand cancels it** (`mutate`): whatever is being pulled
    in can still fold itself away, but a folder someone just created is one
    they want open.
- **Expansion moved out of `TreeNode` into `App.tsx`.** A row's `useState`
  couldn't be it: rows are rebuilt on every tree refresh, and there has to be
  one place that persists the set, follows a rename through `remapId`, and can
  be read back. `Sidebar` takes `collapsed` and `onToggleFolder` now.
- **Everything restored is validated, because nothing else here is.** What
  comes back out of localStorage is the one input to the app that nobody typed
  and nothing this run produced — a build old, hand-edited, half-written — and
  it feeds straight into `panes.ts`, whose invariants the rest of the app
  leans on. `parseWorkspace` enforces them on the way in: at most `MAX_PANES`
  panes, no file open in two of them (the one that would put two Crepe
  instances over one document), an `activeId` that is really one of that
  pane's tabs, a `focused` that names a pane that exists. An entry it can't
  make sense of is dropped whole rather than half-read, and so is one whose
  `version` this build doesn't know. The two advisory lists — collapsed
  folders and source views — are dropped on their own instead, since a bad one
  costs an expanded folder, not a working app. `workspace.test.ts` covers it;
  `bun run browser panes` covers the round trip through a real reload.
- **The URL still wins over the remembered layout.** They normally agree — the
  URL is written from the focused pane on every change — so `initialLayout`
  only has something to reconcile when the URL came from somewhere else: a
  deep link, a bookmark, a link someone sent. That file is what the visitor
  asked for, so it's opened into the restored panes (or focused where it
  already is).
- **Restored tabs are pruned against the tree that actually loaded**, the same
  way a tab is dropped when its file vanishes while the app is open. Worth
  knowing: on a device whose OPFS was evicted but whose localStorage survived,
  that prunes everything before the first pull, and the pruned layout is what
  gets saved back. The alternative is holding tabs for files that may never
  return, and the cost here is a few clicks.
- **A remembered workspace is restored as it stands, empty or not** — closing
  every tab is something someone did on purpose. Only a *first* visit, with
  nothing stored, falls back to opening the first file in the tree.
- **It's written as it changes, not on the way out.** `pagehide` isn't
  reliably delivered on iOS, and this is a few hundred bytes of JSON. The
  effect deliberately doesn't depend on `fs` — that changes on every keystroke
  — and reads it through a ref instead, so a stale id can survive until the
  next change sweeps it up. Writing is also gated on the restore having
  happened, or the component's empty initial state — or the cleared state a
  drive switch leaves behind — would erase the entry it is about to read.
- **Two tabs share one entry, and the last one to change something wins.**
  There is nothing to merge: a layout is what one window is showing. A per-tab
  store (sessionStorage) would forget everything the moment the browser
  closed, which is the case this exists for.

## The sidebar's width

`sidebarWidth.ts` (the number and where it's kept), `SidebarResizer` in
`Sidebar.tsx` (the drag), `.sidebar-resizer` in `index.css`. Covered by
`sidebarWidth.test.ts` and the tail of `bun run browser panes`.

- **The width lives in localStorage, not OPFS.** OPFS is the document store
  and it's what sync pushes to GitHub; how wide a pane is on this screen is
  not a document, and it's per-device by nature — the same notes on a laptop
  and on a large monitor want different widths.
- **It has its own key rather than a place in `workspace.ts`.** Everything in
  a workspace entry is a path *within* one drive, which is why there is an
  entry per drive; a width is about this screen and means the same whichever
  drive is mounted, so storing it per drive would have it change when the
  drive does.
- **It's a custom property, not an inline `width`.** Below 768px the sidebar
  is a fixed-width drawer sized by CSS, and an inline width would win over
  that media block; `--sidebar-width` is simply not read there. The handle
  isn't rendered at all on a narrow screen — a drag target down the drawer's
  edge would fight the tree's own scrolling.
- **The window is a second ceiling** (`MIN_CONTENT_WIDTH`), applied on load
  and on every `resize`: a width chosen on a wide monitor would otherwise
  leave no editor when the same store is opened on a laptop. Only a
  deliberate drag is written back, though, so shrinking the window doesn't
  overwrite the width the user picked — widen it again and a reload restores
  it.
- **The drag uses pointer capture**, so a fast drag that outruns the cursor
  still reports to the handle and a pointer lost to the OS ends the drag by
  itself. `body.resizing-sidebar` suppresses selection for the duration,
  because the pointer spends the drag out over a contenteditable.
- **The handle takes focus and answers the arrow keys.** The point of
  persisting a width is that someone cares about it, and this is the one
  control here a keyboard otherwise couldn't reach. Double-click resets it.

## Searching and sorting the tree

The two buttons at the top of the sidebar. `searchTree` and `childrenOf` in
`fs.ts` (pure, `tree.test.ts`), the header and filtering in `Sidebar.tsx`,
`lastModified` from `storage.ts`, and `bun run browser sidebar` end to end.

- **Both are queries over the tree, so both live in `fs.ts`.** Nothing is
  indexed and nothing is cached: the record is already in memory and a notes
  tree is small, so a filter is one pass over it and an order is a `sort`.
- **A search matches names, not paths.** Matching the id would mean a query
  spelt like a folder silently returned everything beneath it — and worse,
  could span a `/`. A folder whose *name* matches does bring its whole subtree,
  because that is what searching for a folder by name is asking.
- **A search outranks a collapsed folder.** Filtering draws the tree expanded
  whatever `collapsed` says, since a fold hiding a match would defeat the
  thing; `collapsed` is left untouched, so clearing the query gives back the
  tree exactly as it was folded. While a search is up, a folder row's chevron
  is a label rather than a control — the search decides what's shown, and a
  click that visibly did nothing is worse than one that isn't offered.
- **The search isn't remembered across reloads, and the order is.** An order
  is how you like to read this drive; a filter is something you do for a
  moment, and coming back to a tree with most of it missing and no memory of
  why is its own bug report.
- **Folders always sort first and always by name.** OPFS gives a directory no
  timestamp and nothing records a creation date for one, so there is nothing
  to order them by under either date, and
  folders that shuffle about as their contents are edited are harder to
  navigate than ones that stay put. The chosen order applies to files.
- **Both dates sort both ways, and an unknown date sorts last in *both*.**
  That is the one rule in `byTime` worth reading twice: standing a missing
  date in as ±Infinity works for one direction and puts every dateless file at
  the top of the other. "Unknown" is not the oldest thing here any more than
  it is the newest, and files with no creation date are the common case on a
  store that predates one being recorded — so an order that buries them is
  right and an order that leads with them is unusable.
- **`modified` is the odd id out**, meaning newest-first while its partner is
  `modified-asc`. It predates there being a pair, and renaming it to
  `modified-desc` would quietly reset the order of everyone who had chosen it,
  since a stored value this build doesn't know falls back to the default.
- **`lastModified` costs a `getFile()` per file on every walk.** That is the
  price of being able to sort by date at all — nothing else here records one,
  and a timestamp kept on the side would be a second index to hold in step
  with the directory that is meant to be the only one. Cheap at notes scale,
  and worth knowing before the walk grows anything else per entry.
- **A save stamps the node itself** (`touchFile`, called from `flushWrite`).
  The tree is only re-walked on *structural* changes, so without that the
  order reads whatever the last walk saw, and the file you are editing right
  now sits at the bottom of its folder until something unrelated happens. The
  browser suite caught exactly that. The value is when the write landed rather
  than what OPFS recorded — a millisecond apart, and the next walk replaces it.
- **The order is advisory in the stored workspace**, like the collapsed and
  source-view lists: an order this build doesn't recognise falls back to the
  default instead of dropping the entry. That is what lets another order be
  added later without bumping `VERSION` and throwing away everyone's tabs.
- **The mobile drawer drops the "Files" title**, because four tap-sized
  buttons and a title don't fit across it — what wrapped was `+ File` and
  `+ Folder`, folded in half. A drawer full of file names doesn't need to be
  labelled.

### Creation dates (`createdAt.ts`)

OPFS has no creation time — a `File` carries `lastModified` and nothing else,
and a `FileSystemFileHandle` has no metadata API at all. Checked in a real
browser, not assumed. So the "Created" orders read a record webfs keeps
itself, in IndexedDB, keyed by drive and path.

- **It is "first seen here", not "created".** A note written on a laptop and
  pulled onto a phone is dated when it reached the phone, and a store that was
  already full when this shipped has no dates at all. Filling those in from
  `lastModified` is the obvious move and is exactly what makes "Created" a
  second, slightly wrong copy of "Modified" — unknown sorts last instead.
- **Arrivals are noticed by watching the tree** (`noticeArrivals` in
  `App.tsx`), not by hooking the places files are made. A file can appear
  because it was created here, pasted as an image, pulled by a sync or written
  by another tab; one diff against the previous tree covers all four, where
  hooking call sites covers the ones someone remembered. The *first* tree a
  drive produces is the baseline rather than a pile of arrivals — which is
  what makes a pre-existing vault undated, and what makes a GitHub drive's
  files dated, since that one loads empty and fills from the pull.
- **A rename has to be carried across before the refresh sees it**
  (`remapCreated`, awaited inside `mutate`). Otherwise the old path vanishing
  and the new one appearing reads as a deletion and an arrival, and the date
  restarts at today. `remapCreatedAt` is the same rule applied to the map in
  memory, so the order doesn't wait for a round trip; both go through
  `remapId`, like the tabs and the collapsed folders.
- **IndexedDB rather than localStorage**, because this grows with the number
  of files rather than being a handful of settings, and because it's written
  from a tree refresh where a synchronous JSON round trip of the whole thing
  would be felt. Still per-device, for the reason everything else outside OPFS
  is: OPFS is what sync pushes to GitHub, and a sidecar of timestamps has no
  business in someone's notes repository.
- **Writing is add-if-absent, and nothing ever deletes.** Two cases depend on
  the first: another tab that noticed the same new file a moment earlier has
  already recorded it, and a device whose OPFS was evicted re-pulls its whole
  store — where overwriting would replace every real date with the moment of
  the refill. `stampCreated` reads the existing date back rather than
  reporting nothing, so both tabs agree without a reload. The tempting cleanup
  — dropping dates for files that have left the tree — is the same eviction
  case wearing a different hat, and it would take every real date with it
  permanently. The cost of not doing it is a path deleted and later reused
  inheriting the old date, and a row per file ever seen.
- **A blocked IndexedDB costs the dates and nothing else.** Every call resolves
  to an empty result rather than rejecting, so a private window loses the
  "Created" orders and keeps the app. That's the opposite of what
  `opfsAvailable` does, because the store failing has nothing to fall back to
  and this does.
- Covered by `tree.test.ts` for the ordering (both directions, unknown last,
  and the rename remap) and by `bun run browser sidebar` and `sync` for the
  half that needs a real IndexedDB: a seeded file has no date, a file made
  here gets one, a rename carries it, and a file pulled from GitHub is dated
  when it arrived. `createdIndex` in the harness reads the rows straight out
  of the database rather than inferring them from the order on screen, since
  two undated files fall back to name — which is also what the default order
  gives, so the order alone can pass for the wrong reason.

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

## Drives

`drives.ts` (pure: what a drive is and where it lives), `driveConfig.ts` (the
registry, in localStorage), `DrivePanel.tsx` (the switcher at the foot of the
sidebar), and the drive state at the top of `App.tsx`. Driven end to end by
`bun run browser drives`.

A **drive** is a source-of-truth folder. There are two kinds — a plain folder
in OPFS, and a branch in a GitHub repository — and the difference between them
is smaller than it looks: a GitHub drive's files are in OPFS too, because sync
reconciles *into* the local store and reads back out of it. So a drive is a
mount point, plus a remote for the kind that has one.

- **Three things are the same string, on purpose.** A drive's id
  (`opfs/notes`, `jdlunger/webfs`), its URL (`/opfs/notes/Notes/todo.md`) and
  its mount (`drives/opfs/notes/`). An id is always exactly *two* segments,
  which is what lets a URL be split without consulting the registry: take two,
  the rest is the file path. That matters because the drive has to be resolved
  before a path inside it means anything — the tree it names hasn't been read
  yet.
- **Node ids stay relative to their drive.** The mount is applied at the
  `storage.ts` boundary and nowhere else, so `fs.ts`, `panes.ts`, `assets.ts`,
  the `Media/` fallback and the paths sync sends to GitHub all carry on meaning
  what they always meant. That is the whole reason this change didn't touch
  them. `storeAt(mount)` returns the old module-level API bound to a folder;
  `rootStore` is the whole of OPFS and is used only for drive bookkeeping.
- **`opfs` is a reserved GitHub owner.** A repository owned by someone called
  `opfs` would make `/opfs/notes` ambiguous between a local drive and that
  owner's `notes` repo, and no spelling of the URL resolves it without a
  lookup. `validateDrive` refuses it.
- **The branch is not part of a drive's identity.** A repository is one drive,
  whichever branch it points at; re-pointing it is an edit, not a second drive.
  Two branches as two drives would need a third URL segment, and a branch name
  can itself contain a slash. The sync base is still keyed by branch, so
  switching branch starts from no base and switching back finds the old one.
- **Everything lives under `drives/`**, never at the OPFS root. That's what
  keeps a local drive called `Notes` from colliding with a leftover `Notes`
  folder from the layout that predates drives — which is also why upgrading
  needs no migration: what was at the root simply stops being addressable, and
  the add-drive dialog offers to delete it once you've seen your files come
  back. A device that was syncing keeps its repository, branch and token (the
  old `webfs:github:config` is read once and becomes a GitHub drive) but drops
  its sync base, so the first pass re-pulls the whole repository into the new
  mount.
- **Only the active drive syncs.** A drive you aren't looking at has nothing on
  screen to be stale against, and polling every configured repository on the
  same 60s timer would multiply a rate-limited handful of calls by however many
  drives someone has collected. Arriving at a drive syncs it, which is the same
  rule the app has always applied on load.
- **Switching drives is the same work as starting the app**, and `App.tsx`
  treats it that way: queued writes are flushed *before* the switch (a write is
  keyed by a path, and the same path is a different file in the next drive),
  then `pending`, `baseContent`, `externalEdits`, `textViews` and `collapsed`
  are all cleared and the tree is re-read. What was open comes back from that
  drive's own workspace entry (see below), so switching away and back — or
  reloading — lands on the same tabs.
- **The drive is in the pane's React key**, for the same reason. Without it,
  React keeps the editor instance across a switch and hands it the new drive's
  store for the old drive's document — and a pasted image goes into the wrong
  folder.
- **Every BroadcastChannel message names its drive**, and a tab ignores the
  ones about a drive it isn't showing. `{ kind: "drives" }` is the registry
  itself changing, which is the one message that isn't about a drive's
  contents.
- **A first visit creates one local drive** (`DEFAULT_DRIVE`, `opfs/notes`) and
  seeds it, so arriving at the app still lands in something to write in. A
  drive *you* add starts empty: `markSeeded` is called the moment it's created,
  which is what stops three starter notes appearing in every folder anyone ever
  adds. An empty registry that exists is respected — the empty state is for
  someone who removed every drive, not for someone who has just arrived.
- **Removing a drive forgets it; it doesn't delete the folder.** "Remove" that
  meant "delete everything, with no undo" is not a button to put next to a
  drive's name.
- **There is no way to copy files between drives**, so a GitHub drive can only
  be filled by pulling or by writing in it. Connecting a repository no longer
  publishes what was already on the device — before drives, a first sync pushed
  the local store, and now a GitHub drive starts empty. Worth knowing before
  someone expects "point webfs at a new repo" to upload their notes.

## Sharing a drive (`shareLink.ts`)

`shareLink.ts` (pure, `shareLink.test.ts`), `ShareDialog.tsx` (the QR code and
the link), `AcceptDrive.tsx` (what the other device sees), and the capture at
the top of `App.tsx`. Driven end to end by `bun run browser share`.

A GitHub drive is a repository, a branch and a token. The first two are short;
the third is 90-odd unguessable characters, which is not something anyone is
going to retype on a phone. **Share…** in a GitHub drive's settings shows a QR
code of a link carrying all three.

- **The link *is* the token.** Not a reference to it, not a pairing code — the
  token itself, in the URL. Anyone who reads the link or photographs the QR
  code has write access until it's revoked. That is inherent to a
  backend-less app: no server means no short-lived secret to exchange, and no
  session to exchange it for. Both dialogs say so rather than implying
  otherwise, and `SHARE_WARNING` is that sentence.
- **It goes in the fragment, never the query string.** A `#` fragment is not
  sent to the server, so it stays out of GitHub Pages' access logs and out of
  the `Referer` on any link clicked afterwards. `?token=` would be in both.
  Highest-value decision here and it costs nothing; `shareLink.test.ts` pins
  it by asserting the token appears after the `#` and nowhere before it.
- **The receiving device strips it before anything else reads the URL**
  (`takeInvitation`, called at module scope in `App.tsx`, ahead of
  `restoreRedirectedPath` — which rewrites the URL without a fragment and
  would otherwise drop it). So the token never sits in the address bar, the
  history entry, or whatever gets bookmarked next. The browser suite asserts
  this on the real `window.location`, because it is a claim about history
  rather than about a return value.
- **It asks before it stores.** The link has everything needed to add the
  drive silently, and deliberately doesn't: opening a link is not the same act
  as granting a browser write access to a repository, and only the person
  holding the phone knows whether they're the same thing this time. The
  confirmation costs one tap and is where the QR code's "anyone who
  photographs this" stops being theoretical.
- **A link for a drive already here opens it rather than re-adding it.** The
  dialog says "Open" instead of "Add", and nothing is stored — a link can't
  know whether this device's existing token is the better one, so it doesn't
  get to replace it.
- **`hashchange` is handled, not just the initial load.** A share link tapped
  while webfs is already open changes only the fragment, which the browser
  serves without reloading, so the module-level read never runs again. That's
  an ordinary case — the link is in a note, or a chat app reuses the tab — and
  the browser suite caught it as a hang rather than anyone reasoning it out.
- **The QR is drawn as SVG elements from `isDark()`**, not the library's
  injected markup, which keeps it out of `dangerouslySetInnerHTML`. It is
  black on white in **both** themes with a four-module quiet zone: scanners
  expect dark-on-light, and a code that politely inverted itself in dark mode
  would be a code that sometimes doesn't scan.
- **The button is in the drive's settings dialog, not the strip.** The strip
  is already four controls wide on a phone, and settings is where the token
  being handed over is on screen anyway. Offered only for a *saved* GitHub
  drive: what's in the form hasn't been checked yet.
- **`qrcode-generator`** is the one dependency this added — MIT, no deps of
  its own, about 47KB in the bundle.

## Storage (OPFS) and multiple tabs

**OPFS is the only store, and the directory tree is the filesystem.**
Everything webfs persists is a name, a type, a position in the hierarchy or a
file's text, and a directory tree expresses all four — so `storage.ts` is a
thin layer over OPFS and nothing else. Folders are still real directories in
the shape the app shows — but the *names* on disk are escaped rather than
literal, which is the one place the store stopped being a mirror of what you
see. "Names on disk" below is why.

Everything below is about *one drive*. Each one is a folder under `drives/`
(see Drives above), and `storeAt` binds this API to it; paths here are
relative to that mount, so nothing in this section changes meaning because
there is more than one.

- **A node's id is its path within its drive.** At any instant a file has exactly one path, and
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
- **Names are escaped on the way to OPFS** (`names.ts`, and see "Names on
  disk" below). `isValidName` still governs the *logical* name — OPFS rejects
  only `""`, `.`, `..`, and names containing `/` or `\` — and spaces, colons,
  leading dots and non-ASCII are all still legal to type. They are just not
  handed to the platform as typed any more, because one platform rewrote them.
  This bullet used to say names round-tripped byte-identically, confirmed
  against a real browser; that was true of Chromium on Linux and false of
  WebKit on a phone, which is the whole story. If you see non-ASCII names fail
  locally, check your locale first: under `LC_CTYPE=POSIX` Chromium reports a
  bogus `TypeMismatchError` (`LANG=C.utf8` fixes it, and the browser suites
  need it too).
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
  `tree.ts`, keyed by mount — switching drives starts a second load while the
  first may still be settling, and those two are about different folders).
  "Is the store empty, and if so fill it" isn't atomic: two calls
  both walk an empty store and both seed it, and since `createDirectory`
  uniquifies rather than reusing, a first visit ended up with `Projects` *and*
  `Projects 2`. React's StrictMode does exactly that in development, so this
  reproduced on the first load of `bun dev` and in every browser suite.
- `bun test` covers `merge.ts` (`merge.test.ts`), `tree.ts`
  (`tree.test.ts`: projection, id stability across rename/move, name
  validation, and the tree queries in `fs.ts` — sorting, searching,
  `touchFile`) and `panes.ts` (`panes.test.ts`). OPFS itself can't run headless, so seeding, rename, folder
  moves, two-tab merging and offline are verified by driving real Chromium
  tabs — see Browser suites below.

## Names on disk (`names.ts`)

Every path segment is percent-escaped on the way into OPFS and unescaped on
the way out — `Einführung` is stored as `Einf%C3%BChrung`. `bun test
names.test.ts` covers the escaping; `bun run browser names` checks it against
a real OPFS.

**Why, concretely.** On 2026-09-22 a vault synced from Chrome on iOS — which
is WebKit, because Apple requires every iOS browser to use WKWebView — came
back from `walk()` with all nine of its non-ASCII paths in a different Unicode
normalisation than they were written in: `ü` went in as U+00FC and came out as
`u` + U+0308. Nothing in webfs asked for that; there is no `.normalize()` in
the codebase. `planSync` compares paths as strings (`ShaMap` is a plain
`Record`), so it saw nine files that weren't in the remote and nine in the
remote that were no longer local, and did exactly what it is supposed to do
with that: pushed nine and deleted nine, in commit `bc7735a` of the vault.
Every device that pulled it then grew a second `Einführung/`.

- **The invariant is that the platform only ever sees printable ASCII.** Not
  "this engine normalises, so compensate for it" — the set of transformations
  a filesystem may apply to a name is not knowable from here, and guessing at
  it is what produced the bug. Escaping everything above U+007E, plus the
  characters filesystems are known to argue about, means there is nothing left
  to transform. The browser suite asserts that property directly rather than
  asserting that any particular name survived.
- **It costs the store being inspectable as what the app shows.** That was a
  stated property up in Storage, and it's gone for non-ASCII names: OPFS
  Explorer now shows `Einf%C3%BChrung`. Deliberate trade — an inspectable
  store is worth less than a source of truth that webfs can't silently
  rewrite.
- **Case is a known gap.** A case-insensitive backing store would still
  collide `README.md` with `readme.md`, and this doesn't address it. Escaping
  case would make every capital unreadable (`%52%45%41%44%4D%45.md`) to fix a
  fault nothing here has demonstrated, so it is written down rather than
  fixed.
- **Decoding is total and tolerant**, because it runs on whatever OPFS happens
  to hold — including names written before any of this existed. A `%` that
  begins nothing valid stays a `%`. The one ambiguity that buys: a legacy file
  literally named `Einf%C3%BChrung` now reads as `Einführung`. Newly written,
  that name escapes to `Einf%25C3%25BChrung` and stays distinct; only names
  predating the change can collide, and it's a display collision, not lost
  data.
- **`walk` recurses on handles, not on rebuilt paths.** That saves a lookup
  per folder, and it is what lets a not-yet-escaped folder still be listed —
  otherwise a legacy store would go invisible the moment the escaping shipped,
  which is a much worse failure than the one being fixed.
- **`adoptNames` is the migration**, run once per drive arrival from
  `readOrSeed` in `tree.ts` rather than on every tree refresh. It renames only
  what isn't already canonical (`isCanonical`), is idempotent, and does
  children before parents so a folder is canonical inside before it moves. Two
  things it deliberately won't do: merge a legacy name into an escaped one
  that already exists (that is a guess about which the user wants), and touch
  the OPFS root, where pre-drives leftovers live.
- **`copyTree` had to be fixed first.** Directories have no `move()`, so
  renaming one is a copy — and it copied with `file.text()`, which would have
  turned every pasted image inside a renamed folder into U+FFFD. It copies the
  `File` itself now. That bug predates this change and applies to any folder
  move, not just migration.
- **Everything above the boundary still speaks logical names.** `fs.ts`,
  `panes.ts`, `assets.ts`, the workspace, the sync base and the paths sent to
  GitHub are unchanged and mean what they always meant; `dirAt` and
  `storedName` in `storage.ts` are the only places the two spellings meet. The
  same shape as the drives change, for the same reason.

## GitHub sync (two-way, personal access token)

A GitHub drive's branch is a second replica of that drive's folder, kept in
step with OPFS in both directions. `github.ts` (REST client), `sync.ts` (the
algorithm), `driveConfig.ts` (localStorage), `useDriveSync.ts` (when it runs)
and `DrivePanel.tsx` (the strip at the foot of the sidebar). Only the drive
you're looking at syncs — see Drives above.

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
- **`branchUrl` points at `/tree/<branch>`** rather than the repo root, so a
  link lands on what's actually being synced. The drive's name in the strip is
  the switcher now rather than that link, because switching drives is what you
  come to that corner to do; settings are the `⚙` beside it.
- **The dialog links to a pre-filled token page** (`tokenSetupUrl` in
  `DrivePanel.tsx`). GitHub's fine-grained token form takes a template URL, so
  `contents=write` (which implies read; GitHub adds `metadata:read` itself),
  `target_name`, `name` and `expires_in` are all filled in from what the
  dialog already knows. Two things to keep in mind before editing it: there
  is *no* parameter for the repository — only `target_name`, its owner — so
  the dialog says to pick that on the page rather than implying the link does
  everything; and the expiry is set explicitly because the page's own default
  is 30 days, which would quietly stop sync working in a month. These are
  GitHub's parameter names, not ours, so a renamed one fails silently (an
  empty form, no error) — `drivePanel.test.ts` pins them. See
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- **A GitHub drive is never seeded** (`shouldSeed` in `driveConfig.ts`). It is
  empty because it hasn't pulled yet, and seeding would push three starter
  notes into someone's established notes repo.
- **A sync is serialized across tabs** with a Web Lock named for the drive
  (`ifAvailable`, so a second tab skips rather than queues — but two *drives*
  have nothing to serialise against each other), flushes pending editor writes first
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
- **The status strip says what a sync is doing, not just that it is.**
  `syncOnce` takes an `onProgress` callback and reports a stage per step —
  reading, hashing, listing, downloading, merging, keeping, deleting,
  uploading, committing — with the file it's on and a count within the stage.
  `progressPercent` turns that into one number using the fixed shares in
  `STAGE_SHARE`. Three things that look arbitrary and aren't: the shares are a
  guess (nothing can know before it starts how long a pass spends uploading)
  so the percentage promises movement, not time; the stage *order* is what
  makes the bar monotonic, which is why keeping-both has a stage of its own
  rather than sharing "merging" — an unmergeable merge lands there afterwards
  and a shared counter would run backwards; and a pass with nothing to do
  stops after "listing", so the bar jumps to the result line from ~30%.
  `describeProgress` names the file by its last segment (the strip is a
  sidebar wide, and a clipped path shows the half that doesn't identify it),
  with the full path in the `title` — the opposite of `commitTitle`, for the
  opposite reason. The hook throttles these to `PROGRESS_MS` (120ms) per
  stage, since hashing fires one per file and a render apiece would cost more
  than the sync. Blob uploads are counted by `github.ts` as they
  land, each named with the path that just *finished* — several are in flight
  at once, so "currently uploading" is a fiction. They go up
  `UPLOAD_CONCURRENCY` (4) at a time rather than all at once, which is both
  what GitHub asks for on writes (a burst comes back as a 403 secondary rate
  limit, which this client would report as a permissions problem) and what
  makes the count mean anything — fired together they all land in the same
  instant, and the line went from "12 files" straight to "Committing". The bar itself
  is absolutely positioned over the strip's top border (`.sync-progress`), so
  the sidebar's footer doesn't change height every time a sync starts.
- **Timing:** on load, 4s after edits settle, every 60s, on tab-visible and on
  `online`, plus the button. Auto-sync is a checkbox; the button always works.
- **Offline is said out loud, with the date and time of the last sync.** The
  app works offline — everything is in OPFS — which is exactly why the strip
  has to say the network is gone: silence reads as "synced", and a device
  quietly three days behind looks identical to one that is up to date. The
  line takes precedence over both the error and the progress line, because a
  failed request *is* what being offline looks like from inside `github.ts`
  ("Can't reach GitHub — check your connection") and the connection is the
  part worth naming. The sync button is disabled with a title that says why,
  since a press would otherwise run a pass that silently refuses itself.
- **`useDriveSync` watches `online`/`offline` rather than reading
  `navigator.onLine` where it's drawn**, which would be a value from whenever
  that render happened to run. The listener is registered for every drive, not
  only an auto-syncing one — a drive with auto-sync off is still offline — but
  it only re-runs the sync on reconnection *if* auto-sync is on, because "ask
  me" shouldn't be overridden by a reconnection the user didn't ask for.
- **The last-sync time is persisted** (`loadSyncedAt`/`saveSyncedAt` in
  `driveConfig.ts`, keyed by drive and branch like the base). The moment it is
  most worth knowing is the one where memory is empty: the installed app
  opened on a train, with no run to have set it. It is deliberately *not* part
  of `SyncState` — `syncOnce` neither reads nor writes it, and putting it
  there would hand the algorithm a field it has no business in.
- **A restored time with no message says "Last synced 3h ago", not "Up to
  date".** An empty message means the time came back from storage and nothing
  has synced in this session yet, so the older wording claimed a check that
  hadn't happened. `syncedAtLabel` gives the offline line an absolute time
  instead of a relative one, because what matters offline is *how stale* this
  device is and "18h ago" takes work to turn into "before I got on the
  plane"; the two days that have names get them, the year appears only when it
  isn't this one, and both halves go through `toLocale*String` so the clock
  and the day-month order are the reader's settings rather than a guess.
  `drivePanel.test.ts` pins which branch the label takes, not how a locale
  renders it — asserting "23 Sep 14:32" would pin this container's locale.
- **An offline *reload* can't be driven by the browser suites.** Offline it is
  the service worker that serves the shell, and `bun dev` never registers one
  (see PWA below), so `bun run browser sync` checks the durable half instead:
  that the timestamp a fresh load would read is really in localStorage. What
  it does drive for real is `context.setOffline`, which does flip
  `navigator.onLine` and fire the events — checked before the test was written
  around it.
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
  and the token link — in `drivePanel.test.ts`. What none of them covers is
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
  `readBytes` + `decodeText` rather than `readFile`. A format whose bytes
  might decode anyway — a PDF — is settled by extension before the read; see
  PDFs below.
- **`resolveAssetPath` refuses to leave the store**, so a link with enough
  `..` in it resolves to null rather than to something outside. It also
  requires the link to name something: without that, an empty link resolved
  to the note's own folder, which is a directory. `assets.test.ts` covers
  both, which is how the second one was found.

## PDFs, and importing a file from the device

`assets.ts` (`mimeOf`, `neverText`, `importName`), `BinaryFile` in
`Editor.tsx`, `handleImport` in `App.tsx`, the menu item and the drop
handlers in `Sidebar.tsx`. Driven by `bun run browser pdf`.

- **The browser's own viewer renders it, through an iframe over an object
  URL.** Every desktop browser and Android Chrome ship a PDF viewer; a bundled
  renderer would be several times the size of this whole app, to do what is
  already there.
- **iOS Safari is the exception, and it's the platform this is most used on.**
  It draws a PDF in an iframe as a single non-scrolling page, or as nothing.
  There is no page-side fix, so the frame always carries a link that opens the
  object URL in a new tab, where Safari shows the document properly. That link
  is the feature on iOS, not a nicety — don't hide it behind a UA check, which
  would be wrong the moment Safari changes.
- **A `.pdf` is never text, whatever its bytes decode to.** `decodeText` asks
  "is this valid UTF-8 with no NULs", which is a good proxy for every binary
  file and a guarantee for none: a small uncompressed PDF is all-ASCII, so
  without `neverText` in front of it the read effect hands the bytes to Crepe,
  which renders them and saves its reading of them over the file — an image
  destroyed by being looked at, exactly as before, but for a file that *looks*
  like text. The browser suite builds precisely that PDF, and disabling the
  guard fails it.
- **SVG is deliberately not in that list.** It is a picture and text at once,
  it round-trips through the editor, and editing one by hand is reasonable.
- **Importing is how bytes get in without a repository.** Before this the only
  ways were a pasted image and a sync pulling one, so a PDF could be read here
  but never put here — and on a local drive, never at all. There are two
  routes, for the two kinds of device: "Import Files…" in the folder and
  empty-area context menus (which is the tap-friendly one, and the only one on
  a phone), and dropping files onto the tree from outside the browser.
- **A drop is either an import or a move, and the handler has to tell.** The
  tree's rows and background already accept dropped *rows*; a drag carrying
  `Files` is the other thing, and `carriesFiles` is the one-line test that
  splits them. Dropping onto a file row means "into that file's folder", the
  same way a move does.
- **The file input lives outside the menu that opens it.** The menu unmounts
  on the click that calls `input.click()`, and would take the input with it
  before a file was ever chosen. It also clears `value` before importing, or
  picking the same file twice in a row fires no second change event.
- **`importName` has its own fallback**, rather than sharing `assetName`'s.
  A pasted image really is a PNG; an import is whatever was picked, and
  calling a spreadsheet `image-….png` is a lie the editor would then act on.
- Chromium's viewer shows the object URL's UUID in its toolbar where a
  filename would go. Nothing to do about it short of serving the file from a
  real path through the service worker, which is a lot of machinery for a
  caption.

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
- **Only images are drawn; everything else in double brackets is still a
  node.** Obsidian embeds notes and PDFs with the same syntax and links to
  notes with the same brackets minus the `!`; turning one of those into an
  `<img>` would show a broken image where a legible name used to be. They
  become a `wikiLink` instead, which renders as the text it already reads as
  and is written back character for character. Rendering it as its own source
  is the honest minimum until webfs can follow one — the reason it's a node at
  all is that a node is what the serializer leaves alone.
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

## Checkboxes: sorting a list, and the `todo` fence

`tasks.ts` (what a checkbox is, and what order they go in — pure,
`tasks.test.ts`), `fences.ts` (the triple-backtick command syntax — pure,
`fences.test.ts`), the node, the decoration and the slash-menu item in
`Editor.tsx`, `findTasks` in `App.tsx`, and `.task-sort` / `.todo-block` in
`index.css`. Driven end to end by `bun run browser todo`.

Two features that turned out to be one module: a **⇅ beside every checkbox
list**, which drops the finished items to the bottom, and a **```todo fence**,
which draws the unfinished ones from the whole drive wherever it is written.

- **Neither is a markdown dialect of its own.** The sort rearranges lines that
  were already there. The fence is a fenced code block, which CommonMark has
  had all along — so a note holding one is still an ordinary markdown file:
  GitHub renders an empty code block, Obsidian the same, and a sync carries it
  about with nothing having an opinion. Compare `![[…]]`, which had to be
  taught to remark before a note containing one could be *opened* here without
  being rewritten. This only had to be taught how to draw it.
- **Sorting a list that is already sorted must write nothing at all.** That is
  the whole reason `sortedList` returns `null` rather than an equal copy, and
  the reason `orderByDone` hands back a permutation rather than the items. A
  transaction re-serializes the document, and a button that rewrote the note
  every time it was pressed would be a way to make a sync change by tidying
  something already tidy — invisible on screen, which is why the browser suite
  reads the bytes back rather than the list.
- **An item that isn't a checkbox counts as unfinished.** It has nothing to
  say about being done, and dropping it to the bottom with the finished ones
  would be an opinion nobody asked for. Both halves are stable, so the order
  someone chose among their own work survives.
- **One handle per outermost list, and it takes the nested ones with it.** A
  button at every level of a nested list would be four buttons doing the same
  thing, and a sub-list travels inside the item it belongs to, so it stays
  under its parent wherever the parent lands.
- **The handle is a widget decoration, not a node.** Nothing about it is
  written to the file, and a decoration is exactly the way to say that — it
  also means the editor can draw one without `markdownUpdated` ever firing.
  `getPos` is asked at click time rather than captured, so a list that has
  moved since the button was drawn still sorts the right one.
- **It takes a line of its own rather than floating over the list's corner.**
  The right-hand end of a note's *first* task is the text you can least afford
  to cover, and it is also where a long one wraps to. The line is pulled back
  into the list's own top margin, so a list with a handle sits where a list
  without one would.
- **A `todo` fence is drawn from the drive, not from the document.** The
  document holds four characters; what is on screen is a read of every
  markdown file under the scope named after the fence (empty means the whole
  drive). So the node is an atom, not editable, and there is no third copy of
  anything.
- **The scan reads the tree App holds, not the store.** Saves are debounced, so
  the file being edited is behind what is on disk — a block that listed a
  checkbox you ticked a second ago would be wrong in the one place anyone is
  looking at it. A node's own `content` wins where it has been loaded, and the
  store is read only for files this tab has never opened. That is why
  `findTasks` lives in `App.tsx` and is passed in: the tree is App's.
- **A row opens the note; it doesn't tick the box.** Ticking would mean writing
  a file that may be open in the other pane — an uncontrolled Crepe instance
  holding its own copy of the document, whose next save would put the old text
  straight back (see the invariant at the top of `panes.ts`). So the block
  takes you to where the checkbox is and lets the editor that owns it do the
  work. Worth knowing before anyone "just adds a checkbox to each row".
- **A block hears about its own note and nothing else.** Rescanning the drive
  on every keystroke would be absurd, so the trigger is the *answer* changing:
  one pass over the document names the unfinished checkboxes in it, and typing
  in a paragraph leaves that alone. A box ticked in another file, or another
  tab, is what ↻ is for. The alternative is a subscription to the whole drive
  for a block that might be listing four things.
- **A checkbox inside a code fence is an example of one, not one.**
  `openTasksIn` blanks fenced blocks before it looks, keeping the line count so
  the numbers still point at the right line — without it a `todo` block would
  list its own documentation.
- **Only `.md`, `.markdown`, `.mdown` and `.txt` are read.** Everything else in
  a drive is images and attachments, and the scan is a read per file.
  `TASK_LIMIT` (200) is not a page size and nothing pages past it: the block is
  a prompt to go and do something, and a thousand rows of it is not — the count
  of what's left is the honest summary of a backlog that long.
- **The fence system is built to hold more than one command.** `FENCE_COMMANDS`
  is the list, `parseFence` is the single question "is this fence a command",
  and `fenceMarkdown` writes one back — including picking a run of backticks
  long enough to contain a body, which no command has yet. A language webfs
  doesn't know stays a code block, so a note full of shell snippets doesn't
  start sprouting todo lists.
- **The slash menu item is in a group of webfs's own**, and is called "Todo
  list" rather than anything more descriptive. Two reasons, both external:
  Crepe's `getGroup` throws on a key it doesn't know, so reaching into its
  "advanced" group would put the whole slash menu at the mercy of an upstream
  rename; and the menu filters on the *label*, so "Unfinished checkboxes" is an
  item that typing `/todo` — the name of the thing it writes — cannot find.
- **Neither shows up in the plain-text view**, which is the source and shows
  the fence as the four characters it is. That is the same rule the rest of
  that view follows rather than an omission.

## Nothing is rewritten except where the user typed

`preserve.ts` (pure, `preserve.test.ts`), the `markdownUpdated` handler in
`Editor.tsx`, and `bun run browser vault`.

Milkdown is a WYSIWYG editor: the markdown it saves is re-serialized from the
document, never patched. So every convention the serializer has an opinion
about is rewritten at once — tabs become spaces, `-` bullets become `*`,
`#classnotes` becomes `\#classnotes`, trailing spaces vanish, blank lines
appear between blocks. Measured against a real Obsidian vault, **one keystroke
rewrote 190 lines of a 179-line note**, and a sync then carried the whole file
to GitHub as the user's change. Tuning the serializer can't reach this: it is
a dozen separate conventions, and the next one is always a version away.

- **Opening a note used to rewrite it, with nobody typing at all.** Crepe puts
  an empty paragraph at the end of the document when it mounts, so a document
  change lands moments after a file is opened, `markdownUpdated` fires, and the
  normalized text is saved. That is the worst form of this bug and the easiest
  to miss, because nothing on screen suggests the file was touched. An empty
  paragraph isn't content, so `sameText` compares with trailing blank lines
  ignored, and a handler that finds nothing else different returns without
  calling `onChange` at all.
- **The editor's output is read as a statement about what changed**, not as the
  file. Three texts: `stored` (the bytes on disk, in whatever dialect),
  `baseline` (what the serializer made of them) and `current` (what it makes of
  them now). `baseline` and `current` are both the serializer's own output, so
  the diff between them is the user's edit and nothing else; lines that diff
  calls untouched are written back from `stored` byte for byte. A file
  converges on CommonMark line by line as it's edited, and a note that's only
  read is never written.
- **`baseline` is worked out on the first update, not at mount** —
  `roundTrip(stored)` rather than `getMarkdown()` once the editor is ready.
  Crepe's own change can land before or after a promise resolves, and a
  baseline captured on the wrong side of it reads that change as the user's.
  Deriving it from `stored` has no timing to get wrong.
- **`alignKey` is what lets `baseline` and `stored` be matched at all.** They
  say the same thing in different dialects, so exact line equality matches
  almost nothing; dropping indentation, the bullet character and the
  backslashes lines `\t- Kraft` up with `  * Kraft`. It counts blockquote
  markers rather than dropping them (a line in a callout isn't the same line
  as one outside it) but normalises what follows — without that, a note ending
  in an Obsidian `> [!todo]` had its whole checklist misaligned and the entire
  note was rewritten by an edit anywhere in it.
- **Two reconstructions are offered, best first.** They differ over lines the
  serializer added that the original never had. Dropping them is what hands
  the file back exactly; keeping the ones that border on new text is what stops
  a paragraph typed after a callout from being swallowed into the quote. Which
  is right depends on the note, so both are returned and the caller finds out.
- **The caller checks before it writes**, and that is what makes the whole
  thing safe: a candidate is only saved if re-parsing and re-serializing it
  gives `current` back. A reconstruction that says anything else is discarded,
  the list ends with `current` itself, and so this can cost the preservation
  but never the edit. Anything `preserve.ts` gets wrong degrades to the old
  behavior rather than to lost text.
- **What the serializer writes still matters, but only for edited lines.**
  `remarkStringifyOptionsCtx` sets `bullet: "-"` and wraps the `text` handler
  in `unescapeTags`, so a line the user does touch comes out looking like the
  rest of the vault rather than announcing itself. `unescapeTags` only undoes a
  `#` with an ordinary character hard against it: `\# Title` is a real heading
  and stays escaped, and so does a heading's closing `#`.
- **This is line-based, and deliberately so.** Editing one word rewrites that
  whole line in the serializer's dialect — the user edited that line. Anything
  finer would need source positions that don't survive the document being
  edited.

## Browser suites (`bun run browser`)

`browser/` drives the real app in Chromium, because the half of webfs that
matters most can't run headless: OPFS, a live Milkdown editor, a service
worker, and sync reconciling between all three. `bun test` has never covered
any of that, and every bug that reached a user came from exactly there — an
empty repo's 409, a stale service-worker shell, a runaway read loop.

- **Running them:** `bun run browser`, or `bun run browser sync` for one
  (`sync`, `empty-repo`, `images`, `panes`, `drives`, `sidebar`, `pdf`,
  `wikilinks`, `vault`, `view`, `todo`, `names`, `share`). The dev server is started by the
  runner, so nothing needs to be up first. Chromium comes from
  `bunx playwright install chromium`, or point `WEBFS_CHROMIUM` at a binary
  that already exists. **Run them under a UTF-8 locale** — under
  `LC_CTYPE=POSIX` the `names` suite fails on a bogus `TypeMismatchError`
  from Chromium rather than anything in this repo (see Storage above), which
  reads exactly like a regression someone just caused. `LC_ALL=C.UTF-8` is
  enough. Not in CI — they take about a minute and want a real
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
- **Assert that nothing happened, as well as that something did.** The
  `vault` suite opens a note, waits out both debounces and checks the file is
  byte-identical. Every rewrite bug here was invisible on screen, so the only
  way to catch one is to read the bytes back.
- **A drive a suite has just connected to comes up folded**, so a file inside
  a folder has no row to click until `expandFolder` opens it. That's a call
  the suite makes for itself rather than something `openFile` does quietly:
  hiding it there would take the fold's own checks down with it the day it
  stopped working.
- **Assert on what a thing *is*, not what it's labelled.** A tab's `title` is
  its path, straight from the layout; its visible name comes from the tree and
  lags by a render, because `pruneMissing` runs in an effect on `fs`. So after
  a delete there is a frame where the file is gone from the tree but the tab is
  still open, labelled with its whole path — and "plans.md is not among the tab
  names" reads that frame as the tab having closed. It flaked about one run in
  four until the check moved to the ids, and waited for the whole strip rather
  than the absence of one name.
- **Poll outcomes, never the status line.** It shows what the *last* sync
  did, so asserting on it right after clicking Sync reads the previous run
  and passes for the wrong reason — which it did, hiding a real failure.
  `waitUntil` and `syncAndSettle` exist for this.
- **Wait for the thing you mean.** A pasted image writes its file
  immediately but its link goes through the editor's save debounce, so
  waiting on the asset alone catches the note mid-write.
- **`opfsFiles` skips entries that vanish under it.** The app writes while
  the walker reads; a half-created file is not an answer worth returning.
- **Read stored JSON by parsing it, not by matching a substring.** A drive is
  `{owner: "me", repo: "notes"}` in the registry, so asserting that the JSON
  "contains me/notes" is an assertion that passes whatever happens — which two
  checks in the `share` suite did until the run that should have failed didn't.
- **`opfsFiles` reports names as OPFS holds them, which is escaped.** It walks
  the directory rather than going through `storage.ts`, so a non-ASCII path
  comes back as `Einf%C3%BChrung/...` — that is the point, since it is the only
  way to assert what actually reached the platform. `writeOpfsFile` writes the
  name it is given, unescaped, which is how the `names` suite plants a store
  from before the escaping existed.
- **`opfsFiles` is about one drive, and refuses to guess between several.** It
  returns drive-relative paths, because that's what the app's ids and the
  repository's paths both are — an assertion written against
  `drives/me/notes/Notes/todo.md` would be testing the helper's arithmetic.
  With no drive named it walks the only one there is and throws if a context
  has two, since merging them would turn a file written to the wrong drive
  into a passing test. `writeOpfsFile`/`writeOpfsBytes` put something into a
  drive from outside the app, standing in for another tab or a copied vault.
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

## The version in the corner

`version.ts` (reading the define), `build.ts` (computing it), `TabStrip.tsx`
(`VersionTag`, rendered there and in the mobile topbar), `version.test.ts`.

- **The number is `git rev-list --count HEAD` at build time**, inlined as
  `process.env.BUN_PUBLIC_VERSION` exactly the way `BASE_PATH` is — including
  the try/catch, for the same reason (an un-inlined `process.env.X` references
  a `process` global a browser doesn't have, and *throws* rather than giving
  undefined). Nothing is checked in and nothing has to be bumped by hand.
- **It exists to answer "am I on the current deploy?"** That is not idle
  curiosity here: the service worker serves the shell from a cache, and a
  stale one stranded a device on an old build once already (see the PWA notes
  below). On a phone there is no devtools and no reload that clears it, so
  without a version on screen the question is unanswerable.
- **A shallow checkout gets no number at all.** `actions/checkout` clones
  depth 1 by default, and `rev-list --count` counts *the history it has* — so
  the count comes back 1, and the next deploy says 1 again: a version that
  silently resets and climbs again, which is worse than none because it looks
  right. `build.ts` checks `rev-parse --is-shallow-repository` and refuses,
  the app shows "dev" where the number goes, and the workflow passes
  `fetch-depth: 0`. If that ever comes off, the deployed app says so itself
  rather than quietly renumbering.
- **Rendered in the tab strip of the *rightmost* pane, and in the mobile
  topbar** — the two places this app puts its upper-right affordances, the
  same split `ViewToggle` has. Both are in the DOM at once and CSS shows
  exactly one; `last` keeps a split view from showing it twice.
- `version.test.ts` covers the labels and, more to the point, builds the
  module twice: once with the defines (asserting no `process.env` survives)
  and once without, running *that* bundle with `process` shadowed, since
  importing it into Bun — which has `process` — would pass without ever
  reaching the case the try/catch is for.

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
