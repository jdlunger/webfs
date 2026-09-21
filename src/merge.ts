/**
 * A deliberately dumb three-way line merge.
 *
 * Used when another tab saves a file this tab also has open: `base` is the
 * content as this tab last saw on disk, `mine` is what's in the editor now,
 * and `theirs` is what the other tab just wrote.
 *
 * The model is as simple as it can be while still being useful: reduce each
 * side to the single run of lines it changed, and if those two runs don't
 * overlap, apply both. If they do overlap, the local text wins outright and
 * the other tab's version of those lines is dropped — lossy on purpose, on the
 * grounds that clobbering what someone is actively typing is the worse
 * outcome. There's no real diff here and no conflict markers.
 */

const linesEqual = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

/** The one contiguous run of lines that turns `base` into `next`. */
interface Hunk {
  start: number;
  /** Exclusive end of the replaced range, in `base` coordinates. */
  baseEnd: number;
  lines: string[];
}

function changedRun(base: string[], next: string[]): Hunk | null {
  if (linesEqual(base, next)) return null;

  let start = 0;
  while (start < base.length && start < next.length && base[start] === next[start]) start++;

  let tail = 0;
  const room = Math.min(base.length, next.length) - start;
  while (tail < room && base[base.length - 1 - tail] === next[next.length - 1 - tail]) tail++;

  return { start, baseEnd: base.length - tail, lines: next.slice(start, next.length - tail) };
}

export function mergeText(base: string, mine: string, theirs: string): string {
  if (mine === theirs) return mine;
  if (mine === base) return theirs;
  if (theirs === base) return mine;

  const baseLines = base.split("\n");
  const myRun = changedRun(baseLines, mine.split("\n"));
  const theirRun = changedRun(baseLines, theirs.split("\n"));
  if (!myRun) return theirs;
  if (!theirRun) return mine;

  // Half-open ranges, so a pure insertion (start === baseEnd) never counts as
  // overlapping an edit that merely abuts it.
  const overlaps = myRun.start < theirRun.baseEnd && theirRun.start < myRun.baseEnd;
  if (overlaps) return mine;

  const merged = baseLines.slice();
  for (const run of [myRun, theirRun].sort((a, b) => b.start - a.start)) {
    merged.splice(run.start, run.baseEnd - run.start, ...run.lines);
  }
  return merged.join("\n");
}
