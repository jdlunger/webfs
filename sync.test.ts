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
import { commitTitle, conflictCopyPath, planSync, syncOnce, type LocalFs, type ShaMap, type SyncState } from "./src/sync";
import { decodeText, gitBlobSha, type CommitEntry, type Remote, type RemoteTree } from "./src/github";
import type { Bytes } from "./src/storage";

const enc = (text: string): Bytes => new TextEncoder().encode(text);
const dec = (bytes: Bytes) => new TextDecoder().decode(bytes);

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
/**
 * An in-memory store. It holds text for readability, and converts at the
 * edges — the interface deals in bytes, which is what the real store does.
 * `bytes` is for the cases that are genuinely about binary.
 */
function fakeLocal(files: Record<string, string>, bytes: Record<string, Bytes> = {}) {
  const store = {
    files,
    bytes,
    read: async () => {
      const out: Record<string, Bytes> = { ...store.bytes };
      for (const [path, text] of Object.entries(store.files)) out[path] = enc(text);
      return out;
    },
    write: async (path: string, content: Bytes) => {
      const text = decodeText(content);
      if (text === null) store.bytes[path] = content;
      else store.files[path] = text;
    },
    remove: async (path: string) => {
      delete store.files[path];
      delete store.bytes[path];
    },
  };
  return store satisfies LocalFs & { files: Record<string, string>; bytes: Record<string, Bytes> };
}

/** An in-memory branch standing in for a repository. */
class FakeRemote implements Remote {
  readonly blobs = new Map<string, Bytes>();
  files: Record<string, string>;
  commitSha: string | null;
  commits: Array<{ message: string; parent: string | null; files: Record<string, Bytes> }> = [];

  constructor(files: Record<string, string> = {}, commitSha: string | null = files ? "commit0" : null) {
    this.files = files;
    this.commitSha = Object.keys(files).length === 0 ? commitSha : commitSha;
  }

  /** Everything the branch holds, as bytes — text files included. */
  private all(): Record<string, Bytes> {
    return { ...this.rawFiles, ...Object.fromEntries(Object.entries(this.files).map(([p, t]) => [p, enc(t)])) };
  }

  /** Non-text files on the branch, kept as bytes. */
  rawFiles: Record<string, Bytes> = {};

  async tree(): Promise<ShaMap> {
    const out: ShaMap = {};
    for (const [path, content] of Object.entries(this.all())) out[path] = await gitBlobSha(content);
    return out;
  }

  async readTree(): Promise<RemoteTree> {
    const entries = await Promise.all(
      Object.entries(this.all()).map(async ([path, content]) => {
        const sha = await gitBlobSha(content);
        this.blobs.set(sha, content);
        return { path, mode: "100644", type: "blob", sha };
      }),
    );
    return { commitSha: this.commitSha, entries };
  }

  async readBlobBytes(sha: string): Promise<Bytes> {
    const content = this.blobs.get(sha);
    if (content === undefined) throw new Error(`no such blob ${sha}`);
    return content;
  }

  async readBlobText(sha: string): Promise<string | null> {
    return decodeText(await this.readBlobBytes(sha));
  }

  async commit(entries: CommitEntry[], message: string, parent: string | null): Promise<string> {
    const files: Record<string, string> = {};
    const raw: Record<string, Bytes> = {};
    const snapshot: Record<string, Bytes> = {};
    for (const entry of entries) {
      const content = "content" in entry ? entry.content : this.blobs.get(entry.sha);
      if (content === undefined) throw new Error(`commit referenced an unknown blob: ${entry.path}`);
      const bytes = typeof content === "string" ? enc(content) : content;
      const text = decodeText(bytes);
      if (text === null) raw[entry.path] = bytes;
      else files[entry.path] = text;
      snapshot[entry.path] = bytes;
      this.blobs.set(await gitBlobSha(bytes), bytes);
    }
    this.files = files;
    this.rawFiles = raw;
    this.commitSha = `commit${this.commits.length + 1}`;
    this.commits.push({ message, parent, files: { ...snapshot } });
    return this.commitSha;
  }
}

