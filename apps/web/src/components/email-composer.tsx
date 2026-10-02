"use client";

import { useMemo, useState } from "react";
import type { ClientMessageResult, KnownClient } from "@/lib/contracts";
import { frontendApi } from "./api-adapter";
import { Icon } from "./icons";
import { RichTextEditor } from "./rich-text-editor";
import { Field } from "./ui";

type Mode = "rich" | "html";
const failure = (reason: unknown, fallback: string) => (reason instanceof Error && reason.message ? reason.message : fallback);

// The Customers tab's "Message selected" modal. A user-controlled toggle switches between the WYSIWYG editor
// and a raw HTML textarea; both send HTML email (the server derives the plain-text part). SMS is deliberately
// absent -- this feature is email-only.
export function EmailComposer({ recipients, onClose, onSent }: { recipients: KnownClient[]; onClose: () => void; onSent: (result: ClientMessageResult) => void }) {
  const [subject, setSubject] = useState("");
  const [mode, setMode] = useState<Mode>("rich");
  const [richHtml, setRichHtml] = useState("");
  const [htmlSource, setHtmlSource] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const names = useMemo(() => recipients.map((client) => client.name || client.email).join(", "), [recipients]);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    if (next === "html") setHtmlSource(richHtml); else setRichHtml(htmlSource);
    setMode(next);
  };

  const send = async () => {
    const html = mode === "rich" ? richHtml : htmlSource;
    if (!subject.trim()) { setError("Add a subject first."); return; }
    if (!html.trim()) { setError("Write a message first."); return; }
    setSending(true); setError("");
    try {
      const result = await frontendApi.sendClientMessage({ subject: subject.trim(), html, clientIds: recipients.map((client) => client.id) });
      onSent(result);
    } catch (reason) { setError(failure(reason, "The message could not be queued.")); setSending(false); }
  };

  return (
    <div className="modal-layer">
      <button type="button" className="modal-scrim" onClick={onClose} aria-label="Close message composer" tabIndex={-1} />
      <aside className="modal is-wide" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        <header className="composer-head">
          <h2 id="composer-title">Message customers</h2>
          <span className="composer-recipients"><Icon name="mail" size={13} /> Sending to {recipients.length} customer{recipients.length === 1 ? "" : "s"}</span>
        </header>
        <p className="composer-warning" role="note">Sending to a large group at once can land in spam folders, so messages are spaced out about 10 seconds apart. Blacklisted addresses are skipped automatically.</p>
        <Field label="Subject" required>
          <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={200} autoComplete="off" required />
        </Field>
        <div className="composer-mode" role="tablist" aria-label="Message format">
          <button type="button" role="tab" aria-selected={mode === "rich"} className={mode === "rich" ? "is-active" : ""} onClick={() => switchMode("rich")}>Rich text</button>
          <button type="button" role="tab" aria-selected={mode === "html"} className={mode === "html" ? "is-active" : ""} onClick={() => switchMode("html")}>HTML</button>
        </div>
        {mode === "rich"
          ? <RichTextEditor initialHtml={richHtml} onChange={setRichHtml} />
          : <textarea className="composer-textarea" value={htmlSource} onChange={(event) => setHtmlSource(event.target.value)} placeholder="Paste or write HTML here." spellCheck={false} />}
        {mode === "html" && htmlSource.trim() !== "" && <div className="composer-preview" aria-label="HTML preview" dangerouslySetInnerHTML={{ __html: htmlSource }} />}
        <p className="composer-recipients-note">Recipients: {names || "None"}</p>
        {error && <div className="toast toast-error" role="alert"><span><Icon name="x" /></span>{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose} disabled={sending}>Cancel</button>
          <button type="button" className="button button-primary" onClick={send} disabled={sending || recipients.length === 0}>{sending ? "Queuing…" : "Send"}</button>
        </div>
      </aside>
    </div>
  );
}