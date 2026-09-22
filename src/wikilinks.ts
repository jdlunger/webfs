/**
 * Obsidian's embed syntax, `![[Pasted image 20260905101712.png|541]]`.
 *
 * Two things make this worth a module of its own rather than a regex in the
 * editor. The first is that CommonMark has no such construct: remark parses
 * the whole thing as literal text, and remark-stringify then *escapes* it on
 * the way back out — `!\[\[Pasted image…]]`, which Obsidian no longer renders.
 * So a vault opened here would be quietly rewritten by the first keystroke in
 * any note containing an image. Recognising the syntax is what stops that.
 *
 * The second is round-tripping. `raw` holds everything between the brackets
 * exactly as written, spaces included, and serialising puts it back unchanged;
 * the target and the display options are re-derived from it whenever they're
 * needed. Nothing normalises `x.png | center | 623` into `x.png|center|623`,
 * because a note that came back subtly different from how it went in would
 * turn every opened file into a sync change.
 *
 * Pure — no remark, no ProseMirror — so it's `bun test`-able. `Editor.tsx`
 * wires the two functions at the bottom into Milkdown.
 */
import { mimeOf } from "./assets";

/** The id of the ProseMirror node and the mdast node alike. */
export const WIKI_IMAGE = "wikiImage";

/**
 * An embed: `![[` … `]]`. The inner text can't contain a bracket of either
 * kind, which is what keeps this from running past the end of one embed and
 * swallowing the text up to the next.
 */
const EMBED = /!\[\[([^\[\]]*)\]\]/g;

export type WikiTextPart =
  | { type: "text"; value: string }
  | { type: typeof WIKI_IMAGE; raw: string };

/** The part before the first `|`: a filename, possibly with folders. */
export function wikiImageTarget(raw: string): string {
  return (raw.split("|")[0] ?? "").trim();
}

/**
 * Whether an embed points at something this app can show.
 *
 * Obsidian embeds notes and PDFs with the same syntax. Those have no meaning
 * here yet, and turning one into an `<img>` would render it as a broken image
 * rather than leaving it legible, so only images are claimed.
 */
function isImageEmbed(raw: string): boolean {
  return mimeOf(wikiImageTarget(raw)).startsWith("image/");
}

export interface WikiImageLayout {
  /** Pixels, from a `|541` or the first half of a `|640x480`. */
  width?: number;
  height?: number;
  center: boolean;
}

/**
 * The display options after the target. A bare number is a width — that's
 * Obsidian's own rule — and `center` is the one non-numeric option this vault
 * uses. Anything else is ignored rather than guessed at; it still round-trips,
 * because `raw` is what gets written back.
 */
export function wikiImageLayout(raw: string): WikiImageLayout {
  const layout: WikiImageLayout = { center: false };
  for (const param of raw.split("|").slice(1)) {
    const value = param.trim();
    const size = /^(\d+)(?:x(\d+))?$/.exec(value);
    if (size) {
      layout.width = Number(size[1]);
      if (size[2]) layout.height = Number(size[2]);
    } else if (value.toLowerCase() === "center") {
      layout.center = true;
    }
  }
  return layout;
}

/** The markdown an embed came from, byte for byte. */
export function wikiImageMarkdown(raw: string): string {
  return `![[${raw}]]`;
}

/**
 * Splits a run of text around the image embeds in it.
 *
 * Returns a single text part when there are none, so a caller can check
 * whether anything was found by the length of what comes back.
 */
export function splitWikiImages(text: string): WikiTextPart[] {
  const parts: WikiTextPart[] = [];
  let last = 0;

  EMBED.lastIndex = 0;
  for (let match = EMBED.exec(text); match; match = EMBED.exec(text)) {
    const raw = match[1] ?? "";
    if (!isImageEmbed(raw)) continue;
    if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
    parts.push({ type: WIKI_IMAGE, raw });
    last = match.index + match[0].length;
  }

  if (parts.length === 0) return [{ type: "text", value: text }];
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

/** The shape this needs from mdast, without depending on remark for a type. */
export interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  [key: string]: unknown;
}

/**
 * Replaces the embeds inside every text node with nodes of their own.
 *
 * Mutates, because that's what a remark transformer is handed. Only `text` is
 * touched, which is also what keeps code blocks and inline code out of it:
 * remark gives those their own node types, so an embed written inside one is
 * never seen here and stays the literal text it was meant to be.
 */
export function expandWikiImages(tree: MarkdownNode): MarkdownNode {
  const { children } = tree;
  if (!children) return tree;

  const next: MarkdownNode[] = [];
  for (const child of children) {
    if (child.type !== "text" || typeof child.value !== "string") {
      next.push(expandWikiImages(child));
      continue;
    }
    for (const part of splitWikiImages(child.value)) {
      next.push(
        part.type === "text"
          ? { type: "text", value: part.value }
          : { type: WIKI_IMAGE, raw: part.raw },
      );
    }
  }

  tree.children = next;
  return tree;
}
