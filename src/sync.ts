/**
 * Two-way sync between the OPFS store and a branch on GitHub.
 *
 * The model is three-way, exactly like the cross-tab merge in merge.ts, only
 * with the other tab replaced by a git branch:
 *
 *   base   what this browser last saw *and* last pushed — a path → blob-sha
 *          snapshot, kept in localStorage (syncConfig.ts)
 *   local  what's in OPFS right now
 *   remote what's on the branch right now
 *
 * Comparing all three is what tells a deletion apart from a file that simply
 * never existed here, and a local edit apart from a remote one. Two-way sync
 * without a base can only ever guess.
 *
 * Nothing is compared by content: git's blob sha is a content hash, the tree
 * listing hands one over for every remote file, and `gitBlobSha` computes the
 * same hash locally. A sync that finds nothing to do downloads one tree
 * listing and no file contents at all.
 *
 * After a successful sync the branch's tree *is* the local tree, so the push
 * sends the complete desired tree and lets deletions fall out of absence
 * rather than being tracked separately.
 */
import { FILE_MODE, decodeText, gitBlobSha, type CommitEntry, type Remote, type RemoteEntry } from "./github";
import { mergeText } from "./merge";
import type { Bytes, Store, WalkEntry } from "./storage";
import { segmentsOf } from "./fs";

/** path → git blob sha. */
export type ShaMap = Record<string, string>;

export interface SyncState {
  /** The base of the three-way compare: what was in sync last time. */
  files: ShaMap;
}

export const EMPTY_STATE: SyncState = { files: {} };

export interface SyncPlan {
  /** Remote is newer; take its text. */
  pull: string[];
  /** Local is newer; the push carries it. */
  push: string[];
  /** Both sides changed from a known base: three-way merge the text. */
  merge: string[];
  /** Both sides have a file with no shared history: keep both (see below). */
  conflict: string[];
  deleteLocal: string[];
  deleteRemote: string[];
}

/**
 * Decides, per path, what each side's state means. Pure, and the one piece
 * worth reading closely — everything else is plumbing around it.
 *
 * The rule throughout is that a deletion never beats an edit: a file deleted
 * on one side but edited on the other comes back, because an unwanted file is
 * a keystroke to remove and lost writing is gone for good.
 */
export function planSync(base: ShaMap, local: ShaMap, remote: ShaMap): SyncPlan {
  const plan: SyncPlan = { pull: [], push: [], merge: [], conflict: [], deleteLocal: [], deleteRemote: [] };

  for (const path of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[path];
    const r = remote[path];
    const b = base[path];

    if (l === r) continue; // Identical, or absent from both.

    if (l !== undefined && r === undefined) {
      if (b === undefined) plan.push.push(path); // New here.
      else if (b === l) plan.deleteLocal.push(path); // Deleted there, untouched here.
      else plan.push.push(path); // Deleted there, edited here — the edit wins.
      continue;
    }

    if (l === undefined && r !== undefined) {
      if (b === undefined) plan.pull.push(path); // New there.
      else if (b === r) plan.deleteRemote.push(path); // Deleted here, untouched there.
      else plan.pull.push(path); // Deleted here, edited there — the edit wins.
      continue;
    }

    // Present on both sides and different.
    if (b === l) plan.pull.push(path);
    else if (b === r) plan.push.push(path);
    else if (b === undefined) plan.conflict.push(path);
    else plan.merge.push(path);
  }

  return plan;
}

export interface SyncSummary {
  pulled: string[];
  pushed: string[];
  merged: string[];
  /** Both sides had unrelated files at one path; the remote copy was kept
   *  alongside the local one, at these new paths. */
  conflicted: Array<{ path: string; keptAs: string }>;
  deletedLocal: string[];
  deletedRemote: string[];
}

