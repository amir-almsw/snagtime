"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { BookingSlot, HostBookingInput } from "@/lib/contracts";
import type { Booking, CustomQuestionView, DurationOption, EventType } from "./demo-data";
import { frontendApi } from "./api-adapter";
import { clearTerminalBookingAttempt, getBookingAttempt } from "./booking-attempt";
import { loadHostWindowSlots } from "./slot-window";
import { Icon } from "./icons";
import { ActionButton, Field } from "./ui";

type SlotDay = { key: string; weekday: string; day: string; month: string; label: string };
type SlotView = { slot: BookingSlot; day: SlotDay; time: string };
type SlotFormatters = { key: Intl.DateTimeFormat; day: Intl.DateTimeFormat; time: Intl.DateTimeFormat };
type BookingAnswers = NonNullable<HostBookingInput["answers"]>;

function dateKey(value: string, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function slotView(slot: BookingSlot, formatters: SlotFormatters): SlotView {
  const date = new Date(slot.start);
  const parts = formatters.day.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = get("weekday"); const month = get("month"); const day = get("day");
  return { slot, day: { key: dateKey(slot.start, formatters.key), weekday, day, month, label: `${weekday}, ${month} ${day}, ${get("year")}` }, time: formatters.time.format(date) };
}

function validEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()); }

function answerComplete(question: CustomQuestionView, answers: Record<string, string | boolean>) {
  if (!question.required) return true;
  if (!question.id) return false;
  const answer = answers[question.id];
  return typeof answer === "boolean" ? answer : typeof answer === "string" && answer.trim().length > 0;
}

