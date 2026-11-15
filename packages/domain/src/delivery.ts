// Delivering one approved draft: who asked (from provider header fields only), the Word document
// made from it, and the short mail that carries its link. Pure: no I/O.
//
// The .docx is written by hand: a stored (uncompressed) ZIP of the three parts Word requires.
// That is ~80 lines with no dependency, runs in Convex's default runtime (no "use node"), and the
// same text always gives the same bytes. The `docx` package would add a large dependency and a
// Node action for paragraphs, headings and bullets.
import { isMailAddress } from "./actions";

export type Mailbox = { name?: string; address: string };
export type Requester = Mailbox & { subject?: string };

const MAX_NAME = 200;
const MAX_SUBJECT = 200;

/** One mailbox from a From header ("Name <addr>", "addr"), validated; anything else is nothing. */
export function parseMailbox(header: string): Mailbox | undefined {
  const value = header.trim();
  const angle = /^(.*?)\s*<([^<>]+)>$/.exec(value);
  const address = angle === null ? value : angle[2]!.trim();
  if (!isMailAddress(address)) return undefined;
  const name = (angle?.[1] ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
  if (/[\r\n]/.test(name)) return undefined;
  return name === "" ? { address } : { name: name.slice(0, MAX_NAME), address };
}

/** The one sender of the cited mail (newest message's subject), or null when none or more than one. */
export function requesterFrom(rows: { from?: Mailbox; subject?: string; occurredAt: string }[]): Requester | null {
  const mail = rows.filter((row) => row.from !== undefined).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  if (new Set(mail.map((row) => row.from!.address.toLowerCase())).size !== 1) return null;
  const { from, subject } = mail[0]!;
  return { ...from!, ...(subject === undefined ? {} : { subject }) };
}

const oneLine = (text: string) => text.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT);

/** The mail that carries the link: names the document, replies to the asker's subject when known. */
export function deliveryMail(input: { filename: string; link: string; replyTo?: string; fallbackSubject: string }) {
  const reply = input.replyTo === undefined ? "" : oneLine(input.replyTo);
  const subject = reply === "" ? oneLine(input.fallbackSubject) || "Your document" : /^re:/i.test(reply) ? reply : `Re: ${reply}`;
  return { subject, body: `Hi,\n\nHere is the Word document ${input.filename}:\n${input.link}\n\nSent with TARS.` };
}

/** A Content-Disposition-safe name: ASCII letters, digits, space, dot, dash, underscore. */
export function safeFilename(name: string): string {
  const base = name.replace(/[^A-Za-z0-9 ._-]/g, "").replace(/\s+/g, " ").trim().slice(0, 60).replace(/^\.+/, "");
  return `${base === "" ? "TARS document" : base}.docx`;
}

// ---- The .docx writer.

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
// Characters XML 1.0 cannot carry at all (C0 controls but tab/LF/CR, U+FFFE/F, lone surrogates) become U+FFFD.
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const escapeXml = (text: string) => text.replace(NOT_XML, "�").replace(/[&<>"]/g, (c) => ENTITY[c]!);

const run = (text: string, size?: number) =>
  `<w:r>${size === undefined ? "" : `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr>`}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
const paragraph = (runs: string, props = "") => `<w:p>${props === "" ? "" : `<w:pPr>${props}</w:pPr>`}${runs}</w:p>`;
const HEADING_SIZE = [32, 28, 24]; // half-points: #, ##, ###

/** Title, then the draft: `#` headings, `-`/`*` bullets, blank-line paragraphs with line breaks inside. */
function documentXml(title: string, text: string): string {
  const out = [paragraph(run(title, 40))];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) out.push(paragraph(lines.map((line) => run(line)).join("<w:r><w:br/></w:r>")));
    lines = [];
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (line.trim() === "") flush();
    else if (heading !== null) {
      flush();
      out.push(paragraph(run(heading[2]!.trim(), HEADING_SIZE[heading[1]!.length - 1])));
    } else if (bullet !== null) {
      flush();
      out.push(paragraph(run(`• ${bullet[1]!.trim()}`), '<w:ind w:left="720" w:hanging="360"/>'));
    } else lines.push(line);
  }
  flush();
  return `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${out.join("")}<w:sectPr/></w:body></w:document>`;
}

const CONTENT_TYPES =
  `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS =
  `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

/** A real .docx for one draft revision. Deterministic: fixed timestamps, fixed part order. */
export function docx(title: string, text: string): Uint8Array {
  return storedZip([
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", RELS],
    ["word/document.xml", documentXml(title, text)],
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = 0x21; // 1980-01-01, time 00:00

/** ZIP with method 0 (stored): local headers + data, central directory, end record. */
function storedZip(files: [string, string][]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map(([name, text]) => ({ name: encoder.encode(name), data: encoder.encode(text) }));
  const size = entries.reduce((sum, e) => sum + 30 + e.name.length + e.data.length + 46 + e.name.length, 22);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (value: number) => (view.setUint16(at, value, true), (at += 2));
  const u32 = (value: number) => (view.setUint32(at, value, true), (at += 4));
  const bytes = (value: Uint8Array) => (out.set(value, at), (at += value.length));
  const common = (e: { name: Uint8Array; data: Uint8Array; crc: number }) => {
    u16(20); // version needed
    u16(0); // flags
    u16(0); // method: stored
    u16(0); // time
    u16(DOS_DATE);
    u32(e.crc);
    u32(e.data.length); // compressed size
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra length
  };
  const placed = entries.map((e) => {
    const entry = { ...e, crc: crc32(e.data), offset: at };
    u32(0x04034b50);
    common(entry);
    bytes(e.name);
    bytes(e.data);
    return entry;
  });
  const directory = at;
  for (const e of placed) {
    u32(0x02014b50);
    u16(20); // made by
    common(e);
    u16(0); // comment length
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(e.offset);
    bytes(e.name);
  }
  const directorySize = at - directory;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(placed.length);
  u16(placed.length);
  u32(directorySize);
  u32(directory);
  u16(0); // comment length
  return out;
}
