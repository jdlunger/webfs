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
