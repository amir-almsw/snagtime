import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import type { BookingManageCapabilities, CreateBookingInput, CreateBookingResult, ResumeBookingCheckoutResult } from "@/lib/contracts";
import { capabilityRows, materializeCapabilities, newCapabilityIdentity } from "@/server/auth/capabilities";
import { db } from "@/server/db";
import { AppError, conflict, notFound } from "@/server/errors";
import { mapBooking } from "@/server/mappers";
import { generateSlots, getAvailability, type BusyInterval } from "@/server/services/availability";
import { getCalendarService, providerCalendarEventId, type CalendarService } from "@/server/services/calendar";
import { getEventTypeBySlug, getEventTypeForSlotsBySlug } from "@/server/services/event-types";
import { currentDatabaseContext, enterDatabaseAction, enterDatabaseContext, enterPublicBookingDatabaseContext, enterPublicDatabaseContext } from "@/server/db-context";
import { processBookingOutbox } from "@/server/services/outbox";
import { shouldDrainOutboxInline } from "@/server/services/outbox-dispatch";
import { getPaymentService, type PaymentService } from "@/server/services/payments";
import { enqueueBookingEmail, enqueueBookingReminder, supersedeBookingReminders } from "@/server/services/notifications";
import { boundedPrismaTransactionOptions, withDatabaseTransactionRetry } from "@/server/database-retry";
import { generateBookingReference } from "@/server/services/booking-reference";
import { structuredLog } from "@/server/observability";

const activeStatuses = ["CONFIRMED", "PENDING_PAYMENT"];
function providerErrorCode(error: unknown) { return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code || "") : ""; }
// SQLite reports the constraint name ("Booking_reference_key") and PostgreSQL the field list, so this
// flattens both to one string the caller can substring-match rather than comparing shapes.
function providerErrorTarget(error: unknown) { const meta = typeof error === "object" && error !== null && "meta" in error ? (error as { meta?: { target?: unknown } }).meta : undefined; return String(meta?.target ?? ""); }
const MAX_VALIDATED_BOOKING_BUFFER_MINUTES = 240;
const bookingInclude = { eventType: { select: { name: true } }, host: { select: { name: true } }, answers: true } as const;
export type InternalCreateBookingResult = { booking: ReturnType<typeof mapBooking>; checkoutUrl: string | null; checkoutState: CreateBookingResult["checkoutState"]; manageCapabilities: BookingManageCapabilities | null };

export async function listBookings(workspaceId: string) {
  return (await db.booking.findMany({ where: { workspaceId }, include: bookingInclude, orderBy: { startAt: "asc" } })).map(mapBooking);
}

export async function getBookingForHost(workspaceId: string, id: string) {
  const booking = await db.booking.findFirst({ where: { id, workspaceId }, include: bookingInclude });
  if (!booking) throw notFound("Booking");
  return mapBooking(booking);
}

export async function getBookingDetail(id: string) {
  const booking = await db.booking.findUnique({ where: { id }, include: bookingInclude });
  if (!booking) throw notFound("Booking");
  return mapBooking(booking);
}

export async function listManageRescheduleSlots(id: string, from: Date, to: Date, outputTimeZone: string, durationId?: string, calendar: CalendarService = getCalendarService()) {
  const booking = await db.booking.findUnique({ where: { id }, include: { eventType: { select: { slug: true } } } });
  if (!booking || booking.status !== "CONFIRMED") throw notFound("Booking");
  if (booking.calendarProviderSnapshot === "provider_recovery_required") throw new AppError("CALENDAR_PROVIDER_RECOVERY_REQUIRED", "Reconcile this upgraded booking's calendar provider before rescheduling.", 503);
  const providerEventId = booking.externalCalendarEventId ?? (booking.calendarProviderSnapshot === "google" ? providerCalendarEventId(booking.id) : undefined);
  const slots = await listPublicSlots(booking.eventType.slug, from, to, outputTimeZone, calendar, durationId ?? booking.durationId ?? undefined, id, true, true, providerEventId, booking.bookingWindowDays, booking.durationMinutes, booking.bufferBeforeMinutes, booking.bufferAfterMinutes, booking.calendarProviderSnapshot === "google" ? "google" : "local");
  return slots.filter((slot) => new Date(slot.start).getTime() !== booking.startAt.getTime());
}

