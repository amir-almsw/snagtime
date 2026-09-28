import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ClientFileError, readClientFile } from "./customer-import";

// Spreadsheets are built here rather than checked in: the real export is a list of real clients and must
// never enter the repository. The zip is minimal but genuine -- local headers, a central directory and an
// end record -- with each part stored or deflated the way Excel and Salonized write them.
function zip(parts: Array<{ name: string; text: string; deflate?: boolean }>) {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name); const raw = Buffer.from(part.text, "utf8");
    const data = part.deflate ? deflateRawSync(raw) : raw; const method = part.deflate ? 8 : 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name); offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Blob([Buffer.concat([...locals, directory, end])]);
}
const inline = (reference: string, text: string) => `<c r="${reference}" t="inlineStr"><is><t>${text}</t></is></c>`;
const workbook = (target: string) => [
  { name: "xl/workbook.xml", text: `<workbook xmlns:r="r"><sheets><sheet name="Customers" sheetId="1" r:id="rId7"/></sheets></workbook>`, deflate: true },
  { name: "xl/_rels/workbook.xml.rels", text: `<Relationships><Relationship Id="rId1" Target="styles.xml"/><Relationship Id="rId7" Type="worksheet" Target="${target}"/></Relationships>`, deflate: true },
];

describe("reading a client export in the browser", () => {
  it("reads a Salonized export: inline strings, deflated parts, first and last name joined, mobile preferred", async () => {
    const header = ["salonized_id", "first_name", "last_name", "email", "phone", "mobile_phone"].map((name, index) => inline(`${"ABCDEF"[index]}1`, name)).join("");
    const sheet = `<worksheet><sheetData><row r="1">${header}</row>`
      + `<row r="2"><c r="A2"><v>101</v></c>${inline("B2", "  Amir ")}${inline("C2", "El  Idrissi")}${inline("D2", "Amir@Example.NL")}${inline("E2", "0201234567")}${inline("F2", "0612345678")}</row>`
      + `<row r="3">${inline("B3", "Sean")}${inline("C3", "O&apos;Neill &amp; Co")}${inline("D3", "sean@example.nl")}${inline("E3", "0209876543")}</row>`
      + `<row r="4">${inline("B4", "No")}${inline("C4", "Address")}${inline("D4", "not-an-email")}</row>`
      + `<row r="5">${inline("B5", "Repeat")}${inline("D5", "amir@example.nl")}</row>`
      + `<row r="6"/>`
      + `</sheetData></worksheet>`;
    const parsed = await readClientFile(zip([...workbook("worksheets/sheet1.xml"), { name: "xl/worksheets/sheet1.xml", text: sheet, deflate: true }]));
    expect(parsed.clients).toEqual([
      { name: "Amir El Idrissi", email: "amir@example.nl", phone: "0612345678" },
      { name: "Sean O'Neill & Co", email: "sean@example.nl", phone: "0209876543" },
    ]);
    expect(parsed).toMatchObject({ total: 4, skipped: 2 });
  });

  it("reads shared strings, rich-text runs, self-closing strings, numeric cells and a sheet the workbook renamed", async () => {
    const shared = `<sst><si><t>Name</t></si><si><t>E-mail</t></si><si><t>Mobiel</t></si><si/><si><r><t>Fatima </t></r><r><rPr/><t>Zahra</t></r><rPh><t>ignored</t></rPh></si><si><t xml:space="preserve">fatima@example.nl</t></si></sst>`;
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>`
      + `<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>31612345678</v></c></row></sheetData></worksheet>`;
    const parsed = await readClientFile(zip([...workbook("/xl/worksheets/customers.xml"), { name: "xl/sharedStrings.xml", text: shared }, { name: "xl/worksheets/customers.xml", text: sheet }]));
    expect(parsed.clients).toEqual([{ name: "Fatima Zahra", email: "fatima@example.nl", phone: "31612345678" }]);
  });

  it("reads a Dutch semicolon CSV with a byte-order mark, quoted fields and a tussenvoegsel", async () => {
    const csv = "﻿Voornaam;Tussenvoegsel;Achternaam;E-mailadres;Mobiel\r\n\"Jan\";van der;Berg;JAN@example.nl;\"06 1234 5678\"\r\n\"Piet \"\"PJ\"\"\";;\"Smit; senior\";piet@example.nl;\r\n";
    const parsed = await readClientFile(new Blob([csv]));
    expect(parsed.clients).toEqual([
      { name: "Jan van der Berg", email: "jan@example.nl", phone: "06 1234 5678" },
      { name: "Piet \"PJ\" Smit; senior", email: "piet@example.nl" },
    ]);
  });

  it("decodes a Windows-1252 CSV instead of turning accented names into replacement characters", async () => {
    const parsed = await readClientFile(new Blob([Buffer.from("Name,Email\nJosé Müller,jose@example.nl\n", "latin1")]));
    expect(parsed.clients).toEqual([{ name: "José Müller", email: "jose@example.nl" }]);
  });

  it("falls back to the address as the name when a row has none", async () => {
    const parsed = await readClientFile(new Blob(["email,phone\nnameless@example.nl,0612345678\n"]));
    expect(parsed.clients).toEqual([{ name: "nameless@example.nl", email: "nameless@example.nl", phone: "0612345678" }]);
  });

  it("refuses a file without an email column, a damaged spreadsheet, and one over the size bound", async () => {
    await expect(readClientFile(new Blob(["Name,Phone\nAmir,0612345678\n"]))).rejects.toBeInstanceOf(ClientFileError);
    await expect(readClientFile(new Blob([Buffer.from("PK\u0003\u0004 this is not really a zip")]))).rejects.toBeInstanceOf(ClientFileError);
    await expect(readClientFile(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]))).rejects.toThrow(/larger than 5 MB/);
  });
});
