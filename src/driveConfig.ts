/**
 * The drive registry and each drive's sync base: localStorage.
 *
 * Deliberately *not* OPFS, even though OPFS is otherwise the only store. A
 * GitHub drive's folder is what gets pushed to its repository — a token
 * written there would be committed to GitHub on the next sync, and the
 * token's own repo at that. localStorage is per-origin and never leaves the
 * browser.
 *
 * That still means a personal access token sitting in a store any script on
 * this origin can read. There's no way around it for a backend-less app that
 * talks to the GitHub API directly: no server, so no session cookie to hide
 * behind, and no OAuth app secret that could stay secret. Use a fine-grained
 * token scoped to the one repository, and revoke it if the device is lost.
 *
 * Which drive is *active* is not kept here. That belongs to the URL, so that
 * a link opens what it names and two tabs can show two drives; this only
 * remembers the last one, for a visit to the bare app root.
 */
import { DEFAULT_DRIVE, driveId, findDrive, type Drive } from "./drives";
import { EMPTY_STATE, type SyncState } from "./sync";

const DRIVES_KEY = "webfs:drives";
const LAST_KEY = "webfs:drive:last";
const SEEDED_KEY = "webfs:drives:seeded";
const STATE_PREFIX = "webfs:sync:state:";
const SYNCED_AT_PREFIX = "webfs:sync:at:";

/** What the GitHub connection was called before drives existed. */
const LEGACY_CONFIG_KEY = "webfs:github:config";
const LEGACY_STATE_PREFIX = "webfs:github:state:";

/** Private browsing and blocked-cookie settings make localStorage throw. */
function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* nothing to do: the registry just won't persist across reloads */
  }
}

/** Anything missing a field it can't work without isn't a drive. */
function parseDrive(raw: unknown): Drive | null {
  const value = raw as Partial<Drive> | null;
  if (!value || typeof value !== "object") return null;
  if (value.kind === "opfs") return value.name ? { kind: "opfs", name: value.name } : null;
  if (value.kind === "github") {
    if (!value.owner || !value.repo || !value.token) return null;
    return {
      kind: "github",
      owner: value.owner,
      repo: value.repo,
      branch: value.branch || "main",
      token: value.token,
      auto: value.auto !== false,
    };
  }
  return null;
}

export function loadDrives(): Drive[] {
  const raw = readItem(DRIVES_KEY);
  if (raw === null) return adoptLegacyConfig();
  try {
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseDrive).filter((drive): drive is Drive => drive !== null);
  } catch {
    return [];
  }
}

export function saveDrives(drives: readonly Drive[]): void {
  writeItem(DRIVES_KEY, JSON.stringify(drives));
}

/**
 * Carries a pre-drives GitHub connection forward, once.
 *
 * The repository, branch and token are worth keeping — re-issuing a token is
 * the most tedious part of setting this up. The files are not: they lived at
 * the OPFS root, and a drive's files live under its mount, so the drive
 * starts empty and its first sync pulls the whole repository back down. The
 * sync base is dropped with them; kept, it would describe a tree this drive
 * doesn't have and read as "every file was deleted here".
 *
 * What's at the root is left exactly where it is rather than deleted. It is
 * no longer reachable through the app, but nothing has verified yet that the
 * repository really did give everything back, and a folder that costs disk is
 * recoverable in a way a folder that's gone is not.
 */
function adoptLegacyConfig(): Drive[] {
  const raw = readItem(LEGACY_CONFIG_KEY);
  if (raw === null) {
    // Not an upgrade, a first visit. One local drive, so the app opens into
    // somewhere to write rather than into a dialog.
    saveDrives([DEFAULT_DRIVE]);
    return [DEFAULT_DRIVE];
  }
  let drives: Drive[] = [];
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const drive = parseDrive({ ...parsed, kind: "github" });
    if (drive) drives = [drive];
  } catch {
    /* unreadable: nothing to carry over */
  }
  saveDrives(drives);
  writeItem(LEGACY_CONFIG_KEY, null);
  forgetLegacyState();
  return drives;
}

function forgetLegacyState(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(LEGACY_STATE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* nothing to do: the old keys are simply never read again */
  }
}

/**
 * Whether a drive should be filled with starter notes.
 *
 * Only the drive webfs makes for itself on a first visit: the seed exists so
 * that arriving at the app lands in something to write in, not so that every
 * folder anyone ever adds arrives holding three notes about how to use a file
 * tree. A drive added from the dialog is marked as seeded the moment it's
 * created, which is how it starts empty.
 *
 * A drive backed by a repository is never seeded, for a stronger reason: it
 * is empty because it hasn't pulled yet, and starter notes would be pushed
 * into someone's established vault.
 */
export function shouldSeed(drive: Drive): boolean {
  if (drive.kind !== "opfs") return false;
  return !readSeeded().includes(driveId(drive));
}

export function markSeeded(drive: Drive): void {
  const seeded = readSeeded();
  if (seeded.includes(driveId(drive))) return;
  writeItem(SEEDED_KEY, JSON.stringify([...seeded, driveId(drive)]));
}

function readSeeded(): string[] {
  try {
    const parsed = JSON.parse(readItem(SEEDED_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The drive to open when the URL names none — the bare app root, or the
 * first launch of the installed app. Falls back to the first drive, so a
 * device restored from a backup still opens something.
 */
export function loadLastDrive(drives: readonly Drive[]): Drive | null {
  const id = readItem(LAST_KEY);
  return (id === null ? null : findDrive(drives, id)) ?? drives[0] ?? null;
}

export function saveLastDrive(drive: Drive | null): void {
  writeItem(LAST_KEY, drive === null ? null : driveId(drive));
}

/**
 * The base snapshot is keyed by drive *and* branch, so pointing a drive at a
 * different branch doesn't inherit a base describing a tree that branch never
 * had — which would read as "everything was deleted there".
 */
function stateKey(drive: Drive, prefix = STATE_PREFIX): string {
  return `${prefix}${driveId(drive)}${drive.kind === "github" ? `#${drive.branch}` : ""}`;
}

export function loadState(drive: Drive): SyncState {
  const raw = readItem(stateKey(drive));
  if (!raw) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return { files: parsed.files ?? {} };
  } catch {
    return EMPTY_STATE;
  }
}

export function saveState(drive: Drive, state: SyncState): void {
  writeItem(stateKey(drive), JSON.stringify(state));
}

/**
 * When this drive last finished a sync.
 *
 * Kept here rather than only in the hook's state, because the moment it is
 * most worth knowing is the one where that state is empty: the app opened
 * offline, on a phone, with no run to have set it. "Last synced" that says
 * nothing at all after a reload answers the question exactly when it's being
 * asked. Keyed by branch alongside the base for the same reason the base is —
 * it describes a pass over *that* branch.
 *
 * It is not part of `SyncState`, which is the three-way base and nothing
 * else: `syncOnce` neither reads nor produces this, and putting it there
 * would hand the sync algorithm a field it has no business in.
 */
export function loadSyncedAt(drive: Drive): number | null {
  const raw = readItem(stateKey(drive, SYNCED_AT_PREFIX));
  const at = raw === null ? NaN : Number(raw);
  return Number.isFinite(at) ? at : null;
}

export function saveSyncedAt(drive: Drive, at: number): void {
  writeItem(stateKey(drive, SYNCED_AT_PREFIX), String(at));
}

