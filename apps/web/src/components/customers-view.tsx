"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { BlockedEmailEntry, KnownClient } from "@/lib/contracts";
import { frontendApi } from "./api-adapter";
import { stashClientForBooking } from "./book-for-client";
import { ClientFileError, readClientFile } from "./customer-import";
import { Icon } from "./icons";
import { Avatar, Badge, EmptyState, Field, PageHeader } from "./ui";
import { useWorkspaceAccess } from "./workspace-access";

type CustomersList = "clients" | "blacklist";
const IMPORT_MAX_ROWS = 5000;
const byName = (left: KnownClient, right: KnownClient) => left.name.localeCompare(right.name, "nl", { sensitivity: "base" });
const failure = (reason: unknown, fallback: string) => (reason instanceof Error && reason.message ? reason.message : fallback);
const addedOn = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function CopyButton({ label, copied, onCopy }: { label: string; copied: boolean; onCopy: () => void }) {
  return <button type="button" className={`copy-button ${copied ? "is-copied" : ""}`} onClick={onCopy} aria-label={label} title={label}><Icon name={copied ? "check" : "copy"} size={13} /><span>{copied ? "Copied" : "Copy"}</span></button>;
}

export function CustomersView({ initialView }: { initialView: CustomersList }) {
  const router = useRouter();
  const { canManage } = useWorkspaceAccess();
  const [list, setList] = useState<CustomersList>(initialView);
  const [clients, setClients] = useState<KnownClient[]>([]);
  const [blocked, setBlocked] = useState<BlockedEmailEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", email: "", phone: "" });
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [copied, setCopied] = useState("");
  const [blockDraft, setBlockDraft] = useState({ email: "", reason: "" });
  const [blocking, setBlocking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

  const load = useCallback(() => Promise.all([frontendApi.listKnownClients(), frontendApi.listBlockedEmails()])
    .then(([clientItems, blockedItems]) => { setClients(clientItems); setBlocked(blockedItems); setError(""); })
    .catch((reason: unknown) => setError(failure(reason, "Customers did not load.")))
    .finally(() => setLoading(false)), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const flash = (message: string) => {
    setError(""); setNotice(message); window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 6000);
  };
  const fail = (message: string) => { setNotice(""); setError(message); };
  const chooseList = (next: CustomersList) => {
    setList(next);
    const url = new URL(window.location.href);
    if (next === "blacklist") url.searchParams.set("view", "blacklist"); else url.searchParams.delete("view");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };
  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); window.setTimeout(() => setCopied((current) => (current === key ? "" : current)), 1600); }
    catch { fail("The browser blocked copying. Select the text and copy it instead."); }
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return clients;
    const digits = needle.replace(/\D/g, "");
    return clients.filter((client) => client.name.toLowerCase().includes(needle) || client.email.includes(needle) || (digits.length >= 3 && (client.phone ?? "").replace(/\D/g, "").includes(digits)));
  }, [clients, query]);

  const addClient = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true);
    try {
      const phone = draft.phone.trim();
      const created = await frontendApi.addKnownClient({ name: draft.name.trim(), email: draft.email.trim(), ...(phone ? { phone } : {}) });
      setClients((current) => [...current, created].sort(byName)); setDraft({ name: "", email: "", phone: "" }); setAdding(false);
      flash(`${created.name} was added to your customers.`);
    } catch (reason) { fail(failure(reason, "The customer could not be added.")); }
    finally { setSaving(false); }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const parsed = await readClientFile(file);
      if (!parsed.clients.length) { fail(parsed.total ? "None of the rows in that file had a usable email address." : "That file has no customer rows."); return; }
      if (parsed.clients.length > IMPORT_MAX_ROWS) { fail(`That file has ${parsed.clients.length} customers. Import at most ${IMPORT_MAX_ROWS} at a time by splitting it.`); return; }
      const result = await frontendApi.importKnownClients(parsed.clients);
      await load();
      const parts = [`${result.added} added`];
      if (result.skipped) parts.push(`${result.skipped} already on the list`);
      const unusable = parsed.skipped + result.invalid;
      if (unusable) parts.push(`${unusable} skipped for a missing or repeated email`);
      flash(`Import finished: ${parts.join(", ")}.`);
    } catch (reason) { fail(reason instanceof ClientFileError ? reason.message : failure(reason, "That file could not be imported.")); }
    finally { setImporting(false); }
  };

  const removeClient = async (client: KnownClient) => {
    if (!window.confirm(`Remove ${client.name} from your customers? Their appointments are not affected.`)) return;
    try { await frontendApi.deleteKnownClient(client.id); setClients((current) => current.filter((item) => item.id !== client.id)); flash(`${client.name} was removed.`); }
    catch (reason) { fail(failure(reason, "The customer could not be removed.")); }
  };
  const bookFor = (client: KnownClient) => { stashClientForBooking({ name: client.name, email: client.email }); router.push("/bookings"); };
  const startBlock = (client: KnownClient) => { setBlockDraft({ email: client.email, reason: "" }); chooseList("blacklist"); };

  const block = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = blockDraft.email.trim().toLowerCase();
    if (!email) return;
    if (!window.confirm(`Blacklist ${email}?\n\nTheir upcoming appointments are canceled now and they get the usual cancellation email. The booking page and the dashboard will refuse this address until you remove it.`)) return;
    setBlocking(true);
    try {
      const reason = blockDraft.reason.trim();
      const result = await frontendApi.blockEmail(email, reason || undefined);
      setBlocked((current) => [result.entry, ...current.filter((item) => item.id !== result.entry.id)]);
      setClients((current) => current.map((item) => (item.email === result.entry.email ? { ...item, blocked: true } : item)));
      setBlockDraft({ email: "", reason: "" });
      const canceled = result.canceled === 0 ? "No upcoming appointments needed canceling." : `${result.canceled} upcoming appointment${result.canceled === 1 ? " was" : "s were"} canceled.`;
      if (result.failed) fail(`${email} is blacklisted. ${canceled} ${result.failed} could not be canceled automatically. Cancel ${result.failed === 1 ? "it" : "them"} from Bookings.`);
      else flash(`${email} is blacklisted. ${canceled}`);
    } catch (reason) { fail(failure(reason, "That email could not be blacklisted.")); }
    finally { setBlocking(false); }
  };
  const unblock = async (entry: BlockedEmailEntry) => {
    if (!window.confirm(`Remove ${entry.email} from the blacklist? They will be able to book again.`)) return;
    try {
      await frontendApi.unblockEmail(entry.id);
      setBlocked((current) => current.filter((item) => item.id !== entry.id));
      setClients((current) => current.map((item) => (item.email === entry.email ? { ...item, blocked: false } : item)));
      flash(`${entry.email} can book again.`);
    } catch (reason) { fail(failure(reason, "That email could not be removed from the blacklist.")); }
  };

  if (loading) return <div className="page-stack"><PageHeader title="Customers" /><div className="sync-note" role="status"><span className="spinner" />Loading customers…</div></div>;

  const actions = canManage && list === "clients" && <>
    <button type="button" className="button button-secondary" onClick={() => fileRef.current?.click()} disabled={importing}><Icon name="plus" size={16} />{importing ? "Importing…" : "Import spreadsheet"}</button>
    <input ref={fileRef} type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={importFile} />
    <button type="button" className="button button-primary" onClick={() => setAdding((open) => !open)} aria-expanded={adding}><Icon name="plus" size={16} />Add customer</button>
  </>;

  return <div className="page-stack">
    <PageHeader title="Customers" description="Clients you book in by hand, and the addresses the studio no longer takes bookings from." actions={actions || undefined} />
    {error && <div className="toast toast-error" role="alert"><span><Icon name="x" /></span>{error}</div>}
    {notice && !error && <div className="toast" role="status"><span><Icon name="check" /></span>{notice}</div>}
    <span className="customers-live" aria-live="polite">{copied ? "Copied to the clipboard" : ""}</span>
    <div className="segmented customers-switch" aria-label="Customer lists">
      <button type="button" className={list === "clients" ? "is-active" : ""} aria-pressed={list === "clients"} onClick={() => chooseList("clients")}>Known customers <span className="customers-count">{clients.length}</span></button>
      <button type="button" className={list === "blacklist" ? "is-active" : ""} aria-pressed={list === "blacklist"} onClick={() => chooseList("blacklist")}>Blacklist <span className="customers-count">{blocked.length}</span></button>
    </div>

    {list === "clients" && <>
      {adding && canManage && <form className="panel customer-form" onSubmit={addClient}>
        <div className="customer-form-fields">
          <Field label="Name" required><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={120} autoComplete="off" required /></Field>
          <Field label="Email" required><input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} maxLength={254} autoComplete="off" required /></Field>
          <Field label="Phone"><input type="tel" value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} maxLength={40} autoComplete="off" /></Field>
        </div>
        <div className="customer-form-actions"><button type="button" className="button button-ghost" onClick={() => setAdding(false)}>Cancel</button><button type="submit" className="button button-primary" disabled={saving}>{saving ? "Saving…" : "Save customer"}</button></div>
      </form>}
      {clients.length > 0 && <div className="toolbar"><div className="search-field"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, email or phone" aria-label="Search customers" /></div></div>}
      <section className="panel customers-panel">
        {clients.length === 0 ? <EmptyState icon="team" title="No customers yet" description={canManage ? "Import the spreadsheet from your old salon system, or add customers one at a time." : "Customers the studio adds appear here."} /> : <>
          <div className="booking-table-head customer-table-head"><span>Customer</span><span>Email</span><span>Phone</span><span /></div>
          <ul className="customer-list">{filtered.map((client) => <li className="customer-row" key={client.id}>
            <span className="customer-cell"><Avatar name={client.name} size="sm" /><strong className="customer-value">{client.name}</strong>{client.blocked && <Badge tone="danger">Blacklisted</Badge>}<CopyButton label={`Copy the name ${client.name}`} copied={copied === `${client.id}:name`} onCopy={() => void copy(`${client.id}:name`, client.name)} /></span>
            <span className="customer-cell"><span className="customer-value">{client.email}</span><CopyButton label={`Copy the email for ${client.name}`} copied={copied === `${client.id}:email`} onCopy={() => void copy(`${client.id}:email`, client.email)} /></span>
            <span className="customer-cell">{client.phone ? <><span className="customer-value">{client.phone}</span><CopyButton label={`Copy the phone number for ${client.name}`} copied={copied === `${client.id}:phone`} onCopy={() => void copy(`${client.id}:phone`, client.phone ?? "")} /></> : <span className="customer-muted">No phone</span>}</span>
            <span className="customer-actions">{canManage && <>
              <button type="button" className="button button-secondary button-sm" onClick={() => bookFor(client)} disabled={client.blocked} title={client.blocked ? "Blacklisted addresses cannot be booked" : undefined}><Icon name="bookings" size={14} />Book</button>
              {!client.blocked && <button type="button" className="button button-ghost button-sm" onClick={() => startBlock(client)}>Blacklist</button>}
              <button type="button" className="icon-button customer-remove" onClick={() => void removeClient(client)} aria-label={`Remove ${client.name}`} title="Remove"><Icon name="trash" size={16} /></button>
            </>}</span>
          </li>)}</ul>
          {filtered.length === 0 && <EmptyState icon="search" title="No customers match" description="Try a different name, email or phone number." />}
          <footer className="table-footer"><span>Showing {filtered.length} of {clients.length} customers</span></footer>
        </>}
      </section>
    </>}

    {list === "blacklist" && <>
      {canManage && <form className="panel customer-form" onSubmit={block}>
        <div className="customer-form-intro"><h2>Blacklist an email</h2><p>Upcoming appointments for the address are canceled straight away. The booking page and the dashboard then refuse it until you remove it here.</p></div>
        <div className="customer-form-fields">
          <Field label="Email" required hint="Start typing to pick one of your customers."><input type="email" list="customers-known-emails" value={blockDraft.email} onChange={(event) => setBlockDraft({ ...blockDraft, email: event.target.value })} maxLength={254} autoComplete="off" required /></Field>
          <Field label="Reason" hint="Only the studio sees this."><input value={blockDraft.reason} onChange={(event) => setBlockDraft({ ...blockDraft, reason: event.target.value })} maxLength={200} autoComplete="off" /></Field>
        </div>
        <datalist id="customers-known-emails">{clients.filter((client) => !client.blocked).map((client) => <option key={client.id} value={client.email}>{client.name}</option>)}</datalist>
        <div className="customer-form-actions"><button type="submit" className="button button-danger" disabled={blocking || !blockDraft.email.trim()}>{blocking ? "Blacklisting…" : "Blacklist and cancel appointments"}</button></div>
      </form>}
      <section className="panel customers-panel">
        {blocked.length === 0 ? <EmptyState icon="check" title="Nobody is blacklisted" description="Addresses you blacklist appear here, with the reason you gave." /> : <>
          <div className="booking-table-head customer-table-head blocked-table"><span>Email</span><span>Reason</span><span>Added</span><span /></div>
          <ul className="customer-list">{blocked.map((entry) => <li className="customer-row blocked-table" key={entry.id}>
            <span className="customer-cell customer-stacked"><strong className="customer-value">{entry.email}</strong>{entry.clientName && <small>{entry.clientName}</small>}</span>
            <span className="customer-muted">{entry.reason || "No reason given"}</span>
            <span className="customer-muted">{addedOn(entry.createdAt)}</span>
            <span className="customer-actions">{canManage && <button type="button" className="button button-ghost button-sm" onClick={() => void unblock(entry)}>Remove</button>}</span>
          </li>)}</ul>
          <footer className="table-footer"><span>{blocked.length} blacklisted {blocked.length === 1 ? "address" : "addresses"}</span></footer>
        </>}
      </section>
    </>}
  </div>;
}
