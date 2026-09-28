import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import nodemailer from "nodemailer";
import { db } from "@/server/db";
import { decryptToken, encryptToken } from "@/server/crypto/tokens";
import { systemEmailIdentity, validatedMailbox } from "@/server/email-config";
import { structuredLog } from "@/server/observability";
import { renderEmailHtml, renderEmailText, type EmailBody, type EmailBrand, type EmailSection } from "@/server/services/email-template";

export type EmailKind = "EMAIL_VERIFY" | "PASSWORD_RESET" | "WORKSPACE_INVITATION" | "BOOKING_RECOVERY" | "BOOKING_CONFIRMED" | "BOOKING_RESCHEDULED" | "BOOKING_CANCELLED" | "BOOKING_REMINDER";
export type EmailDelivery = { workspaceId: string; outboxId: string; idempotencyKey: string; recipientEmail: string; subject: string; text: string; html?: string; replyTo?: string };
export interface EmailProvider { send(message: EmailDelivery, signal?: AbortSignal): Promise<void> }
export const EMAIL_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;

function tokenSecret() {
  const secret = process.env.EMAIL_TOKEN_SECRET;
  if (secret && Buffer.byteLength(secret) >= 32) return secret;
  if (process.env.NODE_ENV === "test") return "tempocove-test-only-email-token-secret-2026";
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production") return "tempocove-explicit-demo-email-token-secret-2026";
  throw new Error("EMAIL_TOKEN_SECRET with at least 32 bytes is required outside explicit demo mode.");
}

function mac(value: string) { return createHmac("sha256", tokenSecret()).update(value).digest("base64url"); }
export function createActionToken(purpose: string, binding: string, id = randomBytes(18).toString("base64url")) {
  const signature = mac(`token:v1\0${purpose}\0${id}\0${binding}`); const token = `v1.${id}.${signature}`;
  return { id, token, tokenHash: `hmac:v1:${mac(`digest:v1\0${purpose}\0${token}\0${binding}`)}` };
}
export function materializeActionToken(id: string, purpose: string, binding: string) { return createActionToken(purpose, binding, id).token; }
export function actionTokenHash(token: string, purpose: string, binding: string) { return `hmac:v1:${mac(`digest:v1\0${purpose}\0${token}\0${binding}`)}`; }
export function actionTokenId(token: string) {
  if (token.length > 500) return null; const [version, id, supplied] = token.split(".");
  return version === "v1" && id && supplied ? id : null;
}
export function tokenHashMatches(supplied: string, expected: string) {
  const left = Buffer.from(supplied); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right);
}

export function accountTokenBinding(workspaceId: string, userId: string, email: string) { return `${workspaceId}\0${userId}\0${email}`; }
export function bookingTokenBinding(workspaceId: string, bookingId: string, email: string) { return `${workspaceId}\0${bookingId}\0${email}`; }
export function invitationTokenBinding(workspaceId: string, email: string, role: string, version: number) { return `${workspaceId}\0${email}\0${role}\0${version}`; }

type Transaction = Prisma.TransactionClient;
type EnqueueEmail = { workspaceId: string; bookingId?: string; kind: EmailKind; recipientEmail: string; subject: string; payload: Record<string, unknown>; idempotencyKey: string; bookingMutationVersion?: number; nextAttemptAt?: Date };
export async function enqueueEmail(tx: Transaction, input: EnqueueEmail) {
  return tx.emailOutbox.upsert({ where: { idempotencyKey: input.idempotencyKey }, update: {}, create: {
    workspaceId: input.workspaceId, bookingId: input.bookingId, kind: input.kind, recipientEmail: input.recipientEmail.toLowerCase(),
    subjectSnapshot: input.subject, payloadJson: JSON.stringify(input.payload), idempotencyKey: input.idempotencyKey,
    bookingMutationVersion: input.bookingMutationVersion, nextAttemptAt: input.nextAttemptAt,
  } });
}

