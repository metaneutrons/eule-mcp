import { marked } from "marked";

/** Convert Markdown/plain text to HTML. */
export function markdownToHtml(text: string): string {
  return marked.parse(text, { async: false });
}

/** Build an Outlook/Gmail-style quote block from original message HTML. */
export function buildQuoteBlock(
  from: string,
  date: string,
  to: string,
  subject: string,
  originalHtml: string,
): string {
  const d = new Date(date);
  const formatted = d.toLocaleString("de-DE", { dateStyle: "full", timeStyle: "short" });
  return `<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0 0 0">
<p style="font-size:11pt;font-family:Calibri,sans-serif;color:#444"><b>Von:</b> ${esc(from)}<br><b>Gesendet:</b> ${esc(formatted)}<br><b>An:</b> ${esc(to)}<br><b>Betreff:</b> ${esc(subject)}</p>
</div>
<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${originalHtml}</blockquote>`;
}

/** Assemble a full HTML email: body + signature + optional quote. */
export function assembleHtml(bodyMd: string, signature?: string, quoteHtml?: string): string {
  const body = markdownToHtml(bodyMd);
  const parts = [`<div style="font-family:Calibri,sans-serif;font-size:11pt">${body}</div>`];
  if (signature) parts.push(`<br>${signature}`);
  if (quoteHtml) parts.push(`<hr style="border:none;border-top:solid #E1E1E1 1.0pt">${quoteHtml}`);
  return parts.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
