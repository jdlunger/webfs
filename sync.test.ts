/**
 * Covers the GitHub sync: the per-path decision table, the blob hashing the
 * whole comparison rests on, and a full pass driven against an in-memory
 * "GitHub" and an in-memory store.
 *
 * Nothing here touches the network or OPFS — `syncOnce` takes both as
 * interfaces precisely so the interesting half can be tested headless. What
 * that leaves untested is the REST wiring in github.ts, which is verified by
 * pointing a browser at a real repository.
 */
import { test, expect } from "bun:test";
import { conflictCopyPath, planSync, syncOnce, type LocalFs, type ShaMap, type SyncState } from "./src/sync";
import { decodeText, gitBlobSha, type CommitEntry, type Remote, type RemoteTree } from "./src/github";

// --- git blob hashing --------------------------------------------------------

test("blob shas match the ones git itself computes", async () => {
  // $ printf 'hello' | git hash-object --stdin
  expect(await gitBlobSha("hello")).toBe("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
  expect(await gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  // Hashing is over UTF-8 bytes, not characters, or every non-ASCII note
  // would look changed on every sync.
  expect(await gitBlobSha("café\n")).toBe("572eb43fe8e34fb87d01c69e01151ff696022924");
});

test("binary content is reported as untouchable rather than mangled", () => {
  expect(decodeText(new TextEncoder().encode("plain text"))).toBe("plain text");
  expect(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))).toBeNull();
  expect(decodeText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
});

// --- the decision table ------------------------------------------------------

const shas = (paths: Record<string, string>): ShaMap => paths;

test("a file only one side has is created on the other", () => {
  expect(planSync({}, shas({ "a.md": "1" }), {}).push).toEqual(["a.md"]);
  expect(planSync({}, {}, shas({ "b.md": "2" })).pull).toEqual(["b.md"]);
});

test("a file changed on one side only moves in that direction", () => {
  const base = shas({ "a.md": "1" });
  expect(planSync(base, shas({ "a.md": "2" }), shas({ "a.md": "1" })).push).toEqual(["a.md"]);
  expect(planSync(base, shas({ "a.md": "1" }), shas({ "a.md": "2" })).pull).toEqual(["a.md"]);
});

test("a file changed on both sides is merged, not picked", () => {
  const plan = planSync(shas({ "a.md": "1" }), shas({ "a.md": "2" }), shas({ "a.md": "3" }));
  expect(plan.merge).toEqual(["a.md"]);
  expect(plan.push).toEqual([]);
  expect(plan.pull).toEqual([]);
});

test("two unrelated files at one path are a conflict, since there's nothing to merge from", () => {
  expect(planSync({}, shas({ "a.md": "2" }), shas({ "a.md": "3" })).conflict).toEqual(["a.md"]);
});

test("a deletion propagates only when the other side didn't touch the file", () => {
  const base = shas({ "a.md": "1" });
  expect(planSync(base, {}, shas({ "a.md": "1" })).deleteRemote).toEqual(["a.md"]);
  expect(planSync(base, shas({ "a.md": "1" }), {}).deleteLocal).toEqual(["a.md"]);
});

test("an edit beats a deletion, on either side", () => {
  const base = shas({ "a.md": "1" });
  // Deleted on GitHub, edited here: the edit comes back on the next push.
  expect(planSync(base, shas({ "a.md": "2" }), {}).push).toEqual(["a.md"]);
  // Deleted here, edited on GitHub: the edit comes back into the store.
  expect(planSync(base, {}, shas({ "a.md": "2" })).pull).toEqual(["a.md"]);
});

test("identical files on both sides are left alone whatever the base says", () => {
  const plan = planSync(shas({ "a.md": "old" }), shas({ "a.md": "same" }), shas({ "a.md": "same" }));
  expect(plan).toEqual({ pull: [], push: [], merge: [], conflict: [], deleteLocal: [], deleteRemote: [] });
});

test("a conflict copy sidesteps names already in use", () => {
  expect(conflictCopyPath("Notes/todo.md", new Set())).toBe("Notes/todo (github).md");
  expect(conflictCopyPath("Notes/todo.md", new Set(["Notes/todo (github).md"]))).toBe("Notes/todo (github 2).md");
  expect(conflictCopyPath("LICENSE", new Set())).toBe("LICENSE (github)");
});

// --- a full pass -------------------------------------------------------------

/** An in-memory store standing in for OPFS. */
function fakeLocal(files: Record<string, string>): LocalFs & { files: Record<string, string> } {
  // Reads go through `store.files`, not the argument, so a test can replace
  // the whole store (as an evicted OPFS would).
  const store: LocalFs & { files: Record<string, string> } = {
    files,
    read: async () => ({ ...store.files }),
    write: async (path, content) => {
      store.files[path] = content;
    },
    remove: async path => {
      delete store.files[path];
    },
  };
  return store;
}

/** An in-memory branch standing in for a repository. */
class FakeRemote implements Remote {
  readonly blobs = new Map<string, string>();
  files: Record<string, string>;
  commitSha: string | null;
  commits: Array<{ message: string; parent: string | null; files: Record<string, string> }> = [];
  /** Paths whose blob should read back as binary. */
  binary = new Set<string>();

  constructor(files: Record<string, string> = {}, commitSha: string | null = files ? "commit0" : null) {
    this.files = files;
    this.commitSha = Object.keys(files).length === 0 ? commitSha : commitSha;
  }

  async tree(): Promise<ShaMap> {
    const out: ShaMap = {};
    for (const [path, content] of Object.entries(this.files)) out[path] = await gitBlobSha(content);
    return out;
  }

  async readTree(): Promise<RemoteTree> {
    const entries = await Promise.all(
      Object.entries(this.files).map(async ([path, content]) => {
        const sha = await gitBlobSha(content);
        this.blobs.set(sha, content);
        return { path, mode: "100644", type: "blob", sha };
      }),
    );
    return { commitSha: this.commitSha, entries };
  }

  async readBlobText(sha: string): Promise<string | null> {
    const content = this.blobs.get(sha);
    if (content === undefined) throw new Error(`no such blob ${sha}`);
    for (const path of this.binary) {
      if (this.files[path] === content) return null;
    }
    return content;
  }

  async commit(entries: CommitEntry[], message: string, parent: string | null): Promise<string> {
    const files: Record<string, string> = {};
    for (const entry of entries) {
      const content = "content" in entry ? entry.content : this.blobs.get(entry.sha);
      if (content === undefined) throw new Error(`commit referenced an unknown blob: ${entry.path}`);
      files[entry.path] = content;
      this.blobs.set(await gitBlobSha(content), content);
    }
    this.files = files;
    this.commitSha = `commit${this.commits.length + 1}`;
    this.commits.push({ message, parent, files: { ...files } });
    return this.commitSha;
  }
}

const EMPTY: SyncState = { commitSha: null, files: {} };

test("a first sync of a fresh repo pushes the whole store as one commit", async () => {
  const local = fakeLocal({ "Notes/todo.md": "- [ ] one", "Notes/welcome.md": "# hi" });
  const remote = new FakeRemote({}, null);

  const result = await syncOnce(local, remote, EMPTY, "webfs sync");

  expect(remote.files).toEqual({ "Notes/todo.md": "- [ ] one", "Notes/welcome.md": "# hi" });
  expect(remote.commits).toHaveLength(1);
  expect(remote.commits[0]!.parent).toBeNull();
  expect(result.summary.pushed.sort()).toEqual(["Notes/todo.md", "Notes/welcome.md"]);
  expect(result.state.files).toEqual(await remote.tree());
});

test("a fresh browser fills itself from the repo without pushing anything", async () => {
  const local = fakeLocal({});
  const remote = new FakeRemote({ "a.md": "remote text" });

  const result = await syncOnce(local, remote, EMPTY, "webfs sync");

  expect(local.files).toEqual({ "a.md": "remote text" });
  expect(remote.commits).toHaveLength(0);
  expect(result.written).toEqual([{ path: "a.md", content: "remote text" }]);
});

test("a second sync with nothing changed is a no-op", async () => {
  const local = fakeLocal({ "a.md": "text" });
  const remote = new FakeRemote({ "a.md": "text" });

  const first = await syncOnce(local, remote, EMPTY, "webfs sync");
  const second = await syncOnce(local, remote, first.state, "webfs sync");

  expect(remote.commits).toHaveLength(0);
  expect(second.written).toEqual([]);
  expect(second.removed).toEqual([]);
});

test("edits on both sides of a shared base are merged, and the merge is pushed", async () => {
  const local = fakeLocal({ "a.md": "intro\nbody" });
  const remote = new FakeRemote({ "a.md": "intro\nbody" });
  const base = (await syncOnce(local, remote, EMPTY, "webfs sync")).state;

  local.files["a.md"] = "intro edited\nbody";
  remote.files["a.md"] = "intro\nbody\nappended on another device";

  const result = await syncOnce(local, remote, base, "webfs sync");

  const merged = "intro edited\nbody\nappended on another device";
  expect(local.files["a.md"]).toBe(merged);
  expect(remote.files["a.md"]).toBe(merged);
  expect(result.summary.merged).toEqual(["a.md"]);
});

test("files that share only a name keep both copies rather than one overwriting the other", async () => {
  const local = fakeLocal({ "notes.md": "written here" });
  const remote = new FakeRemote({ "notes.md": "written on GitHub" });

  const result = await syncOnce(local, remote, EMPTY, "webfs sync");

  expect(local.files["notes.md"]).toBe("written here");
  expect(local.files["notes (github).md"]).toBe("written on GitHub");
  expect(remote.files).toEqual({ "notes.md": "written here", "notes (github).md": "written on GitHub" });
  expect(result.summary.conflicted).toEqual([{ path: "notes.md", keptAs: "notes (github).md" }]);
});

test("a deletion here deletes there, and a deletion there deletes here", async () => {
  const files = { "gone-here.md": "x", "gone-there.md": "y", "kept.md": "z" };
  const local = fakeLocal({ ...files });
  const remote = new FakeRemote({ ...files });
  const base = (await syncOnce(local, remote, EMPTY, "webfs sync")).state;

  delete local.files["gone-here.md"];
  delete remote.files["gone-there.md"];

  const result = await syncOnce(local, remote, base, "webfs sync");

  expect(Object.keys(local.files)).toEqual(["kept.md"]);
  expect(Object.keys(remote.files)).toEqual(["kept.md"]);
  expect(result.summary.deletedRemote).toEqual(["gone-here.md"]);
  expect(result.summary.deletedLocal).toEqual(["gone-there.md"]);
});

test("a file deleted on GitHub but edited here comes back rather than vanishing", async () => {
  const local = fakeLocal({ "a.md": "original" });
  const remote = new FakeRemote({ "a.md": "original" });
  const base = (await syncOnce(local, remote, EMPTY, "webfs sync")).state;

  local.files["a.md"] = "edited while offline";
  remote.files = {};

  await syncOnce(local, remote, base, "webfs sync");

  expect(local.files["a.md"]).toBe("edited while offline");
  expect(remote.files["a.md"]).toBe("edited while offline");
});

test("non-text files are left untouched on both sides, not pulled or corrupted", async () => {
  const local = fakeLocal({ "a.md": "text" });
  const remote = new FakeRemote({ "a.md": "text", "logo.png": "\u0000binary-ish" });
  remote.binary.add("logo.png");

  const result = await syncOnce(local, remote, EMPTY, "webfs sync");

  expect(local.files["logo.png"]).toBeUndefined();
  expect(remote.files["logo.png"]).toBe("\u0000binary-ish");
  expect(result.summary.skipped).toEqual(["logo.png"]);
  expect(result.state.files["logo.png"]).toBeUndefined();
});

test("a store that lost its data refills from the repo instead of emptying it", async () => {
  const local = fakeLocal({ "a.md": "text", "b.md": "more" });
  const remote = new FakeRemote({ "a.md": "text", "b.md": "more" });
  const base = (await syncOnce(local, remote, EMPTY, "webfs sync")).state;

  // What OPFS eviction looks like: the files are gone but the base snapshot
  // in localStorage still lists them, which naively reads as two deletions.
  local.files = {};

  const result = await syncOnce(local, remote, base, "webfs sync");

  expect(local.files).toEqual({ "a.md": "text", "b.md": "more" });
  expect(remote.files).toEqual({ "a.md": "text", "b.md": "more" });
  expect(remote.commits).toHaveLength(0);
  expect(result.summary.deletedRemote).toEqual([]);
});


test("entries webfs can't represent survive a push that rewrites the tree", async () => {
  const local = fakeLocal({ "a.md": "text" });
  const remote = new FakeRemote({ "a.md": "text" });
  // A submodule: not a blob, and nothing webfs could store even if it were.
  remote.blobs.set("deadbeef", "<a submodule pointer>");
  remote.blobs.set(await gitBlobSha("text"), "text");
  remote.readTree = async () => ({
    commitSha: "commit0",
    entries: [
      { path: "a.md", mode: "100644", type: "blob", sha: await gitBlobSha("text") },
      { path: "vendor/lib", mode: "160000", type: "commit", sha: "deadbeef" },
    ],
  });

  local.files["b.md"] = "new file";
  await syncOnce(local, remote, EMPTY, "webfs sync");

  // The push sends the complete tree, so anything not carried over would be
  // silently deleted from the repository.
  expect(remote.commits[0]!.files["vendor/lib"]).toBe("<a submodule pointer>");
  expect(remote.commits[0]!.files["b.md"]).toBe("new file");
});
