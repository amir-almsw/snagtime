"use client";
/* eslint-disable @next/next/no-img-element -- persisted external workspace logos cannot use a fixed Next image host allowlist */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type { AccountSummary, WorkspaceBranding } from "@/lib/contracts";
import { frontendApi } from "./api-adapter";
import { foregroundForBackground } from "./brand-contrast";
import { Icon } from "./icons";
import { ActionButton, Avatar, Badge, Field, PageHeader } from "./ui";

const emptyBranding: WorkspaceBranding = { workspaceName: "", logoUrl: null, accentColor: "#2563eb", description: null, footerText: null };
const acceptedLogoTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxLogoSourceBytes = 5 * 1024 * 1024;
const maxStoredLogoCharacters = 700_000;

async function optimizeLogo(file: File) {
  if (!acceptedLogoTypes.has(file.type)) throw new Error("Choose a PNG, JPG, or WebP logo.");
  if (file.size > maxLogoSourceBytes) throw new Error("Choose a logo smaller than 5 MB.");
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image(); image.decoding = "async";
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("That image could not be read.")); image.src = objectUrl; });
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 8192 || image.naturalHeight > 8192) throw new Error("Choose a valid logo no larger than 8192 × 8192 pixels.");
    const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d"); if (!context) throw new Error("This browser cannot prepare the logo.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.88, 0.72, 0.56]) {
      const dataUrl = canvas.toDataURL("image/webp", quality);
      if (dataUrl.startsWith("data:image/webp;base64,") && dataUrl.length <= maxStoredLogoCharacters) return dataUrl;
    }
    throw new Error("The optimized logo is still too large. Choose a simpler image.");
  } finally { URL.revokeObjectURL(objectUrl); }
}

