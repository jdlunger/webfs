/**
 * Where the GitHub connection and its sync base live: localStorage.
 *
 * Deliberately *not* OPFS, even though OPFS is otherwise the only store. OPFS
 * is what gets pushed to the repository — a token written there would be
 * committed to GitHub on the next sync, and the token's own repo at that.
 * localStorage is per-origin and never leaves the browser.
 *
 * That still means a personal access token sitting in a store any script on
 * this origin can read. There's no way around it for a backend-less app that
 * talks to the GitHub API directly: no server, so no session cookie to hide
 * behind, and no OAuth app secret that could stay secret. Use a fine-grained
 * token scoped to the one repository, and revoke it if the device is lost.
 */
import { EMPTY_STATE, type SyncState } from "./sync";

const CONFIG_KEY = "webfs:github:config";
const STATE_PREFIX = "webfs:github:state:";

export interface SyncConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** Sync on a timer and after edits settle, rather than only on demand. */
  auto: boolean;
}

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
    /* nothing to do: sync just won't persist across reloads */
  }
}

export function loadConfig(): SyncConfig | null {
  const raw = readItem(CONFIG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncConfig>;
    if (!parsed.owner || !parsed.repo || !parsed.token) return null;
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      branch: parsed.branch || "main",
      token: parsed.token,
      auto: parsed.auto !== false,
    };
  } catch {
    return null;
  }
}

export function saveConfig(config: SyncConfig): void {
  writeItem(CONFIG_KEY, JSON.stringify(config));
}

export function clearConfig(): void {
  writeItem(CONFIG_KEY, null);
}

/**
 * The base snapshot is keyed by repo *and* branch, so pointing webfs at a
 * different branch doesn't inherit a base describing a tree that branch never
 * had — which would read as "everything was deleted there".
 */
function stateKey(config: SyncConfig): string {
  return `${STATE_PREFIX}${config.owner}/${config.repo}#${config.branch}`;
}

export function loadState(config: SyncConfig): SyncState {
  const raw = readItem(stateKey(config));
  if (!raw) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return { files: parsed.files ?? {} };
  } catch {
    return EMPTY_STATE;
  }
}

export function saveState(config: SyncConfig, state: SyncState): void {
  writeItem(stateKey(config), JSON.stringify(state));
}

export function clearState(config: SyncConfig): void {
  writeItem(stateKey(config), null);
}
