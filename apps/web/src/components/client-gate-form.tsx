"use client";

import { useState, type FormEvent } from "react";
import { SnagTimeApiError } from "@/lib/api-client";
import { frontendApi } from "./api-adapter";
import { BrandMark } from "./ui";

export function ClientGateForm({ next }: { next: string }) {
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setWorking(true); setError("");
    try {
      await frontendApi.enterClientGate(password);
      window.location.assign(next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (reason) {
      setError(reason instanceof SnagTimeApiError && reason.status === 429 ? reason.message : "That password is not correct.");
      setWorking(false);
    }
  };
  return (
    <div className="auth-page">
      <main className="auth-card">
        <BrandMark />
        <div><span className="outcome-eyebrow">Client access</span><h1>Enter the shop password</h1><p>Booking is reserved for clients of the shop. Ask us for the password if you don’t have it yet.</p></div>
        <form onSubmit={submit}>
          <label>Shop password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          {error && <div className="form-error" role="alert" aria-live="assertive">{error}</div>}
          <button className="button button-primary" type="submit" disabled={working || !password}>{working ? "Checking…" : "Enter"}</button>
        </form>
      </main>
    </div>
  );
}
