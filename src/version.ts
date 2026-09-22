/**
 * Which build of webfs this is.
 *
 * The number is the commit count on `main` at build time — `git rev-list
 * --count HEAD`, computed in build.ts and inlined as a define. Nothing is
 * checked in and nobody has to remember to bump anything: a build that came
 * from a later commit has a higher number, which is the whole contract.
 *
 * It exists to answer one question the app can otherwise make very hard: *is
 * what I'm looking at the current deploy?* The service worker serves this
 * shell from a cache, and a stale one has stranded a device on an old build
 * before (see the PWA notes in CLAUDE.md) — on a phone, with no devtools and
 * no reload that clears it, "which version am I on" is not a question you can
 * otherwise answer.
 *
 * Reading the define needs the same try/catch as BASE_PATH, for the same
 * reason: un-inlined, `process.env.X` is left as literal source referencing a
 * `process` global that doesn't exist in a browser, so the access throws
 * rather than evaluating to undefined. See basePath.ts.
 */
function readEnv(read: () => string | undefined): string | null {
  try {
    return read() || null;
  } catch {
    return null;
  }
}

/** The commit count, or null in a build that had no git history to count. */
export const APP_VERSION = readEnv(() => process.env.BUN_PUBLIC_VERSION);

/** The commit it was built from, short form. Null in the same cases. */
export const APP_COMMIT = readEnv(() => process.env.BUN_PUBLIC_COMMIT);

/**
 * What the corner shows: "v128", or "dev" for anything not built by the
 * deploy — `bun dev`, `bun run start`, or a release build whose version
 * couldn't be worked out.
 *
 * That last case is deliberately not silent. A shallow clone counts its own
 * truncated history, so a build that lost access to the full one would
 * otherwise start over at "v1" and keep incrementing plausibly from there —
 * a version that goes *backwards* is worse than no version, so build.ts
 * refuses to guess and this says "dev" out loud in the corner instead.
 */
export function versionLabel(version: string | null = APP_VERSION): string {
  return version === null ? "dev" : `v${version}`;
}

/** The tooltip: the same thing, said in full. */
export function versionTitle(version: string | null = APP_VERSION, commit: string | null = APP_COMMIT): string {
  const at = commit === null ? "" : ` (${commit})`;
  return version === null ? `A local build${at}, with no version number` : `Build ${version}${at}`;
}