// The host's booked time is read from the database on every slot request, so a confirmed appointment
// leaves the booking page immediately, before any calendar mirror catches up. In production no public
// policy exposes another client's Booking row, so the read goes through the tempocove_public_host_busy
// definer function, which returns only buffered (start, end) ranges for the event's host and never a
// row: client names and emails stay off the public surface. SQLite has no RLS and reads the rows.
export async function hostBookedIntervals(eventType: { id: string; workspaceId: string; ownerId: string }, from: Date, to: Date, excludeBookingId?: string): Promise<BusyInterval[]> {
  if (process.env.DATABASE_PROVIDER === "postgresql" && process.env.NODE_ENV === "production") {
    const rows = await db.$queryRawUnsafe<Array<{ busy_start: Date | string; busy_end: Date | string }>>("SELECT busy_start,busy_end FROM tempocove_public_host_busy($1::text,$2::timestamp,$3::timestamp,$4::text)", eventType.id, from.toISOString(), to.toISOString(), excludeBookingId ?? "");
    return rows.map((row) => ({ start: new Date(row.busy_start), end: new Date(row.busy_end) }));
  }
  const rangeStart = DateTime.fromJSDate(from).minus({ minutes: MAX_VALIDATED_BOOKING_BUFFER_MINUTES }).toJSDate();
  const rangeEnd = DateTime.fromJSDate(to).plus({ minutes: MAX_VALIDATED_BOOKING_BUFFER_MINUTES }).toJSDate();
  const bookings = await db.booking.findMany({
    where: { id: excludeBookingId ? { not: excludeBookingId } : undefined, workspaceId: eventType.workspaceId, hostId: eventType.ownerId, status: { in: activeStatuses }, startAt: { lt: rangeEnd }, endAt: { gt: rangeStart } },
    select: { startAt: true, endAt: true, bufferBeforeMinutes: true, bufferAfterMinutes: true },
  });
  return bookings.map((item) => ({ start: DateTime.fromJSDate(item.startAt).minus({ minutes: item.bufferBeforeMinutes }).toJSDate(), end: DateTime.fromJSDate(item.endAt).plus({ minutes: item.bufferAfterMinutes }).toJSDate() }));
}

