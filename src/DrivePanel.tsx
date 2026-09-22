import { useEffect, useState } from "react";
import { GitHubRemote } from "./github";
import { describeProgress, progressPercent, type SyncProgress } from "./sync";
import {
  DRIVES_DIR,
  LOCAL_SCHEME,
  describeDrive,
  driveId,
  validateDrive,
  type Drive,
  type GitHubDrive,
} from "./drives";
import { listNames, rootStore } from "./storage";
import type { DriveSync } from "./useDriveSync";

/**
 * The drive switcher at the foot of the sidebar, and the dialog behind it.
 *
 * It's deliberately the only always-visible surface for both jobs it does.
 * Which drive you're in is the one piece of state that changes what every
 * other part of the app means, so it says so in a corner you can read without
 * looking; and sync is meant to be configured once and then read out of the
 * corner of your eye, so it gets one line of state and one button beside it.
 */
export function DrivePanel({
  drives,
  drive,
  sync,
  onSelect,
  onAdd,
  onUpdate,
  onRemove,
}: {
  drives: readonly Drive[];
  drive: Drive | null;
  sync: DriveSync;
  onSelect: (id: string) => void;
  onAdd: (drive: Drive) => void;
  onUpdate: (drive: Drive) => void;
  onRemove: (id: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  /** The drive the dialog is about, or "new" when it's adding one. */
  const [editing, setEditing] = useState<Drive | "new" | null>(null);
  const { status } = sync;

  return (
    <div className="drive-bar">
      {/* A hairline across the top of the strip rather than a bar on a line of
          its own: the strip sits at the foot of the sidebar and would
          otherwise grow and shrink every time a sync started. */}
      {status.phase === "syncing" && (
        <div className="sync-progress" aria-hidden="true">
          <div className="sync-progress-fill" style={{ width: `${status.progress ? progressPercent(status.progress) : 0}%` }} />
        </div>
      )}
      <div className="drive-info">
        <button className="drive-switch" title="Switch drive" onClick={() => setPicking(true)}>
          <DriveIcon kind={drive === null ? "add" : drive.kind} />
          <span className="drive-name">{drive === null ? "Add a drive…" : describeDrive(drive)}</span>
          {drive?.kind === "github" ? <span className="drive-branch">{drive.branch}</span> : null}
          <span className="drive-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {drive === null ? null : <DriveStatusLine drive={drive} status={sync.status} />}
      </div>
      {drive === null ? null : (
        <button className="drive-settings" title={`${describeDrive(drive)} settings`} onClick={() => setEditing(drive)}>
          ⚙
        </button>
      )}
      {drive?.kind === "github" ? (
        <button
          className="sync-now"
          title="Sync with GitHub now"
          disabled={status.phase === "syncing"}
          onClick={sync.syncNow}
        >
          {status.phase === "syncing" ? "…" : "⟳"}
        </button>
      ) : null}
      {picking && (
        <DrivePicker
          drives={drives}
          drive={drive}
          onSelect={id => {
            setPicking(false);
            onSelect(id);
          }}
          onAdd={() => {
            setPicking(false);
            setEditing("new");
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {editing && (
        <DriveDialog
          editing={editing}
          drives={drives}
          onAdd={onAdd}
          onUpdate={onUpdate}
          onRemove={onRemove}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/**
 * Drawn rather than typed.
 *
 * The obvious characters for these — 🖴 for a disk, ⎇ for a branch — are in
 * almost no font, and a missing glyph in the one control that says which
 * drive you are in reads as a broken app rather than as a missing icon.
 */
function DriveIcon({ kind }: { kind: Drive["kind"] | "add" }) {
  return (
    <span className="drive-kind" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        {kind === "opfs" ? (
          <path d="M1.8 4.2A1.4 1.4 0 0 1 3.2 2.8h2.4l1.3 1.5h5.9a1.4 1.4 0 0 1 1.4 1.4v5.5a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4z" />
        ) : kind === "github" ? (
          <>
            <circle cx="4.5" cy="3.6" r="1.8" />
            <circle cx="4.5" cy="12.4" r="1.8" />
            <circle cx="11.5" cy="3.6" r="1.8" />
            <path d="M4.5 5.4v5.2M11.5 5.4v1.1a3 3 0 0 1-3 3H6.3" />
          </>
        ) : (
          <path d="M8 3.4v9.2M3.4 8h9.2" />
        )}
      </svg>
    </span>
  );
}

/**
 * The list of drives, above the button that opened it.
 *
 * A plain popover rather than the tree's `ContextMenu`: this one is anchored
 * to the strip it belongs to and always opens upward, where that one is
 * positioned wherever a finger was and has to work out which way to go.
 */
function DrivePicker({
  drives,
  drive,
  onSelect,
  onAdd,
  onClose,
}: {
  drives: readonly Drive[];
  drive: Drive | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="drive-picker-scrim" onClick={onClose} />
      <div className="drive-picker" role="menu">
        {drives.map(candidate => {
          const id = driveId(candidate);
          const active = drive !== null && id === driveId(drive);
          return (
            <button
              key={id}
              className={`drive-picker-item ${active ? "is-selected" : ""}`}
              role="menuitem"
              onClick={() => onSelect(id)}
            >
              <DriveIcon kind={candidate.kind} />
              <span className="drive-name">{describeDrive(candidate)}</span>
              {active ? <span className="drive-picker-check">✓</span> : null}
            </button>
          );
        })}
        <button className="drive-picker-item drive-picker-add" role="menuitem" onClick={onAdd}>
          <DriveIcon kind="add" />
          <span className="drive-name">Add a drive…</span>
        </button>
      </div>
    </>
  );
}

/**
 * The branch as GitHub shows it. `/tree/<branch>` rather than the repo root,
 * so the link lands on what webfs is actually syncing even when that isn't
 * the default branch.
 */
export function branchUrl({ owner, repo, branch }: Pick<GitHubDrive, "owner" | "repo" | "branch">): string {
  const encode = (segment: string) => segment.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${encode(branch)}`;
}

/** "Synced 2m ago" decays on its own, so it can't sit there claiming "just now". */
function DriveStatusLine({ drive, status }: { drive: Drive; status: DriveSync["status"] }) {
  const [, setTick] = useState(0);
  const { phase, message, lastSyncedAt, progress } = status;
  useEffect(() => {
    if (lastSyncedAt === null) return;
    const timer = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [lastSyncedAt]);

  // A local drive has no remote and so no status to report. Saying where it
  // lives instead answers the question the line is in the right place to
  // answer: this one is on this device and nowhere else.
  if (drive.kind === "opfs") {
    return <span className="sync-status">On this device only</span>;
  }

  if (phase === "error") {
    return (
      <span className="sync-status sync-status-error" title={message}>
        {message}
      </span>
    );
  }
  if (phase === "syncing") {
    // A sync is usually over before this says anything interesting, which is
    // the point: when it isn't — a first pull of someone's whole notes repo, a
    // photo going up — the line says which file and how far in, instead of an
    // ellipsis that gives no way to tell slow from stuck.
    if (progress === null) return <span className="sync-status">Syncing…</span>;
    return (
      <span className="sync-status" title={progress.path ?? describeProgress(progress)}>
        {describeProgress(progress)} · {progressPercent(progress)}%
      </span>
    );
  }
  if (lastSyncedAt === null) return <span className="sync-status">{message || "Not synced yet"}</span>;
  return (
    <span className="sync-status" title={message}>
      {message || "Up to date"} · {relativeTime(lastSyncedAt)}
    </span>
  );
}

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/**
 * Accepts what people actually have in hand: "owner/repo", a browser URL, or
 * a clone URL. Typing the two halves into two fields is busywork.
 */
export function parseRepository(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  const match = trimmed.match(/^(?:https?:\/\/[^/]+\/|git@[^:]+:)?([^/\s]+)\/([^/\s]+)\/?$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

/**
 * A link to GitHub's token page with the permission already chosen.
 *
 * The fine-grained token form takes a template URL, so everything webfs knows
 * can be filled in for the user: `contents=write` (which implies read, and
 * GitHub adds `metadata:read` itself), the resource owner, a name and an
 * expiry. What it has no parameter for is the *repository* — only
 * `target_name`, its owner — so the dialog tells the user to pick it there
 * rather than pretending the link does everything.
 *
 * Expiry is set explicitly because the page's own default is 30 days, which
 * would quietly stop sync working in a month; a year is a starting point the
 * user can change on the page itself.
 *
 * https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
 */
export function tokenSetupUrl(repository: string): string {
  const parsed = parseRepository(repository);
  const url = new URL("https://github.com/settings/personal-access-tokens/new");
  url.searchParams.set("name", "webfs");
  url.searchParams.set(
    "description",
    parsed ? `Two-way file sync between webfs and ${parsed.owner}/${parsed.repo}.` : "Two-way file sync with webfs.",
  );
  url.searchParams.set("contents", "write");
  url.searchParams.set("expires_in", "365");
  if (parsed) url.searchParams.set("target_name", parsed.owner);
  return url.href;
}

type DriveKind = Drive["kind"];

/**
 * Adds a drive, or edits the one you're in.
 *
 * One dialog for both, because the fields are the same either way and the
 * difference is only which of them can still change: a drive's *identity* —
 * a local drive's name, a repository's owner and name — is where its files
 * live, so editing it would orphan the folder rather than move it. Point a
 * drive at a different branch, or give it a fresh token, and that's an edit;
 * anything else is a new drive.
 */
function DriveDialog({
  editing,
  drives,
  onAdd,
  onUpdate,
  onRemove,
  onClose,
}: {
  editing: Drive | "new";
  drives: readonly Drive[];
  onAdd: (drive: Drive) => void;
  onUpdate: (drive: Drive) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const existing = editing === "new" ? null : editing;
  const [kind, setKind] = useState<DriveKind>(existing?.kind ?? "opfs");
  const [name, setName] = useState(existing?.kind === "opfs" ? existing.name : "");
  const [repository, setRepository] = useState(existing?.kind === "github" ? `${existing.owner}/${existing.repo}` : "");
  const [branch, setBranch] = useState(existing?.kind === "github" ? existing.branch : "main");
  const [token, setToken] = useState(existing?.kind === "github" ? existing.token : "");
  const [auto, setAuto] = useState(existing?.kind === "github" ? existing.auto : true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseRepository(repository);

  const save = async () => {
    setError(null);
    let candidate: Drive;
    if (kind === "opfs") {
      candidate = { kind: "opfs", name: name.trim() };
    } else {
      if (!parsed) {
        setError("Enter the repository as owner/name, or paste its GitHub URL.");
        return;
      }
      candidate = { ...parsed, kind: "github", branch: branch.trim() || "main", token: token.trim(), auto };
    }

    // An edit keeps the drive's id, so it must not be told it already exists.
    const rejection = validateDrive(candidate, existing ? drives.filter(d => driveId(d) !== driveId(existing)) : drives);
    if (rejection) {
      setError(rejection);
      return;
    }

    if (candidate.kind === "github") {
      // Check before saving: a typo here otherwise shows up later as a status
      // line failing on a timer, with no obvious way back to this dialog.
      setChecking(true);
      try {
        const { canPush } = await new GitHubRemote(candidate).checkAccess();
        if (!canPush) {
          setError("That token can read the repository but can't write to it.");
          return;
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't reach GitHub.");
        return;
      } finally {
        setChecking(false);
      }
    }

    if (existing) onUpdate(candidate);
    else onAdd(candidate);
    onClose();
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={event => event.stopPropagation()}>
        <h2>{existing ? describeDrive(existing) : "Add a drive"}</h2>

        {existing === null && (
          <div className="drive-kind-choice">
            <button className={kind === "opfs" ? "is-selected" : ""} onClick={() => setKind("opfs")}>
              <strong>This device</strong>
              <span>A folder stored in this browser.</span>
            </button>
            <button className={kind === "github" ? "is-selected" : ""} onClick={() => setKind("github")}>
              <strong>GitHub</strong>
              <span>A branch in a repository, synced both ways.</span>
            </button>
          </div>
        )}

        {kind === "opfs" ? (
          <>
            <label>
              Name
              <input
                autoFocus
                value={name}
                placeholder="notes"
                disabled={existing !== null}
                onChange={event => setName(event.target.value)}
              />
            </label>
            <p className="modal-hint">
              {existing
                ? "A drive's name is the folder its files are in, so it can't be changed here."
                : `Files live in this browser on this device only, at ${LOCAL_SCHEME}/${name.trim() || "name"}.`}
            </p>
          </>
        ) : (
          <>
            <p className="modal-hint">
              Files sync both ways with a branch in a repository. Edits made here are pushed; edits made anywhere else
              are pulled, and a file changed in both places is merged.
            </p>

            <label>
              Repository
              <input
                autoFocus={existing === null}
                value={repository}
                placeholder="owner/notes"
                disabled={existing !== null}
                onChange={event => setRepository(event.target.value)}
              />
            </label>

            <label>
              Branch
              <input value={branch} placeholder="main" onChange={event => setBranch(event.target.value)} />
            </label>

            <label>
              Personal access token
              <input
                type="password"
                value={token}
                placeholder="github_pat_… or ghp_…"
                autoComplete="off"
                onChange={event => setToken(event.target.value)}
              />
            </label>
            <p className="modal-hint">
              <a className="modal-link" href={tokenSetupUrl(repository)} target="_blank" rel="noopener noreferrer">
                Create one on GitHub ↗
              </a>{" "}
              — that opens the token page with <em>Contents: Read and write</em> and a one-year expiry already filled
              in. Pick {parsed ? <code>{parsed.repo}</code> : "the repository"} yourself under{" "}
              <em>Repository access</em>; GitHub has no link parameter for that one.
            </p>
            <p className="modal-hint">
              The token is stored in this browser's local storage on this device only — treat it like a password, and
              revoke it if you lose the device. A classic token with the <code>repo</code> scope works too.
            </p>

            <label className="modal-checkbox">
              <input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)} />
              Sync automatically after edits, and every minute
            </label>
          </>
        )}

        {existing === null && <LegacyFiles />}

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          {existing && (
            <button
              className="modal-danger"
              onClick={() => {
                onRemove(driveId(existing));
                onClose();
              }}
            >
              Remove drive
            </button>
          )}
          <span className="modal-spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="modal-primary" disabled={checking} onClick={() => void save()}>
            {checking ? "Checking…" : existing ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What's left at the OPFS root from before drives existed.
 *
 * Drives live under one directory, so anything beside it is from the layout
 * that had no drives at all. Those files aren't reachable from the app any
 * more, and on a device that was syncing they have already come back down
 * into the drive — but "already come back down" is a claim worth letting
 * someone check before it's acted on, so this offers the deletion rather than
 * performing it.
 */
function LegacyFiles() {
  const [names, setNames] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void listNames([]).then(entries => setNames(entries.filter(name => name !== DRIVES_DIR)));
  }, []);

  if (names === null || names.length === 0) return null;

  const remove = async () => {
    setDeleting(true);
    for (const name of names) await rootStore.removeEntry([name]);
    setNames([]);
    setDeleting(false);
  };

  return (
    <p className="modal-hint modal-legacy">
      {names.length} item{names.length === 1 ? "" : "s"} from before drives ({names.slice(0, 3).join(", ")}
      {names.length > 3 ? ", …" : ""}) are still taking up space here, and nothing can reach them.{" "}
      <button className="modal-inline-danger" disabled={deleting} onClick={() => void remove()}>
        {deleting ? "Deleting…" : "Delete them"}
      </button>
    </p>
  );
}
