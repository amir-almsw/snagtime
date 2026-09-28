// One structure, two renderings. Every client email is described as an EmailBody and emitted as both an
// HTML part and a plain-text part, so the two can never drift: a line added to a section appears in
// both, and the manage links are always present in text even when a client blocks HTML entirely.
//
// The look is the studio's own hand-written mail rather than the website: white ground, dark text,
// plain sentences. A first-name greeting, one bold sentence saying what is booked and when, a pinned
// line for where, short titled sections, a bold sign-off from the barber and plain blue links. No brand
// colour, no buttons, no logo -- it reads as a message from a person, not a template.
//
// The HTML is still deliberately old-fashioned -- a table for the column, inline styles, no external
// assets. Rules that follow from that:
//   - every colour is written literally on the element that uses it, which is what stops Gmail's
//     dark-mode pass from inverting text and background independently;
//   - the diamond and the pin are emoji, which every client draws natively, where an image would be
//     blocked by default and a data URL stripped;
//   - links are plain anchors, one per line, never styled buttons.
export type EmailBrand = { name: string; signature: string; footerText: string | null };
export type EmailSection = { heading: string; lines: string[] };
export type EmailLink = { label: string; href: string };
export type EmailBody = {
  // The line inboxes show after the subject. Without one, clients preview the greeting instead, so
  // every list entry would read "Hey Amir,".
  preheader: string;
  greeting: string;
  // The one bold sentence: what is booked and when. Everything a client needs is in it.
  summary: string;
  location?: string;
  sections: EmailSection[];
  closing: string;
  links: EmailLink[];
  // Small and muted, after the links: the reference, the length, the price. Present because the
  // reference is what a client retypes when the links are spent, not because it needs reading first.
  footnote?: string;
};

const INK = "#1F1F1F"; const MUTED = "#6B6B6B"; const LINK = "#1155CC"; const PAPER = "#FFFFFF";
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const DIAMOND = "🔹"; const PIN = "📍";

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === '"' ? "&quot;" : "&#39;");
}

function paragraph(content: string, style = `margin:0 0 22px;font:400 14px/1.5 ${SANS};color:${INK};`) { return `<p style="${style}">${content}</p>`; }
function bold(text: string) { return paragraph(`<strong style="font-weight:700;">${escapeHtml(text)}</strong>`); }

export function renderEmailHtml(brand: EmailBrand, body: EmailBody) {
  const location = body.location ? bold(`${PIN} ${body.location}`) : "";
  const sections = body.sections.map(({ heading, lines }) =>
    `${paragraph(`${DIAMOND} ${escapeHtml(heading)}`, `margin:34px 0 22px;font:700 20px/1.3 ${SANS};color:${INK};`)}\n          ${paragraph(lines.map(escapeHtml).join("<br />"))}`).join("\n          ");
  const links = body.links.map(({ label, href }) => `<a href="${escapeHtml(href)}" style="color:${LINK};text-decoration:none;">${escapeHtml(label)}</a>`).join("<br />");
  const footnote = [body.footnote, brand.footerText].filter((line): line is string => Boolean(line)).map(escapeHtml).join("<br />");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="color-scheme" content="light" /><meta name="supported-color-schemes" content="light" /><title>${escapeHtml(body.summary)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(body.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAPER};">
    <tr>
      <td style="padding:28px 20px 40px;background:${PAPER};">
        <div style="max-width:640px;">
          ${paragraph(escapeHtml(body.greeting))}
          ${bold(body.summary)}
          ${location}
          ${sections}
          ${bold(body.closing)}
          ${bold(brand.signature)}
          ${paragraph(links)}
          ${footnote ? paragraph(footnote, `margin:30px 0 0;font:400 12px/1.5 ${SANS};color:${MUTED};`) : ""}
        </div>
      </td>
    </tr>
  </table>
</body></html>`;
}

export function renderEmailText(brand: EmailBrand, body: EmailBody) {
  const lines = [body.greeting, "", body.summary];
  if (body.location) lines.push("", `${PIN} ${body.location}`);
  for (const section of body.sections) lines.push("", `${DIAMOND} ${section.heading}`, "", ...section.lines);
  lines.push("", body.closing, "", brand.signature);
  for (const link of body.links) lines.push("", `${link.label}:`, link.href);
  const footnote = [body.footnote, brand.footerText].filter((line): line is string => Boolean(line));
  if (footnote.length) lines.push("", ...footnote);
  return lines.join("\n");
}