// The studio books a client in from the dashboard. The times offered are exactly the ones the booking
// page would offer -- the server recomputes them and refuses anything that is not on that list -- so a
// chair can never be double-sold from here, and the client gets the same confirmation and manage link.
export function HostBookingForm({ services, timeZone, onClose, onCreated }: { services: EventType[]; timeZone: string; onClose: () => void; onCreated: (booking: Booking) => void }) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [serviceId, setServiceId] = useState(() => services[0]?.id ?? "");
  const [durationId, setDurationId] = useState(() => { const first = services[0]; return (first?.durations.find((item) => item.isDefault) ?? first?.durations[0])?.id ?? ""; });
  const [slots, setSlots] = useState<BookingSlot[]>([]);
  const [slotVersion, setSlotVersion] = useState(0);
  const [loadingSlots, setLoadingSlots] = useState(true);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedStart, setSelectedStart] = useState("");
  const [dayOffset, setDayOffset] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const service = services.find((item) => item.id === serviceId) ?? null;
  const duration: DurationOption | null = service ? service.durations.find((item) => item.id === durationId) ?? service.durations.find((item) => item.isDefault) ?? service.durations[0] ?? null : null;
  const formatters = useMemo<SlotFormatters>(() => ({
    key: new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }),
    day: new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric" }),
    time: new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }),
  }), [timeZone]);

  useEffect(() => { const prior = document.body.style.overflow; document.body.style.overflow = "hidden"; window.requestAnimationFrame(() => closeRef.current?.focus()); return () => { document.body.style.overflow = prior; }; }, []);

  // Loading is raised by whatever changes the selection, never inside this effect: a synchronous
  // setState here would cascade an extra render on every slot load.
  useEffect(() => {
    if (!service || !duration?.id) return;
    let active = true; const controller = new AbortController();
    loadHostWindowSlots(service.id, service.bookingWindowDays, timeZone, duration.id, controller.signal)
      .then((items) => { if (!active) return; setSlots(items); setSelectedDate(items[0] ? dateKey(items[0].start, formatters.key) : ""); setSelectedStart(""); setDayOffset(0); })
      .catch((reason) => { if (!active || (reason instanceof DOMException && reason.name === "AbortError")) return; setSlots([]); setError(reason instanceof Error ? reason.message : "Could not load open times."); })
      .finally(() => { if (active) setLoadingSlots(false); });
    return () => { active = false; controller.abort(); };
  }, [duration?.id, formatters.key, service, slotVersion, timeZone]);

  const slotViews = useMemo(() => slots.map((slot) => slotView(slot, formatters)), [formatters, slots]);
  const days = useMemo(() => { const unique = new Map<string, SlotDay>(); slotViews.forEach(({ day }) => { if (!unique.has(day.key)) unique.set(day.key, day); }); return [...unique.values()]; }, [slotViews]);
  const visibleDays = days.slice(dayOffset, dayOffset + 7);
  const daySlots = useMemo(() => slotViews.filter(({ day }) => day.key === selectedDate), [selectedDate, slotViews]);
  const selectedDay = days.find((day) => day.key === selectedDate);
  const selectedView = slotViews.find(({ slot }) => slot.start === selectedStart);
  const questions = service?.questions ?? [];
  const complete = Boolean(service && duration && selectedStart) && name.trim().length >= 2 && name.trim().length <= 120 && validEmail(email) && questions.every((question) => answerComplete(question, answers));

  function chooseService(id: string) {
    const next = services.find((item) => item.id === id);
    setServiceId(id); setDurationId((next?.durations.find((item) => item.isDefault) ?? next?.durations[0])?.id ?? "");
    setSelectedStart(""); setAnswers({}); setError(""); setNotice(""); setLoadingSlots(true);
  }

  // A checkbox is always sent as a boolean and an untouched optional question is left out entirely:
  // createBooking rejects "" for a CHECKBOX and for a SELECT whose options never contain it, so sending
  // a placeholder for a question nobody answered would fail the booking on an optional field.
  function bookingAnswers(): BookingAnswers {
    return questions.flatMap((question): BookingAnswers => {
      if (!question.id) return [];
      const value = answers[question.id];
      if (question.kind === "CHECKBOX") return [{ questionId: question.id, value: Boolean(value) }];
      const text = typeof value === "string" ? value.trim() : "";
      return text ? [{ questionId: question.id, value: text }] : [];
    });
  }

  const trapDrawer = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...(drawerRef.current?.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])") ?? [])];
    const first = focusable[0]; const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  async function submit() {
    if (!service || !duration?.id || !selectedStart) return;
    setSubmitting(true); setError(""); setNotice("");
    const input: HostBookingInput = { eventTypeId: service.id, startAt: selectedStart, inviteeName: name.trim(), inviteeEmail: email.trim(), inviteeTimeZone: timeZone, notes: notes.trim(), durationId: duration.id, answers: bookingAnswers() };
    try {
      // The attempt key is fingerprinted over the input, so a retry of the same booking is idempotent
      // while an edited one gets a fresh key instead of colliding with the abandoned attempt.
      const attempt = await getBookingAttempt(`host:${service.id}`, { startAt: input.startAt, inviteeName: input.inviteeName, inviteeEmail: input.inviteeEmail, inviteeTimeZone: input.inviteeTimeZone, notes: input.notes, durationId: input.durationId, answers: input.answers });
      const booking = await frontendApi.createHostBooking(input, attempt.key, timeZone);
      clearTerminalBookingAttempt(`host:${service.id}`);
      onCreated(booking);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The booking could not be created.";
      // Someone took the slot between the list being drawn and this submit: refresh rather than leave a stale grid.
      if (/no longer available|just booked/i.test(message)) { setSelectedStart(""); setNotice("That time was just taken. The open times have been refreshed."); setLoadingSlots(true); setSlotVersion((current) => current + 1); }
      else setError(message);
    } finally { setSubmitting(false); }
  }

  return <div className="drawer-layer">
    <button type="button" className="drawer-scrim" onClick={onClose} aria-label="Close the new booking form" tabIndex={-1} />
    <aside ref={drawerRef} className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="add-booking-title" onKeyDown={trapDrawer}>
      <header><div><h2 id="add-booking-title">Add booking</h2><span>Book a client in yourself. They get the same confirmation email and manage link.</span></div><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="Close the new booking form"><Icon name="x" /></button></header>
      {error && <div className="toast toast-error" role="alert"><span><Icon name="x" /></span>{error}</div>}
      {notice && <div className="notice notice-warning" role="status"><Icon name="calendar" /><div><strong>That time just went</strong><span>{notice}</span></div></div>}
      {services.length === 0
        ? <div className="empty-state"><span className="empty-icon"><Icon name="calendar" /></span><h3>No published services</h3><p>Publish a service before booking a client into it.</p></div>
        : <div className="drawer-answer">
          <Field label="Service" required><select value={serviceId} onChange={(event) => chooseService(event.target.value)}>{services.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field>
          {service && service.durations.length > 1 && <Field label="Duration" required><select value={duration?.id ?? ""} onChange={(event) => { setDurationId(event.target.value); setSelectedStart(""); setLoadingSlots(true); }}>{service.durations.map((item) => <option key={item.id ?? item.label} value={item.id ?? ""}>{item.label}</option>)}</select></Field>}
          <div className="flow-heading calendar-heading"><div><h3>Date and time</h3><p>{timeZone}</p></div><div><button type="button" className="icon-button" aria-label="Previous open dates" disabled={dayOffset === 0} onClick={() => { const next = Math.max(0, dayOffset - 7); setDayOffset(next); setSelectedDate(days[next]?.key ?? ""); setSelectedStart(""); }}><Icon name="arrow-left" /></button><button type="button" className="icon-button" aria-label="Next open dates" disabled={dayOffset + 7 >= days.length} onClick={() => { const next = Math.min(dayOffset + 7, Math.max(0, days.length - 1)); setDayOffset(next); setSelectedDate(days[next]?.key ?? ""); setSelectedStart(""); }}><Icon name="arrow-right" /></button></div></div>
          {loadingSlots
            ? <div className="sync-note" role="status"><span className="spinner" />Finding open times…</div>
            : days.length
              ? <div className="booking-calendar"><div className="calendar-week">{visibleDays.map((day) => <button type="button" key={day.key} className={selectedDate === day.key ? "is-selected" : ""} aria-pressed={selectedDate === day.key} onClick={() => { setSelectedDate(day.key); setSelectedStart(""); }}><span>{day.weekday}</span><strong>{day.day}</strong><i>{day.month}</i></button>)}</div><div className="time-grid-scroll" role="region" aria-label={`Open times on ${selectedDay?.label ?? "the selected date"}`} tabIndex={0}><div className="time-grid">{daySlots.map(({ slot, time }) => <button type="button" key={slot.start} className={selectedStart === slot.start ? "is-selected" : ""} aria-pressed={selectedStart === slot.start} onClick={() => { setSelectedStart(slot.start); setError(""); setNotice(""); }}>{time}{selectedStart === slot.start && <Icon name="check" size={15} />}</button>)}</div></div></div>
              : <div className="empty-state"><span className="empty-icon"><Icon name="calendar" /></span><h3>No open times</h3><p>Nothing is free for this service in its booking window.</p></div>}
          <Field label="Client name" required><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" minLength={2} maxLength={120} /></Field>
          <Field label="Client email" required hint="Their confirmation, reminder, and manage link go here."><input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" type="email" /></Field>
          {questions.map((question) => <Field key={question.id ?? question.label} label={question.label} required={question.required}>
            {question.kind === "CHECKBOX"
              ? <input type="checkbox" checked={Boolean(question.id && answers[question.id])} onChange={(event) => question.id && setAnswers((current) => ({ ...current, [question.id!]: event.target.checked }))} />
              : question.kind === "SELECT"
                ? <select value={question.id ? String(answers[question.id] ?? "") : ""} onChange={(event) => question.id && setAnswers((current) => ({ ...current, [question.id!]: event.target.value }))}><option value="">Select an option</option>{question.options.map((option) => <option key={option}>{option}</option>)}</select>
                : <textarea rows={question.kind === "TEXTAREA" ? 3 : 2} value={question.id ? String(answers[question.id] ?? "") : ""} onChange={(event) => question.id && setAnswers((current) => ({ ...current, [question.id!]: event.target.value }))} />}
          </Field>)}
          <Field label="Notes" hint="Anything to remember about this appointment."><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} /></Field>
          {selectedView && <p className="muted">Booking {selectedDay?.label} at {selectedView.time} ({timeZone}).</p>}
        </div>}
      <div className="drawer-actions"><ActionButton variant="primary" disabled={!complete || submitting} onClick={() => { void submit(); }}>{submitting ? "Booking…" : "Add booking"}</ActionButton><ActionButton onClick={onClose}>Cancel</ActionButton></div>
    </aside>
  </div>;
}
