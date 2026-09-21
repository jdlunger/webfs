/**
 * A minimal GitHub client, speaking only the git-object half of the REST API
 * (refs, commits, trees, blobs) plus one repository lookup for validation.
 *
 * Why the git-object endpoints rather than the friendlier
 * `/repos/{o}/{r}/contents/*`: sync has to see the *whole* remote tree in one
 * request to diff it, and it has to land a set of file changes as one commit.
 * The contents API can do neither — it's a request per file, and a commit per
 * file, which turns a five-file sync into an eleven-commit history.
 *
 * `sync.ts` talks to the `Remote` interface below rather than this class, so
 * the sync algorithm is testable without a network (see sync.test.ts).
 */

const API = "https://api.github.com";

/** Regular file. The only mode this app ever creates. */
export const FILE_MODE = "100644";

export interface RepoRef {
  owner: string;
  repo: string;
  /** The branch synced against. Created off the default branch if missing. */
  branch: string;
}

export interface Credentials extends RepoRef {
  /** A personal access token: classic with `repo`, or fine-grained with
   *  read+write "Contents" on this repository. */
  token: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** An entry as it exists remotely. `mode`/`type` are git's, verbatim. */
export interface RemoteEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

export interface RemoteTree {
  /** The commit a push must parent itself on; null when the repo has no commits. */
  commitSha: string | null;
  entries: RemoteEntry[];
}

/** Either a blob that already exists remotely, or new text to store. */
export type CommitEntry = { path: string; mode: string; sha: string } | { path: string; mode: string; content: string };

export interface Remote {
  readTree(): Promise<RemoteTree>;
  /** The blob's text, or null if it isn't UTF-8 text (see `decodeText`). */
  readBlobText(sha: string): Promise<string | null>;
  /** Writes `entries` as the branch's complete new tree. Returns the commit sha. */
  commit(entries: CommitEntry[], message: string, parent: string | null): Promise<string>;
}

// --- encoding ---------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on a file
  // of any size.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  // The API returns base64 wrapped at 60 columns.
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Bytes as text, or null if they aren't text at all.
 *
 * Everything this app stores is text, but a repo it's pointed at may hold
 * images or anything else. Decoding those leniently would replace bytes with
 * U+FFFD and the next push would write the corruption back, so a blob that
 * isn't valid UTF-8 (or contains a NUL, which git itself treats as binary) is
 * reported as untouchable instead.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The sha git would give this text: sha1 of "blob <bytelength>\0" + bytes.
 *
 * Computing it locally is what makes sync cheap — a remote tree listing
 * already carries every blob's sha, so nothing has to be downloaded just to
 * find out whether it differs from the local copy.
 */
export async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** crypto.subtle only exists in a secure context; without it there's no sync. */
export function webCryptoAvailable(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function";
}

// --- client -----------------------------------------------------------------

/** `body` is JSON to be stringified, not a RequestInit body. */
interface ApiRequest {
  method?: string;
  body?: unknown;
}

export class GitHubRemote implements Remote {
  /** Whether the configured branch exists yet; decides POST vs PATCH of the ref. */
  private branchExists = false;

  constructor(private readonly credentials: Credentials) {}

  private async request(path: string, init?: ApiRequest): Promise<unknown> {
    const response = await this.fetchRaw(path, init);
    if (response === null) throw new GitHubError(`Not found: ${path}`, 404);
    return response;
  }

  /** As `request`, but a 404 comes back as null — it's an expected answer for
   *  "does this ref exist yet". */
  private async fetchRaw(path: string, init?: ApiRequest): Promise<unknown | null> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.credentials.token}`,
          "x-github-api-version": "2022-11-28",
          ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      // fetch rejects for DNS/offline/CORS, with nothing useful to report.
      throw new GitHubError("Can't reach GitHub — check your connection.", 0);
    }

    if (response.status === 404) return null;
    if (!response.ok) throw new GitHubError(await describeFailure(response), response.status);
    return response.json();
  }

  private get repoPath(): string {
    const { owner, repo } = this.credentials;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private refPath(branch: string): string {
    // Not encodeURIComponent: a branch name's own slashes are path separators
    // here ("refs/heads/feature/x"), and encoding them 404s the ref.
    return `${this.repoPath}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** Confirms the token can see the repo, and reports its default branch. */
  async checkAccess(): Promise<{ defaultBranch: string; canPush: boolean }> {
    const repo = (await this.fetchRaw(this.repoPath)) as {
      default_branch?: string;
      permissions?: { push?: boolean };
    } | null;
    if (repo === null) {
      throw new GitHubError("No such repository, or this token can't see it.", 404);
    }
    return {
      defaultBranch: repo.default_branch ?? "main",
      // Absent for a fine-grained token in some responses; assume writable
      // rather than blocking on a field that may not be there.
      canPush: repo.permissions?.push ?? true,
    };
  }

