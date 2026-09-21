/**
 * Covers the REST wiring in github.ts against a stubbed `fetch`: which
 * endpoints get called, in what order, and what a push actually sends.
 *
 * sync.test.ts drives the sync algorithm through the `Remote` interface, so
 * this is the half that would otherwise only ever be exercised against a real
 * repository — and the half where a wrong path or a missing field shows up as
 * a 404 mid-sync rather than a type error.
 */
import { test, expect, afterEach } from "bun:test";
import { GitHubError, GitHubRemote, decodeText } from "./src/github";

interface Call {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Routes by "METHOD /path"; a route may be a value or a status to fail with. */
function stubFetch(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://api.github.com", "");
    const method = init.method ?? "GET";
    calls.push({
      method,
      path,
      body: init.body ? JSON.parse(init.body as string) : undefined,
      headers: init.headers as Record<string, string>,
    });

    const route = routes[`${method} ${path}`];
    if (route === undefined) return new Response("{}", { status: 404 });
    if (typeof route === "number") return new Response(JSON.stringify({ message: "nope" }), { status: route });
    return new Response(JSON.stringify(route), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const credentials = { owner: "someone", repo: "notes", branch: "main", token: "ghp_secret" };
const base64 = (text: string) => Buffer.from(text, "utf-8").toString("base64");

test("reading the tree walks ref → commit → recursive tree", async () => {
  const calls = stubFetch({
    "GET /repos/someone/notes/git/ref/heads/main": { object: { sha: "commitsha" } },
    "GET /repos/someone/notes/git/commits/commitsha": { tree: { sha: "treesha" } },
    "GET /repos/someone/notes/git/trees/treesha?recursive=1": {
      tree: [{ path: "a.md", mode: "100644", type: "blob", sha: "blobsha" }],
    },
  });

  const tree = await new GitHubRemote(credentials).readTree();

  expect(tree.commitSha).toBe("commitsha");
  expect(tree.entries).toEqual([{ path: "a.md", mode: "100644", type: "blob", sha: "blobsha" }]);
  expect(calls.map(c => c.path)).toEqual([
    "/repos/someone/notes/git/ref/heads/main",
    "/repos/someone/notes/git/commits/commitsha",
    "/repos/someone/notes/git/trees/treesha?recursive=1",
  ]);
  expect(calls[0]!.headers.authorization).toBe("Bearer ghp_secret");
});

test("a branch that doesn't exist yet forks from the default branch", async () => {
  stubFetch({
    "GET /repos/someone/notes": { default_branch: "trunk", permissions: { push: true } },
    "GET /repos/someone/notes/git/ref/heads/trunk": { object: { sha: "trunkhead" } },
    "GET /repos/someone/notes/git/commits/trunkhead": { tree: { sha: "treesha" } },
    "GET /repos/someone/notes/git/trees/treesha?recursive=1": { tree: [] },
  });

  // The notes branch 404s, so the repo's existing files are the starting
  // point rather than an orphan branch.
  const tree = await new GitHubRemote({ ...credentials, branch: "notes" }).readTree();
  expect(tree.commitSha).toBe("trunkhead");
});

test("a repository with no commits at all syncs as an empty tree", async () => {
  stubFetch({ "GET /repos/someone/notes": { default_branch: "main" } });
  const tree = await new GitHubRemote(credentials).readTree();
  expect(tree).toEqual({ commitSha: null, entries: [] });
});

test("a truncated tree is refused rather than half-synced", async () => {
  stubFetch({
    "GET /repos/someone/notes/git/ref/heads/main": { object: { sha: "c" } },
    "GET /repos/someone/notes/git/commits/c": { tree: { sha: "t" } },
    "GET /repos/someone/notes/git/trees/t?recursive=1": { tree: [], truncated: true },
  });
  // Half a tree reads as "everything else was deleted", which would then be
  // pushed as a deletion.
  expect(new GitHubRemote(credentials).readTree()).rejects.toThrow(/too large/);
});

test("blob text is decoded from base64 UTF-8, and binary comes back as null", async () => {
  stubFetch({
    "GET /repos/someone/notes/git/blobs/text": { encoding: "base64", content: base64("café ☕\n") },
    "GET /repos/someone/notes/git/blobs/binary": { encoding: "base64", content: Buffer.from([0, 1, 2]).toString("base64") },
  });
  const remote = new GitHubRemote(credentials);
  expect(await remote.readBlobText("text")).toBe("café ☕\n");
  expect(await remote.readBlobText("binary")).toBeNull();
});

test("a push creates blobs for new text only, then one tree, commit and ref update", async () => {
  const calls = stubFetch({
    "GET /repos/someone/notes/git/ref/heads/main": { object: { sha: "oldcommit" } },
    "GET /repos/someone/notes/git/commits/oldcommit": { tree: { sha: "oldtree" } },
    "GET /repos/someone/notes/git/trees/oldtree?recursive=1": { tree: [] },
    "POST /repos/someone/notes/git/blobs": { sha: "newblob" },
    "POST /repos/someone/notes/git/trees": { sha: "newtree" },
    "POST /repos/someone/notes/git/commits": { sha: "newcommit" },
    "PATCH /repos/someone/notes/git/refs/heads/main": { object: { sha: "newcommit" } },
  });

  const remote = new GitHubRemote(credentials);
  await remote.readTree();
  const sha = await remote.commit(
    [
      { path: "new.md", mode: "100644", content: "written here" },
      { path: "unchanged.md", mode: "100644", sha: "existingblob" },
    ],
    "webfs sync",
    "oldcommit",
  );

  expect(sha).toBe("newcommit");
  const blobs = calls.filter(c => c.path.endsWith("/git/blobs"));
  // The unchanged file is referenced by sha; only the new text is uploaded.
  expect(blobs).toHaveLength(1);
  expect(Buffer.from(blobs[0]!.body.content, "base64").toString()).toBe("written here");

  const tree = calls.find(c => c.path.endsWith("/git/trees") && c.method === "POST")!;
  // No base_tree: the entry list is the complete desired state, which is what
  // makes a deletion just an absence.
  expect(tree.body.base_tree).toBeUndefined();
  expect(tree.body.tree).toEqual([
    { path: "new.md", mode: "100644", type: "blob", sha: "newblob" },
    { path: "unchanged.md", mode: "100644", type: "blob", sha: "existingblob" },
  ]);

  const commit = calls.find(c => c.path.endsWith("/git/commits") && c.method === "POST")!;
  expect(commit.body).toEqual({ message: "webfs sync", tree: "newtree", parents: ["oldcommit"] });

  const ref = calls.find(c => c.method === "PATCH")!;
  // force stays false so a branch that moved underneath us fails loudly
  // rather than losing the other writer's commit.
  expect(ref.body).toEqual({ sha: "newcommit", force: false });
});

test("the first commit to an empty repo has no parent and creates the ref", async () => {
  const calls = stubFetch({
    "GET /repos/someone/notes": { default_branch: "main" },
    "POST /repos/someone/notes/git/blobs": { sha: "blob" },
    "POST /repos/someone/notes/git/trees": { sha: "tree" },
    "POST /repos/someone/notes/git/commits": { sha: "commit" },
    "POST /repos/someone/notes/git/refs": { ref: "refs/heads/main" },
  });

  const remote = new GitHubRemote(credentials);
  await remote.readTree();
  await remote.commit([{ path: "a.md", mode: "100644", content: "hi" }], "webfs sync", null);

  expect(calls.find(c => c.path.endsWith("/git/commits"))!.body.parents).toEqual([]);
  // POST /git/refs, not PATCH: the branch doesn't exist to update.
  expect(calls.find(c => c.path.endsWith("/git/refs"))!.body).toEqual({ ref: "refs/heads/main", sha: "commit" });
});

test("pushing nothing is refused: an empty tree would wipe the branch", () => {
  stubFetch({});
  expect(new GitHubRemote(credentials).commit([], "webfs sync", "c")).rejects.toThrow(/empty tree/);
});

test("a branch name with slashes reaches the right ref", async () => {
  const calls = stubFetch({});
  const remote = new GitHubRemote({ ...credentials, branch: "notes/phone" });
  await remote.readTree().catch(() => {});
  // The slash inside the branch name stays a path separator; encoding it 404s.
  expect(calls[0]!.path).toBe("/repos/someone/notes/git/ref/heads/notes/phone");
});

test("failures explain themselves without ever quoting the token", async () => {
  stubFetch({ "GET /repos/someone/notes/git/ref/heads/main": 401 });
  const error = await new GitHubRemote(credentials).readTree().catch((err: GitHubError) => err);
  expect(error).toBeInstanceOf(GitHubError);
  expect((error as GitHubError).status).toBe(401);
  expect((error as GitHubError).message).toMatch(/rejected the token/);
  expect(JSON.stringify(error)).not.toContain("ghp_secret");
});

test("a repository the token can't see is reported as such", async () => {
  stubFetch({});
  expect(new GitHubRemote(credentials).checkAccess()).rejects.toThrow(/No such repository/);
});

test("an unreachable network is reported as unreachable, not as a crash", async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
  expect(new GitHubRemote(credentials).checkAccess()).rejects.toThrow(/Can't reach GitHub/);
});

test("decodeText is what keeps a pull from corrupting a non-text file", () => {
  expect(decodeText(new TextEncoder().encode("# notes"))).toBe("# notes");
  expect(decodeText(new Uint8Array([0xc3, 0x28]))).toBeNull();
});
