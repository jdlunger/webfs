/**
 * Checkboxes: finding them in markdown, and deciding what order they go in.
 *
 * Two features share this module, which is why it exists rather than living
 * in the editor. Sorting a list (the ⇅ beside every checkbox list) needs to
 * know which items are finished and where they should end up; a `todo` fence
 * needs to find the unfinished ones across a whole drive. Both are questions
 * about checkboxes, and neither is a question about ProseMirror — so they're
 * answered here, in `bun test` reach, and the editor is left holding nothing
 * but the wiring.
 *
 * Pure but for `findOpenTasks`, which is handed a reader rather than a store
 * for the same reason: what it does with the text is the testable part.
 */
import type { FileSystem } from "./fs";

/** A `- [ ] …` line, taken apart. Everything is kept verbatim. */
export interface TaskLine {
  /** Leading whitespace, as written — tabs stay tabs. */
  indent: string;
  /** The bullet or number: `-`, `*`, `+`, `1.`, `1)`. */
  marker: string;
  checked: boolean;
  /** What the checkbox says, trailing whitespace trimmed. */
  text: string;
}

/**
 * `- [ ] text`, in any of the spellings a vault uses.
 *
 * Deliberately not a CommonMark parse: this runs over files that are never
 * opened in the editor, where the only thing wanted is the checkboxes. The
 * cost is that a checkbox inside a fenced code block is found too — see
 * `findOpenTasks`, which strips fences before it gets here.
 */
const TASK = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s?(.*)$/;

export function parseTaskLine(line: string): TaskLine | null {
  const match = TASK.exec(line);
  if (!match) return null;
  return {
    indent: match[1] ?? "",
    marker: match[2] ?? "-",
    checked: (match[3] ?? " ").toLowerCase() === "x",
    text: (match[4] ?? "").trim(),
  };
}

/**
 * The order that leaves the unfinished ones at the top.
 *
 * Returns a permutation rather than the items themselves, so the caller can
 * reorder whatever it is holding — ProseMirror nodes, in the one caller there
 * is — and, more to the point, can see whether anything moved at all. A list
 * already in this order comes back as the identity, and the editor then
 * dispatches nothing: sorting a sorted list must not rewrite the note, or the
 * button becomes a way to make a sync change by pressing it twice.
 *
 * Stable within each half, so the order someone chose among their unfinished
 * items survives. An item that isn't a checkbox at all counts as unfinished:
 * it has nothing to say about being done, and dropping it to the bottom with
 * the finished ones would be an opinion nobody asked for.
 */
export function orderByDone(done: readonly boolean[]): number[] {
  const open: number[] = [];
  const finished: number[] = [];
  done.forEach((isDone, index) => (isDone ? finished : open).push(index));
  return [...open, ...finished];
}

/** Whether an order leaves everything exactly where it was. */
export function isIdentity(order: readonly number[]): boolean {
  return order.every((value, index) => value === index);
}

/** One unfinished checkbox, and where to find it. */
export interface OpenTask {
  /** The file it's in, as a node id — a path within the drive. */
  file: string;
  /** Which line of that file, counting from 1, for the tooltip. */
  line: number;
  text: string;
}

export interface TaskSummary {
  tasks: OpenTask[];
  /** How many more there were than `limit` allowed. */
  more: number;
}

/**
 * How many a `todo` fence lists before it stops.
 *
 * Not a page size and nothing pages past it: the block is a prompt to go and
 * do something, and a thousand rows of it is not. The count of what's left is
 * shown instead, which is the honest summary of a backlog that long.
 */
export const TASK_LIMIT = 200;

/** Only these are read. Everything else in a drive is images and attachments. */
const MARKDOWN = /\.(md|markdown|mdown|txt)$/i;

/**
 * Blanks out fenced code blocks, keeping the line count.
 *
 * A `- [ ]` inside a code fence is an example of a checkbox, not one, and a
 * `todo` fence that listed its own documentation would be a bad joke. Lines
 * are replaced rather than removed so the numbers that come out still point
 * at the right line of the real file.
 */
function withoutFences(lines: readonly string[]): string[] {
  let fence: string | null = null;
  return lines.map(line => {
    const edge = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (edge) {
        fence = (edge[1] ?? "").slice(0, 1);
        return "";
      }
      return line;
    }
    // A fence closes on the same character it opened with, so a ``` inside a
    // ~~~ block doesn't end it.
    if (edge && (edge[1] ?? "").startsWith(fence)) fence = null;
    return "";
  });
}

/** The unfinished checkboxes in one file's text, in the order they appear. */
export function openTasksIn(text: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  withoutFences(text.split("\n")).forEach((line, index) => {
    const task = parseTaskLine(line);
    if (task && !task.checked && task.text) found.push({ line: index + 1, text: task.text });
  });
  return found;
}

/**
 * Whether a file is inside the scope a fence named.
 *
 * An empty scope is the whole drive. Anything else is a path: the file itself,
 * or anything under it. Ids are paths (see `fs.ts`), so this is the same
 * prefix test the rest of the app does — no lookup in the tree, and a scope
 * naming a folder that doesn't exist simply matches nothing.
 */
export function inScope(id: string, scope: string): boolean {
  const prefix = scope.replace(/^\/+|\/+$/g, "");
  if (!prefix) return true;
  return id === prefix || id.startsWith(`${prefix}/`);
}

/**
 * Every unfinished checkbox in a drive, or in the part of it a fence named.
 *
 * `read` is passed in rather than a store, so this is testable without OPFS
 * and so the caller decides what "the current text" means. That matters: the
 * file being edited has text in the record that hasn't reached disk yet (saves
 * are debounced), and a block that listed a checkbox you just ticked would be
 * wrong in the one place anyone is looking. So a node's own `content` wins
 * when it has been loaded, and the store is read only for files this tab has
 * never opened.
 */
export async function findOpenTasks(
  fs: FileSystem,
  scope: string,
  read: (id: string) => Promise<string | null>,
  limit = TASK_LIMIT,
): Promise<TaskSummary> {
  const files = Object.values(fs)
    .filter(node => node.type === "file" && !node.binary && MARKDOWN.test(node.name) && inScope(node.id, scope))
    .sort((a, b) => a.id.localeCompare(b.id));

  const tasks: OpenTask[] = [];
  let more = 0;
  for (const node of files) {
    const text = node.content ?? (await read(node.id));
    if (text === null || text === undefined) continue;
    for (const task of openTasksIn(text)) {
      if (tasks.length < limit) tasks.push({ file: node.id, line: task.line, text: task.text });
      else more += 1;
    }
  }
  return { tasks, more };
}
