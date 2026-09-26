import { useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, editorViewOptionsCtx, parserCtx, remarkStringifyOptionsCtx, serializerCtx } from "@milkdown/kit/core";
import { $node, $prose, $remark, type $Node } from "@milkdown/kit/utils";
import type { Ctx } from "@milkdown/kit/ctx";
import { Fragment, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView as ProseView } from "@milkdown/kit/prose/view";
import { segmentsOf } from "./fs";
import type { Store } from "./storage";
import { ASSET_DIR, assetCandidates, assetName, isAbsoluteUrl, mimeOf } from "./assets";
import { preserveUnchanged } from "./preserve";
import {
  WIKI_IMAGE,
  WIKI_LINK,
  expandWikiImages,
  unescapeTags,
  wikiImageLayout,
  wikiImageMarkdown,
  wikiImageTarget,
  wikiLinkMarkdown,
  type MarkdownNode,
} from "./wikilinks";
import {
  FENCE_BLOCK,
  TODO,
  describeScope,
  expandFences,
  fenceMarkdown,
  isFenceName,
  type FenceName,
  type MarkdownNode as FenceMarkdownNode,
} from "./fences";
import { isIdentity, openTasksIn, orderByDone, type TaskSummary } from "./tasks";
// Import the common feature styles individually rather than the
// `theme/common/style.css` bundle: that bundle pulls in `latex.css`, which
// `@import`s KaTeX's full font set (~1.4MB of base64 fonts) even though the
// latex feature is disabled below.
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/image-block.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/table.css";
import "@milkdown/crepe/theme/frame-dark.css";
import type { FSNode } from "./fs";

/**
 * How a file is being shown: the rendered document Crepe draws, or the
 * markdown behind it. Per file rather than per pane or per app, so the
 * toggle acts on what you're looking at — and a split can hold one of each.
 */
export type EditorView = "rich" | "text";

/**
 * How long after a checkbox changes a `todo` block looks again.
 *
 * Long enough for the edit to have reached the record App holds (that is
 * written on the render after `onChange`, and the scan reads it), and short
 * enough that ticking a box and glancing up is one action.
 */
const TODO_REFRESH_MS = 600;

/** The slash menu's icon for the block, in the shape Crepe wants: raw SVG. */
const CHECKLIST_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 7 2 2 4-4"/><path d="m3 17 2 2 4-4"/><path d="M13 8h8"/><path d="M13 18h8"/></svg>`;

/**
 * Wires up a control drawn inside the document, without ProseMirror seeing it.
 *
 * Everything the editor draws is inside the editable region as far as the
 * browser is concerned, so an unguarded click would also move the selection —
 * or, on a node that can be selected, select the block the button sits in.
 * Swallowing the mouse events is what keeps pressing one of these from being
 * an edit. `touchstart` is only stopped, never prevented: preventing it is
 * what stops the browser sending the click that follows, and the button would
 * then work with a mouse and not with a finger.
 */
function editorButton(element: HTMLElement, run: () => void): void {
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  element.addEventListener("touchstart", event => event.stopPropagation(), { passive: true });
  element.addEventListener("mousedown", swallow);
  element.addEventListener("click", event => {
    swallow(event);
    run();
  });
}

// --- sorting a checkbox list -------------------------------------------------

const LIST_TYPES = new Set(["bullet_list", "ordered_list"]);

const isList = (node: ProseNode) => LIST_TYPES.has(node.type.name);

/**
 * Whether a list has checkboxes in it at all.
 *
 * GFM marks the *items*, not the list — `checked` is null on an ordinary
 * bullet and a boolean on a checkbox — so this is the only way to ask.
 */
function hasCheckbox(list: ProseNode): boolean {
  let found = false;
  list.forEach(item => {
    if (typeof item.attrs.checked === "boolean") found = true;
  });
  return found;
}

/**
 * The list with its finished items moved to the end, or null if none moved.
 *
 * Null rather than an equal copy on purpose: it is what lets the caller
 * dispatch nothing at all. A transaction re-serializes the document, and a
 * button that rewrote the note every time it was pressed — including on a
 * list already in order — would be a way to make a sync change by tidying
 * something that was already tidy.
 *
 * Nested lists are sorted too, and they travel inside the item they belong to,
 * so a sub-list stays under its parent wherever the parent lands.
 */
function sortedList(list: ProseNode): ProseNode | null {
  const items: ProseNode[] = [];
  let changed = false;
  list.forEach(item => {
    const deeper = sortedInside(item);
    if (deeper) changed = true;
    items.push(deeper ?? item);
  });

  const order = orderByDone(items.map(item => item.attrs.checked === true));
  if (!isIdentity(order)) changed = true;
  if (!changed) return null;
  return list.type.create(list.attrs, Fragment.fromArray(order.map(index => items[index]!)), list.marks);
}

