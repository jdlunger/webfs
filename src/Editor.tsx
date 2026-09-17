import type { FSNode } from "./fs";

interface EditorProps {
  file: FSNode | null;
  onChange: (content: string) => void;
}

export function Editor({ file, onChange }: EditorProps) {
  if (!file) {
    return (
      <div className="editor editor-empty">
        <p>Select a file to start editing.</p>
      </div>
    );
  }

  return (
    <div className="editor">
      <div className="editor-header">{file.name}</div>
      <textarea
        className="editor-textarea"
        value={file.content ?? ""}
        onChange={e => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}
