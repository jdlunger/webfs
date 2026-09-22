import { useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import { segmentsOf } from "./fs";
import { createFile, readBytes, writeFile } from "./storage";
import { ASSET_DIR, assetName, isAbsoluteUrl, mimeOf, resolveAssetPath } from "./assets";
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

interface EditorProps {
  file: FSNode | null;
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
     * What the DOM loads for a stored URL. The markdown keeps the relative
     * path (that's what GitHub needs); the browser can't fetch OPFS, so the
     * bytes are handed over as an object URL instead.
     */
    const resolveImage = async (url: string): Promise<string> => {
      if (!url || isAbsoluteUrl(url)) return url;
      const path = resolveAssetPath(file.id, url);
      if (!path) return url;
      const bytes = await readBytes(path);
      if (!bytes) return url;
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeOf(url) }));
      objectUrls.push(objectUrl);
      return objectUrl;
    };

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
    crepe.editor.config(ctx => {
      ctx.update(editorViewOptionsCtx, prev => ({
        ...prev,
        attributes: { spellcheck: "false", autocorrect: "off", autocapitalize: "off" },
      }));
    });
    crepe.on(listener => {
      listener.markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (markdown !== prevMarkdown) onChangeRef.current(file.id, markdown);
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

export function Editor({ file, externalEdit, onChange, onAssetAdded }: EditorProps) {
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

  return (
    <div className="editor">
      {/*
        The key carries `externalEdit` as well as the file id. Crepe is
        uncontrolled and only reads `defaultValue` at construction, so
        remounting is the only way to show text that arrived from another tab.
        It costs the cursor position and undo history, which is why App only
        bumps the counter for genuinely external edits and never for typing.
      */}
      <MilkdownEditor
        key={`${file.id}:${externalEdit}`}
        file={file}
        onChange={onChange}
        onAssetAdded={onAssetAdded}
      />
    </div>
  );
}