type BookingEmailSnapshot = { id: string; reference?: string | null; workspaceId: string; hostId: string; inviteeName: string; durationMinutes?: number; locationTypeSnapshot?: string; locationValueSnapshot?: string | null; inviteeEmail: string; inviteeTimeZone: string; eventTitleSnapshot: string; startAt: Date; endAt: Date; priceCents: number; currency: string; stripePaymentStatus: string | null; refundStatus?: string; mutationVersion: number; calendarProviderSnapshot?: string | null };
// The studio's own confirmation always goes out, whatever the calendar provider does. Google's invite
// is a calendar artefact: it carries no booking reference, no manage link and none of the shop's
// branding, so letting it stand in for the confirmation loses the client everything they need later.
// Two messages per booking is the accepted cost (outbox.ts no longer supersedes this one).
function locationLine(booking: BookingEmailSnapshot) {
  const value = booking.locationValueSnapshot?.trim();
  if (value) return value;
  return booking.locationTypeSnapshot === "GOOGLE_MEET" ? "Google Meet" : booking.locationTypeSnapshot === "PHONE" ? "Phone call" : "In person";
}
function clientPayload(booking: BookingEmailSnapshot, recoveryTokenId: string) {
  return { recoveryTokenId, reference: booking.reference ?? null, eventTitle: booking.eventTitleSnapshot, inviteeName: booking.inviteeName,
    startAt: booking.startAt.toISOString(), endAt: booking.endAt.toISOString(), timeZone: booking.inviteeTimeZone, durationMinutes: booking.durationMinutes ?? null,
    location: locationLine(booking), priceCents: booking.priceCents, currency: booking.currency, paymentTruth: paymentTruth(booking) };
}
function paymentTruth(booking: BookingEmailSnapshot) {
  if (booking.priceCents === 0) return "No payment required";
  if (booking.refundStatus === "REFUNDED") return "Refunded";
  if (booking.refundStatus === "REFUND_PENDING") return "Paid; refund pending";
  if (booking.refundStatus === "REFUND_FAILED") return "Paid; refund needs attention";
  return booking.stripePaymentStatus === "paid" ? "Paid" : booking.stripePaymentStatus === "paid_after_cancel" ? "Paid; refund pending" : "Payable at the shop";
}
// Where the studio's own notices are delivered, which is deliberately not the address the organizer
// signs in with. Resolved through the definer under production PostgreSQL because this runs under
// three different contexts -- public booking creation, an organizer session, and a client's
// capability link -- and no single Workspace SELECT policy spans all three; SQLite has no row level
// security and reads the column. Any failure falls back to the account address: a shop mailbox is a
// convenience, and it must never be able to stop a booking being made or cancelled.
type MailboxReader = Pick<Transaction, "$queryRawUnsafe" | "workspace">;
async function studioNotificationMailbox(client: MailboxReader, workspaceId: string, accountEmail: string) {
  try {
    const configured = process.env.DATABASE_PROVIDER === "postgresql" && process.env.NODE_ENV === "production"
      ? (await client.$queryRawUnsafe<Array<{ email: string | null }>>("SELECT tempocove_workspace_notification_email($1::text) AS email", workspaceId))[0]?.email
      : (await client.workspace.findUnique({ where: { id: workspaceId }, select: { notificationEmail: true } }))?.notificationEmail;
    const trimmed = (configured || "").trim();
    return trimmed ? validatedMailbox(trimmed) : accountEmail;
  } catch (error) {
    structuredLog("warn", { event: "email.studio_mailbox_unavailable", code: failureCode(error) });
    return accountEmail;
  }
}

