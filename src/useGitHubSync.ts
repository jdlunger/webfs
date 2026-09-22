/**
 * Drives sync from the app: when it runs, what it reports, and how the rest
 * of the UI hears about files it changed underneath them.
 *
 * Scheduling rules, all of them for the same reason — a sync is a handful of
 * API calls against a rate limit, so it should happen when something might
 * have changed and not otherwise:
 * - on load, once a connection is configured
 * - a few seconds after local edits stop (the same "settle, then act" shape as
 *   the write debounce)
 * - on a slow timer, which is the only thing that can notice someone else's
 *   push
 * - when the tab is shown again, or the network comes back
 * - whenever the user presses the button
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { GitHubError, GitHubRemote, webCryptoAvailable } from "./github";
import { describeSummary, opfsLocalFs, syncOnce, type SyncProgress, type SyncResult } from "./sync";
import { clearConfig, clearState, loadConfig, loadState, saveConfig, saveState, type SyncConfig } from "./syncConfig";

/** How long after the last local edit to push. */
const SETTLE_MS = 4_000;
/** Backstop poll, for edits made elsewhere. */
const POLL_MS = 60_000;
/** One retry is enough: a 422 means the branch moved, so re-read and redo. */
const RETRIES = 1;
/**
 * How often progress is allowed to reach React.
 *
 * `syncOnce` reports per file, and hashing a store of any size fires one of
 * those for each one — a render apiece would cost more than the sync does. A
 * change of stage always lands immediately, so the line never falls behind
 * what's actually happening by more than this.
 */
const PROGRESS_MS = 120;

export type SyncPhase = "off" | "idle" | "syncing" | "error";

export interface SyncStatus {
  phase: SyncPhase;
  /** What the last sync did, or what went wrong. */
  message: string;
  lastSyncedAt: number | null;
  /** Where the running sync has got to; null unless one is running. */
  progress: SyncProgress | null;
}

export interface GitHubSync {
  config: SyncConfig | null;
  status: SyncStatus;
  connect: (config: SyncConfig) => void;
  disconnect: () => void;
  /** Runs now, unless one is already running. */
  syncNow: () => void;
  /** Asks for a sync once edits settle; ignored when auto-sync is off. */
  requestSync: () => void;
}

export interface GitHubSyncOptions {
  /** Settles queued writes, so sync reads current text out of OPFS. */
  flush: () => Promise<void>;
  /** Called after a sync changed local files, with what it touched. */
  onLocalChanges: (result: SyncResult) => void;
}

/** Runs `body` alone across tabs, or skips if another tab is already in it. */
async function exclusively<T>(name: string, body: () => Promise<T>): Promise<T | "busy"> {
  if (typeof navigator === "undefined" || !navigator.locks) return body();
  const result = await navigator.locks.request(name, { ifAvailable: true }, async lock => {
    if (!lock) return "busy" as const;
    return body();
  });
  return result as T | "busy";
}

export function useGitHubSync({ flush, onLocalChanges }: GitHubSyncOptions): GitHubSync {
  const [config, setConfig] = useState<SyncConfig | null>(() => loadConfig());
  const [status, setStatus] = useState<SyncStatus>(() => ({
    phase: loadConfig() ? "idle" : "off",
    message: "",
    lastSyncedAt: null,
    progress: null,
  }));

  // Timers and listeners are registered once but need today's values.
  const configRef = useRef(config);
  configRef.current = config;
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const onLocalChangesRef = useRef(onLocalChanges);
  onLocalChangesRef.current = onLocalChanges;
  const running = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async () => {
    const current = configRef.current;
    if (!current || running.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (!webCryptoAvailable()) {
      setStatus({
        phase: "error",
        message: "Sync needs crypto.subtle, which this browser isn't exposing here.",
        lastSyncedAt: null,
        progress: null,
      });
      return;
    }

    running.current = true;
    setStatus(prev => ({ ...prev, phase: "syncing", message: "Syncing…", progress: null }));

    let lastStage: string | null = null;
    let lastAt = 0;
    const onProgress = (progress: SyncProgress) => {
      const now = Date.now();
      if (progress.stage === lastStage && now - lastAt < PROGRESS_MS) return;
      lastStage = progress.stage;
      lastAt = now;
      setStatus(prev => ({ ...prev, progress }));
    };

    try {
      // Anything still queued in the editor belongs in this sync, not the next.
      await flushRef.current();

      const outcome = await exclusively("webfs:github-sync", async () => {
        const remote = new GitHubRemote(current);
        let lastError: unknown;
        for (let attempt = 0; attempt <= RETRIES; attempt++) {
          try {
            return await syncOnce(opfsLocalFs, remote, loadState(current), onProgress);
          } catch (err) {
            // 422 on the ref update means another writer moved the branch
            // between our read and our push. Everything is re-read on the way
            // round, so a straight retry is correct.
            if (!(err instanceof GitHubError) || err.status !== 422) throw err;
            lastError = err;
          }
        }
        throw lastError;
      });

      // Another tab is mid-sync; it will do the work and write the same state.
      if (outcome === "busy") {
        setStatus(prev => ({ ...prev, phase: "idle", progress: null }));
        return;
      }

      saveState(current, outcome.state);
      if (outcome.written.length > 0 || outcome.removed.length > 0) onLocalChangesRef.current(outcome);
      setStatus({ phase: "idle", message: describeSummary(outcome.summary), lastSyncedAt: Date.now(), progress: null });
    } catch (err) {
      setStatus(prev => ({
        phase: "error",
        message: err instanceof Error ? err.message : "Sync failed.",
        lastSyncedAt: prev.lastSyncedAt,
        progress: null,
      }));
    } finally {
      running.current = false;
    }
  }, []);

  const syncNow = useCallback(() => void run(), [run]);

  const requestSync = useCallback(() => {
    if (!configRef.current?.auto) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => void run(), SETTLE_MS);
  }, [run]);

  const connect = useCallback((next: SyncConfig) => {
    const previous = configRef.current;
    // A different repo or branch describes a different history, so the base
    // snapshot from the old one would misread as wholesale deletions.
    if (previous && (previous.owner !== next.owner || previous.repo !== next.repo || previous.branch !== next.branch)) {
      clearState(previous);
    }
    saveConfig(next);
    setConfig(next);
    configRef.current = next;
    setStatus({ phase: "idle", message: "", lastSyncedAt: null, progress: null });
    void run();
  }, [run]);

  const disconnect = useCallback(() => {
    const previous = configRef.current;
    if (previous) clearState(previous);
    clearConfig();
    setConfig(null);
    configRef.current = null;
    setStatus({ phase: "off", message: "", lastSyncedAt: null, progress: null });
  }, []);

  // First sync after load, so a device that was away catches up before it's
  // touched — and so a fresh browser fills itself from the repo.
  useEffect(() => {
    if (configRef.current) void run();
  }, [run]);

  useEffect(() => {
    if (!config?.auto) return;
    const timer = setInterval(() => void run(), POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [config?.auto, run]);

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  return { config, status, connect, disconnect, syncNow, requestSync };
}