/** The same, applied to whatever lists are nested inside one item. */
function sortedInside(item: ProseNode): ProseNode | null {
  const children: ProseNode[] = [];
  let changed = false;
  item.forEach(child => {
    const sorted = isList(child) ? sortedList(child) : null;
    if (sorted) changed = true;
    children.push(sorted ?? child);
  });
  return changed ? item.type.create(item.attrs, Fragment.fromArray(children), item.marks) : null;
}

/** Sorts the list that begins at `pos`, if one still does. */
function sortListAt(view: ProseView, pos: number | undefined): void {
  if (pos === undefined) return;
  const list = view.state.doc.nodeAt(pos);
  if (!list || !isList(list)) return;
  const sorted = sortedList(list);
  if (!sorted) return;
  view.dispatch(view.state.tr.replaceWith(pos, pos + list.nodeSize, sorted));
}

/** The ⇅ itself. `getPos` is asked at click time, so a moved list is fine. */
function sortHandle(view: ProseView, getPos: () => number | undefined): HTMLElement {
  const holder = document.createElement("div");
  holder.className = "task-sort";
  holder.contentEditable = "false";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "task-sort-button";
  button.textContent = "⇅";
  const label = "Move finished items to the end";
  button.title = label;
  button.setAttribute("aria-label", label);
  editorButton(button, () => sortListAt(view, getPos()));

  holder.append(button);
  return holder;
}

/**
 * One handle per checkbox list, as a widget before it.
 *
 * Only the outermost gets one: a sort takes the lists below it along, and a
 * button beside every level of a nested list would be four buttons doing the
 * same thing. A widget rather than a node view because the button is not part
 * of the document — nothing about it is written to the file — and a decoration
 * is exactly the way to say that.
 */
function taskListHandles(doc: ProseNode): DecorationSet {
  const widgets: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!isList(node)) return true;
    if (!hasCheckbox(node)) return true;
    widgets.push(
      Decoration.widget(pos, (view, getPos) => sortHandle(view, getPos), {
        side: -1,
        key: `sort@${pos}`,
        ignoreSelection: true,
      }),
    );
    return false;
  });
  return DecorationSet.create(doc, widgets);
}

const sortKey = new PluginKey<DecorationSet>("webfsTaskListSort");

/** Rebuilt only when the document changes; the doc is walked once per edit. */
const sortTaskLists = () =>
  new Plugin({
    key: sortKey,
    state: {
      init: (_config, state) => taskListHandles(state.doc),
      apply: (tr, current) => (tr.docChanged ? taskListHandles(tr.doc) : current),
    },
    props: {
      decorations: state => sortKey.getState(state),
    },
  });

/**
 * Puts a command fence where the slash menu was typed.
 *
 * The whole paragraph is replaced rather than its text cleared and a block
 * added after it: what is in there is the `/todo` that opened the menu, and
 * nobody wants the empty line it would otherwise leave behind.
 */
function insertFence(ctx: Ctx, node: $Node, name: FenceName): void {
  const view = ctx.get(editorViewCtx);
  const { $from } = view.state.selection;
  if ($from.depth === 0) return;
  const block = node.type(ctx).create({ name, args: "", value: "" });
  view.dispatch(
    view.state.tr.replaceWith($from.before($from.depth), $from.after($from.depth), block).scrollIntoView(),
  );
}

interface EditorProps {
  file: FSNode | null;
  view: EditorView;
  /**
   * The active drive's files. Passed rather than imported: a pasted image and
   * a binary preview are reads and writes against one drive's folder, and
   * which drive that is belongs to App, not to the editor.
   */
  store: Store;
  /** Counter bumped when another tab's edit has been merged into `file`. */
  externalEdit: number;
  /** Carries the id, because two panes can be editing two different files. */
  onChange: (id: string, content: string) => void;
  /** A pasted image became a file; the tree and sync need to know. */
  onAssetAdded: () => void;
  /**
   * What a `todo` fence lists, for the scope it names.
   *
   * Passed in rather than done here because it reads every note in the drive,
   * and the tree — with the text other tabs are holding, which hasn't reached
   * disk yet — belongs to App. The editor only knows how to draw the answer.
   */
  findTasks: (scope: string) => Promise<TaskSummary>;
  /** A row in a `todo` fence was clicked: go to the note the checkbox is in. */
  onOpenFile: (id: string) => void;
  /**
   * Tick a checkbox a `todo` fence is listing, in whatever file holds it.
   * Answers false when the file has moved on since the scan, which is the
   * block's cue to show what is actually there now.
   */
  onCompleteTask: (file: string, line: number, text: string) => Promise<boolean>;
}