export async function enqueueBookingEmail(tx: Transaction, booking: BookingEmailSnapshot, kind: "BOOKING_CONFIRMED" | "BOOKING_RESCHEDULED" | "BOOKING_CANCELLED", now = new Date()) {
  await tx.bookingRecoveryToken.updateMany({ where: { bookingId: booking.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
  const expiresAt = new Date(Math.max(now.getTime() + 7 * 24 * 60 * 60_000, booking.endAt.getTime() + 30 * 24 * 60 * 60_000));
  const id = randomBytes(18).toString("base64url"); const binding = bookingTokenBinding(booking.workspaceId, booking.id, booking.inviteeEmail.toLowerCase());
  const authority = createActionToken("BOOKING_RECOVERY", binding, id);
  await tx.bookingRecoveryToken.create({ data: { id, workspaceId: booking.workspaceId, bookingId: booking.id, email: booking.inviteeEmail.toLowerCase(), tokenHash: authority.tokenHash, expiresAt } });
  const action = kind === "BOOKING_CANCELLED" ? "Your appointment is canceled" : kind === "BOOKING_RESCHEDULED" ? "Your appointment has moved" : "You’re booked";
  await enqueueEmail(tx, { workspaceId: booking.workspaceId, bookingId: booking.id, kind, recipientEmail: booking.inviteeEmail, subject: `${action}: ${booking.eventTitleSnapshot}`,
    payload: clientPayload(booking, id),
    idempotencyKey: `email:booking:${kind}:${booking.id}:${booking.mutationVersion}`, bookingMutationVersion: booking.mutationVersion });
  const host = await tx.user.findUnique({ where: { id: booking.hostId }, select: { email: true, timeZone: true } });
  if (host) {
    const organizerAction = kind === "BOOKING_CANCELLED" ? "Appointment canceled" : kind === "BOOKING_RESCHEDULED" ? "Appointment moved" : "New appointment";
    const studioMailbox = await studioNotificationMailbox(tx, booking.workspaceId, host.email);
    await enqueueEmail(tx, { workspaceId: booking.workspaceId, bookingId: booking.id, kind, recipientEmail: studioMailbox, subject: `${organizerAction}: ${booking.eventTitleSnapshot}`,
      payload: { audience: "organizer", hostId: booking.hostId, inviteeName: booking.inviteeName, inviteeEmail: booking.inviteeEmail, eventTitle: booking.eventTitleSnapshot, startAt: booking.startAt.toISOString(), timeZone: host.timeZone, priceCents: booking.priceCents, currency: booking.currency, paymentTruth: paymentTruth(booking) },
      idempotencyKey: `email:booking:organizer:${kind}:${booking.id}:${booking.mutationVersion}`, bookingMutationVersion: booking.mutationVersion });
  }
}

export function bookingReminderLeadMs() {
  const hours = Number(process.env.BOOKING_REMINDER_LEAD_HOURS || "24");
  return (Number.isFinite(hours) && hours >= 1 && hours <= 168 ? hours : 24) * 60 * 60_000;
}
// Scheduled delivery rides the existing claim query: a future nextAttemptAt is simply not picked up until due.
export async function enqueueBookingReminder(tx: Transaction, booking: BookingEmailSnapshot, now = new Date()) {
  const sendAt = new Date(booking.startAt.getTime() - bookingReminderLeadMs());
  // Under one hour of lead the confirmation email IS the reminder; enqueueing would fire it immediately after.
  if (sendAt.getTime() <= now.getTime() + 60 * 60_000) return;
  const id = randomBytes(18).toString("base64url"); const binding = bookingTokenBinding(booking.workspaceId, booking.id, booking.inviteeEmail.toLowerCase());
  const authority = createActionToken("BOOKING_RECOVERY", binding, id);
  const expiresAt = new Date(Math.max(now.getTime() + 7 * 24 * 60 * 60_000, booking.endAt.getTime() + 30 * 24 * 60 * 60_000));
  await tx.bookingRecoveryToken.create({ data: { id, workspaceId: booking.workspaceId, bookingId: booking.id, email: booking.inviteeEmail.toLowerCase(), tokenHash: authority.tokenHash, expiresAt } });
  await enqueueEmail(tx, { workspaceId: booking.workspaceId, bookingId: booking.id, kind: "BOOKING_REMINDER", recipientEmail: booking.inviteeEmail, subject: `See you soon: ${booking.eventTitleSnapshot}`,
    payload: clientPayload(booking, id),
    idempotencyKey: `email:booking:REMINDER:${booking.id}:${booking.mutationVersion}`, bookingMutationVersion: booking.mutationVersion, nextAttemptAt: sendAt });
}
// Called inside the cancel and reschedule transactions so a client who cancels is never reminded to attend.
export async function supersedeBookingReminders(tx: Transaction, bookingId: string, now = new Date()) {
  await tx.emailOutbox.updateMany({ where: { bookingId, kind: "BOOKING_REMINDER", status: { in: ["PENDING", "RETRY"] } }, data: { status: "SUPERSEDED", completedAt: now, leaseToken: null, leaseExpiresAt: null, lastErrorCode: "REMINDER_SUPERSEDED" } });
}

export function appBaseUrl() {
  const value = process.env.NEXT_PUBLIC_APP_URL || (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : "");
  const url = new URL(value); if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("Production email links require canonical HTTPS NEXT_PUBLIC_APP_URL.");
  return url.origin;
}
function money(cents: number, currency: string) { return cents === 0 ? "Free" : new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100); }
// Prices are display-only, so a free service says nothing at all rather than "Free. Payment: none".
function priceLine(payload: Record<string, unknown>) {
  const cents = Number(payload.priceCents);
  return cents > 0 ? ` ${money(cents, String(payload.currency))} — ${String(payload.paymentTruth).toLowerCase()}.` : "";
}
// en-GB, not the default en-US: an Amsterdam shop writes "Thursday 2 April 2099 at 14:00", and a
// client reading "2:00 PM" has to translate it. DATETIME_HUGE carries the weekday, which is the part
// of an appointment people actually check.
function bookingTime(startAt: string, timeZone: string) { return DateTime.fromISO(startAt).setZone(timeZone).setLocale("en-GB").toFormat("cccc d LLLL yyyy 'at' HH:mm (ZZZZ)"); }

async function render(row: { kind: string; workspaceId: string; bookingId: string | null; recipientEmail: string; subjectSnapshot: string; payloadJson: string }, at = new Date()) {
  const payload = JSON.parse(row.payloadJson) as Record<string, unknown>; const base = appBaseUrl();
  if (row.kind === "EMAIL_VERIFY" || row.kind === "PASSWORD_RESET") {
    const record = await db.accountActionToken.findUnique({ where: { id: String(payload.tokenId) } });
    if (!record || record.workspaceId !== row.workspaceId || record.email !== row.recipientEmail || record.consumedAt || record.revokedAt || record.expiresAt <= at) return null;
    const binding = accountTokenBinding(record.workspaceId, record.userId, record.email); const token = materializeActionToken(record.id, record.purpose, binding);
    if (!tokenHashMatches(actionTokenHash(token, record.purpose, binding), record.tokenHash)) return null;
    const path = row.kind === "EMAIL_VERIFY" ? "/verify-email" : "/reset-password";
    return { subject: row.subjectSnapshot, text: `${row.kind === "EMAIL_VERIFY" ? "Verify your Dvision Studio email" : "Reset your Dvision Studio password"}: ${base}${path}#token=${encodeURIComponent(token)}` };
  }
  if (row.kind === "WORKSPACE_INVITATION") {
    const invitation = await db.workspaceInvitation.findUnique({ where: { id: String(payload.invitationId) } });
    if (!invitation || invitation.workspaceId !== row.workspaceId || invitation.email !== row.recipientEmail || invitation.status !== "PENDING" || invitation.expiresAt <= at || invitation.tokenVersion !== Number(payload.tokenVersion) || !invitation.tokenHash) return null;
    const binding = invitationTokenBinding(invitation.workspaceId, invitation.email, invitation.role, invitation.tokenVersion); const token = materializeActionToken(invitation.id, "WORKSPACE_INVITATION", binding);
    if (!tokenHashMatches(actionTokenHash(token, "WORKSPACE_INVITATION", binding), invitation.tokenHash)) return null;
    return { subject: row.subjectSnapshot, text: `You were invited to ${String(payload.workspaceName)} as ${invitation.role}. Accept: ${base}/invite/accept#token=${encodeURIComponent(token)}` };
  }
  if (payload.audience === "organizer") {
    if (!row.bookingId) return null;
    const booking = await db.booking.findFirst({ where: { id: row.bookingId, workspaceId: row.workspaceId, hostId: String(payload.hostId) }, select: { host: { select: { email: true } } } });
    if (!booking) return null;
    const expected = await studioNotificationMailbox(db, row.workspaceId, booking.host.email);
    if (expected.toLowerCase() !== row.recipientEmail.toLowerCase()) return null;
    const action = row.kind === "BOOKING_CANCELLED" ? "canceled" : row.kind === "BOOKING_RESCHEDULED" ? "moved" : "booked";
    return { subject: row.subjectSnapshot, text: `${String(payload.inviteeName)} (${String(payload.inviteeEmail)}) ${action} ${String(payload.eventTitle)}. ${bookingTime(String(payload.startAt), String(payload.timeZone))}.${priceLine(payload)} Open in your dashboard: ${base}/bookings?selected=${encodeURIComponent(row.bookingId)}`, replyTo: String(payload.inviteeEmail) };
  }
  const recovery = await db.bookingRecoveryToken.findUnique({ where: { id: String(payload.recoveryTokenId) } });
  if (!recovery || recovery.workspaceId !== row.workspaceId || recovery.bookingId !== row.bookingId || recovery.email !== row.recipientEmail || recovery.consumedAt || recovery.revokedAt || recovery.expiresAt <= at) return null;
  const binding = bookingTokenBinding(recovery.workspaceId, recovery.bookingId, recovery.email); const token = materializeActionToken(recovery.id, "BOOKING_RECOVERY", binding);
  if (!tokenHashMatches(actionTokenHash(token, "BOOKING_RECOVERY", binding), recovery.tokenHash)) return null;
  // Both links carry the same one-use token. Whichever the client opens first consumes it and sets the
  // per-booking manage cookie; the other page then finds the token spent but the cookie valid, which
  // both RescheduleBookingView and CancelBookingView accept.
  const fragment = `#recovery=${encodeURIComponent(token)}`;
  const links: ClientLinks = { reschedule: `${base}/manage/${recovery.bookingId}/reschedule${fragment}`, cancel: `${base}/manage/${recovery.bookingId}/cancel${fragment}`, book: `${base}/book` };
  // A recovery mail carries only its token id, so the appointment it refers to is read here rather than
  // snapshotted at enqueue time. A booking email carries its own snapshot and needs no second read.
  const detail = await db.booking.findFirst({ where: { id: recovery.bookingId, workspaceId: row.workspaceId }, select: { status: true, reference: true, eventTitleSnapshot: true, inviteeName: true, inviteeTimeZone: true, startAt: true, endAt: true, durationMinutes: true, locationTypeSnapshot: true, locationValueSnapshot: true, priceCents: true, currency: true, stripePaymentStatus: true, refundStatus: true } });
  if (!detail) return null;
  // A reminder for an appointment that is no longer on is worse than no reminder at all.
  if (row.kind === "BOOKING_REMINDER" && detail.status !== "CONFIRMED") return null;
  const { status: ignoredStatus, ...current } = detail; void ignoredStatus;
  const view = row.kind === "BOOKING_RECOVERY"
    ? clientPayload({ ...current, id: recovery.bookingId, workspaceId: row.workspaceId, hostId: "", inviteeEmail: recovery.email, mutationVersion: 0 }, recovery.id)
    : payload;
  const brand = await brandFor(row.workspaceId);
  return { subject: row.subjectSnapshot, ...renderClientEmail(brand, row.kind, view, links, at) };
}

export function failureCode(error: unknown) {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const candidate = error as { code?: unknown; meta?: { code?: unknown }; name?: unknown };
  const code = candidate.meta?.code ?? candidate.code;
  if (typeof code === "string" || typeof code === "number") return String(code);
  return typeof candidate.name === "string" && candidate.name ? candidate.name : "UNKNOWN";
}

// Branding is decoration; delivery is not. On 2026-09-13 the worker had no SELECT grant on
// WorkspaceBranding, so this read raised insufficient_privilege and every client email retried to
// DEAD over a hex colour, while the organizer copy -- whose branch returns before this point -- went
// out fine. The grant is fixed, but a cosmetic read must never be able to hold a confirmation again.
// The sign-off is the owner's own name, read through the branding row's user: the worker holds
// SELECT(name) on "User" and a reference policy on both tables (postgres-guards.sql).
async function brandFor(workspaceId: string): Promise<EmailBrand> {
  try {
    const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true, branding: { select: { workspaceName: true, footerText: true, user: { select: { name: true } } } } } });
    const name = workspace?.branding?.workspaceName || workspace?.name || STUDIO;
    return { name, signature: workspace?.branding?.user.name || name, footerText: workspace?.branding?.footerText ?? null };
  } catch (error) {
    structuredLog("warn", { event: "email.branding_unavailable", code: failureCode(error) });
    return { name: STUDIO, signature: STUDIO, footerText: null };
  }
}

