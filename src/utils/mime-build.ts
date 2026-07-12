import { randomBytes } from "node:crypto";
import { mimeEncode } from "./mime.js";
import { assertNoHeaderInjection } from "./security.js";
import type { OutgoingAttachment } from "../types/index.js";

export interface MimeHeaders {
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  /** Message-ID this is a reply to (angle brackets included). */
  inReplyTo?: string;
  /** References header value (angle brackets included). */
  references?: string;
}

/** Base64-encode a buffer folded into 76-character MIME lines. */
function base64Lines(buf: Buffer): string {
  return buf.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

/**
 * Encode a Content-Disposition/Content-Type filename. ASCII filenames use a
 * plain quoted value; non-ASCII uses RFC 2231 (`filename*=UTF-8''…`). CR/LF are
 * rejected up-front so a crafted filename can never inject MIME headers.
 */
function encodeFilename(param: string, filename: string): string {
  const safe = assertNoHeaderInjection(filename, "attachment filename").replace(/"/g, "");
  if (/^[\x20-\x7E]*$/.test(safe)) return `${param}="${safe}"`;
  return `${param}*=UTF-8''${encodeURIComponent(safe)}`;
}

function attachmentPart(boundary: string, att: OutgoingAttachment): string {
  const ctype = att.contentType ?? "application/octet-stream";
  const disposition = att.cid ? "inline" : "attachment";
  const lines = [
    `--${boundary}`,
    `Content-Type: ${assertNoHeaderInjection(ctype, "attachment content-type")}; ${encodeFilename("name", att.filename)}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}; ${encodeFilename("filename", att.filename)}`,
  ];
  if (att.cid) lines.push(`Content-ID: <${assertNoHeaderInjection(att.cid, "attachment cid")}>`);
  lines.push("", base64Lines(att.content));
  return lines.join("\r\n");
}

/**
 * Build a raw RFC 5322 message. With no attachments it is a single `text/html`
 * part; with attachments it becomes `multipart/mixed` (inline `cid:` parts get
 * a `Content-ID` and `Content-Disposition: inline`). Returned as a UTF-8 string
 * ready for Gmail (`base64url`) or IMAP `APPEND`.
 */
export function buildMimeMessage(
  headers: MimeHeaders,
  html: string,
  attachments?: readonly OutgoingAttachment[],
): string {
  const head: string[] = [];
  if (headers.from) head.push(`From: ${assertNoHeaderInjection(headers.from, "From")}`);
  head.push(`To: ${assertNoHeaderInjection(headers.to, "To")}`);
  if (headers.cc) head.push(`Cc: ${assertNoHeaderInjection(headers.cc, "Cc")}`);
  if (headers.bcc) head.push(`Bcc: ${assertNoHeaderInjection(headers.bcc, "Bcc")}`);
  head.push(`Subject: ${mimeEncode(headers.subject)}`);
  if (headers.inReplyTo)
    head.push(`In-Reply-To: ${assertNoHeaderInjection(headers.inReplyTo, "In-Reply-To")}`);
  if (headers.references)
    head.push(`References: ${assertNoHeaderInjection(headers.references, "References")}`);
  head.push("MIME-Version: 1.0");

  if (!attachments?.length) {
    head.push("Content-Type: text/html; charset=utf-8");
    return `${head.join("\r\n")}\r\n\r\n${html}`;
  }

  const boundary = `----=_eule_${randomBytes(16).toString("hex")}`;
  head.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const body = [
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    ...attachments.map((a) => attachmentPart(boundary, a)),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return `${head.join("\r\n")}\r\n\r\n${body}`;
}
