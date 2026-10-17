"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DayGap } from "@/lib/contracts";
import type { Booking, DurationOption, EventType } from "./demo-data";
import { clearTerminalBookingAttempt, getBookingAttempt } from "./booking-attempt";
import { frontendApi } from "./api-adapter";
import { Icon } from "./icons";
import { ActionButton, Field } from "./ui";

const QUICK_OPTION = "__quick__";

function validEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()); }

// Books a client into a free stretch the barber tapped on the calendar. The times offered are the gap
// itself: the hidden 15-minute "Quick appointment", or any published service whose chosen duration fits
// inside the gap. The server re-validates the start against the same slot list the public page uses, so
// a chair can never be double-sold from here.
export function GapBookingForm({ gap, services, timeZone, onClose, onCreated }: { gap: DayGap; services: EventType[]; timeZone: string; onClose: () => void; onCreated: (booking: Booking) => void }) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [serviceId, setServiceId] = useState(() => services[0]?.id ?? QUICK_OPTION);
  const [durationId, setDurationId] = useState(() => (services[0]?.durations.find((item) => item.isDefault) ?? services[0]?.durations[0])?.id ?? "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const timeFormatter = useMemo(() => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }), [timeZone]);
  const isQuick = serviceId === QUICK_OPTION;
  const service = isQuick ? null : services.find((item) => item.id === serviceId) ?? null;
  const duration: DurationOption | null = isQuick ? { id: undefined, minutes: 15, label: "15 minutes", isDefault: true } : service ? service.durations.find((item) => item.id === durationId) ?? service.durations.find((item) => item.isDefault) ?? service.durations[0] ?? null : null;
  const fits = Boolean(duration && duration.minutes <= gap.minutes);
  const complete = Boolean(duration && fits) && name.trim().length >= 2 && name.trim().length <= 120 && (!email.trim() || validEmail(email));

  useEffect(() => { const prior = document.body.style.overflow; document.body.style.overflow = "hidden"; window.requestAnimationFrame(() => closeRef.current?.focus()); return () => { document.body.style.overflow = prior; }; }, []);

  const trapDrawer = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...(drawerRef.current?.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])") ?? [])];
    const first = focusable[0]; const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  function chooseService(id: string) {
    setServiceId(id);
    if (id === QUICK_OPTION) { setDurationId(""); setError(""); return; }
    const next = services.find((item) => item.id === id);
    setDurationId((next?.durations.find((item) => item.isDefault) ?? next?.durations[0])?.id ?? "");
    setError("");
  }

  async function submit() {
    if (!duration || !complete) return;
    setSubmitting(true); setError("");
    const base = { startAt: gap.start, inviteeName: name.trim(), inviteeEmail: email.trim(), inviteeTimeZone: timeZone, notes: notes.trim() };
    try {
      if (isQuick) {
        const attempt = await getBookingAttempt("quick", base);
        const booking = await frontendApi.createQuickBooking(base, attempt.key, timeZone);
        clearTerminalBookingAttempt("quick");
        onCreated(booking);
      } else if (service) {
        const input = { ...base, eventTypeId: service.id, durationId: duration.id ?? "" };
        const attempt = await getBookingAttempt(`host:${service.id}`, input);
        const booking = await frontendApi.createHostBooking(input, attempt.key, timeZone);
        clearTerminalBookingAttempt(`host:${service.id}`);
        onCreated(booking);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The booking could not be created.");
    } finally { setSubmitting(false); }
  }

  return <div className="drawer-layer">
    <button type="button" className="drawer-scrim" onClick={onClose} aria-label="Close the gap booking form" tabIndex={-1} />
    <aside ref={drawerRef} className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="gap-booking-title" onKeyDown={trapDrawer}>
      <header><div><h2 id="gap-booking-title">Fill the gap</h2><span>A {gap.minutes} minute opening from {timeFormatter.format(new Date(gap.start))}.</span></div><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close the gap booking form"><Icon name="x" /></button></header>
      {error && <div className="toast toast-error" role="alert"><span><Icon name="x" /></span>{error}</div>}
      <div className="drawer-answer">
        <Field label="Service" required><select value={serviceId} onChange={(event) => chooseService(event.target.value)}><option value={QUICK_OPTION}>Quick appointment (15 min)</option>{services.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field>
        {!isQuick && service && <Field label="Duration" required><select value={durationId} onChange={(event) => setDurationId(event.target.value)}>{service.durations.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>}
        {!fits && duration && <p className="muted">This service needs {duration.minutes} minutes, but the gap is only {gap.minutes}.</p>}
        <Field label="Client name" required><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" minLength={2} maxLength={120} /></Field>
        <Field label="Client email" hint="Leave blank if you only have their name — no confirmation, reminder, or manage link will be sent."><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" type="email" placeholder="name@example.com" /></Field>
        <Field label="Notes" hint="Anything to remember about this appointment."><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} /></Field>
        <p className="muted">Booking {timeFormatter.format(new Date(gap.start))} for {duration?.minutes ?? 0} min ({timeZone}).</p>
      </div>
      <div className="drawer-actions"><ActionButton variant="primary" disabled={!complete || submitting} onClick={() => { void submit(); }}>{submitting ? "Booking…" : "Add booking"}</ActionButton><ActionButton onClick={onClose}>Cancel</ActionButton></div>
    </aside>
  </div>;
}
