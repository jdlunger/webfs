/**
 * Drives sync for the drive you're looking at: when it runs, what it reports,
 * and how the rest of the UI hears about files it changed underneath them.
 *
 * Only the active drive syncs. A drive you aren't looking at has nothing on
 * screen that its files could be stale against, and syncing every configured
 * repository on the same timer would multiply a rate-limited handful of API
 * calls by however many drives someone has collected. Switching to a drive
 * syncs it on arrival, which is the same "catch up before it's touched" rule
 * the app has always applied on load.
 *
 * Scheduling rules, all of them for the same reason — a sync is a handful of
 * API calls against a rate limit, so it should happen when something might
 * have changed and not otherwise:
 * - on load, and whenever the active drive changes
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
import { driveId, type Drive, type GitHubDrive } from "./drives";
import { loadState, saveState } from "./driveConfig";
import type { Store } from "./storage";

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

export interface DriveSync {
  status: SyncStatus;
  /** Runs now, unless one is already running. */
  syncNow: () => void;
  /** Asks for a sync once edits settle; ignored when auto-sync is off. */
  requestSync: () => void;
}

export interface DriveSyncOptions {
  /** The active drive. A local one has no remote, so nothing runs. */
  drive: Drive | null;
  /** That drive's store, which is what a sync reads and writes. */
  store: Store;
  /** Settles queued writes, so sync reads current text out of the store. */
  flush: () => Promise<void>;
  /** Called after a sync changed local files, with what it touched. */
  onLocalChanges: (result: SyncResult) => void;
}

const OFF: SyncStatus = { phase: "off", message: "", lastSyncedAt: null, progress: null };
const IDLE: SyncStatus = { ...OFF, phase: "idle" };

/** Runs `body` alone across tabs, or skips if another tab is already in it. */
async function exclusively<T>(name: string, body: () => Promise<T>): Promise<T | "busy"> {
  if (typeof navigator === "undefined" || !navigator.locks) return body();
  const result = await navigator.locks.request(name, { ifAvailable: true }, async lock => {
    if (!lock) return "busy" as const;
    return body();
  });
  return result as T | "busy";
}

export function useDriveSync({ drive, store, flush, onLocalChanges }: DriveSyncOptions): DriveSync {
  const remoteDrive = drive?.kind === "github" ? drive : null;
  const [status, setStatus] = useState<SyncStatus>(() => (remoteDrive ? IDLE : OFF));

  // Timers and listeners are registered once but need today's values.
  const driveRef = useRef<GitHubDrive | null>(remoteDrive);
  driveRef.current = remoteDrive;
  const storeRef = useRef(store);
  storeRef.current = store;
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const onLocalChangesRef = useRef(onLocalChanges);
  onLocalChangesRef.current = onLocalChanges;
  const running = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async () => {
    const current = driveRef.current;
    const currentStore = storeRef.current;
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

      // Named for the drive: two drives are two repositories and two folders,
      // so a sync of one has nothing to serialise against a sync of the other.
      const outcome = await exclusively(`webfs:sync:${driveId(current)}`, async () => {
        const remote = new GitHubRemote(current);
        const local = opfsLocalFs(currentStore);
        let lastError: unknown;
        for (let attempt = 0; attempt <= RETRIES; attempt++) {
          try {
            return await syncOnce(local, remote, loadState(current), onProgress);
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

      // The drive may have been switched away from while this ran. Its files
      // and its base are still correct — they're the drive's, not the
      // screen's — but the status line now belongs to a different drive.
      const stillActive = driveRef.current !== null && driveId(driveRef.current) === driveId(current);
      saveState(current, outcome.state);
      if (outcome.written.length > 0 || outcome.removed.length > 0) onLocalChangesRef.current(outcome);
      if (stillActive) {
        setStatus({ phase: "idle", message: describeSummary(outcome.summary), lastSyncedAt: Date.now(), progress: null });
      }
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
    if (!driveRef.current?.auto) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => void run(), SETTLE_MS);
  }, [run]);

  // On load, and again whenever the active drive changes: a drive arrived at
  // is a drive that may have been away for a while. Keyed by id and branch —
  // re-pointing a drive at another branch is a different tree to reconcile.
  const key = remoteDrive === null ? null : `${driveId(remoteDrive)}#${remoteDrive.branch}`;
  useEffect(() => {
    setStatus(key === null ? OFF : IDLE);
    if (key !== null) void run();
  }, [key, run]);

  const auto = remoteDrive?.auto ?? false;
  useEffect(() => {
    if (!auto) return;
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
  }, [auto, run]);

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  return { status, syncNow, requestSync };
}
