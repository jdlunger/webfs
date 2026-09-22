import { useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewOptionsCtx, parserCtx, remarkStringifyOptionsCtx, serializerCtx } from "@milkdown/kit/core";
import { $node, $remark } from "@milkdown/kit/utils";
import { segmentsOf } from "./fs";
import { createFile, readBytes, writeFile } from "./storage";
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

interface EditorProps {
  file: FSNode | null;
  view: EditorView;
  /** Counter bumped when another tab's edit has been merged into `file`. */
  externalEdit: number;
  /** Carries the id, because two panes can be editing two different files. */
  onChange: (id: string, content: string) => void;
  /** A pasted image became a file; the tree and sync need to know. */
  onAssetAdded: () => void;
}

interface MilkdownEditorProps {
  file: FSNode;
  onChange: (id: string, content: string) => void;
  onAssetAdded: () => void;
}

function MilkdownEditor({ file, onChange, onAssetAdded }: MilkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onAssetAddedRef = useRef(onAssetAdded);
  onAssetAddedRef.current = onAssetAdded;

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
      const name = await createFile([...dir, ASSET_DIR], assetName(image.name));
      const bytes = new Uint8Array(await image.arrayBuffer());
      await writeFile([...dir, ASSET_DIR, name], bytes);
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
          const bytes = await readBytes(path);
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

    const crepe = new Crepe({
      root: containerRef.current,
      defaultValue: file.content ?? "",
      features: {
        [Crepe.Feature.Latex]: false,
      },
      featureConfigs: {
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
    crepe.editor.use(wikiImageRemark).use(wikiImageNode).use(wikiLinkNode);
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
      });
    });
    const ready = crepe.create();
    ready.catch(err => console.error("Failed to create Milkdown editor", err));

    return () => {
      ready.then(() => crepe.destroy()).catch(() => {});
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
    // File identity, not content, controls (re)mount: the editor owns the
    // document once created and content flows out via markdownUpdated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

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
function BinaryFile({ file }: { file: FSNode }) {
  const [preview, setPreview] = useState<string | null>(null);
  const type = mimeOf(file.name);

  useEffect(() => {
    if (!type.startsWith("image/")) return;
    let url: string | null = null;
    let cancelled = false;
    void readBytes(segmentsOf(file.id)).then(bytes => {
      if (cancelled || !bytes) return;
      url = URL.createObjectURL(new Blob([bytes], { type }));
      setPreview(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.id, type]);

  return (
    <div className="editor">
      <div className="binary-file">
        {preview ? <img src={preview} alt={file.name} /> : null}
        <p>This isn't a text file, so there's nothing to edit here. It syncs with everything else.</p>
      </div>
    </div>
  );
}

export function Editor({ file, view, externalEdit, onChange, onAssetAdded }: EditorProps) {
  if (!file) {
    return (
      <div className="editor editor-empty">
        <p>Select a file to start editing.</p>
      </div>
    );
  }

  if (file.binary) return <BinaryFile file={file} />;

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
          onChange={onChange}
          onAssetAdded={onAssetAdded}
        />
      )}
    </div>
  );
}
