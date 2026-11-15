import { crc32 } from "node:zlib";
import { describe, expect, test } from "vitest";
import { deliveryMail, deliveryStages, docx, parseMailbox, replyMail, requesterFrom, safeFilename } from "../../packages/domain/src/delivery";
import { deliverySteps } from "../../packages/domain/src/thread";

/** Reads a stored (uncompressed) ZIP: every entry's name and bytes, CRC-32 checked against zlib's. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true); // central directory offset
  const parts = new Map<string, string>();
  for (let i = 0; i < entries; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    expect(view.getUint16(at + 10, true)).toBe(0); // stored
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    expect(crc32(data) >>> 0).toBe(crc);
    parts.set(name, new TextDecoder("utf-8", { fatal: true }).decode(data));
    at += 46 + nameLength;
  }
  return parts;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** A strict well-formedness check for the XML subset a .docx part uses; returns the text of every w:t. */
function parseXml(xml: string): string[] {
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  expect(xml.startsWith(declaration)).toBe(true);
  const body = xml.slice(declaration.length);
  expect(body).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/);
  const token = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<&]*")*)\s*(\/?)>|([^<]+)/y;
  const stack: string[] = [];
  const texts: string[] = [];
  let roots = 0;
  for (let pos = 0; pos < body.length; ) {
    token.lastIndex = pos;
    const m = token.exec(body);
    if (m === null) throw new Error(`not well-formed at ${pos}: ${body.slice(pos, pos + 20)}`);
    pos = token.lastIndex;
    const [, close, name, , selfClose, text] = m;
    if (text !== undefined) {
      if (stack.length === 0) {
        expect(text.trim()).toBe("");
        continue;
      }
      expect(text).not.toMatch(/&(?!(?:amp|lt|gt|quot|apos);)/);
      expect(text).not.toContain("]]>");
      if (stack.at(-1) === "w:t") texts.push(text.replace(/&(\w+);/g, (_, e: string) => ENTITIES[e]!));
    } else if (close) {
      expect(stack.pop()).toBe(name);
    } else if (!selfClose) {
      if (stack.length === 0) roots++;
      stack.push(name!);
    } else if (stack.length === 0) roots++;
  }
  expect(stack).toEqual([]);
  expect(roots).toBe(1);
  return texts;
}