type ClientLinks = { reschedule: string; cancel: string; book: string };
const STUDIO = "Dvision Studio";
// The client's line reads as a person would write it: "Thursday 8 October at 12:00". The year is added
// only when the appointment falls in a different year from the day the mail is sent, and the zone only
// when the client booked in one other than the studio's, so an Amsterdam client never sees "(CEST)".
function clientTime(startAt: string, timeZone: string, at: Date) {
  const start = DateTime.fromISO(startAt).setZone(timeZone).setLocale("en-GB");
  const year = start.year === DateTime.fromJSDate(at).setZone(timeZone).year ? "" : " yyyy";
  const zone = timeZone === "Europe/Amsterdam" ? "" : " (ZZZZ)";
  return start.toFormat(`cccc d LLLL${year} 'at' HH:mm${zone}`);
}
// "★ Haircut": the star marks the service in every sentence that names it. A barber who already put
// one in the service name keeps theirs rather than getting two.
function starred(title: string) { return title.startsWith("★") ? title : `★ ${title}`; }
function clientFootnote(payload: Record<string, unknown>) {
  const parts: string[] = [];
  if (payload.reference) parts.push(`Booking reference ${String(payload.reference)}`);
  const minutes = Number(payload.durationMinutes);
  if (Number.isFinite(minutes) && minutes > 0) parts.push(`${minutes} minutes`);
  const cents = Number(payload.priceCents);
  if (cents > 0) parts.push(`${money(cents, String(payload.currency))}, ${String(payload.paymentTruth).toLowerCase()}`);
  return parts.length ? parts.join(" · ") : undefined;
}

