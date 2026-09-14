// One structure, two renderings. Every client email is described as an EmailBody and emitted as both an
// HTML part and a plain-text part, so the two can never drift: a detail added to the table appears in
// both, and the manage link is always present in text even when a client blocks HTML entirely.
//
// The look follows dvision.studio rather than the dashboard: near-black ground, bone text, crimson
// accent, micro-labels set in wide-tracked uppercase, display type tracked tight. Webfonts do not
// survive Gmail, so the brand has to live in colour, case and tracking -- all of which do survive --
// with Syne and Manrope named first for the clients that honour them.
//
// The HTML is deliberately old-fashioned -- nested tables, inline styles, no external assets. Rules
// that follow from that, and from the ground being dark:
//   - every colour is written literally on the element that uses it, which is also what stops Gmail's
//     dark-mode pass from inverting text and background independently and producing bone on bone;
//   - borders are solid hex, not rgba, which Outlook drops;
//   - the logo is typographic. Branding logos are stored as data URLs, which Gmail strips, and a
//     remote image would be blocked by default anyway;
//   - the call to action is a padded table cell, not a styled <button>.
export type EmailBrand = { name: string; accentColor: string; footerText: string | null };
export type EmailDetail = { label: string; value: string };
export type EmailBody = {
  // The line inboxes show after the subject. Without one, clients preview the header text instead,
  // so every list entry would read "DVISION".
  preheader: string;
  // Shown in crimson above the heading. Short by contract: the site sets these at nine or ten pixels
  // with .18em tracking, and anything longer than a few words wraps and stops reading as a label.
  eyebrow: string;
  heading: string;
  intro: string;
  details: EmailDetail[];
  action?: { label: string; href: string };
  note?: string;
};

// dvision.studio's own palette, read from its stylesheet rather than guessed.
const ACCENT = "#C11427";
const GROUND = "#050505"; const PAPER = "#0C0C0C"; const BONE = "#F2F0EB"; const MUTED = "#96938D"; const LINE = "#232120";
const SANS = "'Syne','Manrope','Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'DM Mono','SFMono-Regular',Consolas,'Liberation Mono',monospace";

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === '"' ? "&quot;" : "&#39;");
}
// Re-checked at render time rather than trusted from the row: a colour reaches an inline style
// attribute, and rows can predate the validation that now guards the settings form.
export function safeAccent(value: string | null | undefined) { return value && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : ACCENT; }

// Label above value, not beside it: a phone inbox is too narrow for two columns, and the site sets
// its own micro-labels this way.
function detailRows(details: EmailDetail[]) {
  return details.map(({ label, value }) => `<tr>
                  <td style="padding:0 0 5px;font:500 9px/1.4 ${MONO};letter-spacing:.16em;text-transform:uppercase;color:${MUTED};">${escapeHtml(label)}</td>
                </tr>
                <tr>
                  <td style="padding:0 0 20px;font:400 16px/1.45 ${SANS};letter-spacing:-.01em;color:${BONE};">${escapeHtml(value)}</td>
                </tr>`).join("\n");
}

export function renderEmailHtml(brand: EmailBrand, body: EmailBody) {
  const accent = safeAccent(brand.accentColor);
  const action = body.action ? `<tr>
                  <td style="padding:10px 0 2px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                      <td style="background:${accent};">
                        <a href="${escapeHtml(body.action.href)}" style="display:inline-block;padding:15px 22px;font:600 10px/1 ${MONO};letter-spacing:.16em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${escapeHtml(body.action.label)} &#8599;</a>
                      </td>
                    </tr></table>
                  </td>
                </tr>` : "";
  const note = body.note ? `<tr>
                  <td style="padding:22px 0 0;font:400 13px/1.65 ${SANS};color:${MUTED};">${escapeHtml(body.note)}</td>
                </tr>` : "";
  const footerText = brand.footerText ? ` &middot; ${escapeHtml(brand.footerText)}` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="color-scheme" content="dark" /><meta name="supported-color-schemes" content="dark" /><title>${escapeHtml(body.heading)}</title></head>
<body style="margin:0;padding:0;background:${GROUND};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(body.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GROUND};">
    <tr>
      <td align="center" style="padding:36px 16px 44px;background:${GROUND};">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td style="padding:0 2px 22px;font:600 15px/1 ${SANS};letter-spacing:.2em;text-transform:uppercase;color:${BONE};">${escapeHtml(brand.name)}</td>
          </tr>
          <tr>
            <td style="background:${PAPER};border:1px solid ${LINE};border-top:2px solid ${accent};padding:34px 30px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:0 0 14px;font:500 10px/1.4 ${MONO};letter-spacing:.18em;text-transform:uppercase;color:${accent};">${escapeHtml(body.eyebrow)}</td>
                </tr>
                <tr>
                  <td style="padding:0 0 14px;font:600 30px/1.1 ${SANS};letter-spacing:-.035em;color:${BONE};">${escapeHtml(body.heading)}</td>
                </tr>
                <tr>
                  <td style="padding:0 0 30px;font:400 16px/1.6 ${SANS};color:${MUTED};">${escapeHtml(body.intro)}</td>
                </tr>
                <tr>
                  <td style="padding:0 0 26px;border-top:1px solid ${LINE};font-size:0;line-height:0;">&nbsp;</td>
                </tr>
${detailRows(body.details)}
${action}${note}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 2px 0;font:400 9px/1.7 ${MONO};letter-spacing:.14em;text-transform:uppercase;color:${MUTED};">${escapeHtml(brand.name)}${footerText}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body></html>`;
}

export function renderEmailText(brand: EmailBrand, body: EmailBody) {
  const lines = [brand.name.toUpperCase(), "", body.heading, "", body.intro, "", ...body.details.map(({ label, value }) => `${label}: ${value}`)];
  if (body.action) lines.push("", `${body.action.label}:`, body.action.href);
  if (body.note) lines.push("", body.note);
  lines.push("", "--", brand.footerText ? `${brand.name} — ${brand.footerText}` : brand.name);
  return lines.join("\n");
}