describe("the Word document writer", () => {
  const DRAFT = "# Budget summary\n\nThe numbers Dana asked for.\nSecond line.\n\n- Travel: 400\n- Venue: 1200\n\n2. Numbered stays as text";

  test("docx_is_a_zip_of_the_three_required_parts_that_parse_as_xml_and_carry_the_draft", () => {
    const parts = unzip(docx("Budget for Dana", DRAFT));
    expect([...parts.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
    for (const xml of parts.values()) parseXml(xml);
    expect(parts.get("[Content_Types].xml")).toContain('PartName="/word/document.xml"');
    expect(parts.get("_rels/.rels")).toContain('Target="word/document.xml"');
    const texts = parseXml(parts.get("word/document.xml")!);
    expect(texts).toEqual([
      "Budget for Dana",
      "Budget summary",
      "The numbers Dana asked for.",
      "Second line.",
      "• Travel: 400",
      "• Venue: 1200",
      "2. Numbered stays as text",
    ]);
    // A heading is bold and larger; a list item is indented; lines inside one paragraph break, not split.
    const doc = parts.get("word/document.xml")!;
    expect(doc).toContain('<w:b/><w:sz w:val="32"/>');
    expect(doc).toContain('<w:ind w:left="720" w:hanging="360"/>');
    expect(doc).toContain("<w:br/>");
  });

  test("hostile_text_is_rendered_as_text", () => {
    const hostile = `</w:t></w:r><w:r><w:t>injected & <b>bold</b> ]]> "q" 'a'\u0000\u0007\u001B￿ end \uD800`;
    const parts = unzip(docx(`Title <x> & ]]>`, hostile));
    const texts = parseXml(parts.get("word/document.xml")!);
    expect(texts[0]).toBe("Title <x> & ]]>");
    expect(texts[1]).toBe(`</w:t></w:r><w:r><w:t>injected & <b>bold</b> ]]> "q" 'a'���� end �`);
    expect(parts.get("word/document.xml")!.match(/<w:t /g)).toHaveLength(2);
  });

  test("the same input always gives the same bytes", () => {
    expect(docx("T", DRAFT)).toEqual(docx("T", DRAFT));
  });
});

describe("who asked", () => {
  test("a from header is one validated mailbox or nothing", () => {
    expect(parseMailbox("Dana Reyes <dana@illustrative.example>")).toEqual({ name: "Dana Reyes", address: "dana@illustrative.example" });
    expect(parseMailbox('"Reyes, Dana" <dana@illustrative.example>')).toEqual({ name: "Reyes, Dana", address: "dana@illustrative.example" });
    expect(parseMailbox("dana@illustrative.example")).toEqual({ address: "dana@illustrative.example" });
    expect(parseMailbox(" <dana@illustrative.example>")).toEqual({ address: "dana@illustrative.example" });
    expect(parseMailbox("a@illustrative.example, b@illustrative.example")).toBeUndefined();
    expect(parseMailbox("Dana <dana@illustrative.example>\r\nBcc: x@y.z")).toBeUndefined();
    expect(parseMailbox("not an address")).toBeUndefined();
    expect(parseMailbox("")).toBeUndefined();
  });

  test("the requester is the one sender of the cited mail, or nothing when absent or ambiguous", () => {
    const dana = { address: "dana@illustrative.example", name: "Dana" };
    expect(requesterFrom([])).toBeNull();
    expect(requesterFrom([{ occurredAt: "2026-11-14T10:00:00.000Z" }])).toBeNull();
    expect(
      requesterFrom([
        { from: dana, subject: "Budget", occurredAt: "2026-11-14T10:00:00.000Z" },
        { from: { address: "DANA@illustrative.example" }, subject: "Re: Budget", occurredAt: "2026-11-14T11:00:00.000Z" },
        { occurredAt: "2026-11-14T12:00:00.000Z" },
      ]),
    ).toEqual({ address: "DANA@illustrative.example", subject: "Re: Budget" });
    expect(
      requesterFrom([
        { from: dana, occurredAt: "2026-11-14T10:00:00.000Z" },
        { from: { address: "eve@illustrative.example" }, occurredAt: "2026-11-14T11:00:00.000Z" },
      ]),
    ).toBeNull();
  });

  test("the mail names the document, carries its link, and replies to the asker's subject", () => {
    const link = "https://illustrative.convex.site/d/abc";
    expect(deliveryMail({ filename: "Budget.docx", link, fallbackSubject: "Budget for Dana" })).toEqual({
      subject: "Budget for Dana",
      body: `Hi,\n\nHere is the Word document Budget.docx:\n${link}\n\nSent with TARS.`,
    });
    expect(deliveryMail({ filename: "B.docx", link, replyTo: "Budget", fallbackSubject: "x" }).subject).toBe("Re: Budget");
    expect(deliveryMail({ filename: "B.docx", link, replyTo: "RE: Budget", fallbackSubject: "x" }).subject).toBe("RE: Budget");
    expect(deliveryMail({ filename: "B.docx", link, replyTo: "a\r\nBcc: x", fallbackSubject: "x" }).subject).toBe("Re: a Bcc: x");
  });

  test("a reply is the draft text itself as the body, replying to the asker's subject, with no document or link", () => {
    const text = "Hi Dana,\n\nTravel is 400 and the venue 1200.\n\nAlice";
    expect(replyMail({ text, replyTo: "Budget", fallbackSubject: "Hi Dana," })).toEqual({ subject: "Re: Budget", body: text });
    expect(replyMail({ text, fallbackSubject: "Hi Dana," })).toEqual({ subject: "Hi Dana,", body: text });
    expect(replyMail({ text, replyTo: "RE: Budget", fallbackSubject: "x" }).subject).toBe("RE: Budget");
    expect(replyMail({ text, replyTo: "a\r\nBcc: x", fallbackSubject: "x" }).subject).toBe("Re: a Bcc: x");
    expect(replyMail({ text, fallbackSubject: "" }).subject).toBe("Re: your message");
    expect(replyMail({ text, replyTo: "Budget", fallbackSubject: "x" }).body).not.toMatch(/Word document|https?:\/\//);
  });

  test("a reply's stages are the send and its check only; a document (or no form) keeps all four", () => {
    expect(deliveryStages("reply")).toEqual(["send", "verify"]);
    expect(deliveryStages("document")).toEqual(["document", "link", "send", "verify"]);
    expect(deliveryStages(undefined)).toEqual(["document", "link", "send", "verify"]);
    const steps = deliverySteps({
      state: "succeeded",
      verified: true,
      recipient: "dana@illustrative.example",
      stages: deliveryStages("reply").map((name) => ({ name, state: "done" as const })),
    });
    expect(steps.map((s) => s.doneLabel).join(" ")).not.toMatch(/document|link/i);
  });

  test("a filename keeps only safe characters", () => {
    expect(safeFilename('Budget "Q4" / <Dana>')).toBe("Budget Q4 Dana.docx");
    expect(safeFilename("\u0000‮")).toBe("TARS document.docx");
  });
});