interface MilkdownEditorProps {
  file: FSNode;
  store: Store;
  onChange: (id: string, content: string) => void;
  onAssetAdded: () => void;
  findTasks: (scope: string) => Promise<TaskSummary>;
  onOpenFile: (id: string) => void;
  onCompleteTask: (file: string, line: number, text: string) => Promise<boolean>;
}

function MilkdownEditor({ file, store, onChange, onAssetAdded, findTasks, onOpenFile, onCompleteTask }: MilkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onAssetAddedRef = useRef(onAssetAdded);
  onAssetAddedRef.current = onAssetAdded;
  // Refs for the same reason the two above are: the editor is built once and
  // holds these for its whole life, and a new function identity every render
  // must not be a reason to tear Crepe down.
  const findTasksRef = useRef(findTasks);
  findTasksRef.current = findTasks;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onCompleteTaskRef = useRef(onCompleteTask);
  onCompleteTaskRef.current = onCompleteTask;

  useEffect(() => {
    if (!containerRef.current) return;

    /** Object URLs handed to the DOM, revoked together when this unmounts. */
    const objectUrls: string[] = [];

    /**
     * Where a pasted or dropped image goes.
     *
     * Crepe's default keeps the File in memory behind a `blob:` URL, which
     * dies with the document — the note then holds a link to nothing, and
     * GitHub can't see it at all. Writing a real file instead makes the
     * image a normal part of the store: it syncs, it survives a reload, and
     * the relative link resolves on GitHub exactly as it does here.
     */
    const storeImage = async (image: File): Promise<string> => {
      const dir = segmentsOf(file.id).slice(0, -1);
      const name = await store.createFile([...dir, ASSET_DIR], assetName(image.name));
      const bytes = new Uint8Array(await image.arrayBuffer());
      await store.writeFile([...dir, ASSET_DIR, name], bytes);
      onAssetAddedRef.current();
      // Encoded, because a space in the name would otherwise end the URL as
      // far as markdown is concerned.
      return `${ASSET_DIR}/${encodeURIComponent(name)}`;
    };

    /**
     * Object URL per link, so a note that shows the same image twice reads it
     * once and — more to the point — a re-render of a node doesn't mint a
     * second URL for a picture that's already on screen.
     */
    const loading = new Map<string, Promise<string | null>>();

    /**
     * The bytes behind a stored link, as something the DOM can load.
     *
     * The markdown keeps the link as written (that's what GitHub reads), and
     * the browser can't fetch OPFS, so the file is read and handed over as an
     * object URL instead. Null when the link names nothing in the store, after
     * every candidate path has been tried.
     */
    const loadImage = (url: string): Promise<string | null> => {
      const cached = loading.get(url);
      if (cached) return cached;

      const pending = (async () => {
        for (const path of assetCandidates(file.id, url)) {
          const bytes = await store.readBytes(path);
          if (!bytes) continue;
          const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeOf(url) }));
          objectUrls.push(objectUrl);
          return objectUrl;
        }
        return null;
      })();

      loading.set(url, pending);
      return pending;
    };

    /** What Crepe's own image nodes load. Absolute URLs are already loadable. */
    const resolveImage = async (url: string): Promise<string> => {
      if (!url || isAbsoluteUrl(url)) return url;
      return (await loadImage(url)) ?? url;
    };

    /**
     * An Obsidian embed on screen. The image arrives after the node is in the
     * document, since reading it is async and `toDOM` isn't; a link that
     * resolves to nothing shows its own source instead of an empty gap, so
     * it's clear *which* embed is broken.
     */
    const renderWikiImage = (raw: string): HTMLElement => {
      const span = document.createElement("span");
      span.className = "wiki-image";
      span.dataset.wikiRaw = raw;

      const { width, height, center } = wikiImageLayout(raw);
      if (center) span.classList.add("wiki-image-center");

      const img = document.createElement("img");
      img.alt = wikiImageTarget(raw);
      if (width !== undefined) img.style.width = `${width}px`;
      if (height !== undefined) img.style.height = `${height}px`;
      span.appendChild(img);

      void loadImage(wikiImageTarget(raw)).then(src => {
        if (src) {
          img.src = src;
          return;
        }
        span.classList.add("wiki-image-missing");
        span.textContent = wikiImageMarkdown(raw);
      });

      return span;
    };

    /**
     * The embed as a node of its own, holding the text between the brackets
     * verbatim and writing it back unchanged. Without this the syntax is text
     * to remark, and gets escaped into `!\[\[…]]` the first time the note is
     * saved — see wikilinks.ts.
     */
    const wikiImageNode = $node(WIKI_IMAGE, () => ({
      inline: true,
      group: "inline",
      atom: true,
      attrs: { raw: { default: "" } },
      parseDOM: [
        {
          tag: "span[data-wiki-raw]",
          getAttrs: (dom: HTMLElement | string) => ({
            raw: typeof dom === "string" ? "" : dom.dataset.wikiRaw ?? "",
          }),
        },
      ],
      toDOM: (node: { attrs: Record<string, unknown> }) => renderWikiImage(String(node.attrs.raw ?? "")),
      parseMarkdown: {
        match: (node: MarkdownNode) => node.type === WIKI_IMAGE,
        runner: (state, node, type) => {
          state.addNode(type, { raw: String(node.raw ?? "") });
        },
      },
      toMarkdown: {
        match: node => node.type.name === WIKI_IMAGE,
        runner: (state, node) => {
          state.addNode(WIKI_IMAGE, undefined, undefined, { raw: String(node.attrs.raw ?? "") });
        },
      },
    }));

    /**
     * A link, or an embed of something that isn't an image: shown as the text
     * it already reads as, and written back exactly as it was found.
     */
    const wikiLinkNode = $node(WIKI_LINK, () => ({
      inline: true,
      group: "inline",
      atom: true,
      attrs: { source: { default: "" } },
      parseDOM: [
        {
          tag: "span[data-wiki-link]",
          getAttrs: (dom: HTMLElement | string) => ({
            source: typeof dom === "string" ? "" : dom.dataset.wikiLink ?? "",
          }),
        },
      ],
      toDOM: (node: { attrs: Record<string, unknown> }) => {
        const source = String(node.attrs.source ?? "");
        const span = document.createElement("span");
        span.className = "wiki-link";
        span.dataset.wikiLink = source;
        span.textContent = source;
        return span;
      },
      parseMarkdown: {
        match: (node: MarkdownNode) => node.type === WIKI_LINK,
        runner: (state, node, type) => {
          state.addNode(type, { source: String(node.source ?? "") });
        },
      },
      toMarkdown: {
        match: node => node.type.name === WIKI_LINK,
        runner: (state, node) => {
          state.addNode(WIKI_LINK, undefined, undefined, { source: String(node.attrs.source ?? "") });
        },
      },
    }));

    /**
     * Both halves of the syntax: the embeds and links are cut out of the text
     * remark parsed them into, and stringify handlers put them back. remark
     * has no idea what either node is otherwise and refuses to serialize one.
     */
    const wikiImageRemark = $remark(WIKI_IMAGE, () => function remarkWikiImage(this: {
      data: () => { toMarkdownExtensions?: unknown[] };
    }) {
      const data = this.data();
      const extensions = (data.toMarkdownExtensions ??= []);
      extensions.push({
        handlers: {
          [WIKI_IMAGE]: (node: MarkdownNode) => wikiImageMarkdown(String(node.raw ?? "")),
          [WIKI_LINK]: (node: MarkdownNode) => wikiLinkMarkdown(String(node.source ?? "")),
        },
      });
      return (tree: unknown) => {
        expandWikiImages(tree as MarkdownNode);
      };
    });

    /**
     * The `todo` blocks on screen, so an edit that changes what they list can
     * tell them to look again.
     *
     * Pruned as it is walked rather than through some unmount hook ProseMirror
     * doesn't offer: a node's DOM is rebuilt whenever the node instance
     * changes, and the loader belonging to the DOM that was dropped would
     * otherwise sit here for the life of the editor, re-reading the drive on
     * every pass.
     */
    const todoBlocks = new Set<{ root: HTMLElement; load: () => void }>();

    const refreshTodoBlocks = () => {
      for (const block of todoBlocks) {
        if (block.root.isConnected) block.load();
        else todoBlocks.delete(block);
      }
    };

    /**
     * The rows of a `todo` block: what's unfinished, and where it lives.
     *
     * `reload` is how a tick gets back on screen. Rather than striking the row
     * out where it is, the block asks again — so what you are looking at is
     * what the drive says, including when the tick was *refused* because the
     * file had moved on. A row that lied about being ticked would be worse
     * than one that reappears.
     */
    const renderTasks = ({ tasks, more }: TaskSummary, reload: () => void): HTMLElement => {
      if (tasks.length === 0) {
        const empty = document.createElement("p");
        empty.className = "todo-block-empty";
        empty.textContent = "Nothing unfinished here.";
        return empty;
      }

      const list = document.createElement("ul");
      list.className = "todo-block-list";
      for (const task of tasks) {
        const row = document.createElement("li");

        // A real checkbox rather than a styled span: this is the one control
        // in the block that changes a file, and everything that expects a
        // checkbox — a screen reader, a keyboard, a long-press — should find
        // one. It is disabled the moment it is pressed, because the write
        // goes through the record and the queue and the row is about to be
        // replaced; a second press in that window would be a second tick
        // against a list that no longer exists.
        const tick = document.createElement("input");
        tick.type = "checkbox";
        tick.className = "todo-block-tick";
        tick.title = "Tick this off";
        tick.setAttribute("aria-label", `Tick off: ${task.text}`);
        editorButton(tick, () => {
          if (tick.disabled) return;
          tick.disabled = true;
          tick.checked = true;
          void onCompleteTaskRef.current(task.file, task.line, task.text).then(reload, error => {
            console.error("Failed to tick off a checkbox", error);
            reload();
          });
        });
        row.append(tick);

        const open = document.createElement("button");
        open.type = "button";
        open.className = "todo-block-item";
        // The last segment on screen and the whole path in the tooltip: this
        // is a column the width of a note, and a clipped path shows the half
        // that doesn't identify it. The opposite trade to `commitTitle`.
        open.title = `${task.file} · line ${task.line}`;
        const text = document.createElement("span");
        text.className = "todo-block-text";
        text.textContent = task.text;
        const where = document.createElement("span");
        where.className = "todo-block-where";
        where.textContent = task.file.split("/").pop() ?? task.file;
        open.append(text, where);
        // The rest of the row still opens the note: ticking is one thing you
        // might want from a list of what's left, and reading the paragraph
        // under the checkbox is the other.
        editorButton(open, () => onOpenFileRef.current(task.file));
        row.append(open);
        list.append(row);
      }

      if (more > 0) {
        const rest = document.createElement("li");
        rest.className = "todo-block-more";
        rest.textContent = `…and ${more} more`;
        list.append(rest);
      }
      return list;
    };

    /**
     * A `todo` fence, drawn.
     *
     * The scan is asynchronous and `toDOM` isn't, so the block goes in saying
     * what it is doing and fills when the answer lands — the same shape as a
     * wiki embed above, for the same reason.
     */
    const renderTodoBlock = (args: string): HTMLElement => {
      const root = document.createElement("div");
      root.className = "todo-block";
      root.contentEditable = "false";
      root.dataset.fence = TODO;
      root.dataset.fenceArgs = args;

      const header = document.createElement("div");
      header.className = "todo-block-header";
      const title = document.createElement("span");
      title.className = "todo-block-title";
      title.textContent = "Unfinished";
      const scope = document.createElement("span");
      scope.className = "todo-block-scope";
      scope.textContent = describeScope(args);
      const again = document.createElement("button");
      again.type = "button";
      again.className = "todo-block-refresh";
      again.textContent = "↻";
      // A block only hears about the note it is in (see `noticeTasks` below),
      // so this is how it hears about every other one.
      const label = "Look again";
      again.title = label;
      again.setAttribute("aria-label", label);
      header.append(title, scope, again);

      const body = document.createElement("div");
      body.className = "todo-block-body";
      body.textContent = "Looking…";
      root.append(header, body);

      // A later scan always wins, so pressing ↻ twice can't leave the slower
      // of the two answers on screen.
      let generation = 0;
      const load = () => {
        const mine = ++generation;
        void findTasksRef.current(args).then(
          summary => {
            if (mine === generation) body.replaceChildren(renderTasks(summary, load));
          },
          err => {
            console.error("Failed to list unfinished checkboxes", err);
            if (mine === generation) body.textContent = "Couldn't read the drive.";
          },
        );
      };

      editorButton(again, load);
      todoBlocks.add({ root, load });
      load();
      return root;
    };

    /**
     * A command fence as a node of its own.
     *
     * Atomic and not editable: what is on screen is read out of the drive, and
     * the document holds only the fence that asked for it. Left as the `code`
     * node remark parsed, Crepe hands it to CodeMirror and someone gets a code
     * editor where they asked for a list.
     */
    const fenceNode = $node(FENCE_BLOCK, () => ({
      group: "block",
      atom: true,
      selectable: true,
      isolating: true,
      attrs: { name: { default: TODO }, args: { default: "" }, value: { default: "" } },
      parseDOM: [
        {
          tag: "div[data-fence]",
          getAttrs: (dom: HTMLElement | string) =>
            typeof dom === "string"
              ? { name: TODO, args: "", value: "" }
              : { name: dom.dataset.fence ?? TODO, args: dom.dataset.fenceArgs ?? "", value: "" },
        },
      ],
      // `todo` is the only command there is, and `parseFence` is what decides
      // a node gets made at all — so a node here always has one it can draw.
      toDOM: (node: { attrs: Record<string, unknown> }) => renderTodoBlock(String(node.attrs.args ?? "")),
      parseMarkdown: {
        match: (node: FenceMarkdownNode) => node.type === FENCE_BLOCK,
        runner: (state, node, type) => {
          state.addNode(type, {
            name: isFenceName(node.name) ? node.name : TODO,
            args: String(node.args ?? ""),
            value: String(node.value ?? ""),
          });
        },
      },
      toMarkdown: {
        match: node => node.type.name === FENCE_BLOCK,
        runner: (state, node) => {
          state.addNode(FENCE_BLOCK, undefined, undefined, {
            name: node.attrs.name,
            args: node.attrs.args,
            value: node.attrs.value,
          });
        },
      },
    }));

    /**
     * Both halves again: the fences remark parsed as code blocks are lifted
     * into nodes, and a stringify handler writes them back as the fence they
     * came from. Without the handler remark refuses to serialize a node type
     * it has never heard of.
     */
    const fenceRemark = $remark(FENCE_BLOCK, () => function remarkFenceCommand(this: {
      data: () => { toMarkdownExtensions?: unknown[] };
    }) {
      const data = this.data();
      const extensions = (data.toMarkdownExtensions ??= []);
      extensions.push({
        handlers: {
          [FENCE_BLOCK]: (node: FenceMarkdownNode) =>
            fenceMarkdown(
              { name: isFenceName(node.name) ? node.name : TODO, args: String(node.args ?? "") },
              String(node.value ?? ""),
            ),
        },
      });
      return (tree: unknown) => {
        expandFences(tree as FenceMarkdownNode);
      };
    });

    /**
     * The file as it is on disk, and what the serializer makes of it.
     *
     * Milkdown re-serializes the whole document on every change, so saving its
     * output verbatim rewrites every convention it has an opinion about —
     * tabs, bullet characters, escaping — across the whole file at once. These
     * two let `preserveUnchanged` tell the user's edit apart from that, and
     * hand the rest of the file back untouched. See preserve.ts.
     */
    let stored = file.content ?? "";
    let baseline: string | null = null;

    /**
     * Tells the `todo` blocks in this note when one of its checkboxes has
     * changed.
     *
     * Rescanning the drive on every keystroke would be absurd, so the trigger
     * is the answer changing rather than the document changing: one pass over
     * the text names the unfinished checkboxes in it, and typing in a
     * paragraph leaves that alone. Ticking a box, or editing the words in one,
     * moves it, and the blocks look again.
     *
     * Only this note, though. A box ticked in another tab or another file is
     * what ↻ is for — anything more would be a subscription to the whole drive
     * for a block that might be listing four things.
     */
    const taskSignature = (text: string) => JSON.stringify(openTasksIn(text));
    let saidTasks = taskSignature(stored);
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const noticeTasks = (text: string) => {
      const said = taskSignature(text);
      if (said === saidTasks) return;
      saidTasks = said;
      clearTimeout(refreshTimer);
      // Debounced past the render that puts this edit into the record the scan
      // reads, as well as past the next few keystrokes.
      refreshTimer = setTimeout(refreshTodoBlocks, TODO_REFRESH_MS);
    };

    const crepe = new Crepe({
      root: containerRef.current,
      defaultValue: file.content ?? "",
      features: {
        [Crepe.Feature.Latex]: false,
      },
      featureConfigs: {
        [Crepe.Feature.BlockEdit]: {
          buildMenu: builder => {
            // Its own group rather than one of Crepe's: `getGroup` throws on a
            // key it doesn't know, so reaching into "advanced" would put the
            // whole slash menu at the mercy of an upstream rename.
            builder.addGroup("webfs", "Tracking").addItem(TODO, {
              // Named for the fence rather than for what it does: the menu
              // filters on the label, so "Unfinished checkboxes" is an item
              // that typing `/todo` cannot find.
              label: "Todo list",
              icon: CHECKLIST_ICON,
              onRun: ctx => insertFence(ctx, fenceNode, TODO),
            });
          },
        },
        [Crepe.Feature.ImageBlock]: {
          onUpload: storeImage,
          blockOnUpload: storeImage,
          inlineOnUpload: storeImage,
          proxyDomURL: resolveImage,
        },
      },
    });
    // iOS Safari's predictive-text suggestion strip (part of its keyboard
    // accessory bar) follows these standard attributes on the editable
    // element; the rest of that bar (line-navigation arrows, "Done") is
    // drawn by the OS and isn't something a page can turn off.
    /** What the editor would make of a text: parsed, then serialized again. */
    const roundTrip = (text: string): string | null => {
      try {
        return crepe.editor.action(ctx => ctx.get(serializerCtx)(ctx.get(parserCtx)(text)));
      } catch (err) {
        console.error("Failed to verify preserved markdown", err);
        return null;
      }
    };

    crepe.editor.config(ctx => {
      ctx.update(editorViewOptionsCtx, prev => ({
        ...prev,
        attributes: { spellcheck: "false", autocorrect: "off", autocapitalize: "off" },
      }));
      // What the serializer writes on a line the user actually edits. The rest
      // of the file keeps its own conventions (see preserve.ts), so this only
      // decides what new text looks like — `-` because that's what every other
      // bullet in a vault written elsewhere uses, and an unescaped `#` because
      // `\#classnotes` is not a tag.
      ctx.update(remarkStringifyOptionsCtx, prev => ({
        ...prev,
        bullet: "-" as const,
        handlers: {
          ...prev.handlers,
          // Milkdown's own text handler, with the tag put back. The first line
          // is theirs: a run of trailing whitespace is passed through rather
          // than escaped.
          text: ((node, _parent, state, info) => {
            const value = String((node as { value?: unknown }).value ?? "");
            if (/^[^*_\\]*\s+$/.test(value)) return value;
            return unescapeTags(state.safe(value, { ...info, encode: [] }));
          }) as NonNullable<typeof prev.handlers>["text"],
        },
      }));
    });
    crepe.editor
      .use(wikiImageRemark)
      .use(wikiImageNode)
      .use(wikiLinkNode)
      .use(fenceRemark)
      .use(fenceNode)
      .use($prose(() => sortTaskLists()));
    crepe.on(listener => {
      listener.markdownUpdated((_ctx, markdown) => {
        // What the file itself says, in the serializer's dialect. Worked out
        // here rather than when the editor was built because Crepe changes the
        // document once on its own after mounting, and a baseline captured
        // before that lands would read that change as the user's.
        baseline ??= roundTrip(stored) ?? markdown;

        // Crepe puts an empty paragraph at the end of the document when it
        // mounts, so the first change it reports is one nobody made — and
        // before this was handled, merely opening a note rewrote it and
        // offered the whole file to the next sync as the user's work. An empty
        // paragraph is not content, so trailing blank lines don't count as a
        // difference here or in the check below.
        if (sameText(markdown, baseline)) {
          baseline = markdown;
          return;
        }

        // The first reconstruction the editor reads back as exactly what it
        // just said. One that says anything else — a dropped blank line that
        // ran two paragraphs together, an alignment that went wrong — is
        // discarded rather than saved, and the list ends with the editor's own
        // text, so this can cost the preservation but never the edit.
        let text = markdown;
        for (const candidate of preserveUnchanged(stored, baseline, markdown)) {
          if (candidate === markdown) break;
          const back = roundTrip(candidate);
          if (back !== null && sameText(back, markdown)) {
            text = candidate;
            break;
          }
        }

        baseline = markdown;
        if (text === stored) return; // Nothing for the file to say differently.
        stored = text;
        onChangeRef.current(file.id, text);
        noticeTasks(text);
      });
    });
    const ready = crepe.create();
    ready.catch(err => console.error("Failed to create Milkdown editor", err));

    return () => {
      clearTimeout(refreshTimer);
      ready.then(() => crepe.destroy()).catch(() => {});
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
    // File identity, not content, controls (re)mount: the editor owns the
    // document once created and content flows out via markdownUpdated. The
    // store is in here because a file id is only unique *within* a drive —
    // two drives can both hold "Notes/todo.md", and an instance carried over
    // from one to the other would write a pasted image into the wrong folder.
    // App memoizes it per drive, so this is a switch of drives and nothing else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, store]);

  return <div className="milkdown-root" ref={containerRef} />;
}