/**
 * Where a sync has got to, for the status strip.
 *
 * A pass is the fixed sequence of stages below. Within one, `done`/`total`
 * count the files it works through (`0`/`0` when there is nothing countable)
 * and `path` names the one it is on. A stage reports when a step *starts*, so
 * `path` is what is happening now and `done` is what is already behind it —
 * except "uploading", which can't: its blobs go up in parallel, so it reports
 * each one as it lands and `done` includes the file named.
 */
export type SyncStage =
  | "reading"
  | "hashing"
  | "listing"
  | "downloading"
  | "merging"
  | "keeping"
  | "deleting"
  | "uploading"
  | "committing";

export interface SyncProgress {
  stage: SyncStage;
  /** The file this step is about, where a step is about one file. */
  path?: string;
  done: number;
  total: number;
}

export type OnSyncProgress = (progress: SyncProgress) => void;

/**
 * The stages in the order they run, each with a share of the bar.
 *
 * The shares are a guess, and deliberately so: how long a pass spends
 * uploading depends entirely on what changed, and nothing here can know that
 * before it starts. The percentage is a sense of movement, not an estimate of
 * time. What it does promise is that it only ever goes up — stages are
 * emitted in this order and each one's counter only climbs, which is why
 * keeping both copies of a file has a stage of its own rather than sharing
 * "merging": a merge that turns out to be impossible lands there *after* the
 * merges, and a shared counter would visibly go backwards.
 *
 * A pass that finds nothing to do stops partway through (there is no commit
 * to make), so the bar jumps from wherever it got to straight to the result
 * line. That is honest: it really did finish early.
 */
const STAGE_SHARE: ReadonlyArray<readonly [SyncStage, number]> = [
  ["reading", 8],
  ["hashing", 12],
  ["listing", 10],
  ["downloading", 25],
  ["merging", 10],
  ["keeping", 2],
  ["deleting", 3],
  ["uploading", 20],
  ["committing", 10],
];

/** 0–100 across the whole pass, from a stage and its place within it. */
export function progressPercent({ stage, done, total }: SyncProgress): number {
  let before = 0;
  for (const [candidate, share] of STAGE_SHARE) {
    if (candidate === stage) {
      const fraction = total > 0 ? Math.min(done / total, 1) : 0;
      return Math.round(before + share * fraction);
    }
    before += share;
  }
  return before;
}

/**
 * The status line's "what's happening right now".
 *
 * The file is named by its last segment, not its full path: this line is
 * glanced at rather than read, it is replaced a moment later, and the sidebar
 * is narrow enough that a long path would be clipped to exactly the half that
 * doesn't identify the file. The full path goes in the element's `title`.
 * (The commit title does the opposite, for the opposite reason — it's a
 * record, and it lasts.)
 */
export function describeProgress({ stage, path, done, total }: SyncProgress): string {
  const name = path === undefined ? "" : path.slice(path.lastIndexOf("/") + 1);
  const of = total > 1 ? ` (${Math.min(done + 1, total)}/${total})` : "";
  switch (stage) {
    case "reading":
      return "Reading local files…";
    case "hashing":
      return total > 0 ? `Checking local files (${done}/${total})` : "Checking local files…";
    case "listing":
      return "Reading the branch…";
    case "downloading":
      return `Downloading ${name}${of}`;
    case "merging":
      return `Merging ${name}${of}`;
    case "keeping":
      return `Keeping both copies of ${name}${of}`;
    case "deleting":
      return `Deleting ${name}${of}`;
    // The only stage that counts what it has *finished* rather than what it is
    // starting, since that's all a parallel upload can honestly report.
    case "uploading":
      if (path === undefined) return total > 1 ? `Uploading ${total} files` : "Uploading 1 file";
      return total > 1 ? `Uploading ${done}/${total} files (${name})` : `Uploading ${name}`;
    case "committing":
      return "Committing…";
  }
}

/**
 * Bytes, not text.
 *
 * Text is the common case, but an image pasted into a note is a real file in
 * the store, and a sync that decoded it would replace bytes with U+FFFD and
 * push the damage. So bytes are the medium throughout and text is a *view*,
 * taken only where it's needed — which is the three-way merge, and nothing
 * else.
 */
