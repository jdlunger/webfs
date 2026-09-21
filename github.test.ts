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
import { GitHubError, GitHubRemote, decodeText, gitBlobSha } from "./src/github";

interface Call {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
  cache?: RequestCache;
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
      cache: init.cache,
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

test("blob shas over raw bytes match git too, not just text", async () => {
  // $ printf '\x89PNG\x0d\x0a\x1a\x0a\x00\x01\xfe\xff' > shot.png && git hash-object shot.png
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xfe, 0xff]);
  expect(await gitBlobSha(png)).toBe("9714067f58f8ff1bf97bed9bba57c23411963535");
  // The bytes decide, not their spelling: an image and its base64 are
  // different files, and hashing the wrong one would sync the wrong thing.
  expect(await gitBlobSha(png)).not.toBe(await gitBlobSha(Buffer.from(png).toString("base64")));
});

test("a binary blob is uploaded as its own bytes, not as text", async () => {
  const calls = stubFetch({
    "GET /repos/someone/notes/git/ref/heads/main": { object: { sha: "c" } },
    "GET /repos/someone/notes/git/commits/c": { tree: { sha: "t" } },
    "GET /repos/someone/notes/git/trees/t?recursive=1": { tree: [] },
    "POST /repos/someone/notes/git/blobs": { sha: "blob" },
    "POST /repos/someone/notes/git/trees": { sha: "tree" },
    "POST /repos/someone/notes/git/commits": { sha: "commit" },
    "PATCH /repos/someone/notes/git/refs/heads/main": { object: { sha: "commit" } },
  });

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xfe, 0xff]);
  const remote = new GitHubRemote(credentials);
  await remote.readTree();
  await remote.commit([{ path: "assets/shot.png", mode: "100644", content: png }], "webfs sync", "c");

  const uploaded = calls.find(c => c.path.endsWith("/git/blobs") && c.method === "POST")!;
  expect(uploaded.body.encoding).toBe("base64");
  expect([...Buffer.from(uploaded.body.content, "base64")]).toEqual([...png]);
});

test("a blob that came back as bytes round-trips through readBlobBytes", async () => {
  const png = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80]);
  stubFetch({
    "GET /repos/someone/notes/git/blobs/b": { encoding: "base64", content: Buffer.from(png).toString("base64") },
  });
  const remote = new GitHubRemote(credentials);
  expect([...(await remote.readBlobBytes("b"))]).toEqual([...png]);
  // The same blob as text is null, which is how sync knows not to merge it.
  expect(await remote.readBlobText("b")).toBeNull();
});

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

// A brand-new repository — the "create a repo, then point webfs at it" case.
// GitHub answers ref lookups on a repository with no commits with 409, not
// 404: its git endpoints have no history to talk about. Stubbing this as a
// 404 (which is what a missing branch in a *populated* repo returns) is what
// let a broken empty-repo path pass its own test — syncing to a fresh repo
// threw instead of making an initial commit.
test("a repository with no commits at all syncs as an empty tree", async () => {
  stubFetch({
    "GET /repos/someone/notes": { default_branch: "main" },
    "GET /repos/someone/notes/git/ref/heads/main": 409,
  });
  const tree = await new GitHubRemote(credentials).readTree();
  expect(tree).toEqual({ commitSha: null, entries: [] });
});

// An empty repository cannot be written to with the git-object endpoints at
// all. They 409 while there is no history, and GitHub refuses ref creation
// outright: "You are unable to create new references for empty repositories,
// even if the commit SHA-1 hash used exists." So this fake refuses both, and
// only the Contents API works — exactly as the real thing behaves.
function stubEmptyRepo(extra: Record<string, unknown> = {}) {
  return stubFetch({
    "GET /repos/someone/notes": { default_branch: "main" },
    "GET /repos/someone/notes/git/ref/heads/main": 409,
    "POST /repos/someone/notes/git/blobs": 409,
    "POST /repos/someone/notes/git/trees": 409,
    "POST /repos/someone/notes/git/commits": 409,
    "POST /repos/someone/notes/git/refs": 422,
    ...extra,
  });
}