export async function listPublicSlots(slug: string, from: Date, to: Date, outputTimeZone: string, calendar: CalendarService = getCalendarService(), durationId?: string, excludeBookingId?: string, allowInactiveDuration = false, allowInactiveEvent = false, excludeProviderEventId?: string, bookingWindowDaysOverride?: number, durationMinutesOverride?: number, bufferBeforeOverride?: number, bufferAfterOverride?: number, busyProviderOverride?: "google" | "local") {
  const eventType = await getEventTypeForSlotsBySlug(slug, !allowInactiveEvent);
  // getEventTypeForSlotsBySlug enters a slug-only context before its first await -- which does reach us,
  // replacing whatever the caller had -- and then re-enters the full one after that await, where it is
  // discarded the moment it returns (see db-context.ts). So without this line we resume holding a context
  // whose workspace id is empty, and tempocove_public_host_busy below, which matches the event on
  // e."workspaceId"=current_setting('tempocove.workspace_id'), finds nothing. It returns zero rows rather
  // than an error, so every booked slot silently stayed on the public list. Entered in this function's own
  // frame so hostBookedIntervals and the duration lookup below both see it.
  enterPublicDatabaseContext(slug, eventType.workspaceId, eventType.id);
  const duration = (durationId ? eventType.durations.find((item) => item.id === durationId) : eventType.durations.find((item) => item.isDefault))
    ?? (durationId && allowInactiveDuration ? await db.eventDuration.findFirst({ where: { id: durationId, eventTypeId: eventType.id } }) : null);
  if (!duration) throw notFound("Duration option");
  const effectiveBufferBefore = bufferBeforeOverride ?? eventType.bufferBeforeMinutes; const effectiveBufferAfter = bufferAfterOverride ?? eventType.bufferAfterMinutes;
  const providerFrom = DateTime.fromJSDate(from).minus({ minutes: effectiveBufferBefore }).toJSDate();
  const providerTo = DateTime.fromJSDate(to).plus({ minutes: effectiveBufferAfter }).toJSDate();
  const providerBusyRequest = async (): Promise<BusyInterval[]> => {
    // Promise branches get their own signed public context so another contextual
    // Prisma transaction cannot leave provider readiness workspace-less.
    enterPublicDatabaseContext(slug, eventType.workspaceId, eventType.id);
    try {
      return await ((excludeProviderEventId || busyProviderOverride) && calendar.getBusyIntervalsExcludingEvent
        ? calendar.getBusyIntervalsExcludingEvent(eventType.ownerId, providerFrom, providerTo, excludeProviderEventId ?? "__tempocove_no_excluded_event__", busyProviderOverride, eventType.workspaceId)
        : calendar.getBusyIntervals(eventType.ownerId, providerFrom, providerTo, eventType.workspaceId));
    } catch (error) {
      // The database is the authority for the schedule and for booked time. Provider busy time only adds
      // blocks the host typed straight into Google Calendar, so a provider failure is logged and the slots
      // are served from the database rather than taking the booking page down with it.
      structuredLog("warn", { event: "provider_busy_unavailable", kind: "public_slots", code: providerErrorCode(error) || (error instanceof Error ? error.message : "UNKNOWN") });
      return [];
    }
  };
  const [schedule, booked, providerBusy] = await Promise.all([
    getAvailability(eventType.workspaceId, eventType.ownerId, eventType.owner.timeZone, { from, to }),
    hostBookedIntervals(eventType, providerFrom, providerTo, excludeBookingId),
    providerBusyRequest(),
  ]);
  return generateSlots({
    eventType: { ...eventType, bookingWindowDays: bookingWindowDaysOverride ?? eventType.bookingWindowDays, durationId: duration.id, durationMinutes: durationMinutesOverride ?? duration.durationMinutes, bufferBeforeMinutes: effectiveBufferBefore, bufferAfterMinutes: effectiveBufferAfter, priceCents: duration.priceCents, currency: duration.currency },
    schedule,
    busy: [...booked, ...providerBusy],
    from, to, outputTimeZone,
  });
}

export function occupiedMinutes(start: Date, end: Date, beforeMinutes: number, afterMinutes: number) {
  const first = DateTime.fromJSDate(start).minus({ minutes: beforeMinutes }).startOf("minute");
  const last = DateTime.fromJSDate(end).plus({ minutes: afterMinutes }).startOf("minute");
  const minutes: Date[] = [];
  for (let cursor = first; cursor < last; cursor = cursor.plus({ minutes: 1 })) minutes.push(cursor.toJSDate());
  return minutes;
}

async function priorResult(slug: string, idempotencyKey: string, requestFingerprint: string): Promise<InternalCreateBookingResult | null> {
  const prior = await db.booking.findFirst({ where: { idempotencyKey, eventType: { slug } }, include: bookingInclude });
  if (!prior) return null;
  if (prior.requestFingerprint !== requestFingerprint) throw conflict("That idempotency key was already used for a different booking request.");
  const activeCapabilities = await db.bookingCapability.count({ where: { bookingId: prior.id, revokedAt: null, expiresAt: { gt: new Date() } } });
  return { booking: mapBooking(prior), checkoutUrl: prior.stripeCheckoutUrl, checkoutState: prior.priceCents === 0 ? "NOT_REQUIRED" : prior.stripeCheckoutUrl ? "READY" : "RETRY_REQUIRED", manageCapabilities: activeCapabilities === 3 ? materializeCapabilities(prior.id, prior.capabilityVersion, prior.manageExpiresAt, prior.capabilityKeyId) : null };
}