const EMPTY: SyncState = { files: {} };

test("a first sync of a fresh repo pushes the whole store as one commit", async () => {
  const local = fakeLocal({ "Notes/todo.md": "- [ ] one", "Notes/welcome.md": "# hi" });
  const remote = new FakeRemote({}, null);

  const result = await syncOnce(local, remote, EMPTY);

  expect(remote.files).toEqual({ "Notes/todo.md": "- [ ] one", "Notes/welcome.md": "# hi" });
  expect(remote.commits).toHaveLength(1);
  expect(remote.commits[0]!.parent).toBeNull();
  expect(result.summary.pushed.sort()).toEqual(["Notes/todo.md", "Notes/welcome.md"]);
  expect(result.state.files).toEqual(await remote.tree());
});

test("a fresh browser fills itself from the repo without pushing anything", async () => {
  const local = fakeLocal({});
  const remote = new FakeRemote({ "a.md": "remote text" });

  const result = await syncOnce(local, remote, EMPTY);

  expect(local.files).toEqual({ "a.md": "remote text" });
  expect(remote.commits).toHaveLength(0);
  expect(result.written).toEqual([{ path: "a.md", content: "remote text" }]);
});

test("a second sync with nothing changed is a no-op", async () => {
  const local = fakeLocal({ "a.md": "text" });
  const remote = new FakeRemote({ "a.md": "text" });

  const first = await syncOnce(local, remote, EMPTY);
  const second = await syncOnce(local, remote, first.state);

  expect(remote.commits).toHaveLength(0);
  expect(second.written).toEqual([]);
  expect(second.removed).toEqual([]);
});

test("edits on both sides of a shared base are merged, and the merge is pushed", async () => {
  const local = fakeLocal({ "a.md": "intro\nbody" });
  const remote = new FakeRemote({ "a.md": "intro\nbody" });
  const base = (await syncOnce(local, remote, EMPTY)).state;

  local.files["a.md"] = "intro edited\nbody";
  remote.files["a.md"] = "intro\nbody\nappended on another device";

  const result = await syncOnce(local, remote, base);

  const merged = "intro edited\nbody\nappended on another device";
  expect(local.files["a.md"]).toBe(merged);
  expect(remote.files["a.md"]).toBe(merged);
  expect(result.summary.merged).toEqual(["a.md"]);
});

test("files that share only a name keep both copies rather than one overwriting the other", async () => {
  const local = fakeLocal({ "notes.md": "written here" });
  const remote = new FakeRemote({ "notes.md": "written on GitHub" });

  const result = await syncOnce(local, remote, EMPTY);

  expect(local.files["notes.md"]).toBe("written here");
  expect(local.files["notes (github).md"]).toBe("written on GitHub");
  expect(remote.files).toEqual({ "notes.md": "written here", "notes (github).md": "written on GitHub" });
  expect(result.summary.conflicted).toEqual([{ path: "notes.md", keptAs: "notes (github).md" }]);
});

test("a deletion here deletes there, and a deletion there deletes here", async () => {
  const files = { "gone-here.md": "x", "gone-there.md": "y", "kept.md": "z" };
  const local = fakeLocal({ ...files });
  const remote = new FakeRemote({ ...files });
  const base = (await syncOnce(local, remote, EMPTY)).state;

  delete local.files["gone-here.md"];
  delete remote.files["gone-there.md"];

  const result = await syncOnce(local, remote, base);

  expect(Object.keys(local.files)).toEqual(["kept.md"]);
  expect(Object.keys(remote.files)).toEqual(["kept.md"]);
  expect(result.summary.deletedRemote).toEqual(["gone-here.md"]);
  expect(result.summary.deletedLocal).toEqual(["gone-there.md"]);
});

