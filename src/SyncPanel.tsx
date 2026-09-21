import { useEffect, useState } from "react";
import { GitHubRemote } from "./github";
import type { SyncConfig } from "./syncConfig";
import type { GitHubSync } from "./useGitHubSync";

/**
 * The sync status strip at the foot of the sidebar, and the dialog behind it.
 *
 * The strip is deliberately the only always-visible surface: sync is meant to
 * be something you configure once and then read out of the corner of your eye,
 * so it shows one line of state and one button.
 */
export function SyncPanel({ sync }: { sync: GitHubSync }) {
  const [editing, setEditing] = useState(false);
  const { config, status } = sync;

  return (
    <div className="sync-bar">
      {config ? (
        <>
          <div className="sync-info">
            <button className="sync-repo" title="GitHub sync settings" onClick={() => setEditing(true)}>
              {config.owner}/{config.repo}
              <span className="sync-branch">{config.branch}</span>
            </button>
            <SyncStatusLine phase={status.phase} message={status.message} lastSyncedAt={status.lastSyncedAt} />
          </div>
          <button
            className="sync-now"
            title="Sync with GitHub now"
            disabled={status.phase === "syncing"}
            onClick={sync.syncNow}
          >
            {status.phase === "syncing" ? "…" : "⟳"}
          </button>
        </>
      ) : (
        <button className="sync-connect" onClick={() => setEditing(true)}>
          Sync with GitHub…
        </button>
      )}
      {editing && <SyncSettings sync={sync} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** "Synced 2m ago" decays on its own, so it can't sit there claiming "just now". */
function SyncStatusLine({ phase, message, lastSyncedAt }: { phase: string; message: string; lastSyncedAt: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (lastSyncedAt === null) return;
    const timer = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [lastSyncedAt]);

  if (phase === "error") {
    return (
      <span className="sync-status sync-status-error" title={message}>
        {message}
      </span>
    );
  }
  if (phase === "syncing") return <span className="sync-status">Syncing…</span>;
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

function SyncSettings({ sync, onClose }: { sync: GitHubSync; onClose: () => void }) {
  const existing = sync.config;
  const [repository, setRepository] = useState(existing ? `${existing.owner}/${existing.repo}` : "");
  const [branch, setBranch] = useState(existing?.branch ?? "main");
  const [token, setToken] = useState(existing?.token ?? "");
  const [auto, setAuto] = useState(existing?.auto ?? true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseRepository(repository);

  const save = async () => {
    if (!parsed) {
      setError("Enter the repository as owner/name, or paste its GitHub URL.");
      return;
    }
    if (!token.trim()) {
      setError("A personal access token is required.");
      return;
    }
    const config: SyncConfig = { ...parsed, branch: branch.trim() || "main", token: token.trim(), auto };

    // Check before saving: a typo here otherwise shows up later as a status
    // line failing on a timer, with no obvious way back to this dialog.
    setChecking(true);
    setError(null);
    try {
      const { canPush } = await new GitHubRemote(config).checkAccess();
      if (!canPush) {
        setError("That token can read the repository but can't write to it.");
        return;
      }
      sync.connect(config);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reach GitHub.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={event => event.stopPropagation()}>
        <h2>Sync with GitHub</h2>
        <p className="modal-hint">
          Files sync both ways with a branch in a repository. Edits made here are pushed; edits made anywhere else are
          pulled, and a file changed in both places is merged.
        </p>

        <label>
          Repository
          <input
            autoFocus
            value={repository}
            placeholder="owner/notes"
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
          — that opens the token page with <em>Contents: Read and write</em> and a one-year expiry already filled in.
          Pick {parsed ? <code>{parsed.repo}</code> : "the repository"} yourself under <em>Repository access</em>;
          GitHub has no link parameter for that one.
        </p>
        <p className="modal-hint">
          The token is stored in this browser's local storage on this device only — treat it like a password, and
          revoke it if you lose the device. A classic token with the <code>repo</code> scope works too.
        </p>

        <label className="modal-checkbox">
          <input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)} />
          Sync automatically after edits, and every minute
        </label>

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          {existing && (
            <button
              className="modal-danger"
              onClick={() => {
                sync.disconnect();
                onClose();
              }}
            >
              Disconnect
            </button>
          )}
          <span className="modal-spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="modal-primary" disabled={checking} onClick={() => void save()}>
            {checking ? "Checking…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