// One live appointment per client, keyed on the email they book with. The booking id travels on the
// error so the caller can decide whether the requester has proved it is theirs before revealing it.
export const ACTIVE_BOOKING_EXISTS = "ACTIVE_BOOKING_EXISTS";
export function activeBookingConflict(bookingId: string) {
  const error = new AppError(ACTIVE_BOOKING_EXISTS, "You already have an appointment booked with us. Reschedule that one instead of booking a second.", 409);
  (error as AppError & { bookingId?: string }).bookingId = bookingId;
  return error;
}
export async function activeBookingIdForEmail(workspaceId: string, email: string) {
  // No public RLS policy exposes a Booking row by invitee email, so production asks a definer
  // function that returns only the id. A plain query here would read empty in production.
  if (process.env.DATABASE_PROVIDER === "postgresql" && process.env.NODE_ENV === "production") {
    const rows = await db.$queryRawUnsafe<Array<{ id: string | null }>>("SELECT tempocove_active_booking_for_email($1::text) AS id", email);
    return rows[0]?.id ?? null;
  }
  const row = await db.booking.findFirst({
    where: { workspaceId, inviteeEmail: email.toLowerCase(), status: { in: activeStatuses }, endAt: { gt: new Date() } },
    orderBy: { startAt: "asc" }, select: { id: true },
  });
  return row?.id ?? null;
}

async function ensureCheckoutLinked(bookingId: string, payments: PaymentService) {
  const booking = await db.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { eventType: true } });
  if (!booking.priceCents || booking.stripeCheckoutSessionId) return booking.stripeCheckoutUrl;
  const checkout = await payments.createCheckout(booking, booking.eventType);
  if (!checkout) throw new Error("PAID_CHECKOUT_UNAVAILABLE");
  if (process.env.DATABASE_PROVIDER === "postgresql" && process.env.NODE_ENV === "production") {
    const rows = await db.$queryRawUnsafe<Array<{ linked: boolean }>>("SELECT tempocove_link_checkout($1::text,$2::text,$3::text) AS linked", booking.id, checkout.sessionId, checkout.url);
    if (rows[0]?.linked) return checkout.url;
  } else {
    const linked = await db.booking.updateMany({ where: { id: booking.id, stripeCheckoutSessionId: null, status: "PENDING_PAYMENT" }, data: { stripeCheckoutSessionId: checkout.sessionId, stripeCheckoutUrl: checkout.url, stripePaymentStatus: "unpaid" } });
    if (linked.count === 1) return checkout.url;
  }
  return (await db.booking.findUniqueOrThrow({ where: { id: booking.id } })).stripeCheckoutUrl;
}

// The one-live-appointment rule stops an anonymous client from quietly holding two chairs. The studio
// booking from its own dashboard is the authority over its own calendar, so it books a regular's next
// appointment while the current one is still ahead of them. Every other guard -- the slot has to be
// genuinely free, the answers valid, the buffers honoured -- applies unchanged.
export type CreateBookingOptions = { allowSecondActiveBooking?: boolean };

