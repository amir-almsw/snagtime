"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { takeClientForBooking, type BookForClient } from "./book-for-client";
import type { DayGap } from "@/lib/contracts";
import type { Booking, BookingStatus, EventType } from "./demo-data";
import { frontendApi } from "./api-adapter";
import { BookingsCalendar } from "./bookings-calendar";
import { dayKey } from "./bookings-calendar-state";
import { GapBookingForm } from "./gap-booking-form";
import { HostBookingForm } from "./host-booking-form";
import { Icon } from "./icons";
import { Avatar, Badge, EmptyState, PageHeader } from "./ui";
import { useWorkspaceAccess } from "./workspace-access";

const tones: Record<BookingStatus, "success" | "warning" | "danger"> = { confirmed: "success", pending: "warning", canceled: "danger" };
// The barber's last-used layout, kept per browser like the appearance switch. Calendar is the default.
const VIEW_STORAGE_KEY = "dvision:bookings-view";
type BookingsLayout = "calendar" | "list";
// Read once as the initial state. On the server (no window) and in private browsing the read throws
// and the default wins; the first paint is the loading state either way, so hydration has nothing to diff.
function storedLayout(): BookingsLayout { try { return window.localStorage.getItem(VIEW_STORAGE_KEY) === "list" ? "list" : "calendar"; } catch { return "calendar"; } }

function notificationCopy(status: Booking["notificationStatus"]) {
  switch (status) {
    case "GOOGLE_UPDATE_ACCEPTED": return "Google Calendar accepted the latest booking update.";
    case "LOCAL_NO_EMAIL": return "Saved in the studio schedule and confirmed by email. Not mirrored to Google Calendar.";
    case "RETRY_PENDING": return "The update will be retried automatically.";
    case "PENDING": return "Waiting to sync this booking update.";
  }
}

function answerText(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value == null) return "No answer";
  try { return JSON.stringify(value); } catch { return "Recorded answer"; }
}

