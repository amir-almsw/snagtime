"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailabilityOverride } from "@/lib/contracts";
import type { AvailabilityDay, AvailabilityWindow } from "./demo-data";
import { frontendApi } from "./api-adapter";
import { addHoursOff, addOpenDate, addTimeOff, availabilitySaveResultIsCurrent, canMutateAvailability, conflictingOverrideDates, dayCountLabel, expandDateRange, hoursOffRuns, isFullDayOff, MAX_TIME_OFF_DAYS, pruneExpiredOverrides, rangeDays, removeHoursOff, removeTimeOff, shiftDateKey, timeOffRunLabel, timeOffRuns, timeOptions, todayKey, usualStudioHours, weekBounds, windowEndOptions, windowStartOptions, type AvailabilityLoadState } from "./availability-editor-state";
import { Icon } from "./icons";
import { ActionButton, Badge, Field, PageHeader, SectionHeader, Toggle } from "./ui";
import { useUnsavedChangesWarning } from "./unsaved-changes";
import { useWorkspaceAccess } from "./workspace-access";

const clockValue = (minutes: number | null | undefined, fallback: number) => { const value = minutes ?? fallback; return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`; };
const clockMinutes = (value: string) => { const [hours = 0, minutes = 0] = value.split(":").map(Number); return hours * 60 + minutes; };

export function AvailabilityEditor() {
  const { canManage } = useWorkspaceAccess();
  const [days, setDays] = useState<AvailabilityDay[]>([]);
  const [timeZone, setTimeZone] = useState("Europe/Amsterdam");
  const [overrides, setOverrides] = useState<AvailabilityOverride[]>([]);
  const [timeOffFrom, setTimeOffFrom] = useState("");
  const [timeOffTo, setTimeOffTo] = useState("");
  const [timeOffMode, setTimeOffMode] = useState<"days" | "hours" | "open">("days");
  const [hoursFrom, setHoursFrom] = useState("12:00");
  const [hoursTo, setHoursTo] = useState("14:00");
  const [openDate, setOpenDate] = useState("");
  const [openStart, setOpenStart] = useState("09:00");
  const [openEnd, setOpenEnd] = useState("17:00");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadState, setLoadState] = useState<AvailabilityLoadState>("loading");
  const [error, setError] = useState("");
  const editRevision = useRef(0);
  const loadRevision = useRef(0);
  useUnsavedChangesWarning(dirty, "You have unsaved availability changes. Leave this page?");

  const markEdited = () => { editRevision.current += 1; setDirty(true); setSaved(false); };
  const patchDay = (index: number, patch: Partial<AvailabilityDay>) => { markEdited(); setDays((items) => items.map((day, i) => i === index ? { ...day, ...patch } : day)); };
  const patchWindow = (dayIndex: number, windowIndex: number, patch: Partial<AvailabilityWindow>) => { markEdited(); setDays((items) => items.map((day, index) => index === dayIndex ? { ...day, windows: day.windows.map((window, i) => i === windowIndex ? { ...window, ...patch } : window) } : day)); };
  const patchOverrides = (update: (items: AvailabilityOverride[]) => AvailabilityOverride[]) => { markEdited(); setOverrides(update); };
  const patchTimeZone = (value: string) => { markEdited(); setTimeZone(value); };
  const loadAvailability = useCallback(() => {
    const requestRevision = ++loadRevision.current;
    return frontendApi.getAvailability().then((schedule) => {
      if (loadRevision.current !== requestRevision) return;
      setDays(schedule.days); setTimeZone(schedule.timeZone); setOverrides(schedule.overrides);
      editRevision.current = 0; setDirty(false); setLoadState("loaded");
    }).catch((reason) => {
      if (loadRevision.current !== requestRevision) return;
      setError(reason instanceof Error ? reason.message : "Could not load availability."); setLoadState("error");
    });
  }, []);
  useEffect(() => { void loadAvailability(); return () => { loadRevision.current += 1; }; }, [loadAvailability]);
  const retryLoad = () => { setLoadState("loading"); setError(""); setSaved(false); void loadAvailability(); };
  const save = async () => {
    if (!canMutateAvailability(loadState) || !dirty || saving || conflictingDates.size > 0) return;
    const submittedRevision = editRevision.current;
    const submittedDays = days; const submittedTimeZone = timeZone; const submittedOverrides = pruneExpiredOverrides(overrides, todayKey(timeZone));
    setSaving(true); setError("");
    try {
      const schedule = await frontendApi.saveAvailability(submittedDays, submittedTimeZone, submittedOverrides);
      if (availabilitySaveResultIsCurrent(submittedRevision, editRevision.current)) {
        setDays(schedule.days); setTimeZone(schedule.timeZone); setOverrides(schedule.overrides); setDirty(false); setSaved(true);
        window.setTimeout(() => setSaved(false), 2400);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save availability."); }
    finally { setSaving(false); }
  };
  const discard = () => { if (!dirty) return; if (!window.confirm("Discard unsaved availability changes?")) return; setSaved(false); void loadAvailability(); };
  const today = todayKey(timeZone);
  const nextDate = () => shiftDateKey(today, 7);
  const upcoming = overrides.filter((item) => item.dateKey >= today);
  const conflictingDates = conflictingOverrideDates(upcoming);
  const rangeFrom = timeOffFrom || today; const rangeTo = timeOffTo || rangeFrom;
  const rangeLength = rangeDays(rangeFrom, rangeTo);
  const rangeValid = rangeLength > 0 && rangeLength <= MAX_TIME_OFF_DAYS && rangeFrom >= today && rangeTo >= today;
  const rangeHint = rangeLength === 0 ? "Choose a start and end date." : rangeFrom < today || rangeTo < today ? "Time off starts today or later." : rangeLength > MAX_TIME_OFF_DAYS ? "Add up to a year at a time." : `Closes the studio for ${dayCountLabel(rangeLength)}.`;
  const thisWeek = weekBounds(today); const nextWeek = weekBounds(today, 1);
  const quickPicks = [["Today", today, today], ["Tomorrow", shiftDateKey(today, 1), shiftDateKey(today, 1)], ["This week", thisWeek.from < today ? today : thisWeek.from, thisWeek.to], ["Next week", nextWeek.from, nextWeek.to]] as const;
  const pickRange = (from: string, to: string) => { setTimeOffFrom(from); setTimeOffTo(to); };
  const addTimeOffRange = () => { if (!rangeValid) return; patchOverrides((items) => addTimeOff(items, rangeFrom, rangeTo)); };
  const blockStart = clockMinutes(hoursFrom); const blockEnd = clockMinutes(hoursTo);
  const blockDateIsOff = (date: string) => overrides.some((item) => item.dateKey === date && isFullDayOff(item));
  const hoursCoveredDates = expandDateRange(rangeFrom, rangeTo).filter((date) => !blockDateIsOff(date));
  const hoursValid = rangeValid && blockEnd > blockStart && hoursCoveredDates.length > 0;
  const hoursHint = blockEnd <= blockStart ? "The end time must be after the start time." : rangeLength === 0 || rangeFrom < today || rangeTo < today ? "Choose a date today or later." : rangeLength > MAX_TIME_OFF_DAYS ? "Add up to a year at a time." : hoursCoveredDates.length === 0 ? "Those dates are already fully off." : `Blocks ${clockValue(blockStart, 0)} – ${clockValue(blockEnd, 0)} on ${dayCountLabel(hoursCoveredDates.length)}.`;
  const addHoursOffRange = () => { if (!hoursValid) return; patchOverrides((items) => addHoursOff(items, rangeFrom, rangeTo, blockStart, blockEnd)); };
  const runs = timeOffRuns(upcoming);
  const blockRuns = hoursOffRuns(upcoming);
  const nextUnusedDate = () => { const date = new Date(`${nextDate()}T12:00:00Z`); while (overrides.some((item) => item.dateKey === date.toISOString().slice(0, 10))) date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); };
  const usualHours = usualStudioHours(days);
  const openStartMin = clockMinutes(openStart); const openEndMin = clockMinutes(openEnd);
  const openValid = Boolean(openDate) && openDate >= today && openEndMin > openStartMin;
  const openHint = openEndMin <= openStartMin ? "The end time must be after the start time." : openDate && openDate < today ? "Choose today or a later date." : "Opens the studio for these hours on this date only — other days keep their usual schedule.";
  const addOpenDateRange = () => { if (!openValid) return; patchOverrides((items) => addOpenDate(items, openDate, openStartMin, openEndMin)); };

  if (!canManage) return <div className="page-stack"><PageHeader title="Availability" /><section className="panel error-state" role="alert"><span><Icon name="x" /></span><h2>Studio access required</h2><p>Your workspace role cannot change availability.</p></section></div>;
  if (loadState === "loading") return <div className="page-stack"><PageHeader eyebrow="Schedule · Working hours" title="Availability" description="Define when people can book you. Event rules and calendar conflicts are applied on top." /><div className="sync-note" role="status"><span className="spinner" />Loading availability…</div></div>;
  if (loadState === "error") return <div className="page-stack"><PageHeader eyebrow="Schedule · Working hours" title="Availability" description="Define when people can book you. Event rules and calendar conflicts are applied on top." /><section className="panel error-state" role="alert"><span><Icon name="x" /></span><h2>Availability did not load</h2><p>{error || "Could not load availability."}</p><ActionButton variant="primary" onClick={retryLoad}>Retry</ActionButton></section></div>;

  return <div className="page-stack availability-page">
    <PageHeader eyebrow="Schedule · Working hours" title="Availability" description="Define when people can book you. Event rules and calendar conflicts are applied on top." actions={<ActionButton variant="primary" onClick={save} disabled={saving || !dirty || conflictingDates.size > 0}><Icon name="check" size={16} />{saving ? "Saving…" : dirty ? "Save changes" : "Saved"}</ActionButton>} />
    {saved && <div className="toast" role="status"><span><Icon name="check" /></span>Availability saved</div>}
    {error && <div className="toast toast-error" role="alert"><span><Icon name="x" /></span>{error}</div>}
    {conflictingDates.size > 0 && <div className="toast toast-error" role="alert"><span><Icon name="x" /></span>Use each date only once. Remove or change the highlighted duplicate date before saving.</div>}
    <div className="availability-layout">
      <section className="panel availability-main">
        <SectionHeader title="Weekly hours" description="Your reusable default schedule" action={<div className="timezone-pill"><Icon name="globe" size={15} />{timeZone}</div>} />
        <div className="schedule-list">
          {days.map((day, dayIndex) => <div className={`schedule-day ${!day.enabled ? "is-off" : ""}`} key={day.day}>
            <div className="day-toggle"><Toggle checked={day.enabled} onChange={(enabled) => patchDay(dayIndex, { enabled, windows: enabled && day.windows.length === 0 ? [{ id: crypto.randomUUID(), start: "9:00 AM", end: "5:00 PM" }] : day.windows })} label={`${day.day} availability`} /><strong>{day.short}</strong></div>
            <div className="day-windows">{day.enabled ? day.windows.map((window, windowIndex) => <div className="time-window" role="group" aria-label={`${day.day} time window ${windowIndex + 1}`} key={window.id}><select aria-label={`Start time for ${day.day} window ${windowIndex + 1}`} value={window.start} onChange={(e) => patchWindow(dayIndex, windowIndex, { start: e.target.value })}>{timeOptions(windowStartOptions, window.start).map((time) => <option key={time}>{time}</option>)}</select><span aria-hidden="true">–</span><select aria-label={`End time for ${day.day} window ${windowIndex + 1}`} value={window.end} onChange={(e) => patchWindow(dayIndex, windowIndex, { end: e.target.value })}>{timeOptions(windowEndOptions, window.end).map((time) => <option key={time}>{time}</option>)}</select><button type="button" className="icon-button" aria-label={`Remove ${day.day} time window`} onClick={() => patchDay(dayIndex, { windows: day.windows.filter((_, i) => i !== windowIndex) })}><Icon name="trash" size={16} /></button></div>) : <span className="unavailable-label">Unavailable</span>}</div>
            <button type="button" className="icon-button add-window" aria-label={`Add ${day.day} time window`} disabled={!day.enabled} onClick={() => patchDay(dayIndex, { windows: [...day.windows, { id: crypto.randomUUID(), start: "1:00 PM", end: "5:00 PM" }] })}><Icon name="plus" /></button>
          </div>)}
        </div>
      </section>
      <aside className="availability-aside">
        <section className="panel compact-panel"><SectionHeader title="Calendar preview" /><div className="mini-week"><div className="mini-week-head">{days.map((day) => <span key={day.short}>{day.short[0]}</span>)}</div><div className="mini-week-grid">{days.map((day) => <div key={day.short} className={day.enabled ? "has-hours" : ""}>{day.enabled && <span style={{ height: `${Math.max(28, day.windows.length * 24)}px` }} />}</div>)}</div></div><p className="aside-note"><span className="legend-dot" />Your bookable hours before event rules and connected calendar conflicts.</p></section>
        <section className="panel compact-panel"><SectionHeader title="Schedule rules" /><Field label="Timezone"><select value={timeZone} onChange={(event) => patchTimeZone(event.target.value)}>{[...new Set([timeZone, "Europe/Amsterdam", "Europe/London", "Europe/Berlin", "Europe/Paris", "UTC"])].map((zone) => <option value={zone} key={zone}>{zone}</option>)}</select></Field><p className="aside-note">Clients choose their own display timezone on the public booking page.</p></section>
      </aside>
    </div>
    <div className="two-panel-grid">
      <section className="panel"><SectionHeader title="Date overrides" description="Open a normally-closed date or use different hours on one date" action={<ActionButton icon="plus" variant="secondary" onClick={() => patchOverrides((items) => [...items, { dateKey: nextUnusedDate(), isAvailable: true, startMinute: usualHours.startMinute, endMinute: usualHours.endMinute }])}>Add override</ActionButton>} /><div className="exception-list">{upcoming.filter((item) => item.isAvailable).map((item, index) => <div className={`exception-row ${conflictingDates.has(item.dateKey) ? "has-conflict" : ""}`} key={item.id ?? `${item.dateKey}-${index}`}><span className="exception-icon"><Icon name="calendar" /></span><div><input type="date" value={item.dateKey} onChange={(event) => patchOverrides((items) => items.map((current) => current === item ? { ...current, dateKey: event.target.value } : current))} aria-label="Override date" aria-invalid={conflictingDates.has(item.dateKey)} /><span><input type="time" value={clockValue(item.startMinute, 540)} onChange={(event) => patchOverrides((items) => items.map((current) => current === item ? { ...current, startMinute: clockMinutes(event.target.value) } : current))} aria-label={`Start time for ${item.dateKey}`} /> – <input type="time" value={clockValue(item.endMinute, 1020)} onChange={(event) => patchOverrides((items) => items.map((current) => current === item ? { ...current, endMinute: clockMinutes(event.target.value) } : current))} aria-label={`End time for ${item.dateKey}`} /></span>{conflictingDates.has(item.dateKey) && <small role="alert">This date is already used.</small>}</div><Badge tone="info">Available</Badge><button className="icon-button" onClick={() => patchOverrides((items) => items.filter((current) => current !== item))} aria-label={`Remove override for ${item.dateKey}`}><Icon name="trash" /></button></div>)}</div>{!upcoming.some((item) => item.isAvailable) && <div className="empty-state"><p>No date overrides configured.</p></div>}</section>
      <section className="panel"><SectionHeader title="Time off" description="Close the studio for a day, a run of days, or certain hours" /><div className="time-off-modes" role="group" aria-label="Time off type"><button type="button" className={timeOffMode === "days" ? "is-selected" : ""} aria-pressed={timeOffMode === "days"} onClick={() => setTimeOffMode("days")}>Full days</button><button type="button" className={timeOffMode === "hours" ? "is-selected" : ""} aria-pressed={timeOffMode === "hours"} onClick={() => setTimeOffMode("hours")}>Certain hours</button><button type="button" className={timeOffMode === "open" ? "is-selected" : ""} aria-pressed={timeOffMode === "open"} onClick={() => { setTimeOffMode("open"); setOpenStart(clockValue(usualHours.startMinute, 540)); setOpenEnd(clockValue(usualHours.endMinute, 1020)); }}>Open a date</button></div>{timeOffMode === "open" ? <div className="time-off-form is-hours"><Field label="Date"><input type="date" value={openDate} min={today} onChange={(event) => setOpenDate(event.target.value)} aria-label="Date to open" /></Field><Field label="From"><input type="time" value={openStart} onChange={(event) => setOpenStart(event.target.value)} aria-label="Open from time" /></Field><Field label="To"><input type="time" value={openEnd} onChange={(event) => setOpenEnd(event.target.value)} aria-label="Open until time" /></Field><ActionButton icon="plus" variant="secondary" onClick={addOpenDateRange} disabled={!openValid}>Open this date</ActionButton></div> : <div className={`time-off-form${timeOffMode === "hours" ? " is-hours" : ""}`}><Field label="From"><input type="date" value={rangeFrom} min={today} onChange={(event) => { const value = event.target.value; setTimeOffFrom(value); if (timeOffTo && value > timeOffTo) setTimeOffTo(value); }} aria-label="Time off start date" /></Field><Field label="To"><input type="date" value={rangeTo} min={rangeFrom} onChange={(event) => setTimeOffTo(event.target.value)} aria-label="Time off end date" /></Field>{timeOffMode === "hours" && <><Field label="From"><input type="time" value={hoursFrom} onChange={(event) => setHoursFrom(event.target.value)} aria-label="Time off start time" /></Field><Field label="To"><input type="time" value={hoursTo} onChange={(event) => setHoursTo(event.target.value)} aria-label="Time off end time" /></Field></>}<ActionButton icon="plus" variant="secondary" onClick={timeOffMode === "hours" ? addHoursOffRange : addTimeOffRange} disabled={timeOffMode === "hours" ? !hoursValid : !rangeValid}>Add time off</ActionButton></div>}{timeOffMode === "days" && <div className="time-off-presets" role="group" aria-label="Time off quick picks">{quickPicks.map(([label, from, to]) => <ActionButton key={label} variant="secondary" className="button-sm" onClick={() => pickRange(from, to)}>{label}</ActionButton>)}</div>}<p className="time-off-hint">{timeOffMode === "open" ? openHint : timeOffMode === "hours" ? hoursHint : rangeHint}</p><div className="exception-list">{runs.map((run) => { const conflict = run.dateKeys.some((date) => conflictingDates.has(date)); const label = timeOffRunLabel(run, today); return <div className={`exception-row ${conflict ? "has-conflict" : ""}`} key={run.from}><span className="exception-icon exception-off"><Icon name="calendar" /></span><div><strong>{label}</strong><span>{run.days === 1 ? "Unavailable all day" : `Unavailable for ${dayCountLabel(run.days)}`}</span>{conflict && <small role="alert">Another entry uses a date in this range.</small>}</div><Badge tone="neutral">{dayCountLabel(run.days)}</Badge><button className="icon-button" onClick={() => patchOverrides((items) => removeTimeOff(items, run))} aria-label={`Remove time off ${label}`}><Icon name="trash" /></button></div>; })}{blockRuns.map((run) => { const conflict = run.dateKeys.some((date) => conflictingDates.has(date)); const label = timeOffRunLabel(run, today); return <div className={`exception-row ${conflict ? "has-conflict" : ""}`} key={`hours-${run.from}-${run.startMinute}`}><span className="exception-icon exception-off"><Icon name="calendar" /></span><div><strong>{label}</strong><span>{`Unavailable ${clockValue(run.startMinute, 0)} – ${clockValue(run.endMinute, 0)}`}</span>{conflict && <small role="alert">Another entry overlaps a date in this range.</small>}</div><Badge tone="neutral">{dayCountLabel(run.days)}</Badge><button className="icon-button" onClick={() => patchOverrides((items) => removeHoursOff(items, run))} aria-label={`Remove time off ${label}`}><Icon name="trash" /></button></div>; })}</div>{!runs.length && !blockRuns.length && <div className="empty-state"><p>No time off configured.</p></div>}</section>
    </div>
    <div className="availability-save-bar">
      <span className="availability-save-state" role="status" aria-live="polite">{saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}</span>
      <div className="availability-save-actions">
        <button type="button" className="button button-ghost button-sm" onClick={discard} disabled={saving || !dirty}>Discard</button>
        <ActionButton variant="primary" onClick={save} disabled={saving || !dirty || conflictingDates.size > 0}>{saving ? "Saving…" : "Save changes"}</ActionButton>
      </div>
    </div>
  </div>;
}