export async function createBooking(
  slug: string, input: CreateBookingInput, idempotencyKey: string,
  calendar: CalendarService = getCalendarService(), payments: PaymentService = getPaymentService(),
  options: CreateBookingOptions = {},
): Promise<InternalCreateBookingResult> {
  const requestFingerprint = createHash("sha256").update(JSON.stringify({ slug, ...input })).digest("hex");
  const eventType = await withDatabaseTransactionRetry(() => getEventTypeBySlug(slug));
  enterPublicBookingDatabaseContext(eventType.id, eventType.workspaceId, idempotencyKey);
  const prior = await withDatabaseTransactionRetry(() => priorResult(slug, idempotencyKey, requestFingerprint));
  if (prior) {
    if (prior.booking.priceCents > 0 && !prior.checkoutUrl && prior.booking.status === "PENDING_PAYMENT") {
      try { prior.checkoutUrl = await ensureCheckoutLinked(prior.booking.id, payments); prior.checkoutState = prior.checkoutUrl ? "READY" : "RETRY_REQUIRED"; }
      catch { prior.checkoutState = "RETRY_REQUIRED"; await db.booking.updateMany({ where: { id: prior.booking.id, status: "PENDING_PAYMENT" }, data: { stripePaymentStatus: "checkout_retry" } }); }
    }
    return prior;
  }
  const existing = options.allowSecondActiveBooking ? null : await withDatabaseTransactionRetry(() => activeBookingIdForEmail(eventType.workspaceId, input.inviteeEmail));
  if (existing) throw activeBookingConflict(existing);
  const duration = input.durationId ? eventType.durations.find((item) => item.id === input.durationId) : eventType.durations.find((item) => item.isDefault);
  if (!duration) throw notFound("Duration option");
  const answerMap = new Map((input.answers ?? []).map((answer) => [answer.questionId, answer.value]));
  for (const question of eventType.questions) {
    const value = answerMap.get(question.id);
    if (question.required && (!answerMap.has(question.id) || value == null || value === "")) throw conflict(`Answer required: ${question.label}`);
    if (!answerMap.has(question.id)) continue;
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > 4000) throw conflict(`Answer is invalid: ${question.label}`);
    if (question.kind === "CHECKBOX" && typeof value !== "boolean") throw conflict(`Answer must be checked or unchecked: ${question.label}`);
    if (question.kind === "SELECT" && (typeof value !== "string" || !((question.optionsJson ? JSON.parse(question.optionsJson) as string[] : []).includes(value)))) throw conflict(`Choose a valid option: ${question.label}`);
  }
  if ([...answerMap.keys()].some((id) => !eventType.questions.some((question) => question.id === id))) throw conflict("A booking answer does not belong to this event type.");
  const requestedStart = new Date(input.startAt);
  const requestedEnd = DateTime.fromJSDate(requestedStart).plus({ minutes: duration.durationMinutes }).toJSDate();
  const windowStart = DateTime.fromJSDate(requestedStart).startOf("day").minus({ hours: 14 }).toJSDate();
  const windowEnd = DateTime.fromJSDate(requestedStart).endOf("day").plus({ hours: 14 }).toJSDate();
  const slots = await withDatabaseTransactionRetry(() => listPublicSlots(slug, windowStart, windowEnd, input.inviteeTimeZone, calendar, duration.id));
  if (!slots.some((slot) => new Date(slot.start).getTime() === requestedStart.getTime())) throw conflict("That time is no longer available.");
  enterPublicBookingDatabaseContext(eventType.id, eventType.workspaceId, idempotencyKey);
  const capability = newCapabilityIdentity(requestedEnd);
  const calendarProviderSnapshot = await calendar.providerKind?.(eventType.ownerId, eventType.workspaceId) ?? "local";
  let created;
  // A duplicate reference is a coin landing twice, not anything the client can act on. Minting a fresh
  // code and retrying keeps it invisible; falling through to the P2002 branch below would tell them
  // their slot was taken, which is both wrong and unactionable.
  for (let attempt = 0; ; attempt += 1) {
  try {
    created = await withDatabaseTransactionRetry((remainingMs) => db.$transaction(async (tx) => {
      const booking = await tx.booking.create({ data: {
        reference: generateBookingReference(),
        workspaceId: eventType.workspaceId, eventTypeId: eventType.id, hostId: eventType.ownerId, durationId: duration.id,
        durationMinutes: duration.durationMinutes, priceCents: duration.priceCents, currency: duration.currency,
        bufferBeforeMinutes: eventType.bufferBeforeMinutes, bufferAfterMinutes: eventType.bufferAfterMinutes,
        bookingWindowDays: eventType.bookingWindowDays,
        inviteeName: input.inviteeName, inviteeEmail: input.inviteeEmail, inviteeTimeZone: input.inviteeTimeZone,
        startAt: requestedStart, endAt: requestedEnd, notes: input.notes || null,
        eventTitleSnapshot: eventType.name, locationTypeSnapshot: eventType.locationType,
        locationValueSnapshot: eventType.locationValue, calendarProviderSnapshot,
        idempotencyKey, requestFingerprint, capabilityVersion: capability.version, capabilityKeyId: capability.keyId, manageExpiresAt: capability.expiresAt,
        status: "CONFIRMED",
        checkoutResumeExpiresAt: null,
        calendarSyncStatus: "PENDING",
        notificationStatus: "PENDING",
        answers: { create: eventType.questions.filter((item) => answerMap.has(item.id)).map((item) => ({ questionId: item.id, questionLabel: item.label, valueJson: JSON.stringify(answerMap.get(item.id)) })) },
      } });
      await tx.bookingOccupancy.createMany({ data: occupiedMinutes(requestedStart, requestedEnd, eventType.bufferBeforeMinutes, eventType.bufferAfterMinutes).map((minuteStart) => ({ workspaceId: eventType.workspaceId, bookingId: booking.id, hostId: eventType.ownerId, minuteStart })) });
      await tx.bookingCapability.createMany({ data: capabilityRows(booking.id, capability.version, capability.expiresAt, capability.keyId) });
      // Prices are display-only (settled at the shop), so every booking confirms immediately.
      await tx.integrationOutbox.create({ data: { workspaceId: eventType.workspaceId, bookingId: booking.id, kind: "CALENDAR_CREATE", idempotencyKey: `calendar:create:${booking.id}:free` } });
      await enqueueBookingEmail(tx, booking, "BOOKING_CONFIRMED");
      await enqueueBookingReminder(tx, booking);
      return tx.booking.findUniqueOrThrow({ where: { id: booking.id }, include: bookingInclude });
    }, boundedPrismaTransactionOptions(remainingMs)));
    break;
  } catch (error) {
    // SQLite and PostgreSQL use separately generated Prisma clients, so
    // cross-client `instanceof` is not a valid production error discriminator.
    if (providerErrorCode(error) === "P2002" && providerErrorTarget(error).includes("reference") && attempt < 3) continue;
    if (providerErrorCode(error) === "P2002") {
      const winner = await withDatabaseTransactionRetry(() => priorResult(slug, idempotencyKey, requestFingerprint));
      if (winner) return winner;
      throw conflict("That time was just booked. Choose another slot.");
    }
    throw error;
  }
  }
  if (shouldDrainOutboxInline()) await processBookingOutbox(created.id);
  return { booking: mapBooking(created), checkoutUrl: null, checkoutState: "NOT_REQUIRED", manageCapabilities: materializeCapabilities(created.id, capability.version, capability.expiresAt, capability.keyId) };
}