export function BookingsView() {
  const { canManage } = useWorkspaceAccess();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [services, setServices] = useState<EventType[]>([]);
  const [adding, setAdding] = useState(false);
  const [prefill, setPrefill] = useState<BookForClient | null>(null);
  const [gap, setGap] = useState<DayGap | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | BookingStatus>("all");
  const [selected, setSelected] = useState<Booking | null>(null);
  const [workspaceTimeZone, setWorkspaceTimeZone] = useState("UTC");
  const [view, setView] = useState<BookingsLayout>(storedLayout);
  const [anchorDay, setAnchorDay] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [canceling, setCanceling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const closeAdd = () => { setAdding(false); setPrefill(null); window.requestAnimationFrame(() => addRef.current?.focus()); };
  const load = useCallback(() => { frontendApi.getAccount().then(async (account) => { const [bookingItems, eventItems] = await Promise.all([frontendApi.listBookings(account.workspace.timeZone), frontendApi.listEventTypes()]); const events = new Map(eventItems.map((event) => [event.id, event])); const resolved = bookingItems.map((booking) => { const event = events.get(booking.eventTypeId); return { ...booking, ...(event ? { eventSlug: event.slug } : {}) }; }); setWorkspaceTimeZone(account.workspace.timeZone); setBookings(resolved); setServices(eventItems.filter((event) => event.status === "published")); const params = new URLSearchParams(window.location.search); const requested = params.get("selected"); const requestedBooking = requested ? resolved.find((booking) => booking.id === requested) ?? null : null; if (requested) setSelected(requestedBooking); setAnchorDay(dayKey(requestedBooking?.startsAt ?? new Date(), account.workspace.timeZone)); const handedOver = takeClientForBooking(); if (handedOver) { setPrefill(handedOver); setAdding(true); } else if (params.get("add") === "1") { const url = new URL(window.location.href); url.searchParams.delete("add"); window.history.replaceState(null, "", `${url.pathname}${url.search}`); setAdding(true); } }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load bookings.")).finally(() => setLoading(false)); }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  const flash = (message: string) => { setError(""); setNotice(message); window.clearTimeout(noticeTimer.current); noticeTimer.current = window.setTimeout(() => setNotice(""), 6000); };
  const chooseView = (next: BookingsLayout) => { setView(next); try { window.localStorage.setItem(VIEW_STORAGE_KEY, next); } catch { /* the choice lasts for this page only */ } };
  const openBooking = (booking: Booking, trigger: HTMLButtonElement) => { returnFocusRef.current = trigger; const url = new URL(window.location.href); url.searchParams.set("selected", booking.id); window.history.replaceState(null, "", `${url.pathname}${url.search}`); setCanceling(false); setCancelReason(""); setCancelError(""); setSelected(booking); };
  useEffect(() => { if (!selected) return; const prior = document.body.style.overflow; document.body.style.overflow = "hidden"; window.requestAnimationFrame(() => closeRef.current?.focus()); return () => { document.body.style.overflow = prior; }; }, [selected]);
  const closeDrawer = () => { setSelected(null); setCanceling(false); setCancelReason(""); setCancelError(""); const url = new URL(window.location.href); if (url.searchParams.has("selected")) { url.searchParams.delete("selected"); window.history.replaceState(null, "", `${url.pathname}${url.search}`); } window.requestAnimationFrame(() => returnFocusRef.current?.focus()); };
  const trapDrawer = (event: KeyboardEvent<HTMLElement>) => { if (event.key === "Escape") { event.preventDefault(); closeDrawer(); return; } if (event.key !== "Tab") return; const focusable = [...(drawerRef.current?.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])") ?? [])]; const first = focusable[0]; const last = focusable.at(-1); if (!first || !last) return; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } };
  const cancelSelected = async () => {
    if (!selected || cancelBusy) return;
    setCancelBusy(true); setCancelError("");
    try {
      await frontendApi.cancelBooking(selected.id, cancelReason.trim() || undefined);
      setCanceling(false); setCancelReason("");
      flash("Booking canceled. The client was emailed.");
      void load();
    } catch (reason) { setCancelError(reason instanceof Error ? reason.message : "Could not cancel this booking."); }
    finally { setCancelBusy(false); }
  };
  const blockSelected = async () => {
    if (!selected?.email) return;
    if (!window.confirm(`Blacklist ${selected.email}? This cancels their upcoming appointments and blocks new bookings.`)) return;
    try {
      const result = await frontendApi.blockEmail(selected.email, "Blocked from the booking drawer");
      flash(`${selected.email} is blacklisted.${result.canceled ? ` ${result.canceled} upcoming ${result.canceled === 1 ? "appointment was" : "appointments were"} canceled.` : ""}${result.failed ? ` ${result.failed} could not be canceled.` : ""}`);
      void load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not blacklist this customer."); }
  };
  const filtered = useMemo(() => bookings.filter((booking) => (status === "all" || booking.status === status) && `${booking.invitee} ${booking.email} ${booking.eventTitle}`.toLowerCase().includes(query.toLowerCase())), [bookings, query, status]);
  // The list is the barber's day sheet, not an archive: today first, then upcoming, then past newest-first.
  const listBookings = useMemo(() => {
    const today = dayKey(new Date(), workspaceTimeZone);
    const rank = (booking: Booking) => { const key = dayKey(new Date(booking.startsAt), workspaceTimeZone); return key === today ? 0 : key > today ? 1 : 2; };
    return [...filtered].sort((a, b) => {
      const aRank = rank(a); const bRank = rank(b);
      if (aRank !== bRank) return aRank - bRank;
      const diff = new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
      return aRank === 2 ? -diff : diff;
    });
  }, [filtered, workspaceTimeZone]);

  if (loading) return <div className="page-stack"><PageHeader title="Bookings" /><div className="sync-note" role="status"><span className="spinner" />Loading bookings…</div></div>;
  if (error && bookings.length === 0) return <div className="page-stack"><PageHeader title="Bookings" /><section className="panel error-state" role="alert"><span><Icon name="x" /></span><h2>Bookings did not load</h2><p>{error}</p><button type="button" className="button button-primary" onClick={() => { setLoading(true); setError(""); void load(); }}>Retry</button></section></div>;

  return <div className="page-stack">
    <PageHeader title="Bookings" description={`Studio dates and times are shown in ${workspaceTimeZone}.${view === "calendar" ? " Canceled bookings appear in the list only." : ""}`} actions={canManage && <button ref={addRef} type="button" className="button button-primary" onClick={() => setAdding(true)} aria-haspopup="dialog"><Icon name="plus" size={16} />Add booking</button>} />
    {error && <div className="toast toast-error" role="alert"><span><Icon name="x" /></span>{error}</div>}
    {notice && <div className="toast" role="status"><span><Icon name="check" /></span>{notice}</div>}
    <div className="toolbar bookings-toolbar"><div className="search-field"><Icon name="search" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, email, or service" aria-label="Search bookings" /></div><select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter booking status"><option value="all">All statuses</option><option value="confirmed">Confirmed</option><option value="pending">Pending</option><option value="canceled">Canceled</option></select><div className="segmented" aria-label="Bookings layout">{(["calendar", "list"] as const).map((item) => <button type="button" key={item} className={view === item ? "is-active" : ""} aria-pressed={view === item} onClick={() => chooseView(item)}>{item === "calendar" ? "Calendar" : "List"}</button>)}</div></div>
    {view === "calendar" && <BookingsCalendar key={anchorDay} bookings={filtered} timeZone={workspaceTimeZone} anchorDay={anchorDay || dayKey(new Date(), workspaceTimeZone)} onOpen={openBooking} onGapAdd={setGap} canManage={canManage} />}
    {view === "list" && <section className="panel bookings-panel">
      <div className="booking-table-head"><span>Client</span><span>Service</span><span>Date & time</span><span>Status</span><span /></div>
      <div className="booking-table">{listBookings.map((booking) => <button type="button" className="booking-table-row" key={booking.id} onClick={(event) => openBooking(booking, event.currentTarget)} aria-haspopup="dialog"><span className="invitee-cell"><Avatar name={booking.invitee} /><span><strong>{booking.invitee}</strong><small>{booking.email || "No email"}</small></span></span><span><strong>{booking.eventTitle}</strong><small>{booking.duration} min</small></span><span><strong>{booking.dateLabel}</strong><small>{booking.timeLabel}</small></span><span><Badge tone={tones[booking.status]} dot>{booking.status}</Badge></span><span><Icon name="arrow-right" /></span></button>)}</div>
      {filtered.length === 0 && <EmptyState icon="search" title="No bookings found" description="Try changing your search or filters." />}
      <footer className="table-footer"><span>Showing {filtered.length} of {bookings.length} bookings</span></footer>
    </section>}
    {/* A client handed over by the Customers tab's "Book" button opens this form with their details in. */}
    {adding && canManage && <HostBookingForm services={services} timeZone={workspaceTimeZone} initialClient={prefill} onClose={closeAdd} onCreated={(booking) => { setAdding(false); setPrefill(null); setLoading(true); setError(""); void load(); const url = new URL(window.location.href); url.searchParams.set("selected", booking.id); window.history.replaceState(null, "", `${url.pathname}${url.search}`); }} />}
    {gap && canManage && <GapBookingForm gap={gap} services={services} timeZone={workspaceTimeZone} onClose={() => setGap(null)} onCreated={(booking) => { setGap(null); setLoading(true); setError(""); void load(); const url = new URL(window.location.href); url.searchParams.set("selected", booking.id); window.history.replaceState(null, "", `${url.pathname}${url.search}`); }} />}
    {selected && <div className="drawer-layer"><button type="button" className="drawer-scrim" onClick={closeDrawer} aria-label="Close booking details" tabIndex={-1} /><aside ref={drawerRef} className="detail-drawer booking-detail-drawer" role="dialog" aria-modal="true" aria-labelledby="booking-drawer-title" onKeyDown={trapDrawer}><header><div><Badge tone={tones[selected.status]} dot>{selected.status}</Badge><h2 id="booking-drawer-title">{selected.eventTitle}</h2><span>{selected.reference ?? selected.id}</span></div><button ref={closeRef} type="button" className="icon-button" onClick={closeDrawer} aria-label="Close booking details"><Icon name="x" /></button></header><div className="drawer-invitee"><Avatar name={selected.invitee} size="lg" /><div><strong>{selected.invitee}</strong><span>{selected.email ? <a href={`mailto:${selected.email}`}>{selected.email}</a> : "No email"}</span></div></div><div className="detail-list"><div><Icon name="calendar" /><span><small>Studio date</small><strong>{new Intl.DateTimeFormat("en-US", { timeZone: workspaceTimeZone, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date(selected.startsAt))}</strong></span></div><div><Icon name="clock" /><span><small>Studio time</small><strong>{selected.timeLabel}</strong><em>{workspaceTimeZone}</em>{selected.timezone !== workspaceTimeZone && <em>Client timezone: {selected.timezone}</em>}</span></div>{selected.location && <div><Icon name="video" /><span><small>Location</small><strong>{selected.location}</strong></span></div>}<div><Icon name="video" /><span><small>Calendar sync</small><strong>{selected.notificationStatus.replaceAll("_", " ").toLowerCase()}</strong><em>{notificationCopy(selected.notificationStatus)}</em></span></div><div><Icon name="team" /><span><small>Host</small><strong>{selected.hostName}</strong></span></div></div>{selected.answers.length > 0 && <section className="drawer-answer"><h3>Custom answers</h3>{selected.answers.map((answer, index) => <p key={answer.questionId ?? `${answer.questionLabel}-${index}`}><strong>{answer.questionLabel}</strong><br />{answerText(answer.value)}</p>)}</section>}{selected.cancellationReason && <section className="drawer-answer"><h3>Cancellation reason</h3><p>{selected.cancellationReason}</p></section>}{selected.notes && <section className="drawer-answer"><h3>Client notes</h3><p>{selected.notes}</p></section>}{canManage && selected.status !== "canceled" && <div className="drawer-action-bar">{canceling ? <div className="drawer-cancel-form"><label className="field"><span className="field-label">Reason (optional)</span><input value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} maxLength={500} autoComplete="off" placeholder="Why is this being canceled?" /></label>{cancelError && <p className="form-error" role="alert">{cancelError}</p>}<div className="drawer-cancel-actions"><button type="button" className="button button-ghost button-sm" onClick={() => { setCanceling(false); setCancelError(""); }} disabled={cancelBusy}>Keep booking</button><button type="button" className="button button-danger button-sm" onClick={() => void cancelSelected()} disabled={cancelBusy}>{cancelBusy ? "Canceling…" : "Cancel booking"}</button></div></div> : <>{selected.status === "confirmed" && <Link className="button button-secondary button-sm" href={`/manage/${selected.id}/reschedule${selected.eventSlug ? `?slug=${encodeURIComponent(selected.eventSlug)}` : ""}`}>Reschedule</Link>}{selected.email && <a className="button button-secondary button-sm" href={`mailto:${selected.email}`}>Email</a>}{selected.email && <button type="button" className="button button-ghost button-sm" onClick={() => void blockSelected()}>Blacklist</button>}<button type="button" className="button button-danger button-sm" onClick={() => { setCanceling(true); setCancelError(""); }}>Cancel</button></>}</div>}</aside></div>}
  </div>;
}
