/**
 * Where images pasted into a note live, and how their markdown links map onto
 * the store.
 *
 * Pure path arithmetic, kept out of the editor component so it can be tested
 * without mounting one — the `..` guard in particular is the kind of thing
 * that should never be verified by eye.
 */
import { idOf, segmentsOf } from "./fs";

/** Where a pasted image lands: a folder beside the note that references it. */
export const ASSET_DIR = "assets";

/**
 * Obsidian's attachment folder, and the one place a link is looked for when it
 * doesn't resolve where it points.
 *
 * A vault keeps every attachment in one folder at the root and refers to it by
 * bare filename from anywhere — `![[Pasted image 20260905101712.png]]` in a
 * note three folders deep. webfs resolves links the way GitHub does, relative
 * to the note, so that link points at a file beside the note that isn't there.
 * Rather than make the folder configurable, the name Obsidian defaults to is
 * simply tried second. It costs one extra miss on a link that's broken anyway,
 * and it's only reached when the honest interpretation found nothing.
 */
export const MEDIA_DIR = "Media";

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

/**
 * The name at the end of a link, decoded, or null if it doesn't end in one.
 */
function linkedName(url: string): string | null {
  const raw = url.split("/").filter(segment => segment !== "" && segment !== "." && segment !== "..").pop();
  if (raw === undefined) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Every place a relative link might be, best interpretation first.
 *
 * The first is where the link actually points, which is what GitHub reads and
 * what webfs itself writes. The second is `Media/`, for a vault that was
 * authored in Obsidian (see MEDIA_DIR). A caller reads them in order and takes
 * the first that exists — the fallback is never preferred over a real file.
 */
export function assetCandidates(noteId: string, url: string): string[][] {
  const candidates: string[][] = [];

  const direct = resolveAssetPath(noteId, url);
  if (direct) candidates.push(direct);

  const name = linkedName(url);
  if (name !== null) {
    const media = [MEDIA_DIR, name];
    if (!direct || idOf(direct) !== idOf(media)) candidates.push(media);
  }

  return candidates;
}

/** Keeps the pasted file's name where it's usable, and invents one where it isn't. */
export function assetName(original: string): string {
  const base = original.split(/[\\/]/).pop()?.trim() ?? "";
  if (base && base !== "." && base !== "..") return base;
  return `image-${Date.now()}.png`;
}