export async function resumeBookingCheckout(id: string, payments: PaymentService = getPaymentService()): Promise<ResumeBookingCheckoutResult> {
  const booking = await db.booking.findUnique({ where: { id } });
  if (!booking) throw notFound("Booking");
  if (booking.status !== "PENDING_PAYMENT" || booking.priceCents <= 0) return { bookingId: booking.id, status: booking.status as ResumeBookingCheckoutResult["status"], checkoutState: "NOT_REQUIRED", checkoutUrl: null };
  if (!booking.checkoutResumeExpiresAt || booking.checkoutResumeExpiresAt.getTime() - Date.now() < 30 * 60_000) throw new AppError("CHECKOUT_RESUME_EXPIRED", "This payment attempt can no longer be resumed. Cancel it or create a new booking.", 409);
  if (booking.stripeCheckoutUrl) return { bookingId: booking.id, status: "PENDING_PAYMENT", checkoutState: "READY", checkoutUrl: booking.stripeCheckoutUrl };
  try {
    const checkoutUrl = await ensureCheckoutLinked(booking.id, payments);
    if (checkoutUrl) return { bookingId: booking.id, status: "PENDING_PAYMENT", checkoutState: "READY", checkoutUrl };
  } catch { await db.booking.updateMany({ where: { id: booking.id, status: "PENDING_PAYMENT" }, data: { stripePaymentStatus: "checkout_retry" } }); }
  return { bookingId: booking.id, status: "PENDING_PAYMENT", checkoutState: "RETRY_REQUIRED", checkoutUrl: null };
}

