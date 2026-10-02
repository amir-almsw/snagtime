"use client";

import { useEffect, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";

// A dependency-free rich-text editor: a contentEditable surface driven by document.execCommand. execCommand
// is deprecated but universally supported, which keeps this feature library-free (the repo adds no editor
// dependency) while still offering bold, italic, underline, strikethrough, lists and links.

type InlineCommand = "bold" | "italic" | "underline" | "strikeThrough";

const INLINE: Array<{ id: InlineCommand; label: string; title: string; style: CSSProperties }> = [
  { id: "bold", label: "B", title: "Bold", style: { fontWeight: 700 } },
  { id: "italic", label: "I", title: "Italic", style: { fontStyle: "italic" } },
  { id: "underline", label: "U", title: "Underline", style: { textDecoration: "underline" } },
  { id: "strikeThrough", label: "S", title: "Strikethrough", style: { textDecoration: "line-through" } },
];

const BLOCKS = [
  { value: "p", label: "Paragraph" },
  { value: "h1", label: "Heading 1" },
  { value: "h2", label: "Heading 2" },
  { value: "h3", label: "Heading 3" },
];

export function RichTextEditor({ initialHtml = "", onChange }: { initialHtml?: string; onChange: (html: string) => void }) {
  const editorRef = useRef<HTMLDivElement>(null);

  // Seed once on mount; re-setting innerHTML on every render would drop the caret.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.innerHTML !== initialHtml) editor.innerHTML = initialHtml;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recreated each render, so it always captures the latest onChange; no ref indirection required.
  const emit = () => { if (editorRef.current) onChange(editorRef.current.innerHTML); };
  const exec = (command: string, value?: string) => {
    const editor = editorRef.current; if (!editor) return;
    editor.focus();
    document.execCommand(command, false, value);
    emit();
  };
  const link = () => {
    const url = window.prompt("Link URL", "https://");
    if (url) exec("createLink", url);
  };
  // Prevent the toolbar button from stealing focus/selection before execCommand runs.
  const keepSelection = (event: ReactMouseEvent) => event.preventDefault();

  return (
    <div className="composer-editor-shell">
      <div className="composer-toolbar" role="toolbar" aria-label="Text formatting">
        <select aria-label="Text style" className="composer-block" defaultValue="p" onChange={(event) => exec("formatBlock", event.target.value)}>
          {BLOCKS.map((block) => <option key={block.value} value={block.value}>{block.label}</option>)}
        </select>
        {INLINE.map((item) => (
          <button key={item.id} type="button" className="composer-tool" onMouseDown={keepSelection} onClick={() => exec(item.id)} title={item.title} aria-label={item.title}><span style={item.style}>{item.label}</span></button>
        ))}
        <button type="button" className="composer-tool" onMouseDown={keepSelection} onClick={() => exec("insertUnorderedList")} title="Bulleted list" aria-label="Bulleted list">• List</button>
        <button type="button" className="composer-tool" onMouseDown={keepSelection} onClick={() => exec("insertOrderedList")} title="Numbered list" aria-label="Numbered list">1. List</button>
        <button type="button" className="composer-tool" onMouseDown={keepSelection} onClick={link} title="Link" aria-label="Link">Link</button>
        <button type="button" className="composer-tool" onMouseDown={keepSelection} onClick={() => exec("removeFormat")} title="Clear formatting" aria-label="Clear formatting">Clear</button>
      </div>
      <div ref={editorRef} className="composer-editor" contentEditable suppressContentEditableWarning onInput={emit} role="textbox" aria-multiline="true" aria-label="Message body" />
    </div>
  );
}