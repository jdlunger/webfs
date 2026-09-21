/**
 * Where images pasted into a note live, and how their markdown links map onto
 * the store.
 *
 * Pure path arithmetic, kept out of the editor component so it can be tested
 * without mounting one — the `..` guard in particular is the kind of thing
 * that should never be verified by eye.
 */
import { segmentsOf } from "./fs";

/** Where a pasted image lands: a folder beside the note that references it. */
export const ASSET_DIR = "assets";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

export const mimeOf = (path: string) => IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/** A URL webfs shouldn't touch: one a browser can already load by itself. */
export const isAbsoluteUrl = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//") || url.startsWith("/");

/**
 * Resolves a markdown image URL against the folder of the note it appears in,
 * the same way GitHub does when it renders that file.
 *
 * Returns null for anything that escapes the store, rather than letting `..`
 * walk out of it.
 */
export function resolveAssetPath(noteId: string, url: string): string[] | null {
  const segments = segmentsOf(noteId).slice(0, -1);
  /**
   * Whether the URL contributed a name of its own. Without this, "" and "./"
   * resolve to the note's own folder — a directory, not a file, and not
   * something any link meant to point at.
   */
  let named = false;

  for (const raw of url.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null; // Malformed percent-encoding; not ours to resolve.
    }
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Above the root is nowhere. A link can walk up inside the store, but
      // never out of it.
      if (segments.length === 0) return null;
      segments.pop();
      named = false;
      continue;
    }
    segments.push(segment);
    named = true;
  }

  return named ? segments : null;
}

/** Keeps the pasted file's name where it's usable, and invents one where it isn't. */
export function assetName(original: string): string {
  const base = original.split(/[\\/]/).pop()?.trim() ?? "";
  if (base && base !== "." && base !== "..") return base;
  return `image-${Date.now()}.png`;
}
