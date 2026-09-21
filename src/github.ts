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

  /**
   * As `request`, but statuses that mean "this isn't there" come back as null
   * instead of throwing — 404 always, plus whatever `absent` lists.
   */
  private async fetchRaw(path: string, init?: ApiRequest, absent: readonly number[] = []): Promise<unknown | null> {
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

    if (response.status === 404 || absent.includes(response.status)) return null;
    if (!response.ok) throw new GitHubError(await describeFailure(response), response.status);
    return response.json();
  }

  private get repoPath(): string {
    const { owner, repo } = this.credentials;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private refPath(branch: string): string {
    // Not encodeURIComponent on the whole string: a branch name's own slashes
    // are path separators here ("refs/heads/feature/x"), and encoding them
    // 404s the ref. Same for a file path's directory separators.
    return `${this.repoPath}/git/ref/heads/${encodePath(branch)}`;
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

  /**
   * The branch's head commit, or null when there isn't one to parent a push on.
   *
   * GitHub says "no head" in two different ways, and the difference isn't
   * about the branch. A branch that doesn't exist in a repository that *has*
   * commits is a 404. A repository with no commits at all answers 409
   * instead — its git endpoints have no history to talk about — and that is
   * the state every brand-new empty repository is in. Both mean the same
   * thing here, so both are null.
   *
   * Reading only the 404 as absent is what made syncing to a fresh repo fail
   * outright: the 409 threw, `readTree` never returned, and the initial
   * commit this client is perfectly able to make was never attempted.
   */
  private async headSha(branch: string): Promise<string | null> {
    const ref = (await this.fetchRaw(this.refPath(branch), undefined, [409])) as { object?: { sha?: string } } | null;
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

    // No parent means a repository with no commits, and none of the code
    // below can touch one: the git-object endpoints 409 while there is no
    // history, and creating the branch afterwards is refused outright —
    // "You are unable to create new references for empty repositories, even
    // if the commit SHA-1 hash used exists." The Contents API is the one
    // endpoint that works on an empty repo, and a single call to it makes
    // the first branch and commit, after which all of this behaves normally.
    let base = parent;
    if (base === null) {
      base = await this.initializeRepository(entries, message);
      // One file and we're already done — the bootstrap wrote the whole tree.
      if (entries.length === 1) return base;
    }

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
      body: { message, tree: created.sha, parents: [base] },
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

  /**
   * Gives an empty repository its first commit, via the only endpoint that
   * works on one, and returns that commit's sha to parent the real push on.
   *
   * It writes a single file — whichever the push was going to send anyway —
   * so nothing extra is invented and the full tree that follows simply
   * supersedes it. That does cost two commits on a first sync, which is the
   * price of the repository having had no branch to begin with.
   */
  private async initializeRepository(entries: CommitEntry[], message: string): Promise<string> {
    const seed = entries.find(entry => "content" in entry);
    if (seed === undefined || !("content" in seed)) {
      // Everything referenced an existing blob, which can't happen when the
      // repository is empty — there is nothing there to reference.
      throw new GitHubError("Can't start an empty repository without a file's text to write.", 0);
    }

    const created = (await this.request(`${this.repoPath}/contents/${encodePath(seed.path)}`, {
      method: "PUT",
      body: {
        message,
        content: toBase64(new TextEncoder().encode(seed.content)),
        branch: this.credentials.branch,
      },
    })) as { commit?: { sha?: string } };

    const sha = created.commit?.sha;
    if (typeof sha !== "string") throw new GitHubError("GitHub didn't report a commit for the first file.", 0);
    // The branch exists now, so the ref gets updated rather than created.
    this.branchExists = true;
    return sha;
  }

  private async createBlob(content: string): Promise<string> {
    const blob = (await this.request(`${this.repoPath}/git/blobs`, {
      method: "POST",
      body: { content: toBase64(new TextEncoder().encode(content)), encoding: "base64" },
    })) as { sha: string };
    return blob.sha;
  }
}

/** Percent-encodes each segment, leaving the separators as separators. */
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Turns a failed response into something worth showing a user. */
async function describeFailure(response: Response): Promise<string> {
  // GitHub's own message is always appended, never swallowed by our summary.
  // A canned "the branch is in an odd state (409)" is what a real failure
  // looked like from the outside once, and it named nothing anyone could act
  // on; GitHub had said "Git Repository is empty" all along.
  let detail = "";
  try {
    const body = (await response.json()) as { message?: string };
    if (typeof body.message === "string" && body.message) detail = ` — GitHub said: ${body.message}`;
  } catch {
    /* not JSON; the status alone will have to do */
  }

  if (response.status === 401) return `GitHub rejected the token (401). It may be expired or mistyped.${detail}`;
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    return `GitHub rate limit reached. Try again shortly.${detail}`;
  }
  if (response.status === 403) {
    return `That token isn't allowed to do this (403). Check its repository permissions.${detail}`;
  }
  if (response.status === 422) return `GitHub rejected the update (422) — the branch moved. Retrying.${detail}`;
  return `GitHub request failed (${response.status})${detail}`;
}