export interface LocalFs {
  read(): Promise<Record<string, Bytes>>;
  write(path: string, content: Bytes): Promise<void>;
  remove(path: string): Promise<void>;
}

/** How many times a sync write retries another tab's lock before giving up. */
const WRITE_ATTEMPTS = 4;
const WRITE_RETRY_MS = 200;

/**
 * The OPFS-backed implementation, for one drive; the interface above exists
 * for tests.
 *
 * Paths stay relative to the drive's mount, which is what lets them be the
 * paths in the repository as well — a drive's root *is* the repository root.
 */
export function opfsLocalFs(store: Store): LocalFs {
  return {
    read: () => readLocalTree(store),
    write: async (path, content) => {
      // A write that loses the lock race must not be reported as done: the
      // caller records what it wrote as the new sync base, and a base claiming
      // a file holds text that never reached disk would read as a local edit to
      // push on the next pass — pushing the version this sync was replacing.
      for (let attempt = 1; ; attempt++) {
        if ((await store.writeFile(segmentsOf(path), content)) === "ok") return;
        if (attempt === WRITE_ATTEMPTS) throw new Error(`Couldn't write ${path}: another tab is holding it.`);
        await new Promise(resolve => setTimeout(resolve, WRITE_RETRY_MS));
      }
    },
    remove: async path => {
      await store.removeEntry(segmentsOf(path));
    },
  };
}

export async function readLocalTree(store: Store): Promise<Record<string, Bytes>> {
  const files: Record<string, Bytes> = {};
  const visit = async (entries: WalkEntry[], prefix: string[]): Promise<void> => {
    for (const entry of entries) {
      const path = [...prefix, entry.name];
      if (entry.kind === "directory") await visit(entry.children, path);
      else files[path.join("/")] = (await store.readBytes(path)) ?? new Uint8Array(0);
    }
  };
  await visit(await store.walk(), []);
  return files;
}

/** Only regular files take part; anything else is carried through untouched. */
const isSyncableEntry = (entry: RemoteEntry) => entry.type === "blob" && (entry.mode === FILE_MODE || entry.mode === "100755");

/**
 * "notes.md" → "notes (github).md", avoiding names already in use. Used when
 * both sides independently created a file at the same path.
 */
