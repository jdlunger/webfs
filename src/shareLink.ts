/**
 * Handing a GitHub drive to another device.
 *
 * A GitHub drive is a repository, a branch and a personal access token. The
 * first two are short and the third is long, unguessable and painful to type
 * on a phone — which is the whole reason this exists: a link (and a QR code
 * of it) that a second device can open to get all three at once.
 *
 * **The link is the token.** Not a reference to it, not a one-time code — the
 * token itself, in the URL. Anyone who reads the link, photographs the QR
 * code, or finds it in a chat log has write access to that repository until
 * the token is revoked. That is inherent to a backend-less app: there is no
 * server to hold a short-lived pairing secret, and no session to exchange it
 * for. The dialog says so in as many words, and `SHARE_WARNING` is that text.
 *
 * Two things reduce the blast radius without pretending the above isn't true:
 *
 * - **It goes in the fragment, not the query string.** A `#` fragment is never
 *   sent to the server: it stays out of request lines, out of GitHub Pages'
 *   access logs, and out of the `Referer` header on any link clicked from the
 *   loaded page. A `?token=` would be in all three. This is the single
 *   highest-value choice here and it costs nothing.
 * - **The receiving device strips it immediately** (`App.tsx`), before
 *   anything else reads the URL, so the token doesn't sit in the address bar,
 *   the back/forward history, or whatever the user bookmarks next.
 *
 * What it deliberately does *not* do is claim to be safe. There is no expiry
 * (GitHub's token page sets that, and the add dialog already asks for a year),
 * and no way to revoke one link without revoking the token.
 */
import { LOCAL_SCHEME, type GitHubDrive } from "./drives";

/** Marks a fragment as one of ours rather than a router path or an anchor. */
const MARKER = "add-drive";

/** Shown wherever a link is produced. Deliberately blunt. */
export const SHARE_WARNING =
  "This link contains your access token in full. Anyone who opens it — or " +
  "photographs the QR code — can read and write this repository as you. " +
  "Send it only to your own devices, over something you trust, and revoke " +
  "the token on GitHub if it ever goes anywhere else.";

/**
 * The link to open on the other device.
 *
 * `origin` and `basePath` are passed in rather than read from `window` so the
 * whole thing stays testable, and because the app already knows its own base
 * path in one place (`basePath.ts`).
 */
export function shareLink(drive: GitHubDrive, origin: string, basePath: string): string {
  const params = new URLSearchParams({
    [MARKER]: "1",
    owner: drive.owner,
    repo: drive.repo,
    branch: drive.branch,
    token: drive.token,
    auto: drive.auto ? "1" : "0",
  });
  // The app root, not a deep link: a path under it would 404 on GitHub Pages
  // and bounce through public/404.html, which rebuilds the URL and would have
  // to be taught to carry a fragment. There is nothing to deep-link to anyway
  // — the drive isn't on this device yet.
  return `${origin}${basePath}/#${params}`;
}

/**
 * The drive a fragment names, or null if it doesn't name one.
 *
 * Shape only: that every field is present and that the two id segments could
 * be a drive at all. Whether it *may* be added — already present, name taken,
 * reserved owner — is `validateDrive`'s question, asked against the registry
 * by the caller.
 */
export function parseShareLink(hash: string): GitHubDrive | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  if (params.get(MARKER) !== "1") return null;

  const owner = params.get("owner")?.trim() ?? "";
  const repo = params.get("repo")?.trim() ?? "";
  const branch = params.get("branch")?.trim() ?? "";
  const token = params.get("token")?.trim() ?? "";
  if (!owner || !repo || !branch || !token) return null;
  // A repository owned by `opfs` would shadow the local-drive namespace, and
  // a slash in either segment would make the id ambiguous. Refused here as
  // well as in validateDrive, because this input arrives from a stranger's
  // link rather than from the dialog.
  if (owner === LOCAL_SCHEME) return null;
  if ([owner, repo].some(segment => segment.includes("/") || segment.includes("\\"))) return null;

  return { kind: "github", owner, repo, branch, token, auto: params.get("auto") !== "0" };
}

/** Whether a fragment is one of these at all, without parsing it. */
export const looksLikeShareLink = (hash: string): boolean =>
  new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash).get(MARKER) === "1";
