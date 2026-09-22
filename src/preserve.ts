/**
 * Keeps a file's own bytes everywhere the user didn't type.
 *
 * Milkdown is a WYSIWYG editor: the markdown it saves is re-serialized from
 * the document, not patched, so every convention the serializer has an opinion
 * about is rewritten at once — tabs become spaces, `-` bullets become `*`,
 * `#classnotes` becomes `\#classnotes`, trailing spaces vanish. Measured on a
 * real Obsidian vault, one keystroke rewrote 190 lines of a 179-line note. All
 * of it is valid CommonMark and none of it was asked for, and a sync then
 * carries the whole lot to GitHub as the user's change.
 *
 * So the editor's output is treated as a statement about *what changed*, not
 * as the file. Three texts go in:
 *
 * - `original` — the bytes on disk, whatever dialect they're in.
 * - `baseline` — what the editor serialized the document to *before* this
 *   edit, so the same content in the serializer's own dialect.
 * - `current` — what it serializes to now.
 *
 * `baseline` and `current` are both the serializer's output, so the diff
 * between them is exactly the user's edit and nothing else. Lines that diff
 * says are untouched are written back from `original` byte for byte; only the
 * lines the edit actually covers come out in the serializer's dialect. A file
 * therefore converges on CommonMark line by line as it's edited, and a note
 * that's only read is never rewritten at all.
 *
 * Pure and line-based. `Editor.tsx` checks the result before writing it: it
 * re-parses and re-serializes, and falls back to `current` unless that gives
 * `current` back — so a bad reconstruction can only ever cost the preservation,
 * never the edit.
 */

/**
 * The most cells an alignment may cost before giving up.
 *
 * Quadratic in the line count, so it's nothing at the scale of a note (a
 * 250-line file is 62k) and worth refusing on something pathological. Giving
 * up loses the preservation, not the edit.
 */
const MAX_CELLS = 4_000_000;

/**
 * What two lines have to share to count as the same line in different
 * dialects.
 *
 * `baseline` and `original` say the same thing and disagree about how to write
 * it, so aligning them on exact text would match almost nothing. Dropping the
 * indentation, the bullet character and the backslashes lines up `\t- Kraft`
 * with `  * Kraft`, which is the pairing that lets the original be handed back.
 * Only ever used for matching — nothing is written in this form.
 */
function alignKey(line: string): string {
  // Blockquote markers are counted rather than dropped — a line inside a
  // callout is not the same line as one outside it — but what follows them
  // gets the same treatment as anything else, which is what lines up
  // `> - [x] Lesen` with `> * [x] Lesen` inside an Obsidian `> [!todo]`.
  let depth = 0;
  let rest = line;
  for (let quote = /^\s*>\s?/.exec(rest); quote; quote = /^\s*>\s?/.exec(rest)) {
    depth++;
    rest = rest.slice(quote[0].length);
  }

  return (
    ">".repeat(depth) +
    rest
      .replace(/^\s+/, "")
      .replace(/^[*+-](\s)/, "-$1")
      .replace(/\\([^A-Za-z0-9\s])/g, "$1")
      .trimEnd()
  );
}

/**
 * Index pairs of lines common to both, in order — a longest common
 * subsequence. Null when the middle is too big to be worth aligning.
 *
 * The common prefix and suffix are taken first, which is what makes the
 * ordinary case (one keystroke in a long note) cost almost nothing: it leaves
 * a middle of a line or two to actually align.
 */