test("an empty repository is started through the Contents API, not git objects", async () => {
  const calls = stubEmptyRepo({
    "PUT /repos/someone/notes/contents/Notes/welcome.md": { commit: { sha: "firstcommit" } },
  });

  const remote = new GitHubRemote(credentials);
  const tree = await remote.readTree();
  expect(tree.commitSha).toBeNull();

  const sha = await remote.commit(
    [{ path: "Notes/welcome.md", mode: "100644", content: "# hi" }],
    "webfs sync",
    tree.commitSha,
  );

  expect(sha).toBe("firstcommit");
  const put = calls.find(c => c.method === "PUT")!;
  expect(Buffer.from(put.body.content, "base64").toString()).toBe("# hi");
  expect(put.body.branch).toBe("main");
  // A single file is the whole tree, so nothing else is needed.
  expect(calls.some(c => c.path.endsWith("/git/trees"))).toBe(false);
  expect(calls.some(c => c.path.endsWith("/git/refs"))).toBe(false);
});

test("the rest of an empty repository's files follow as a normal commit", async () => {
  const calls = stubEmptyRepo({
    "PUT /repos/someone/notes/contents/a.md": { commit: { sha: "firstcommit" } },
    // Reachable only once the repo has a commit, which is the point.
    "POST /repos/someone/notes/git/blobs": { sha: "blob" },
    "POST /repos/someone/notes/git/trees": { sha: "tree" },
    "POST /repos/someone/notes/git/commits": { sha: "secondcommit" },
    "PATCH /repos/someone/notes/git/refs/heads/main": { object: { sha: "secondcommit" } },
  });

  const remote = new GitHubRemote(credentials);
  const tree = await remote.readTree();
  const sha = await remote.commit(
    [
      { path: "a.md", mode: "100644", content: "one" },
      { path: "b.md", mode: "100644", content: "two" },
    ],
    "webfs sync",
    tree.commitSha,
  );

  expect(sha).toBe("secondcommit");
  // Parented on the bootstrap commit, not parentless: the branch now exists.
  expect(calls.find(c => c.path.endsWith("/git/commits"))!.body.parents).toEqual(["firstcommit"]);
  // And updated, never created — creating a ref is what GitHub refuses here.
  expect(calls.some(c => c.method === "PATCH")).toBe(true);
  expect(calls.some(c => c.path.endsWith("/git/refs") && c.method === "POST")).toBe(false);
});

test("a file path's directories survive encoding into the Contents URL", async () => {
  const calls = stubEmptyRepo({
    "PUT /repos/someone/notes/contents/My%20Notes/caf%C3%A9.md": { commit: { sha: "c" } },
  });
  const remote = new GitHubRemote(credentials);
  await remote.commit([{ path: "My Notes/café.md", mode: "100644", content: "x" }], "webfs sync", (await remote.readTree()).commitSha);
  // The slash stays a separator; everything else is percent-encoded.
  expect(calls.find(c => c.method === "PUT")!.path).toBe("/repos/someone/notes/contents/My%20Notes/caf%C3%A9.md");
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

test("API reads never come from the browser's HTTP cache", async () => {
  const calls = stubFetch({
    "GET /repos/someone/notes/git/ref/heads/main": { object: { sha: "c" } },
    "GET /repos/someone/notes/git/commits/c": { tree: { sha: "t" } },
    "GET /repos/someone/notes/git/trees/t?recursive=1": { tree: [] },
  });

  await new GitHubRemote(credentials).readTree();

  // GitHub sends `cache-control: private, max-age=60`, so a cached branch
  // head can be a minute old. The push parents its commit on whatever this
  // read returned, and a stale parent makes the ref update a non-fast-forward
  // — a 422 that retrying cannot clear, because the retry reads the same
  // stale answer.
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call.cache).toBe("no-store");
});

test("a failure carries GitHub's own words, not just our summary of them", async () => {
  // The one thing that actually identifies an unexpected failure. A canned
  // message with only a status code sent a real bug report back as "odd
  // state (409)" when GitHub had said exactly what was wrong.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Git Repository is empty." }), { status: 409 })) as unknown as typeof fetch;

  const error = await new GitHubRemote(credentials)
    .commit([{ path: "a.md", mode: "100644", sha: "x" }], "webfs sync", "c")
    .catch((err: GitHubError) => err);

  expect((error as GitHubError).message).toContain("Git Repository is empty.");
  expect((error as GitHubError).status).toBe(409);
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
