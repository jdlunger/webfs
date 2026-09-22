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
 * The same file holds the other Obsidian construct remark has an opinion
 * about, `#tags`, for the same reason: CommonMark doesn't have them, and
 * left alone the serializer writes something else.
 *
 * Pure — no remark, no ProseMirror — so it's `bun test`-able. `Editor.tsx`
 * wires these into Milkdown.
 */
import { mimeOf } from "./assets";

/** The id of the ProseMirror node and the mdast node alike. */
export const WIKI_IMAGE = "wikiImage";

/**
 * Everything else written in double brackets: a link to another note
 * (`[[Osteologie Knie]]`), or an embed of something that isn't an image.
 *
 * webfs can't follow one or show what it points at, so it renders as the text
 * it already looks like. The point of giving it a node at all is that the
 * serializer leaves it alone: as ordinary text it comes back `!\[\[…]]`, and
 * Obsidian stops recognising it.
 */
export const WIKI_LINK = "wikiLink";

/**
 * An embed: `![[` … `]]`. The inner text can't contain a bracket of either
 * kind, which is what keeps this from running past the end of one embed and
 * swallowing the text up to the next.
 */
const EMBED = /!?\[\[([^\[\]]*)\]\]/g;

export type WikiTextPart =
  | { type: "text"; value: string }
  | { type: typeof WIKI_IMAGE; raw: string }
  /** Kept whole, brackets and leading `!` included, because it's written back verbatim. */
  | { type: typeof WIKI_LINK; source: string };

/** The part before the first `|`: a filename, possibly with folders. */
export function wikiImageTarget(raw: string): string {
  return (raw.split("|")[0] ?? "").trim();
}

/**
 * Whether a match is an embed of something this app can show as a picture.
 *
 * Obsidian embeds notes and PDFs with the same syntax, and links to notes with
 * the same brackets minus the `!`. Turning one of those into an `<img>` would
 * put a broken image where a legible name used to be, so they become a
 * WIKI_LINK instead — rendered as their own text, and just as carefully
 * preserved.
 */
function isImageEmbed(mark: string, raw: string): boolean {
  return mark === "!" && mimeOf(wikiImageTarget(raw)).startsWith("image/");
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

/** A link's markdown is what it was written as; nothing is derived from it. */
export function wikiLinkMarkdown(source: string): string {
  return source;
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
    const source = match[0];
    const raw = match[1] ?? "";
    if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
    parts.push(
      isImageEmbed(source.startsWith("!") ? "!" : "", raw)
        ? { type: WIKI_IMAGE, raw }
        : { type: WIKI_LINK, source },
    );
    last = match.index + source.length;
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
      if (part.type === "text") next.push({ type: "text", value: part.value });
      else if (part.type === WIKI_IMAGE) next.push({ type: WIKI_IMAGE, raw: part.raw });
      else next.push({ type: WIKI_LINK, source: part.source });
    }
  }

  tree.children = next;
  return tree;
}

/**
 * Puts back the `#` of a tag the serializer escaped.
 *
 * remark escapes any `#` that starts a line, because one *could* start a
 * heading — but in CommonMark it only does when followed by a space, so
 * `#classnotes` never could. What it writes instead, `\#classnotes`, renders
 * as the same text and is perfectly valid, and is no longer a tag in Obsidian:
 * the vault's notes are filed by exactly these.
 *
 * Only a `#` with an ordinary character hard against it is unescaped, which
 * leaves a real heading (`\# Title`) and a heading's own closing `#` escaped,
 * since both are followed by a space or nothing at all.
 */
export function unescapeTags(text: string): string {
  return text.replace(/\\#(?=[^\s#\\])/g, "#");
}
