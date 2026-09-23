/**
 * What a name looks like once it reaches OPFS.
 *
 * webfs keeps its notes in a real directory tree, which means every name it
 * stores is handed to a filesystem — and a filesystem is not a faithful
 * key-value store for names. It interprets them. On 2026-09-22 a vault synced
 * from a phone came back with all nine of its non-ASCII paths rewritten:
 * `Einführung` went in as U+00FC and came out of `walk()` as `u` + U+0308, the
 * same text in a different Unicode normalisation. Nothing in webfs asked for
 * that. `planSync` compares paths as strings, so it read nine files that
 * weren't there and nine that had gone, and pushed exactly that to GitHub.
 *
 * So names are escaped on the way in and unescaped on the way out, and the
 * platform only ever sees characters it has no opinions about. The escape is
 * percent-encoding of the UTF-8 bytes, which is familiar, reversible, and
 * stays readable for the ASCII names that are most of them: `Einführung`
 * is stored as `Einf%C3%BChrung`, and `Geshundheit & Bewegung` as itself.
 *
 * What this costs: OPFS inspected directly no longer shows exactly what the
 * app shows, which was a stated property of the store. It buys the more
 * important one — that a name webfs never chose can't reach the source of
 * truth.
 *
 * Two things this deliberately does *not* do:
 * - **Case is left alone.** A case-insensitive backing store would still
 *   collide `README.md` with `readme.md`. Escaping case would make every
 *   capital letter unreadable (`%52%45%41%44%4D%45.md`) for a fault nothing
 *   has yet demonstrated here, so it's a known gap rather than a fixed one.
 * - **A legacy name that already looks encoded is ambiguous.** A file someone
 *   literally called `Einf%C3%BChrung` before this existed now reads as
 *   `Einführung`. Newly written, that name escapes to `Einf%25C3%25BChrung`
 *   and is distinct; only names predating the change can collide, and the
 *   collision is a display one, not a data loss.
 */

/** Percent, and the characters filesystems are known to object to. */
const RESERVED = new Set([..."%<>:\"|?*\\/"]);

/**
 * Whether the platform can be trusted to hand this character back unchanged.
 *
 * Printable ASCII only, which is the whole point: normalisation has nothing to
 * do to a character that is one byte and already canonical. Everything above
 * U+007E is escaped whether or not this particular engine would have touched
 * it, because "which engines rewrite which characters" is exactly the question
 * that shouldn't need answering.
 */
function trusted(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return false; // Control characters.
  if (code > 0x7e) return false; // Everything non-ASCII.
  return !RESERVED.has(ch);
}

/** A character as percent-escaped UTF-8: `ü` → `%C3%BC`. */
function escape(ch: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(ch)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  return out;
}

/**
 * One path segment, as it is stored.
 *
 * Edges are escaped even when the character itself is fine: a trailing dot or
 * a leading or trailing space is silently trimmed by some filesystems, which
 * is the same class of fault as normalisation and just as invisible. A
 * *leading* dot is left alone — `.obsidian` is an ordinary name here.
 */
export function encodeSegment(name: string): string {
  const points = [...name];
  return points
    .map((ch, index) => {
      const last = index === points.length - 1;
      const trimmable = (ch === " " && (last || index === 0)) || (ch === "." && last);
      return trusted(ch) && !trimmable ? ch : escape(ch);
    })
    .join("");
}

/**
 * The name a stored segment stands for.
 *
 * Total, and tolerant: it runs on whatever OPFS happens to hold, including
 * names written before any of this existed. A `%` that doesn't begin a valid
 * escape is left as a `%`, so a legacy name survives being read even though it
 * was never encoded.
 */
export function decodeSegment(stored: string): string {
  const bytes: number[] = [];
  let out = "";
  const flush = () => {
    if (bytes.length === 0) return;
    out += new TextDecoder().decode(new Uint8Array(bytes));
    bytes.length = 0;
  };

  for (let i = 0; i < stored.length; i++) {
    const pair = stored[i] === "%" ? stored.slice(i + 1, i + 3) : "";
    if (pair.length === 2 && /^[0-9A-Fa-f]{2}$/.test(pair)) {
      bytes.push(Number.parseInt(pair, 16));
      i += 2;
      continue;
    }
    flush();
    out += stored[i];
  }

  flush();
  return out;
}

/** A whole path, logical → stored and back. */
export const encodePath = (path: readonly string[]): string[] => path.map(encodeSegment);
export const decodePath = (path: readonly string[]): string[] => path.map(decodeSegment);

/**
 * Whether a stored name is already what this module would have written.
 *
 * The test a migration runs: anything that answers false was written before
 * the escaping existed (or by something else entirely) and has to be renamed
 * before a lookup by its logical path can find it.
 */
export const isCanonical = (stored: string): boolean => encodeSegment(decodeSegment(stored)) === stored;