export function conflictCopyPath(path: string, taken: ReadonlySet<string>): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = `${dir}${stem} (github${n === 1 ? "" : ` ${n}`})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface SyncResult {
  state: SyncState;
  summary: SyncSummary;
  /**
   * Local files this sync wrote, so the app can refresh what's on screen.
   * `content` is null for a file that isn't text — there is nothing for the
   * editor to show, but the tree still has to be re-read.
   */
  written: Array<{ path: string; content: string | null }>;
  removed: string[];
}

/**
 * One full pass. Callers should serialize these (App takes a Web Lock, so two
 * tabs don't push over each other) and retry once on a 422 from the ref
 * update, which is how a lost race announces itself.
 *
 * The commit title is built here rather than passed in, because only this
 * function knows which files the push actually changes.
 */
export async function syncOnce(
  local: LocalFs,
  remote: Remote,
  state: SyncState,
  onProgress: OnSyncProgress = () => {},
): Promise<SyncResult> {
  onProgress({ stage: "reading", done: 0, total: 0 });
  const localBytes = await local.read();
  const localSha: ShaMap = {};
  const localFiles = Object.entries(localBytes);
  for (const [index, [path, content]] of localFiles.entries()) {
    onProgress({ stage: "hashing", path, done: index, total: localFiles.length });
    localSha[path] = await gitBlobSha(content);
  }

  onProgress({ stage: "listing", done: 0, total: 0 });
  const tree = await remote.readTree();
  const remoteSha: ShaMap = {};
  const carried: CommitEntry[] = [];
  for (const entry of tree.entries) {
    if (entry.type === "tree") continue; // Directories are implied by paths.
    if (isSyncableEntry(entry)) remoteSha[entry.path] = entry.sha;
    // Symlinks and submodules: webfs can't represent them, but a push sends
    // the whole tree, so they'd be deleted if they weren't carried over.
    else carried.push({ path: entry.path, mode: entry.mode, sha: entry.sha });
  }

  // An empty store whose base says otherwise is almost always lost data, not
  // a deletion of every note: Safari evicts unused site storage, and OPFS can
  // go without localStorage going with it. Taken at face value it reads as
  // "delete everything on GitHub" — so the base is dropped instead and the
  // repository is treated as new, which refills the device. The opposite
  // mistake (re-downloading notes someone really did delete) costs a second
  // deletion; this one costs the notes.
  const lostLocalStore = Object.keys(localBytes).length === 0 && Object.keys(state.files).length > 0;
  const base = lostLocalStore ? {} : state.files;

  const plan = planSync(base, localSha, remoteSha);
  // Merges that turn out to be unmergeable join these, rather than being
  // pushed back into the plan — that record stays what planSync decided.
  const conflicts = [...plan.conflict];
  const summary: SyncSummary = {
    pulled: [],
    pushed: [...plan.push],
    merged: [],
    conflicted: [],
    deletedLocal: [],
    deletedRemote: [...plan.deleteRemote],
  };
  const written: Array<{ path: string; content: string | null }> = [];
  const removed: string[] = [];
  /** The tree as it will be after this sync: path → bytes. Starts as local. */
  const finalBytes: Record<string, Bytes> = { ...localBytes };

  const writeLocal = async (path: string, content: Bytes) => {
    await local.write(path, content);
    finalBytes[path] = content;
    written.push({ path, content: decodeText(content) });
  };

  for (const [index, path] of plan.pull.entries()) {
    onProgress({ stage: "downloading", path, done: index, total: plan.pull.length });
    await writeLocal(path, await remote.readBlobBytes(remoteSha[path]!));
    summary.pulled.push(path);
  }

  for (const [index, path] of plan.merge.entries()) {
    onProgress({ stage: "merging", path, done: index, total: plan.merge.length });
    const theirs = await remote.readBlobBytes(remoteSha[path]!);
    // The base *text*, not just its sha: it was pushed at the last sync, so
    // the blob is still reachable in the repo. If it isn't (history rewritten,
    // repo re-created), fall back to keeping both copies rather than guessing.
    const baseText = await remote.readBlobBytes(base[path]!).then(decodeText, () => null);
    const mine = decodeText(localBytes[path]!);
    const theirText = decodeText(theirs);
    // Only text can be merged. Two versions of a changed image have no
    // middle ground, so rather than picking one and losing the other, they
    // take the same route as files with no shared history: keep both.
    if (baseText === null || mine === null || theirText === null) {
      conflicts.push(path);
      continue;
    }
    const merged = mergeText(baseText, mine, theirText);
    if (merged !== mine) await writeLocal(path, new TextEncoder().encode(merged));
    summary.merged.push(path);
  }

  for (const [index, path] of conflicts.entries()) {
    onProgress({ stage: "keeping", path, done: index, total: conflicts.length });
    // No shared history, or nothing mergeable: there's no honest way to merge
    // two files that just happen to share a name, and silently preferring one
    // side loses work that exists nowhere else. Both are kept; the push then
    // carries both.
    const keptAs = conflictCopyPath(path, new Set(Object.keys(finalBytes)));
    await writeLocal(keptAs, await remote.readBlobBytes(remoteSha[path]!));
    summary.conflicted.push({ path, keptAs });
  }

  for (const [index, path] of plan.deleteLocal.entries()) {
    onProgress({ stage: "deleting", path, done: index, total: plan.deleteLocal.length });
    await local.remove(path);
    delete finalBytes[path];
    removed.push(path);
    summary.deletedLocal.push(path);
  }

  // Only files this pass rewrote need re-hashing; everything else still has
  // the sha computed at the top.
  const rewritten = new Set(written.map(file => file.path));
  const finalSha: ShaMap = {};
  for (const [path, content] of Object.entries(finalBytes)) {
    finalSha[path] = rewritten.has(path) ? await gitBlobSha(content) : localSha[path]!;
  }

  const identical =
    Object.keys(finalSha).length === Object.keys(remoteSha).length &&
    Object.entries(finalSha).every(([path, sha]) => remoteSha[path] === sha);

  if (identical) {
    return { state: { files: finalSha }, summary, written, removed };
  }

  const entries: CommitEntry[] = [
    ...carried,
    ...Object.entries(finalBytes).map(([path, content]) =>
      remoteSha[path] === finalSha[path]
        ? { path, mode: FILE_MODE, sha: finalSha[path]! }
        : { path, mode: FILE_MODE, content },
    ),
  ];
  // Git has no empty tree to push, so this is refused either way. It should
  // now be unreachable — the lost-store case above is what used to reach it —
  // but it stays as the last thing standing between a bug up here and
  // someone's notes.
  if (entries.length === 0) {
    throw new Error("Refusing to sync: this would leave the repository with no files. If that's really what you want, delete them on GitHub.");
  }

  // What this commit actually changes on the branch: everything whose sha
  // differs from the remote's, plus everything the remote has that the final
  // tree doesn't — a deletion is as much a change as an edit.
  const changed = [
    ...Object.keys(finalSha).filter(path => remoteSha[path] !== finalSha[path]),
    ...Object.keys(remoteSha).filter(path => finalSha[path] === undefined),
  ];

  // Only entries carrying content are uploaded; the rest name a blob the
  // branch already has. That's the count worth showing, and on a note with a
  // photo in it, it's where the seconds go.
  const uploads = entries.filter(entry => "content" in entry).length;
  onProgress(uploads === 0 ? { stage: "committing", done: 0, total: 0 } : { stage: "uploading", done: 0, total: uploads });
  await remote.commit(entries, commitTitle(changed), tree.commitSha, (done, total, path) =>
    onProgress(done === total ? { stage: "committing", done: 0, total: 0 } : { stage: "uploading", path, done, total }),
  );
  return { state: { files: finalSha }, summary, written, removed };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The commit title: when the sync happened, and what it was about.
 *
 * Local time rather than UTC — the commit already carries an authoritative
 * timestamp, so this one is here to be recognised ("that was my lunchtime
 * edit"), which only works in the clock the person was looking at.
 *
 * Paths, not bare filenames: two notes called `todo.md` in different folders
 * are ordinary here, and a title that can't tell them apart is worth less
 * than the characters it costs. Only the first is named, since a title is a
 * title; the ellipsis says to open the commit for the rest.
 */
export function commitTitle(changed: readonly string[], at: Date = new Date()): string {
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const [first, ...rest] = [...changed].sort();
  if (first === undefined) return `${when} sync`;
  return `${when} ${first}${rest.length > 0 ? " …" : ""}`;
}

/** A one-line description of what a sync did, for the status bar. */
export function describeSummary(summary: SyncSummary): string {
  const parts: string[] = [];
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (summary.pushed.length) parts.push(`pushed ${count(summary.pushed.length, "file")}`);
  if (summary.pulled.length) parts.push(`pulled ${count(summary.pulled.length, "file")}`);
  if (summary.merged.length) parts.push(`merged ${count(summary.merged.length, "file")}`);
  if (summary.conflicted.length) parts.push(`kept both copies of ${count(summary.conflicted.length, "file")}`);
  if (summary.deletedLocal.length) parts.push(`deleted ${count(summary.deletedLocal.length, "file")} here`);
  if (summary.deletedRemote.length) parts.push(`deleted ${count(summary.deletedRemote.length, "file")} on GitHub`);
  return parts.length === 0 ? "Up to date" : parts.join(", ").replace(/^./, c => c.toUpperCase());
}
