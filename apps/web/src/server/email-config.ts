export function validatedMailbox(value: string) {
  if (!value || value.length > 320 || /[\r\n]/.test(value)) throw new Error("SMTP_MAILBOX_INVALID");
  const trimmed = value.trim(); const display = trimmed.match(/^.{1,100}<([^<>]+)>$/); const mailbox = (display?.[1] || trimmed).trim();
  const parts = mailbox.split("@");
  if (parts.length !== 2 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(parts[0]!) || !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(parts[1]!)) throw new Error("SMTP_MAILBOX_INVALID");
  return mailbox;
}

function validatedFromIdentity(value: string) {
  if (!value || value.length > 320 || /[\r\n]/.test(value)) throw new Error("SMTP_MAILBOX_INVALID");
  const trimmed = value.trim();
  if (!trimmed.includes("<") && !trimmed.includes(">")) {
    const mailbox = validatedMailbox(trimmed);
    return { from: mailbox, mailbox };
  }
  const display = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9 ._'()-]{0,99})\s+<([^<>]+)>$/);
  if (!display) throw new Error("SMTP_MAILBOX_INVALID");
  const name = display[1]!.trim(); const mailbox = validatedMailbox(display[2]!);
  return { from: `${name} <${mailbox}>`, mailbox };
}

export function systemEmailIdentity() {
  const from = process.env.EMAIL_FROM || ""; const replyTo = process.env.EMAIL_REPLY_TO || ""; const senderDomain = (process.env.EMAIL_SENDER_DOMAIN || "").toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(senderDomain)) throw new Error("SMTP_SENDER_IDENTITY_INVALID");
  const identity = validatedFromIdentity(from); const systemReplyTo = validatedMailbox(replyTo);
  const fromMailbox = identity.mailbox;
  if (fromMailbox.split("@")[1]!.toLowerCase() !== senderDomain) throw new Error("SMTP_SENDER_IDENTITY_INVALID");
  return { from: identity.from, fromMailbox, replyTo: systemReplyTo, senderDomain };
}

// Where the studio's own booking notifications land, which is deliberately not the account the barber
// signs in with: the login stays a personal address, the notifications go to a shared shop mailbox
// somebody else can also read. Unset means the two are the same, which is the single-operator default.
//
// A bad value falls back to the account address rather than throwing: this is called inside the booking
// transaction, and a typo in an environment variable must not be able to stop clients booking. The typo
// is caught at deploy time by prod:check instead.
export function organizerNotificationMailbox(accountEmail: string) {
  const configured = (process.env.ORGANIZER_NOTIFICATION_EMAIL || "").trim();
  if (!configured) return accountEmail;
  try { return validatedMailbox(configured); } catch { return accountEmail; }
}