/**
 * Whether two markdown texts say the same thing.
 *
 * Trailing blank lines are not content — Crepe keeps an empty paragraph at the
 * end of every document so there's somewhere to click below the last block,
 * and it shows up in the serializer's output as one.
 */
const sameText = (a: string, b: string) => a.trimEnd() === b.trimEnd();

/**
 * The same file as markdown source.
 *
 * Controlled, unlike the Crepe editor beside it: a textarea takes new text
 * without being torn down, so an edit merged in from another tab or a sync
 * lands here by itself and `externalEdit` has nothing to remount. Both write
 * through the same `onChange`, and a file is open in at most one pane, so the
 * two editors never hold the same document at once.
 *
 * What it shows is what a save would write — Crepe re-serialises the document
 * it parsed, so switching here after editing shows Crepe's markdown rather
 * than the bytes the file was created with.
 */
function PlainTextEditor({ file, onChange }: { file: FSNode; onChange: (id: string, content: string) => void }) {
  return (
    <textarea
      className="text-editor"
      value={file.content ?? ""}
      aria-label={`${file.name} as plain text`}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      autoComplete="off"
      onChange={event => onChange(file.id, event.target.value)}
    />
  );
}

/**
 * The button that switches between the two, shown in a pane's tab strip and
 * in the mobile topbar — the same control in the two places the app puts its
 * upper-right affordances.
 */