// The studio's own words, as the barber writes them: the sections are what make the mail read as a
// welcome rather than a receipt.
function experience(studio: string): EmailSection {
  return { heading: "The Experience", lines: [`At ${studio.toUpperCase()}, this is more than just a haircut.`, "You’re stepping into a premium grooming experience — precision cuts, attention to detail, and a clean, high-end atmosphere designed to make you look and feel your best."] };
}
const ARRIVAL: EmailSection = { heading: "Arrival", lines: ["Please arrive on time to ensure the full experience without rush.", "If you need to reschedule, you can do it easily using the link below."] };
const CLOSING = "I truly appreciate your trust and look forward to seeing you.";
function clientBody(brand: EmailBrand, kind: string, payload: Record<string, unknown>, links: ClientLinks, at: Date): EmailBody {
  const service = starred(String(payload.eventTitle)); const when = clientTime(String(payload.startAt), String(payload.timeZone), at);
  const first = String(payload.inviteeName || "").trim().split(/\s+/)[0];
  const greeting = first ? `Hey ${first},` : "Hey there,";
  const location = payload.location ? String(payload.location) : undefined;
  const manage = [{ label: "Reschedule appointment", href: links.reschedule }, { label: "Cancel appointment", href: links.cancel }];
  const footnote = clientFootnote(payload);
  if (kind === "BOOKING_CANCELLED") return {
    preheader: `Canceled — was ${when}`, greeting, summary: `Your appointment for ${service} on ${when} has been canceled.`,
    sections: [{ heading: "What happens next", lines: ["Nothing further is needed from you.", "Whenever you’re ready, you can book a new appointment using the link below."] }],
    closing: "I hope to see you again soon.", links: [{ label: "Book another appointment", href: links.book }], footnote,
  };
  if (kind === "BOOKING_RESCHEDULED") return {
    preheader: `Moved to ${when}`, greeting, summary: `Your appointment for ${service} has moved to ${when}.`, location,
    sections: [{ heading: "What changed", lines: ["Only the time. Your service, the studio and everything else stay the same."] }, ARRIVAL],
    closing: CLOSING, links: manage, footnote,
  };
  if (kind === "BOOKING_REMINDER") return {
    preheader: location ? `${when} — ${location}` : when, greeting, summary: `Your appointment for ${service} is coming up on ${when}.`, location,
    sections: [ARRIVAL], closing: CLOSING, links: manage, footnote,
  };
  if (kind === "BOOKING_RECOVERY") return {
    preheader: "Your link to reschedule or cancel", greeting, summary: `Here is the link to manage your appointment for ${service} on ${when}.`, location,
    sections: [{ heading: "Managing your appointment", lines: ["Use the links below to reschedule or cancel.", "If you didn’t ask for this email, you can safely ignore it."] }],
    closing: "I look forward to seeing you.", links: manage, footnote,
  };
  return {
    preheader: location ? `${when} — ${location}` : when, greeting, summary: `Your appointment for ${service} is confirmed for ${when}.`, location,
    sections: [experience(brand.name), ARRIVAL], closing: CLOSING, links: manage, footnote,
  };
}
function renderClientEmail(brand: EmailBrand, kind: string, payload: Record<string, unknown>, links: ClientLinks, at: Date) {
  const body = clientBody(brand, kind, payload, links, at);
  return { text: renderEmailText(brand, body), html: renderEmailHtml(brand, body) };
}

