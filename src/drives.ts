/**
 * What a drive is, and the path arithmetic that follows from it.
 *
 * A drive is a source-of-truth folder. There are two kinds — a plain folder in
 * OPFS, and a branch in a GitHub repository — but that difference is smaller
 * than it looks: a GitHub drive's files live in OPFS too, because sync
 * reconciles *into* the local store and reads back out of it, never around it
 * (see sync.ts). So a drive is an OPFS mount point plus, for the GitHub kind,
 * the remote to keep it in step with.
 *
 * Three things are the same string, and deliberately so:
 *
 *   id      "opfs/notes", "jdlunger/webfs" — how the registry keys a drive
 *   URL     /opfs/notes/Notes/todo.md, /jdlunger/webfs/Notes/todo.md
 *   mount   drives/opfs/notes/, drives/jdlunger/webfs/
 *
 * An id is always exactly two segments, which is what makes a URL parseable
 * without consulting the registry first: take two, the rest is the file path.
 * That matters because the drive has to be known before its tree can be read,
 * and the tree has to be read before the file path means anything.
 *
 * Node ids *inside* a drive stay relative to it (see fs.ts). The mount is
 * applied at the storage boundary and nowhere else, so everything above it —
 * panes, assets, the `Media/` fallback, the paths sync sends to GitHub —
 * carries on meaning what it always meant.
 */
import { isValidName } from "./storage";

/**
 * The one directory at the OPFS root that webfs owns.
 *
 * Every drive lives under it, which keeps two things apart that would
 * otherwise collide: a local drive named `Notes` and a leftover `Notes`
 * folder from before drives existed. It also makes "everything webfs manages"
 * a single subtree, so what predates it can be left alone rather than deleted
 * out from under someone.
 */
export const DRIVES_DIR = "drives";

/**
 * The first segment of a local drive's id, and so a GitHub owner name that
 * can't be used. Reserved rather than escaped: an owner genuinely called
 * `opfs` would make `/opfs/notes` ambiguous between a local drive and that
 * owner's `notes` repository, and there is no spelling of the URL that
 * resolves it without a lookup.
 */
export const LOCAL_SCHEME = "opfs";

export interface OpfsDrive {
  kind: "opfs";
  name: string;
}

export interface GitHubDrive {
  kind: "github";
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** Sync on a timer and after edits settle, rather than only on demand. */
  auto: boolean;
}

export type Drive = OpfsDrive | GitHubDrive;

/**
 * The drive a browser that has never seen webfs starts in.
 *
 * A first visit has always landed in a working notes app, and it still does:
 * the empty-state screen is for someone who has removed every drive, not for
 * someone who has just arrived. Created only when the registry has never been
 * written — an empty registry that exists is a choice, and is respected.
 */
export const DEFAULT_DRIVE: OpfsDrive = { kind: "opfs", name: "notes" };

/** The two segments a drive is named by, decoded. */
export function driveSegments(drive: Drive): [string, string] {
  return drive.kind === "opfs" ? [LOCAL_SCHEME, drive.name] : [drive.owner, drive.repo];
}

/**
 * How the registry, the sync base and every keyed-by-drive map name a drive.
 *
 * The branch is *not* part of it: a repository is one drive, whichever branch
 * it currently points at. Two branches of one repo as two drives would need a
 * third segment in the URL, and a branch name may itself contain a slash.
 */
export function driveId(drive: Drive): string {
  return driveSegments(drive).join("/");
}

/** Where the drive's files are, as an OPFS path from the root. */
export function mountOf(drive: Drive): string[] {
  return [DRIVES_DIR, ...driveSegments(drive)];
}

/** The drive's own root in the URL, encoded, with no trailing slash. */
export function driveUrl(drive: Drive): string {
  return "/" + driveSegments(drive).map(encodeURIComponent).join("/");
}

/** What the switcher shows, and what a drive is called in prose. */
export function describeDrive(drive: Drive): string {
  return drive.kind === "opfs" ? drive.name : `${drive.owner}/${drive.repo}`;
}

export function findDrive(drives: readonly Drive[], id: string): Drive | null {
  return drives.find(drive => driveId(drive) === id) ?? null;
}

/**
 * Splits a URL path into the drive that owns it and the path within it.
 *
 * Takes the pathname still percent-encoded and hands back the remainder the
 * same way, so the file path is decoded exactly once, by whoever resolves it
 * (`findNodeByPath`). Only the two id segments are decoded here, because the
 * id is what gets compared against the registry.
 *
 * Null for anything with fewer than two segments — "/" itself, or a truncated
 * link — which the caller reads as "no drive named, use the last one".
 */
export function parseDrivePath(pathname: string): { id: string; path: string } | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  let id: string;
  try {
    id = segments.slice(0, 2).map(decodeURIComponent).join("/");
  } catch {
    return null; // Malformed percent-encoding: not a drive we could name.
  }
  return { id, path: "/" + segments.slice(2).join("/") };
}

/**
 * Why this drive can't be added, or null if it can.
 *
 * Returns a sentence for the dialog rather than a code: every one of these is
 * shown to the user as-is, and there is nothing else that needs to tell them
 * apart.
 */
export function validateDrive(drive: Drive, existing: readonly Drive[]): string | null {
  for (const segment of driveSegments(drive)) {
    // A segment is a directory name under the mount, so OPFS's rules are the
    // real constraint here, not a style preference.
    if (!isValidName(segment)) {
      return `"${segment}" isn't a usable name — it can't be empty or contain a slash.`;
    }
  }
  if (drive.kind === "github") {
    if (drive.owner === LOCAL_SCHEME) {
      return `"${LOCAL_SCHEME}" is reserved for local drives, so a repository owned by it can't be added.`;
    }
    if (!drive.branch) return "A branch is required.";
    if (!drive.token) return "A personal access token is required.";
  }
  if (findDrive(existing, driveId(drive))) {
    return `${describeDrive(drive)} is already one of your drives.`;
  }
  return null;
}