export function ViewToggle({
  view,
  className,
  onToggle,
}: {
  view: EditorView;
  className: string;
  onToggle: () => void;
}) {
  const label = view === "rich" ? "Edit as plain text" : "Back to the formatted editor";
  return (
    <button className={className} title={label} aria-label={label} onClick={onToggle}>
      {view === "rich" ? "</>" : "¶"}
    </button>
  );
}

/**
 * A file the editor must not open.
 *
 * Crepe would render the bytes as text and then write that reading straight
 * back on the first keystroke, so an image opened by accident would be
 * destroyed by looking at it. Shown instead of edited.
 */
function BinaryFile({ file, store }: { file: FSNode; store: Store }) {
  const [preview, setPreview] = useState<string | null>(null);
  const type = mimeOf(file.name);
  const pdf = type === "application/pdf";
  // Everything else is bytes as far as this app is concerned, and reading a
  // file it can't show would mint an object URL for nothing.
  const showable = pdf || type.startsWith("image/");

  useEffect(() => {
    if (!showable) return;
    let url: string | null = null;
    let cancelled = false;
    void store.readBytes(segmentsOf(file.id)).then(bytes => {
      if (cancelled || !bytes) return;
      url = URL.createObjectURL(new Blob([bytes], { type }));
      setPreview(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, showable, store, type]);

  /*
    A PDF is shown by handing the bytes to the browser's own viewer, through
    an iframe over an object URL — no viewer library, because every desktop
    browser and Android Chrome already ship one and a bundled renderer would
    be several times the size of this whole app.

    iOS Safari is the exception, and the one that matters most here: it
    renders a PDF in an iframe as a single non-scrolling page, or as nothing
    at all. There is no page-side fix for that, so the link below is not a
    nicety — it is the way to read the document on the platform this app is
    most used on, and it stays visible everywhere rather than being hidden
    behind a UA sniff that would be wrong the moment Safari changes.
  */
  if (pdf) {
    return (
      <div className="editor">
        <div className="pdf-file">
          {preview ? (
            <>
              <iframe className="pdf-frame" src={preview} title={file.name} />
              <p className="pdf-note">
                Shown by this browser's PDF viewer.{" "}
                <a href={preview} target="_blank" rel="noopener noreferrer">
                  Open it in a new tab
                </a>{" "}
                if it doesn't display here — on iOS it won't.
              </p>
            </>
          ) : (
            <p className="pdf-note">Loading…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="binary-file">
        {preview ? <img src={preview} alt={file.name} /> : null}
        <p>This isn't a text file, so there's nothing to edit here. It syncs with everything else.</p>
      </div>
    </div>
  );
}

export function Editor({
  file,
  view,
  store,
  externalEdit,
  onChange,
  onAssetAdded,
  findTasks,
  onOpenFile, onCompleteTask,
}: EditorProps) {
  if (!file) {
    return (
      <div className="editor editor-empty">
        <p>Select a file to start editing.</p>
      </div>
    );
  }

  if (file.binary) return <BinaryFile file={file} store={store} />;

  // Content is fetched when a file is opened, so a file node can exist before
  // its text does.
  if (file.content === undefined) {
    return (
      <div className="editor editor-empty">
        <p>Loading…</p>
      </div>
    );
  }

  // Switching view is a swap of one editor for the other, which works for the
  // same reason `externalEdit` does: Crepe reads `defaultValue` at
  // construction, and content has already flowed out of whichever editor was
  // on screen (`markdownUpdated` and the textarea's `onChange` both land in
  // `fs` synchronously), so the one coming up starts from the current text.
  return (
    <div className="editor">
      {view === "text" ? (
        <PlainTextEditor key={file.id} file={file} onChange={onChange} />
      ) : (
        /*
          The key carries `externalEdit` as well as the file id. Crepe is
          uncontrolled and only reads `defaultValue` at construction, so
          remounting is the only way to show text that arrived from another tab.
          It costs the cursor position and undo history, which is why App only
          bumps the counter for genuinely external edits and never for typing.
        */
        <MilkdownEditor
          key={`${file.id}:${externalEdit}`}
          file={file}
          store={store}
          onChange={onChange}
          onAssetAdded={onAssetAdded}
          findTasks={findTasks}
          onOpenFile={onOpenFile}
          onCompleteTask={onCompleteTask}
        />
      )}
    </div>
  );
}
