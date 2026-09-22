# bun-react-tailwind-template

To install dependencies:

```bash
bun install
```

To start a development server:

```bash
bun dev
```

To run for production:

```bash
bun start
```

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Editing

On a large screen, several files can be open at once: clicking a file in the
sidebar adds a tab, and the **▥** button at the end of the tab strip splits the
editor into two panes side by side. Each pane keeps its own tabs; a file is
only ever open in one of them. **✕** closes a pane, keeping its tabs in the one
that remains. Phone-width screens show one file at a time instead.

Right-click (or press and hold, on a touch screen) a file or folder in the
sidebar for rename, move and delete, and for creating a file or folder inside
it.

## Obsidian vaults

Notes written in Obsidian link their images with `![[Pasted image 2026.png]]`
rather than markdown's `![](…)`. Those embeds are displayed here, including the
`|541` and `| center |` options after the name, and are written back exactly as
they were — editing a note doesn't rewrite them.

An embed names a file without saying where it is. It's looked for beside the
note first, and then in a `Media/` folder at the top level, which is where
Obsidian keeps attachments by default. Links in double brackets
(`[[Another Note]]`) aren't followed yet, but they're left exactly as written.

More generally, a note is only ever changed where you typed. The editor works
on a parsed document and would otherwise write the whole file back in its own
style — retabbing lists, swapping `-` bullets for `*`, escaping `#tags` —
every time you touched a note. Instead your file keeps its own formatting, and
only the lines you actually edit are rewritten. Opening a note doesn't change
it at all.

## Tests

```bash
bun test          # unit tests
bun run browser   # drives the real app in Chromium (needs `bunx playwright install chromium`)
```

## Sync with GitHub

Files can be kept in step with a branch of a GitHub repository, in both
directions: edits made here are pushed, edits made anywhere else are pulled,
and a file changed in both places is merged.

1. Create a personal access token at
   [github.com/settings/tokens](https://github.com/settings/tokens) — a
   fine-grained token with **read and write access to _Contents_** on the one
   repository you want to sync (a classic token needs the `repo` scope).
2. In the sidebar, click **Sync with GitHub…**, enter the repository as
   `owner/name`, the branch, and the token.

Notes on how it behaves:

- A file deleted in one place but edited in the other comes back, rather than
  the deletion winning.
- If both sides independently create a file at the same path, both are kept —
  the GitHub copy lands beside yours as `notes (github).md`.
- Files that aren't UTF-8 text (images, binaries) are left alone on both sides.
- The token is stored in this browser's local storage, on this device only. It
  is sent to `api.github.com` and nowhere else. Treat it like a password, and
  revoke it if you lose the device.
