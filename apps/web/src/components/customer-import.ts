// Reads a client list exported from the studio's old salon system (Salonized's .xlsx, or any .csv) into
// plain rows for the Customers import. It runs in the browser, so the server only ever receives validated
// JSON and never unpacks an uploaded archive. No spreadsheet library: an .xlsx is a zip of XML parts, the
// platform's DecompressionStream inflates them, and the handful of elements a sheet uses are read here.
export type ImportedClient = { name: string; email: string; phone?: string };
export type ParsedClientFile = { clients: ImportedClient[]; skipped: number; total: number };

const MAX_FILE_BYTES = 5 * 1024 * 1024;
// A worksheet part inflates far larger than its zip entry; this bounds a hostile file without limiting a
// real client list, which is a few hundred kilobytes of XML even at thousands of rows.
const MAX_PART_BYTES = 40 * 1024 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ClientFileError extends Error {}

export async function readClientFile(file: Blob): Promise<ParsedClientFile> {
  if (file.size > MAX_FILE_BYTES) throw new ClientFileError("That file is larger than 5 MB. Export only the customer list and try again.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const rows = isZip(bytes) ? await readXlsxRows(bytes) : parseCsv(decodeText(bytes));
  return clientsFromRows(rows);
}

// ---- Column mapping --------------------------------------------------------------------------------------

// Headers are compared with case, spaces and punctuation removed, so "first_name", "First name" and
// "FirstName" all match. Dutch exports are covered alongside English ones.
const HEADERS = {
  email: ["email", "emailaddress", "emailadres", "mail", "mailadres"],
  full: ["name", "fullname", "naam", "volledigenaam", "customer", "customername", "client", "clientname", "klant", "klantnaam"],
  first: ["firstname", "voornaam", "givenname", "first"],
  middle: ["middlename", "tussenvoegsel", "infix"],
  last: ["lastname", "achternaam", "surname", "familyname", "last"],
  mobile: ["mobilephone", "mobile", "mobilenumber", "mobiel", "mobielnummer", "mobieltelefoonnummer", "cellphone", "cell", "gsm"],
  phone: ["phone", "phonenumber", "telephone", "telefoon", "telefoonnummer", "tel"],
} as const;
const normalizeHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const clean = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

export function clientsFromRows(rows: string[][]): ParsedClientFile {
  const headerIndex = rows.slice(0, 10).findIndex((row) => row.some((cell) => (HEADERS.email as readonly string[]).includes(normalizeHeader(cell))));
  if (headerIndex < 0) throw new ClientFileError("No email column was found. The first row should name the columns, including one called Email.");
  const header = rows[headerIndex]!.map(normalizeHeader);
  const column = (names: readonly string[]) => header.findIndex((cell) => names.includes(cell));
  const at = { email: column(HEADERS.email), full: column(HEADERS.full), first: column(HEADERS.first), middle: column(HEADERS.middle), last: column(HEADERS.last), mobile: column(HEADERS.mobile), phone: column(HEADERS.phone) };
  const cell = (row: string[], index: number) => (index < 0 ? "" : clean(row[index]));
  const seen = new Set<string>(); const clients: ImportedClient[] = []; let skipped = 0; let total = 0;
  for (const row of rows.slice(headerIndex + 1)) {
    if (!row.some((value) => clean(value))) continue;
    total += 1;
    const email = cell(row, at.email).toLowerCase();
    if (email.length > 254 || !EMAIL.test(email) || seen.has(email)) { skipped += 1; continue; }
    seen.add(email);
    const name = (cell(row, at.full) || [cell(row, at.first), cell(row, at.middle), cell(row, at.last)].filter(Boolean).join(" ")).slice(0, 120) || email;
    const phone = (cell(row, at.mobile) || cell(row, at.phone)).slice(0, 40);
    clients.push(phone ? { name, email, phone } : { name, email });
  }
  return { clients, skipped, total };
}

// ---- CSV -------------------------------------------------------------------------------------------------

// UTF-8 first; a CSV saved by an older Windows Excel is Windows-1252, which decodes accented names into
// replacement characters under UTF-8 and correctly under its own table.
function decodeText(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  if (!text.includes("\uFFFD")) return text;
  try { return new TextDecoder("windows-1252").decode(bytes); } catch { return text; }
}

// RFC 4180 quoting, CRLF or LF, and the delimiter taken from the header line: a Dutch Excel saves CSV with
// semicolons, most other tools with commas.
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const newline = source.search(/\r?\n/); const firstLine = newline < 0 ? source : source.slice(0, newline);
  const delimiter = [";", ",", "\t"].map((candidate) => ({ candidate, count: firstLine.split(candidate).length })).sort((left, right) => right.count - left.count)[0]!.candidate;
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character === "\"" && source[index + 1] === "\"") { field += "\""; index += 1; }
      else if (character === "\"") quoted = false;
      else field += character;
    } else if (character === "\"" && field === "") quoted = true;
    else if (character === delimiter) { row.push(field); field = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += character;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---- XLSX ------------------------------------------------------------------------------------------------

function isZip(bytes: Uint8Array) { return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04; }

type ZipEntry = { method: number; compressedSize: number; localOffset: number };
function zipEntries(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
  if (end < 0) throw new ClientFileError("That spreadsheet could not be read. Save it again as .xlsx or .csv and retry.");
  const count = view.getUint16(end + 10, true); let offset = view.getUint32(end + 16, true);
  const entries = new Map<string, ZipEntry>(); const names = new TextDecoder();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new ClientFileError("That spreadsheet is damaged. Save it again as .xlsx or .csv and retry.");
    const nameLength = view.getUint16(offset + 28, true); const extraLength = view.getUint16(offset + 30, true); const commentLength = view.getUint16(offset + 32, true);
    entries.set(names.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)), { method: view.getUint16(offset + 10, true), compressedSize: view.getUint32(offset + 20, true), localOffset: view.getUint32(offset + 42, true) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { view, entries };
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength); copy.set(data);
  const reader = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PART_BYTES) { await reader.cancel(); throw new ClientFileError("That spreadsheet is too large to import in one go."); }
    chunks.push(value);
  }
  const out = new Uint8Array(total); let position = 0;
  for (const chunk of chunks) { out.set(chunk, position); position += chunk.byteLength; }
  return out;
}