export class LocalInboxEmailProvider implements EmailProvider {
  async send(message: EmailDelivery) {
    if (process.env.NODE_ENV === "production" || process.env.DEMO_MODE !== "true" || process.env.EMAIL_PROVIDER !== "local") throw new Error("LOCAL_EMAIL_PROVIDER_DISABLED");
    const encryptedText = encryptToken(message.text); if (!encryptedText) throw new Error("LOCAL_EMAIL_ENCRYPTION_REQUIRED");
    await db.localInboxMessage.upsert({ where: { outboxId: message.outboxId }, update: {}, create: { workspaceId: message.workspaceId, outboxId: message.outboxId, recipientEmail: message.recipientEmail, subject: message.subject, encryptedText } });
  }
}
export class SmtpEmailProvider implements EmailProvider {
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;
  private readonly from: string;
  private readonly systemReplyTo: string;
  private readonly senderDomain: string;
  constructor() {
    const required = ["SMTP_HOST","SMTP_PORT","SMTP_USER","SMTP_PASSWORD","EMAIL_FROM","EMAIL_REPLY_TO","EMAIL_SENDER_DOMAIN","SMTP_TLS_MODE"];
    if (required.some((name) => !process.env[name])) throw new Error("SMTP_CONFIGURATION_INCOMPLETE");
    const port = Number(process.env.SMTP_PORT); const timeout = Number(process.env.SMTP_TIMEOUT_MS || 8_000);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || !Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 10_000) throw new Error("SMTP_CONFIGURATION_INVALID");
    const mode = process.env.SMTP_TLS_MODE; if (mode !== "implicit" && mode !== "starttls") throw new Error("SMTP_CONFIGURATION_INVALID");
    const allowSelfSigned = process.env.NODE_ENV === "test" && process.env.SMTP_ALLOW_SELF_SIGNED === "true";
    const identity = systemEmailIdentity(); this.systemReplyTo = identity.replyTo; this.from = identity.from; this.senderDomain = identity.senderDomain;
    this.transport = nodemailer.createTransport({ host: process.env.SMTP_HOST!, port, secure: mode === "implicit", requireTLS: mode === "starttls", auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASSWORD! }, connectionTimeout: timeout, greetingTimeout: timeout, socketTimeout: timeout, tls: { rejectUnauthorized: !allowSelfSigned } });
  }
  async send(message: EmailDelivery, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("SMTP_DELIVERY_ABORTED");
    const identity = createHash("sha256").update(`tempocove-email-v1\0${message.idempotencyKey}`).digest("hex");
    await this.transport.sendMail({ from: this.from, to: validatedMailbox(message.recipientEmail), replyTo: validatedMailbox(message.replyTo || this.systemReplyTo), subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}), messageId: `<${identity}@${this.senderDomain}>`, headers: { "X-SnagTime-Dedupe": identity } });
    // Once SMTP acknowledges the deterministic message id, commit SENT even if shutdown starts.
    // Retrying after an accepted response would create a duplicate external delivery.
  }
}
export function getEmailProvider(): EmailProvider { return process.env.EMAIL_PROVIDER === "smtp" ? new SmtpEmailProvider() : new LocalInboxEmailProvider(); }