export function SettingsView() {
  const [branding, setBranding] = useState<WorkspaceBranding>(emptyBranding);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "error">("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState("");
  const [logoProcessing, setLogoProcessing] = useState(false);
  const [logoFileName, setLogoFileName] = useState("");
  const [profileProcessing, setProfileProcessing] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const logoInputRef = useRef<HTMLInputElement>(null);
  const profileInputRef = useRef<HTMLInputElement>(null);
  const editRevision = useRef(0);
  const loadRevision = useRef(0);
  const [error, setError] = useState("");
  const loadSettings = useCallback(() => {
    const requestRevision = ++loadRevision.current;
    const startingEditRevision = editRevision.current;
    return Promise.all([frontendApi.getWorkspaceBranding(), frontendApi.getAccount()]).then(([workspaceBranding, summary]) => {
      if (loadRevision.current !== requestRevision || editRevision.current !== startingEditRevision) return;
      setBranding(workspaceBranding); setAccount(summary); setDirty(false); setLoadState("loaded");
    }).catch((reason) => { if (loadRevision.current === requestRevision) { setError(reason instanceof Error ? reason.message : "Could not load workspace settings."); setLoadState("error"); } });
  }, []);
  useEffect(() => { void loadSettings(); return () => { loadRevision.current += 1; }; }, [loadAttempt, loadSettings]);
  const patch = <K extends keyof WorkspaceBranding>(key: K, value: WorkspaceBranding[K]) => { if (loadState !== "loaded") return; editRevision.current += 1; setDirty(true); setSaved(false); setBranding((current) => ({ ...current, [key]: value })); };
  const uploadLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    setLogoProcessing(true); setError("");
    try { patch("logoUrl", await optimizeLogo(file)); setLogoFileName(file.name); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The logo could not be prepared."); }
    finally { setLogoProcessing(false); event.target.value = ""; }
  };
  const removeLogo = () => { patch("logoUrl", null); setLogoFileName(""); if (logoInputRef.current) logoInputRef.current.value = ""; };
  const persistProfileImage = async (imageUrl: string | null) => {
    setProfileProcessing(true); setProfileMessage(""); setError("");
    try {
      const user = await frontendApi.updateProfileImage({ imageUrl });
      setAccount((current) => current ? { ...current, user } : current);
      window.dispatchEvent(new CustomEvent("snagtime:profile-image", { detail: user }));
      setProfileMessage(imageUrl ? "Profile photo updated." : "Profile photo removed. Initials are shown instead.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update your profile photo."); }
    finally { setProfileProcessing(false); if (profileInputRef.current) profileInputRef.current.value = ""; }
  };
  const uploadProfileImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    setProfileProcessing(true); setProfileMessage(""); setError("");
    try { await persistProfileImage(await optimizeLogo(file)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The profile photo could not be prepared."); setProfileProcessing(false); event.target.value = ""; }
  };
  const save = async () => {
    if (loadState !== "loaded" || !dirty) return;
    const submittedRevision = editRevision.current;
    const submittedBranding = branding;
    setSaving(true); setError("");
    try {
      const persisted = await frontendApi.updateWorkspaceBranding(submittedBranding);
      if (editRevision.current !== submittedRevision) return;
      setBranding(persisted); setDirty(false);
      setAccount((current) => current ? { ...current, workspace: { ...current.workspace, name: persisted.workspaceName }, workspaces: current.workspaces.map((workspace) => workspace.id === current.workspace.id ? { ...workspace, name: persisted.workspaceName } : workspace) } : current);
      window.dispatchEvent(new CustomEvent("snagtime:workspace-branding", { detail: { workspaceName: persisted.workspaceName, logoUrl: persisted.logoUrl } }));
      setSaved(true); window.setTimeout(() => setSaved(false), 2200);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save workspace settings."); }
    finally { setSaving(false); }
  };
  const passwordValid = newPassword.length >= 12 && /[a-z]/.test(newPassword) && /[A-Z]/.test(newPassword) && /\d/.test(newPassword) && /[^A-Za-z0-9]/.test(newPassword);
  const changePassword = async () => {
    if (!currentPassword || !passwordValid) { setError("Enter your current password and a new password that meets every requirement."); return; }
    setChangingPassword(true); setError(""); setPasswordMessage("");
    try {
      const result = await frontendApi.changePassword(currentPassword, newPassword);
      setCurrentPassword(""); setNewPassword("");
      setPasswordMessage(result.signedOutOtherSessions ? "Password changed. Other signed-in sessions were ended; this device remains signed in with a rotated session." : "Password changed.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The password could not be changed."); }
    finally { setChangingPassword(false); }
  };
  if (loadState === "loading") return <div className="page-stack settings-page"><PageHeader title="Workspace settings" description="Manage your workspace identity, security, and booking-page appearance." /><div className="sync-note" role="status"><span className="spinner" />Loading workspace settings…</div></div>;
  if (loadState === "error") return <div className="page-stack settings-page"><PageHeader title="Workspace settings" /><section className="panel error-state" role="alert"><span><Icon name="x" /></span><h2>Workspace settings did not load</h2><p>{error || "Could not load workspace settings."}</p><ActionButton variant="primary" onClick={() => { setError(""); setLoadState("loading"); setLoadAttempt((attempt) => attempt + 1); }}>Retry</ActionButton></section></div>;
  return <div className="page-stack settings-page">
    <PageHeader title="Workspace settings" description="Manage your workspace identity, security, and booking-page appearance." />
    {saved && <div className="toast" role="status"><span><Icon name="check" /></span>Workspace settings saved</div>}
    {error && <div className="toast toast-error" role="alert"><span><Icon name="x" /></span>{error}</div>}
    {account && <div className="account-settings-grid"><section className="panel settings-content"><div className="settings-heading"><div><h2>Active workspace</h2><p>The workspace you are currently managing.</p></div><Badge tone="brand">{account.workspace.role.toLowerCase()}</Badge></div><div className="workspace-overview">{branding.logoUrl ? <img src={branding.logoUrl} alt={`${branding.workspaceName || account.workspace.name} logo`} className="workspace-dot workspace-logo" /> : <span className="workspace-dot">{(branding.workspaceName || account.workspace.name).charAt(0).toUpperCase()}</span>}<div><strong>{branding.workspaceName || account.workspace.name}</strong><span>{account.workspace.timeZone}</span></div></div><dl className="workspace-facts"><div><dt>Workspace ID</dt><dd>{account.workspace.id}</dd></div><div><dt>Setup</dt><dd>{account.workspace.onboardingCompleted ? "Complete" : "Incomplete"}</dd></div></dl></section><section className="panel settings-content"><div className="settings-heading"><div><h2>Account security</h2><p>Update your password and sign out other active sessions.</p></div></div><div className="security-form"><Field label="Current password" required><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></Field><Field label="New password" required hint="At least 12 characters with uppercase, lowercase, a number, and a symbol."><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={12} maxLength={200} /></Field>{passwordMessage && <div className="notice notice-info" role="status"><Icon name="check" /><div><strong>Password updated</strong><span>{passwordMessage}</span></div></div>}<ActionButton variant="primary" onClick={changePassword} disabled={changingPassword || !currentPassword || !passwordValid}>{changingPassword ? "Changing password…" : "Change password"}</ActionButton></div></section></div>}
    {account && <section className="panel settings-content"><div className="settings-heading"><div><h2>Profile photo</h2><p>Shown in your studio navigation and beside your account.</p></div></div><div className="profile-photo"><Avatar name={account.user.name} imageUrl={account.user.imageUrl} size="lg" /><div><input ref={profileInputRef} id="profile-photo-upload" className="visually-hidden-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="Profile photo file" onChange={(event) => void uploadProfileImage(event)} disabled={profileProcessing} /><div className="logo-upload-actions"><ActionButton variant="secondary" onClick={() => profileInputRef.current?.click()} disabled={profileProcessing}>{profileProcessing ? "Updating…" : account.user.imageUrl ? "Replace photo" : "Choose photo"}</ActionButton>{account.user.imageUrl && <ActionButton variant="ghost" onClick={() => void persistProfileImage(null)} disabled={profileProcessing}>Remove</ActionButton>}</div><span>PNG, JPG, or WebP up to 5 MB. The saved image is resized and normalized.</span></div></div>{profileMessage && <div className="notice notice-info" role="status"><Icon name="check" /><div><strong>Profile updated</strong><span>{profileMessage}</span></div></div>}</section>}
    {account?.workspace.role !== "MEMBER" && <section className="panel settings-content">
      <div className="settings-heading"><div><h2>Booking page branding</h2><p>Set how the studio appears to your clients.</p></div></div>
      <div className="brand-editor">
        <div className="brand-form">
          <Field label="Workspace name" required><input value={branding.workspaceName} onChange={(event) => patch("workspaceName", event.target.value)} /></Field>
          <Field label="Logo" hint="Upload a PNG, JPG, or WebP up to 5 MB. We optimize it for your booking pages."><div className="upload-box">{branding.logoUrl ? <img src={branding.logoUrl} alt="Current workspace logo" className="brand-logo-thumb" /> : <div className="brand-logo-thumb brand-logo-fallback" style={{ background: branding.accentColor, color: foregroundForBackground(branding.accentColor) }}>{branding.workspaceName.charAt(0).toUpperCase() || "T"}</div>}<div><input ref={logoInputRef} id="workspace-logo-upload" className="visually-hidden-file" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadLogo(event)} disabled={logoProcessing || saving} /><div className="logo-upload-actions"><label className="button button-secondary button-sm" htmlFor="workspace-logo-upload" aria-disabled={logoProcessing || saving}>{logoProcessing ? "Preparing…" : branding.logoUrl ? "Replace image" : "Choose image"}</label>{branding.logoUrl && <button className="button button-ghost button-sm" type="button" onClick={removeLogo} disabled={logoProcessing || saving}>Remove</button>}</div><small>{logoFileName || (branding.logoUrl ? "Current saved logo" : "No logo uploaded")}</small></div></div></Field>
          <Field label="Accent color"><div className="brand-color-row" role="group" aria-label="Accent color"><input type="color" aria-label="Choose accent color" value={branding.accentColor} onChange={(event) => patch("accentColor", event.target.value)} /><input aria-label="Accent color hex value" value={branding.accentColor} onChange={(event) => patch("accentColor", event.target.value)} pattern="#[0-9A-Fa-f]{6}" /></div></Field>
          <Field label="Company description"><textarea rows={4} value={branding.description ?? ""} onChange={(event) => patch("description", event.target.value || null)} /></Field>
          <Field label="Booking page footer"><input value={branding.footerText ?? ""} onChange={(event) => patch("footerText", event.target.value || null)} /></Field>
        </div>
        <div className="brand-preview"><span>Preview</span><div className="brand-preview-card">{branding.logoUrl ? <img src={branding.logoUrl} alt={`${branding.workspaceName || "Workspace"} logo`} className="mini-logo uploaded-brand-logo" /> : <div className="mini-logo" style={{ background: branding.accentColor, color: foregroundForBackground(branding.accentColor) }}>{branding.workspaceName.charAt(0).toUpperCase() || "T"}</div>}<strong>{branding.workspaceName || "Workspace name"}</strong><h3>Booking page</h3><p>{branding.description || "Your company description will appear here."}</p><button type="button" disabled aria-label="Preview only" style={{ background: branding.accentColor, color: foregroundForBackground(branding.accentColor) }}>Select a time</button><small>{branding.footerText || "Dvision Studio"}</small></div></div>
      </div>
      <footer className="settings-footer"><ActionButton variant="primary" onClick={save} disabled={saving || !dirty || !branding.workspaceName.trim()}>{saving ? "Saving…" : dirty ? "Save settings" : "Saved"}</ActionButton></footer>
    </section>}
  </div>;
}