test("a file deleted on GitHub but edited here comes back rather than vanishing", async () => {
  const local = fakeLocal({ "a.md": "original" });
  const remote = new FakeRemote({ "a.md": "original" });
  const base = (await syncOnce(local, remote, EMPTY)).state;

  local.files["a.md"] = "edited while offline";
  remote.files = {};

  await syncOnce(local, remote, base);

  expect(local.files["a.md"]).toBe("edited while offline");
  expect(remote.files["a.md"]).toBe("edited while offline");
});

// A pasted image is a real file in the store now, so it has to survive the
// round trip byte for byte — decoding it as text anywhere would replace bytes
// with U+FFFD and push the damage back.
const PNG: Bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xfe, 0xff]);

test("a binary file is pushed byte for byte, not mangled into text", async () => {
  const local = fakeLocal({ "note.md": "see below" }, { "assets/shot.png": PNG });
  const remote = new FakeRemote({});

  await syncOnce(local, remote, EMPTY);

  expect([...remote.rawFiles["assets/shot.png"]!]).toEqual([...PNG]);
  expect(await gitBlobSha(remote.rawFiles["assets/shot.png"]!)).toBe(await gitBlobSha(PNG));
});

test("a binary file added on GitHub is pulled byte for byte", async () => {
  const local = fakeLocal({ "note.md": "text" });
  const remote = new FakeRemote({ "note.md": "text" });
  remote.rawFiles["assets/shot.png"] = PNG;

  const result = await syncOnce(local, remote, EMPTY);

  expect([...local.bytes["assets/shot.png"]!]).toEqual([...PNG]);
  // Nothing for the editor to show, but the tree still has to be re-read.
  expect(result.written.find(w => w.path === "assets/shot.png")!.content).toBeNull();
});

test("an unchanged binary file doesn't churn on the next sync", async () => {
  const local = fakeLocal({ "note.md": "text" }, { "assets/shot.png": PNG });
  const remote = new FakeRemote({});
  const base = (await syncOnce(local, remote, EMPTY)).state;

  const before = remote.commits.length;
  await syncOnce(local, remote, base);

  expect(remote.commits.length).toBe(before);
});

test("a binary file changed on both sides keeps both rather than merging", async () => {
  const local = fakeLocal({ "note.md": "text" }, { "shot.png": PNG });
  const remote = new FakeRemote({ "note.md": "text" });
  remote.rawFiles["shot.png"] = PNG;
  const base = (await syncOnce(local, remote, EMPTY)).state;

  // Two different edits of the same image: there is no middle ground, and
  // picking a side would lose the other outright.
  local.bytes["shot.png"] = new Uint8Array([...PNG, 0x01]) as Bytes;
  remote.rawFiles["shot.png"] = new Uint8Array([...PNG, 0x02]) as Bytes;

  const result = await syncOnce(local, remote, base);

  expect(result.summary.conflicted).toEqual([{ path: "shot.png", keptAs: "shot (github).png" }]);
  expect([...local.bytes["shot.png"]!]).toEqual([...PNG, 0x01]);
  expect([...local.bytes["shot (github).png"]!]).toEqual([...PNG, 0x02]);
});

test("text files still merge normally alongside binary ones", async () => {
  const local = fakeLocal({ "note.md": "intro\nbody" }, { "shot.png": PNG });
  const remote = new FakeRemote({ "note.md": "intro\nbody" });
  remote.rawFiles["shot.png"] = PNG;
  const base = (await syncOnce(local, remote, EMPTY)).state;

  local.files["note.md"] = "intro edited\nbody";
  remote.files["note.md"] = "intro\nbody\nappended";

  const result = await syncOnce(local, remote, base);

  expect(result.summary.merged).toEqual(["note.md"]);
  expect(local.files["note.md"]).toBe("intro edited\nbody\nappended");
});

