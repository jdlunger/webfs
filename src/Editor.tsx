import { useEffect, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
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
  onChange: (content: string) => void;
}

interface MilkdownEditorProps {
  file: FSNode;
  onChange: (content: string) => void;
}

function MilkdownEditor({ file, onChange }: MilkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const crepe = new Crepe({
      root: containerRef.current,
      defaultValue: file.content ?? "",
      features: {
        [Crepe.Feature.Latex]: false,
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
        if (markdown !== prevMarkdown) onChangeRef.current(markdown);
      });
    });
    const ready = crepe.create();
    ready.catch(err => console.error("Failed to create Milkdown editor", err));

    return () => {
      ready.then(() => crepe.destroy()).catch(() => {});
    };
    // File identity, not content, controls (re)mount: the editor owns the
    // document once created and content flows out via markdownUpdated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  return <div className="milkdown-root" ref={containerRef} />;
}

export function Editor({ file, externalEdit, onChange }: EditorProps) {
  if (!file) {
    return (
      <div className="editor editor-empty">
        <p>Select a file to start editing.</p>
      </div>
    );
  }

  // Content is fetched when a file is opened, so a file node can exist before
  // its text does.
  if (file.content === undefined) {
    return (
      <div className="editor">
        <div className="editor-header">{file.name}</div>
        <div className="editor-empty">
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="editor-header">{file.name}</div>
      {/*
        The key carries `externalEdit` as well as the file id. Crepe is
        uncontrolled and only reads `defaultValue` at construction, so
        remounting is the only way to show text that arrived from another tab.
        It costs the cursor position and undo history, which is why App only
        bumps the counter for genuinely external edits and never for typing.
      */}
      <MilkdownEditor key={`${file.id}:${externalEdit}`} file={file} onChange={onChange} />
    </div>
  );
}