async function readPart(bytes: Uint8Array, zip: ReturnType<typeof zipEntries>, name: string): Promise<string | null> {
  const entry = zip.entries.get(name);
  if (!entry) return null;
  const { view } = zip;
  if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new ClientFileError("That spreadsheet is damaged. Save it again as .xlsx or .csv and retry.");
  const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method === 8) return new TextDecoder().decode(await inflateRaw(data));
  throw new ClientFileError("That spreadsheet uses a compression this page cannot read. Save it again as .xlsx or .csv and retry.");
}

function decodeXml(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ({ lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" } as Record<string, string>)[lower] ?? entity;
  });
}
// The text of a shared or inline string: every <t>, in order, across rich-text runs, minus phonetic guides.
// Self-closing forms are matched first: <t/> read as an opening tag would run on to the next </t>.
function stringText(xml: string) { return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*\/>|<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1] ?? "")).join(""); }
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function attribute(attributes: string, name: string) { return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1]; }
function columnIndex(reference: string | undefined) {
  const letters = /^[A-Z]+/.exec(reference ?? "")?.[0];
  if (!letters) return -1;
  let index = 0; for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

async function firstSheetPath(bytes: Uint8Array, zip: ReturnType<typeof zipEntries>) {
  const workbook = await readPart(bytes, zip, "xl/workbook.xml"); const rels = await readPart(bytes, zip, "xl/_rels/workbook.xml.rels");
  const found = workbook ? /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1] : undefined; const relationId = found && escapeRegExp(found);
  const target = relationId && rels ? new RegExp(`<Relationship\\b[^>]*\\bId="${relationId}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${relationId}"`).exec(rels)?.[1] : undefined;
  if (target) return target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  return [...zip.entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0];
}

export async function readXlsxRows(bytes: Uint8Array): Promise<string[][]> {
  const zip = zipEntries(bytes);
  const sheetPath = await firstSheetPath(bytes, zip);
  const sheet = sheetPath ? await readPart(bytes, zip, sheetPath) : null;
  if (!sheet) throw new ClientFileError("That spreadsheet has no sheet to read.");
  const sharedXml = await readPart(bytes, zip, "xl/sharedStrings.xml");
  const shared = sharedXml ? [...sharedXml.matchAll(/<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => stringText(match[1] ?? "")) : [];
  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = []; let position = 0;
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1] ?? ""; const body = cellMatch[2] ?? "";
      const column = columnIndex(attribute(attributes, "r")); const index = column >= 0 ? column : position;
      const type = attribute(attributes, "t"); const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const value = type === "s" ? shared[Number(raw)] ?? "" : type === "inlineStr" ? stringText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "") : decodeXml(raw ?? "");
      while (row.length < index) row.push("");
      row[index] = value; position = index + 1;
    }
    rows.push(row);
  }
  return rows;
}