test("a store that lost its data refills from the repo instead of emptying it", async () => {
  const local = fakeLocal({ "a.md": "text", "b.md": "more" });
  const remote = new FakeRemote({ "a.md": "text", "b.md": "more" });
  const base = (await syncOnce(local, remote, EMPTY)).state;

  // What OPFS eviction looks like: the files are gone but the base snapshot
  // in localStorage still lists them, which naively reads as two deletions.
  local.files = {};

  const result = await syncOnce(local, remote, base);

  expect(local.files).toEqual({ "a.md": "text", "b.md": "more" });
  expect(remote.files).toEqual({ "a.md": "text", "b.md": "more" });
  expect(remote.commits).toHaveLength(0);
  expect(result.summary.deletedRemote).toEqual([]);
});


test("entries webfs can't represent survive a push that rewrites the tree", async () => {
  const local = fakeLocal({ "a.md": "text" });
  const remote = new FakeRemote({ "a.md": "text" });
  // A submodule: not a blob, and nothing webfs could store even if it were.
  remote.blobs.set("deadbeef", enc("<a submodule pointer>"));
  remote.blobs.set(await gitBlobSha("text"), enc("text"));
  remote.readTree = async () => ({
    commitSha: "commit0",
    entries: [
      { path: "a.md", mode: "100644", type: "blob", sha: await gitBlobSha("text") },
      { path: "vendor/lib", mode: "160000", type: "commit", sha: "deadbeef" },
    ],
  });

  local.files["b.md"] = "new file";
  await syncOnce(local, remote, EMPTY);

  // The push sends the complete tree, so anything not carried over would be
  // silently deleted from the repository.
  expect(dec(remote.commits[0]!.files["vendor/lib"]!)).toBe("<a submodule pointer>");
  expect(dec(remote.commits[0]!.files["b.md"]!)).toBe("new file");
});

// --- commit titles ----------------------------------------------------------

const at = new Date(2026, 8, 21, 14, 32); // 21 September 2026, 14:32 local

test("a commit title says when it happened and which file it was", () => {
  expect(commitTitle(["Notes/todo.md"], at)).toBe("2026-09-21 14:32 Notes/todo.md");
});

test("several files are named by the first, with an ellipsis for the rest", () => {
  expect(commitTitle(["Notes/todo.md", "Notes/welcome.md"], at)).toBe("2026-09-21 14:32 Notes/todo.md …");
});

test("the file named is stable regardless of the order changes were found in", () => {
  const forwards = commitTitle(["a.md", "b.md", "c.md"], at);
  const backwards = commitTitle(["c.md", "b.md", "a.md"], at);
  expect(forwards).toBe(backwards);
  expect(forwards).toBe("2026-09-21 14:32 a.md …");
});

test("months, days, hours and minutes are all zero-padded", () => {
  expect(commitTitle(["a.md"], new Date(2026, 0, 5, 9, 7))).toBe("2026-01-05 09:07 a.md");
});

test("a title still reads sensibly if nothing was named", () => {
  expect(commitTitle([], at)).toBe("2026-09-21 14:32 sync");
});

test("the title on a real push names the file that changed", async () => {
  const local = fakeLocal({ "Notes/todo.md": "one", "Notes/welcome.md": "hi" });
  const remote = new FakeRemote({ "Notes/todo.md": "one", "Notes/welcome.md": "hi" });
  const base = (await syncOnce(local, remote, EMPTY)).state;

  local.files["Notes/todo.md"] = "one, edited";
  await syncOnce(local, remote, base);

  // Only todo.md differs from the branch, so it alone is named — no ellipsis,
  // even though the tree being pushed contains both files.
  expect(remote.commits.at(-1)!.message).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} Notes\/todo\.md$/);
});

test("a deletion is a change worth naming in the title", async () => {
  const local = fakeLocal({ "a.md": "one", "b.md": "two" });
  const remote = new FakeRemote({ "a.md": "one", "b.md": "two" });
  const base = (await syncOnce(local, remote, EMPTY)).state;

  delete local.files["b.md"];
  await syncOnce(local, remote, base);

  expect(remote.commits.at(-1)!.message).toContain("b.md");
});