export async function cancelBooking(id: string, cancellationReason?: string) {
  enterDatabaseAction("booking_write");
  const current = await db.booking.findUnique({ where: { id }, include: bookingInclude });
  if (!current) throw notFound("Booking");
  if (current.status === "CANCELLED") return mapBooking(current);
  const updated = await db.$transaction(async (tx) => {
    const mutationNow = new Date();
    const won = await tx.booking.updateMany({ where: { id, mutationVersion: current.mutationVersion, status: { not: "CANCELLED" }, OR: [{ calendarLeaseToken: null }, { calendarLeaseExpiresAt: { lte: mutationNow } }] }, data: { status: "CANCELLED", mutationVersion: { increment: 1 }, calendarLeaseToken: null, calendarLeaseExpiresAt: null, cancellationReason: cancellationReason?.trim() || "INVITEE_CANCELLED", calendarSyncStatus: "PENDING", notificationStatus: "PENDING" } });
    if (won.count !== 1) throw conflict("The booking changed while cancellation was being applied. Refresh and try again.");
    await tx.bookingOccupancy.deleteMany({ where: { bookingId: id } });
    await tx.bookingCapability.updateMany({ where: { bookingId: id, scope: { in: ["cancel", "reschedule"] }, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.bookingManageSession.updateMany({ where: { bookingId: id, revokedAt: null }, data: { scopes: "read" } });
    await tx.integrationOutbox.upsert({ where: { idempotencyKey: `calendar:delete:${id}` }, update: {}, create: { workspaceId: current.workspaceId, bookingId: id, kind: "CALENDAR_DELETE", idempotencyKey: `calendar:delete:${id}` } });
    const result = await tx.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude });
    if (result.stripePaymentStatus === "paid" || result.stripePaymentStatus === "paid_after_cancel") {
      if (!result.stripePaymentIntentId) throw new Error("STRIPE_REFUND_AUTHORITY_REQUIRED");
      await tx.booking.update({ where: { id }, data: { refundStatus: "REFUND_PENDING", refundFailureCode: null } });
      await tx.integrationOutbox.upsert({ where: { idempotencyKey: `stripe:refund:${id}:full:v1` }, update: {}, create: { workspaceId: result.workspaceId, bookingId: id, kind: "STRIPE_REFUND", idempotencyKey: `stripe:refund:${id}:full:v1` } });
    } else if (result.stripeCheckoutSessionId) await tx.integrationOutbox.upsert({ where: { idempotencyKey: `stripe:expire:${id}` }, update: {}, create: { workspaceId: result.workspaceId, bookingId: id, kind: "STRIPE_EXPIRE", idempotencyKey: `stripe:expire:${id}` } });
    const finalResult = await tx.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude });
    await supersedeBookingReminders(tx, id, mutationNow);
    await enqueueBookingEmail(tx, finalResult, "BOOKING_CANCELLED", mutationNow); return finalResult;
  });
  if (shouldDrainOutboxInline()) await processBookingOutbox(id);
  return mapBooking(updated);
}

