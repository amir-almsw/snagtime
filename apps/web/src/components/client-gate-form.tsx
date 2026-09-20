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
      window.location.assign(next.startsWith("/") && !next.startsWith("//") ? next : "/book");
    } catch (reason) {
      setError(reason instanceof SnagTimeApiError && reason.status === 429 ? reason.message : "That password isn’t right. Check with the studio and try again.");
      setWorking(false);
    }
  };
  return (
    <div className="auth-page dvision">
      <main className="auth-card">
        <BrandMark />
        <div><span className="outcome-eyebrow">Clients only</span><h1>Welcome to Dvision Studio</h1><p>The book is kept for our regulars. Enter the studio password to see what’s open — ask us for it next time you’re in the chair.</p></div>
        <form onSubmit={submit}>
          <label>Studio password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>
          {error && <div className="form-error" role="alert" aria-live="assertive">{error}</div>}
          <button className="button button-primary" type="submit" disabled={working || !password}>{working ? "Checking…" : "Enter"}</button>
        </form>
      </main>
    </div>
  );
}
