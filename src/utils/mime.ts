/** RFC 2047 encode a header value for non-ASCII content. */
export function mimeEncode(value: string): string {
  // Pass through only printable ASCII (0x20–0x7E). Anything else — non-ASCII OR
  // a control character such as CR/LF/TAB — is base64-encoded. Besides meeting
  // RFC 2047 this neutralizes header (CRLF) injection via the subject, since a
  // raw newline can no longer survive into the assembled header block.
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}