export async function rescheduleBooking(id: string, startAt: string, calendar: CalendarService = getCalendarService()) {
  enterDatabaseAction("booking_write");
  const mutationContext = currentDatabaseContext();
  const booking = await db.booking.findUnique({ where: { id }, include: { eventType: { include: { durations: true, questions: true } }, host: true } });
  if (!booking || booking.status !== "CONFIRMED") throw notFound("Booking");
  if (booking.calendarProviderSnapshot === "provider_recovery_required") throw new AppError("CALENDAR_PROVIDER_RECOVERY_REQUIRED", "Reconcile this upgraded booking's calendar provider before rescheduling.", 503);
  const requestedStart = new Date(startAt);
  if (requestedStart.getTime() === booking.startAt.getTime()) return mapBooking(await db.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude }));
  const requestedEnd = DateTime.fromJSDate(requestedStart).plus({ minutes: booking.durationMinutes }).toJSDate();
  const renewedManageExpiry = new Date(requestedEnd.getTime() + 30 * 24 * 60 * 60 * 1000);
  const rangeStart = DateTime.fromJSDate(requestedStart).startOf("day").minus({ hours: 14 }).toJSDate();
  const rangeEnd = DateTime.fromJSDate(requestedStart).endOf("day").plus({ hours: 14 }).toJSDate();
  const providerEventId = booking.externalCalendarEventId ?? (booking.calendarProviderSnapshot === "google" ? providerCalendarEventId(booking.id) : undefined);
  const slots = await listPublicSlots(booking.eventType.slug, rangeStart, rangeEnd, booking.inviteeTimeZone, calendar, booking.durationId ?? undefined, id, true, true, providerEventId, booking.bookingWindowDays, booking.durationMinutes, booking.bufferBeforeMinutes, booking.bufferAfterMinutes, booking.calendarProviderSnapshot === "google" ? "google" : "local");
  if (!slots.some((slot) => new Date(slot.start).getTime() === requestedStart.getTime())) throw conflict("That time is no longer available.");
  if (mutationContext) enterDatabaseContext({ ...mutationContext, action: "booking_write" });
  let updated;
  try {
    updated = await db.$transaction(async (tx) => {
      const mutationNow = new Date();
      const won = await tx.booking.updateMany({ where: { id, mutationVersion: booking.mutationVersion, status: "CONFIRMED", OR: [{ calendarLeaseToken: null }, { calendarLeaseExpiresAt: { lte: mutationNow } }] }, data: { startAt: requestedStart, endAt: requestedEnd, manageExpiresAt: renewedManageExpiry, mutationVersion: { increment: 1 }, calendarLeaseToken: null, calendarLeaseExpiresAt: null, calendarSyncStatus: "PENDING", notificationStatus: "PENDING" } });
      if (won.count !== 1) throw conflict("The booking changed while rescheduling. Refresh and choose a new time.");
      await tx.bookingOccupancy.deleteMany({ where: { bookingId: id } });
      await tx.bookingOccupancy.createMany({ data: occupiedMinutes(requestedStart, requestedEnd, booking.bufferBeforeMinutes, booking.bufferAfterMinutes).map((minuteStart) => ({ workspaceId: booking.workspaceId, bookingId: id, hostId: booking.hostId, minuteStart })) });
      await tx.bookingManageSession.updateMany({ where: { bookingId: id, revokedAt: null }, data: { expiresAt: renewedManageExpiry } });
      await tx.integrationOutbox.create({ data: { workspaceId: booking.workspaceId, bookingId: id, kind: "CALENDAR_UPDATE", bookingMutationVersion: booking.mutationVersion + 1, idempotencyKey: `calendar:update:${id}:${requestedStart.toISOString()}` } });
      const result = await tx.booking.findUniqueOrThrow({ where: { id }, include: bookingInclude });
      await supersedeBookingReminders(tx, id, mutationNow);
      await enqueueBookingEmail(tx, result, "BOOKING_RESCHEDULED", mutationNow);
      await enqueueBookingReminder(tx, result, mutationNow); return result;
    });
  } catch (error) {
    if (providerErrorCode(error) === "P2002") throw conflict("That time was just booked. Choose another slot.");
    throw error;
  }
  if (shouldDrainOutboxInline()) await processBookingOutbox(id);
  return mapBooking(updated);
}
