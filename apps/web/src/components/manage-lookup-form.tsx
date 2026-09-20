"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { SnagTimeApiError } from "@/lib/api-client";
import { frontendApi } from "./api-adapter";
import { BrandMark } from "./ui";

type Mode = "reference" | "email";

export function ManageLookupForm() {
  const [mode, setMode] = useState<Mode>("reference");
  const [value, setValue] = useState("");
  const [working, setWorking] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setError("");
    try {
      await frontendApi.requestBookingManageLookup(mode === "reference" ? { reference: value.trim() } : { email: value.trim() });
      setSent(true);
    } catch (reason) {
      // The server never distinguishes a hit from a miss, so the only errors worth showing are the ones
      // about the request itself: too many attempts, or something that could not be a reference at all.
      setError(reason instanceof SnagTimeApiError && (reason.status === 429 || reason.status === 422) ? reason.message : "That request could not be sent. Try again in a moment.");
    } finally { setWorking(false); }
  };

  if (sent) {
    return (
      <div className="auth-page dvision">
        <main className="auth-card">
          <BrandMark />
          <div>
            <span className="outcome-eyebrow">Check your inbox</span>
            <h1>If we found it, the link is on its way</h1>
            {/* Stating both exclusions up front: without them a client whose appointment was this
                morning waits for an email that is never coming. Which case applies is still never said. */}
            <p>We’ve sent a link to manage your appointment. Nothing will arrive if we have no record of it, or if the appointment has already passed — we don’t say which, for everyone’s privacy.</p>
          </div>
          <div className="manage-lookup-actions">
            <button className="button button-secondary" type="button" onClick={() => { setSent(false); setValue(""); }}>Try another way</button>
            <Link className="button button-primary" href="/book">Book an appointment</Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="auth-page dvision">
      <main className="auth-card">
        <BrandMark />
        <div>
          <span className="outcome-eyebrow">Manage my appointment</span>
          <h1>Find your appointment</h1>
          <p>Lost the link from your confirmation email? Enter your booking reference and we’ll send a fresh one.</p>
        </div>
        <div className="manage-lookup-modes" role="group" aria-label="Find your appointment by">
          <button type="button" className={mode === "reference" ? "is-selected" : ""} aria-pressed={mode === "reference"} onClick={() => { setMode("reference"); setValue(""); setError(""); }}>Booking reference</button>
          <button type="button" className={mode === "email" ? "is-selected" : ""} aria-pressed={mode === "email"} onClick={() => { setMode("email"); setValue(""); setError(""); }}>I don’t have it</button>
        </div>
        <form onSubmit={submit}>
          {mode === "reference" ? (
            <label>Booking reference
              <input type="text" value={value} onChange={(event) => setValue(event.target.value)} placeholder="DV-4K7Q2M" autoComplete="off" autoCapitalize="characters" spellCheck={false} required />
              <small>On your confirmation email, near the top. Upper or lower case both work.</small>
            </label>
          ) : (
            <label>Email you booked with
              <input type="email" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="email" required />
              <small>We’ll send the link to this address if it has an upcoming appointment.</small>
            </label>
          )}
          {error && <div className="form-error" role="alert" aria-live="assertive">{error}</div>}
          <button className="button button-primary" type="submit" disabled={working || value.trim().length < 3}>{working ? "Sending…" : "Email me my link"}</button>
        </form>
        <p className="manage-lookup-foot"><Link href="/book">Back to booking</Link></p>
      </main>
    </div>
  );
}
