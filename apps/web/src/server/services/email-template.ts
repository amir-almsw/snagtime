// One structure, two renderings. Every client email is described as an EmailBody and emitted as both an
// HTML part and a plain-text part, so the two can never drift: a detail added to the table appears in
// both, and the manage link is always present in text even when a client blocks HTML entirely.
//
// The HTML is deliberately old-fashioned -- nested tables, inline styles, no external assets. Gmail
// strips <style> blocks in some contexts and Outlook still renders through Word, so anything that only
// works in a browser will silently break in someone's inbox. Rules that follow from that:
//   - every colour is written literally on the element that uses it, which also stops the more
//     aggressive dark-mode clients from inverting text and background independently;
//   - the logo is typographic. Branding logos are stored as data URLs, which Gmail drops outright,
//     and a remote image would be blocked by default anyway;
//   - the call to action is a padded table cell, not a styled <button>.
export type EmailBrand = { name: string; accentColor: string; footerText: string | null };
export type EmailDetail = { label: string; value: string };
export type EmailBody = {
  // The line inboxes show after the subject. Without one, clients preview the header text instead,
  // so every list entry would read "DVISION STUDIO".
  preheader: string;
  heading: string;
  intro: string;
  details: EmailDetail[];
  action?: { label: string; href: string };
  note?: string;
};

const DEFAULT_ACCENT = "#2563EB";
const INK = "#111827"; const MUTED = "#6B7280"; const LINE = "#E5E7EB"; const PAPER = "#FFFFFF"; const GROUND = "#F3F4F6";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === '"' ? "&quot;" : "&#39;");
}
// Re-checked at render time rather than trusted from the row: a colour reaches an inline style
// attribute, and rows can predate the validation that now guards the settings form.
export function safeAccent(value: string | null | undefined) { return value && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : DEFAULT_ACCENT; }

function detailRows(details: EmailDetail[]) {
  return details.map(({ label, value }) => `<tr>
                  <td style="padding:0 0 4px;font:600 11px/1.4 ${FONT};letter-spacing:.08em;text-transform:uppercase;color:${MUTED};">${escapeHtml(label)}</td>
                </tr>
                <tr>
                  <td style="padding:0 0 18px;font:400 16px/1.5 ${FONT};color:${INK};">${escapeHtml(value)}</td>
                </tr>`).join("\n");
}

export function renderEmailHtml(brand: EmailBrand, body: EmailBody) {
  const accent = safeAccent(brand.accentColor);
  const action = body.action ? `<tr>
                  <td style="padding:8px 0 4px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                      <td style="background:${accent};border-radius:6px;">
                        <a href="${escapeHtml(body.action.href)}" style="display:inline-block;padding:13px 26px;font:600 15px/1 ${FONT};color:#FFFFFF;text-decoration:none;">${escapeHtml(body.action.label)}</a>
                      </td>
                    </tr></table>
                  </td>
                </tr>` : "";
  const note = body.note ? `<tr>
                  <td style="padding:18px 0 0;font:400 13px/1.6 ${FONT};color:${MUTED};">${escapeHtml(body.note)}</td>
                </tr>` : "";
  const footerText = brand.footerText ? `<br />${escapeHtml(brand.footerText)}` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="color-scheme" content="light only" /><title>${escapeHtml(body.heading)}</title></head>
<body style="margin:0;padding:0;background:${GROUND};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(body.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GROUND};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td style="padding:0 0 20px;font:700 13px/1.3 ${FONT};letter-spacing:.14em;text-transform:uppercase;color:${accent};">${escapeHtml(brand.name)}</td>
          </tr>
          <tr>
            <td style="background:${PAPER};border:1px solid ${LINE};border-top:3px solid ${accent};border-radius:8px;padding:32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:0 0 12px;font:700 23px/1.3 ${FONT};color:${INK};">${escapeHtml(body.heading)}</td>
                </tr>
                <tr>
                  <td style="padding:0 0 26px;font:400 16px/1.6 ${FONT};color:${INK};">${escapeHtml(body.intro)}</td>
                </tr>
${detailRows(body.details)}
${action}${note}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 4px 0;font:400 12px/1.6 ${FONT};color:${MUTED};">${escapeHtml(brand.name)}${footerText}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body></html>`;
}

export function renderEmailText(brand: EmailBrand, body: EmailBody) {
  const lines = [body.heading, "", body.intro, "", ...body.details.map(({ label, value }) => `${label}: ${value}`)];
  if (body.action) lines.push("", `${body.action.label}:`, body.action.href);
  if (body.note) lines.push("", body.note);
  lines.push("", "--", brand.footerText ? `${brand.name} — ${brand.footerText}` : brand.name);
  return lines.join("\n");
}