  private async headSha(branch: string): Promise<string | null> {
    const ref = (await this.fetchRaw(this.refPath(branch))) as { object?: { sha?: string } } | null;
    return ref?.object?.sha ?? null;
  }

  async readTree(): Promise<RemoteTree> {
    let commitSha = await this.headSha(this.credentials.branch);
    this.branchExists = commitSha !== null;

    if (commitSha === null) {
      // The branch doesn't exist. Fork it from the default branch, so pointing
      // webfs at a fresh branch of an existing repo starts from that repo's
      // files rather than orphaning them. A repo with no commits at all leaves
      // this null, and the first push becomes its initial commit.
      const { defaultBranch } = await this.checkAccess();
      commitSha = await this.headSha(defaultBranch);
      if (commitSha === null) return { commitSha: null, entries: [] };
    }

    const commit = (await this.request(`${this.repoPath}/git/commits/${commitSha}`)) as { tree: { sha: string } };
    const tree = (await this.request(`${this.repoPath}/git/trees/${commit.tree.sha}?recursive=1`)) as {
      tree?: RemoteEntry[];
      truncated?: boolean;
    };
    if (tree.truncated) {
      throw new GitHubError("That repository is too large for webfs to sync (its tree listing was truncated).", 0);
    }
    return { commitSha, entries: tree.tree ?? [] };
  }

  async readBlobText(sha: string): Promise<string | null> {
    const blob = (await this.request(`${this.repoPath}/git/blobs/${sha}`)) as { content?: string; encoding?: string };
    if (blob.encoding !== "base64" || typeof blob.content !== "string") return null;
    return decodeText(fromBase64(blob.content));
  }

  async commit(entries: CommitEntry[], message: string, parent: string | null): Promise<string> {
    // A tree must have entries; more to the point, pushing an empty one would
    // wipe the repository, which is never what a sync of an empty browser
    // store should mean. sync.ts refuses before getting here, too.
    if (entries.length === 0) throw new GitHubError("Refusing to push an empty tree.", 0);

    const tree = await Promise.all(
      entries.map(async entry => ({
        path: entry.path,
        mode: entry.mode,
        type: "blob" as const,
        sha: "sha" in entry ? entry.sha : await this.createBlob(entry.content),
      })),
    );

    // No base_tree: `tree` is the complete desired state, so deletions need no
    // separate expression.
    const created = (await this.request(`${this.repoPath}/git/trees`, { method: "POST", body: { tree } })) as {
      sha: string;
    };
    const commit = (await this.request(`${this.repoPath}/git/commits`, {
      method: "POST",
      body: { message, tree: created.sha, parents: parent === null ? [] : [parent] },
    })) as { sha: string };

    const ref = `refs/heads/${this.credentials.branch}`;
    if (this.branchExists) {
      // force stays false: the commit we just made parents on the head we
      // read, so a non-fast-forward here means another writer moved the branch
      // underneath us. sync.ts catches that and starts over.
      await this.request(`${this.repoPath}/git/${ref}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
    } else {
      await this.request(`${this.repoPath}/git/refs`, { method: "POST", body: { ref, sha: commit.sha } });
      this.branchExists = true;
    }
    return commit.sha;
  }

  private async createBlob(content: string): Promise<string> {
    const blob = (await this.request(`${this.repoPath}/git/blobs`, {
      method: "POST",
      body: { content: toBase64(new TextEncoder().encode(content)), encoding: "base64" },
    })) as { sha: string };
    return blob.sha;
  }
}

/** Turns a failed response into something worth showing a user. */
async function describeFailure(response: Response): Promise<string> {
  if (response.status === 401) return "GitHub rejected the token (401). It may be expired or mistyped.";
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    return "GitHub rate limit reached. Try again shortly.";
  }
  if (response.status === 403) return "That token isn't allowed to do this (403). Check its repository permissions.";
  if (response.status === 409) return "The repository is empty or the branch is in an odd state (409).";
  if (response.status === 422) return "GitHub rejected the update (422) — the branch moved. Retrying.";

  let detail = "";
  try {
    const body = (await response.json()) as { message?: string };
    if (typeof body.message === "string") detail = `: ${body.message}`;
  } catch {
    /* not JSON; the status alone will have to do */
  }
  return `GitHub request failed (${response.status})${detail}`;
}
