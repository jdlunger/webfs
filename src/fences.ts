/**
 * Triple-backtick commands: a fenced block whose language names something for
 * webfs to draw rather than a language to highlight.
 *
 *     ```todo
 *     ```
 *
 * The syntax is chosen rather than invented. A fence is already CommonMark, so
 * a note containing one is still a valid markdown file everywhere else: GitHub
 * renders it as an empty code block, Obsidian the same, and a sync carries it
 * about without anything having an opinion. Compare `![[…]]`, which had to be
 * taught to remark before a note containing one could be opened here without
 * being rewritten (see `wikilinks.ts`) — this needs teaching only how to *draw*
 * it, because the parser already knows the shape.
 *
 * The node still has to exist, though, for the same reason the wiki ones do:
 * left as a `code` node, Crepe hands it to CodeMirror and someone gets a code
 * editor where they asked for a list. So a known command is lifted out into a
 * node of its own, drawn by `Editor.tsx`, and written back as the fence it came
 * from.
 *
 * Pure — no remark, no ProseMirror.
 */

/** The id of the ProseMirror node and the mdast node alike. */
export const FENCE_BLOCK = "fenceCommand";

/**
 * The one command there is. Held in a list because the point of the syntax is
 * that there can be more, and because "is this fence a command" has to be one
 * question with one answer — the parser, the serializer and the slash menu all
 * ask it.
 */
export const FENCE_COMMANDS = ["todo"] as const;

export type FenceName = (typeof FENCE_COMMANDS)[number];

export const TODO = "todo" satisfies FenceName;

export interface FenceCommand {
  name: FenceName;
  /** Everything after the name on the fence line, verbatim and trimmed. */
  args: string;
}

export function isFenceName(value: unknown): value is FenceName {
  return typeof value === "string" && (FENCE_COMMANDS as readonly string[]).includes(value);
}

/**
 * The command a fence names, or null for an ordinary code block.
 *
 * `lang` and `meta` are remark's split of the info string — the first word and
 * the rest — which is exactly the split wanted here, so nothing is re-parsed.
 * A language webfs doesn't know is left alone, and stays a code block.
 */
export function parseFence(lang: unknown, meta: unknown): FenceCommand | null {
  if (!isFenceName(lang)) return null;
  return { name: lang, args: typeof meta === "string" ? meta.trim() : "" };
}

/**
 * The fence written back out.
 *
 * The run of backticks is long enough to contain whatever is inside, which
 * matters only for a command that grows a body — but getting it wrong would
 * end the block early and turn the rest of the note into prose, so it is
 * handled here once rather than assumed away.
 */
export function fenceMarkdown({ name, args }: FenceCommand, value = ""): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map(run => run[0].length));
  const edge = "`".repeat(Math.max(3, longest + 1));
  const head = args ? `${name} ${args}` : name;
  return value ? `${edge}${head}\n${value}\n${edge}` : `${edge}${head}\n${edge}`;
}

/**
 * How a `todo` block says what it is looking at.
 *
 * Here rather than in the editor because it is a statement about what the
 * argument means, and the argument is this module's.
 */
export function describeScope(args: string): string {
  const scope = args.replace(/^\/+|\/+$/g, "");
  return scope ? `in ${scope}` : "everywhere in this drive";
}

/** The shape this needs from mdast, without depending on remark for a type. */
export interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  [key: string]: unknown;
}

/**
 * Turns the code blocks that name a command into nodes of their own.
 *
 * Mutates, because that's what a remark transformer is handed. Recurses, so a
 * command inside a blockquote or a list item is found too — there is no reason
 * for the syntax to work only at the top level, and `children` is the only
 * thing being walked either way.
 */
export function expandFences(tree: MarkdownNode): MarkdownNode {
  const { children } = tree;
  if (!children) return tree;

  tree.children = children.map(child => {
    if (child.type !== "code") return expandFences(child);
    const command = parseFence(child.lang, child.meta);
    if (!command) return child;
    return {
      type: FENCE_BLOCK,
      name: command.name,
      args: command.args,
      value: typeof child.value === "string" ? child.value : "",
    };
  });
  return tree;
}