async function tokenStillCurrent(row: { kind: string; workspaceId: string; bookingId: string | null; recipientEmail: string; payloadJson: string }, at: Date) { return Boolean(await render({ ...row, subjectSnapshot: "" }, at)); }
export async function processEmailOutbox(workspaceId?: string, now = new Date(), provider: EmailProvider = getEmailProvider(), signal?: AbortSignal) {
  const due = await db.emailOutbox.findMany({ where: { workspaceId, OR: [{ status: { in: ["PENDING","RETRY"] }, nextAttemptAt: { lte: now } }, { status: "PROCESSING", leaseExpiresAt: { lte: now } }] }, orderBy: { createdAt: "asc" }, take: 50 });
  let attempted = 0;
  for (const candidate of due) {
    if (signal?.aborted) break;
    const leaseToken = randomBytes(18).toString("base64url");
    const claimed = await db.emailOutbox.updateMany({ where: { id: candidate.id, OR: [{ status: { in: ["PENDING","RETRY"] }, nextAttemptAt: { lte: now } }, { status: "PROCESSING", leaseExpiresAt: { lte: now } }] }, data: { status: "PROCESSING", leaseToken, leaseExpiresAt: new Date(now.getTime() + EMAIL_LEASE_MS), attemptCount: { increment: 1 } } });
    if (claimed.count !== 1) continue; attempted += 1;
    if (signal?.aborted) { await db.emailOutbox.updateMany({ where: { id: candidate.id, leaseToken, status: "PROCESSING" }, data: { status: "RETRY", attemptCount: { decrement: 1 }, nextAttemptAt: now, leaseToken: null, leaseExpiresAt: null, lastErrorCode: "WORKER_STOPPED" } }); break; }
    const row = await db.emailOutbox.findFirstOrThrow({ where: { id: candidate.id, leaseToken, status: "PROCESSING" } });
    try {
      if (row.bookingId && row.bookingMutationVersion != null) {
        const booking = await db.booking.findFirst({ where: { id: row.bookingId, workspaceId: row.workspaceId }, select: { mutationVersion: true } });
        if (!booking || booking.mutationVersion !== row.bookingMutationVersion) { await db.emailOutbox.updateMany({ where: { id: row.id, leaseToken, status: "PROCESSING" }, data: { status: "SUPERSEDED", leaseToken: null, leaseExpiresAt: null, completedAt: now, lastErrorCode: "STALE_BOOKING_VERSION" } }); continue; }
      }
      if (!await tokenStillCurrent(row, now)) { await db.emailOutbox.updateMany({ where: { id: row.id, leaseToken, status: "PROCESSING" }, data: { status: "SUPERSEDED", leaseToken: null, leaseExpiresAt: null, completedAt: now, lastErrorCode: "AUTHORITY_NOT_CURRENT" } }); continue; }
      const rendered = await render(row, now); if (!rendered) throw new Error("EMAIL_AUTHORITY_NOT_CURRENT");
      if (signal?.aborted) throw new Error("EMAIL_WORKER_STOPPING");
      const replyTo = rendered.replyTo || (process.env.EMAIL_REPLY_TO ? validatedMailbox(process.env.EMAIL_REPLY_TO) : undefined);
      await provider.send({ workspaceId: row.workspaceId, outboxId: row.id, idempotencyKey: row.idempotencyKey, recipientEmail: row.recipientEmail, ...rendered, replyTo }, signal);
      await db.emailOutbox.updateMany({ where: { id: row.id, leaseToken, status: "PROCESSING" }, data: { status: "COMPLETED", completedAt: now, leaseToken: null, leaseExpiresAt: null, lastErrorCode: null } });
    } catch (error) {
      if (signal?.aborted) await db.emailOutbox.updateMany({ where: { id: row.id, leaseToken, status: "PROCESSING" }, data: { status: "RETRY", attemptCount: { decrement: 1 }, nextAttemptAt: now, leaseToken: null, leaseExpiresAt: null, lastErrorCode: "WORKER_STOPPED" } });
      else { const attempt = row.attemptCount;
        structuredLog("warn", { event: "email.delivery_failed", kind: row.kind, code: failureCode(error), dead: attempt >= MAX_ATTEMPTS }); await db.emailOutbox.updateMany({ where: { id: row.id, leaseToken, status: "PROCESSING" }, data: { status: attempt >= MAX_ATTEMPTS ? "DEAD" : "RETRY", nextAttemptAt: new Date(now.getTime() + Math.min(60 * 60_000, 2 ** Math.min(attempt, 10) * 1_000)), leaseToken: null, leaseExpiresAt: null, lastErrorCode: "DELIVERY_FAILED" } }); }
    }
  }
  return { attempted, pending: await db.emailOutbox.count({ where: { workspaceId, status: { in: ["PENDING","RETRY","PROCESSING"] } } }) };
}

export async function listLocalInbox(workspaceId: string) {
  if (process.env.NODE_ENV === "production" || process.env.DEMO_MODE !== "true" || process.env.EMAIL_PROVIDER !== "local") throw new Error("LOCAL_INBOX_DISABLED");
  const rows = await db.localInboxMessage.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 100 });
  return rows.map((row) => ({ id: row.id, recipientEmail: row.recipientEmail, subject: row.subject, text: decryptToken(row.encryptedText) || "", createdAt: row.createdAt.toISOString() }));
}
