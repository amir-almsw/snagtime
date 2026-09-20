import { randomInt } from "node:crypto";

// The booking id is a cuid and exists for the software; this is the code a person is given. It is read
// aloud over the counter and retyped from a printed confirmation, so the alphabet drops every glyph pair
// that survives neither: 0/O, 1/I/L and U/V are all absent.
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTWXYZ";
const REFERENCE_LENGTH = 6;
export const BOOKING_REFERENCE_PREFIX = "DV";
// 29^6 is ~594 million, so a collision needs tens of thousands of bookings before it is even worth
// thinking about -- and createBooking mints a fresh code and retries rather than failing when one lands.
export const BOOKING_REFERENCE_PATTERN = new RegExp(`^${BOOKING_REFERENCE_PREFIX}-[${REFERENCE_ALPHABET}]{${REFERENCE_LENGTH}}$`);

export function generateBookingReference() {
  let body = "";
  for (let index = 0; index < REFERENCE_LENGTH; index += 1) body += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return `${BOOKING_REFERENCE_PREFIX}-${body}`;
}

// Accepts what people actually type: lower case, the prefix left off, and whatever spaces, dashes or
// dots they added while copying it down. Returns "" when the result could not be a reference at all, so
// callers can reject it before it ever reaches a query.
export function normalizeBookingReference(value: string) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = compact.startsWith(BOOKING_REFERENCE_PREFIX) ? compact.slice(BOOKING_REFERENCE_PREFIX.length) : compact;
  const candidate = `${BOOKING_REFERENCE_PREFIX}-${body}`;
  return BOOKING_REFERENCE_PATTERN.test(candidate) ? candidate : "";
}