function commonLines(a: readonly string[], b: readonly string[]): Array<[number, number]> | null {
  const pairs: Array<[number, number]> = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    pairs.push([start, start]);
    start++;
  }

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const rows = endA - start;
  const columns = endB - start;
  if (rows > 0 && columns > 0) {
    if (rows * columns > MAX_CELLS) return null;

    const width = columns + 1;
    const lengths = new Int32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        lengths[i * width + j] =
          a[start + i] === b[start + j]
            ? lengths[(i + 1) * width + j + 1]! + 1
            : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
      }
    }

    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (a[start + i] === b[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
        i++;
      } else {
        j++;
      }
    }
  }

  for (let k = 0; endA + k < a.length; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

interface Run {
  /** Half-open range in the first text. */
  aStart: number;
  aEnd: number;
  /** Half-open range in the second. */
  bStart: number;
  bEnd: number;
  same: boolean;
}

/** The pairs above, turned into alternating runs that cover both texts. */
function runs(pairs: Array<[number, number]>, aLength: number, bLength: number): Run[] {
  const out: Run[] = [];
  let a = 0;
  let b = 0;

  for (const [pa, pb] of pairs) {
    if (pa > a || pb > b) out.push({ aStart: a, aEnd: pa, bStart: b, bEnd: pb, same: false });
    const last = out.at(-1);
    if (last?.same && last.aEnd === pa && last.bEnd === pb) {
      last.aEnd = pa + 1;
      last.bEnd = pb + 1;
    } else {
      out.push({ aStart: pa, aEnd: pa + 1, bStart: pb, bEnd: pb + 1, same: true });
    }
    a = pa + 1;
    b = pb + 1;
  }

  if (a < aLength || b < bLength) out.push({ aStart: a, aEnd: aLength, bStart: b, bEnd: bLength, same: false });
  return out;
}

/**
 * Reconstructions of `current` that keep `original`'s bytes, best first.
 *
 * The caller writes the first one the editor reads back as `current` itself,
 * so this can afford to offer an exact answer and a cautious one rather than
 * having to choose between them. They differ over the lines the serializer
 * added that the original never had — a blank line between a paragraph and the
 * list under it, say. Dropping those is what hands the original back exactly;
 * keeping the ones that border on new text is what stops a paragraph the user
 * just typed from being swallowed by the block above it. Which is right
 * depends on the note, and the check the caller runs can tell.
 *
 * Always ends with `current`, so a caller that finds nothing it can verify
 * still has something to write.
 */
export function preserveUnchanged(original: string, baseline: string, current: string): string[] {
  if (baseline === current) return [original];
  if (original === "") return [current];

  // Held aside and put back at the end: the serializer always ends its output
  // with one newline, so a text that ends with a blank line and one that
  // doesn't would otherwise align a line out of step the whole way down.
  const trailing = original.endsWith("\n") ? "\n" : "";
  const chop = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text);

  const originalLines = chop(original).split("\n");
  const baselineLines = chop(baseline).split("\n");
  const currentLines = chop(current).split("\n");

  const anchors = commonLines(baselineLines.map(alignKey), originalLines.map(alignKey));
  const edit = commonLines(baselineLines, currentLines);
  if (!anchors || !edit) return [current];

  /**
   * What each baseline line is worth in the original's own bytes.
   *
   * A baseline line the original has no counterpart for is one the serializer
   * added, and is worth nothing. Original lines with no baseline counterpart
   * ride along with the next one that has one, which is how a blank line the
   * serializer dropped finds its way back.
   */
  const restored: string[][] = baselineLines.map(() => []);
  let taken = 0;
  for (const [b, o] of anchors) {
    restored[b] = [...originalLines.slice(taken, o), originalLines[o]!];
    taken = o + 1;
  }
  const rest = originalLines.slice(taken);
  const sections = runs(edit, baselineLines.length, currentLines.length);

  const rebuild = (keepBorders: boolean): string => {
    const out: string[] = [];

    sections.forEach((section, index) => {
      if (!section.same) {
        out.push(...currentLines.slice(section.bStart, section.bEnd));
        return;
      }

      let first = -1;
      let last = -1;
      for (let b = section.aStart; b < section.aEnd; b++) {
        if (restored[b]!.length === 0) continue;
        if (first < 0) first = b;
        last = b;
      }

      for (let b = section.aStart; b < section.aEnd; b++) {
        if (restored[b]!.length > 0) {
          out.push(...restored[b]!);
        } else if (
          keepBorders &&
          (((first < 0 || b < first) && index > 0) ||
            ((last < 0 || b > last) && index < sections.length - 1))
        ) {
          // An added line with the user's new text on the other side of it.
          // It's usually the blank that keeps them separate blocks.
          out.push(baselineLines[b]!);
        }
      }
    });

    // Only when the end of the note is what the edit left alone; if the user
    // typed there, what they typed is the end of the note.
    if (sections.at(-1)?.same) out.push(...rest);
    return out.join("\n") + trailing;
  };

  const exact = rebuild(false);
  const cautious = rebuild(true);
  return exact === cautious ? [exact, current] : [exact, cautious, current];
}
