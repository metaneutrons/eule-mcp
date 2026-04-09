import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

turndown.addRule("removeImages", { filter: "img", replacement: () => "" });
turndown.addRule("removeStyle", { filter: ["style", "script"], replacement: () => "" });

/** Patterns that indicate an email signature in plain text. */
const SIGNATURE_PATTERNS = [
  /^--\s*$/m,
  /^_{3,}$/m,
  /^Mit freundlichen Grüßen/im,
  /^Best regards/im,
  /^Kind regards/im,
  /^Viele Grüße/im,
  /^Freundliche Grüße/im,
  /^Sent from my iPhone/im,
  /^Sent from Outlook/im,
  /^Von meinem iPhone gesendet/im,
  /^Get Outlook for/im,
];

/** Plain text thread separators. */
const TEXT_SEPARATORS = [
  /^-{3,}\s*Original Message\s*-{3,}/im,
  /^-{3,}\s*Ursprüngliche Nachricht\s*-{3,}/im,
  /^-{3,}\s*Weitergeleitete Nachricht\s*-{3,}/im,
  /^-{3,}\s*Forwarded message\s*-{3,}/im,
  /^Am .+ schrieb .+:$/m,
  /^On .+ wrote:$/m,
];

export interface ThreadMessage {
  header: string;
  body: string;
}

/** Split HTML email body into thread parts using HTML markers. */
function splitHtmlThread(html: string): string[] {

  // Strategy 1: Split on <div id="divRplyFwdMsg"> (Outlook/OWA)
  // The <hr> + divRplyFwdMsg pattern is the most common in enterprise email.
  const outlookSplit = html.split(/<hr[^>]*>[\s\S]*?<div\s+id=["']divRplyFwdMsg["'][^>]*>/i);
  if (outlookSplit.length > 1) {
    return outlookSplit;
  }

  // Strategy 2: Split on <div id="appendonsend"> (Outlook marker)
  const appendSplit = html.split(/<div\s+id=["']appendonsend["'][^>]*>[\s\S]*?<hr[^>]*>/i);
  if (appendSplit.length > 1) {
    return appendSplit;
  }

  // Strategy 3: Split on <blockquote> (Gmail, Apple Mail)
  const bqMatch = html.match(/^([\s\S]*?)<blockquote[^>]*>([\s\S]*)$/i);
  if (bqMatch && bqMatch[1] && bqMatch[2]) {
    return [bqMatch[1], bqMatch[2]];
  }

  // No split found — return as single part.
  return [html];
}

/** Convert a single HTML fragment to clean Markdown. */
function htmlFragmentToMarkdown(html: string): string {
  const cleaned = html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<o:p>[\s\S]*?<\/o:p>/gi, "")
    .replace(/&nbsp;/g, " ");
  return turndown.turndown(cleaned).trim();
}

/** Split plain text into thread messages. */
function splitTextThread(text: string): string[] {
  for (const sep of TEXT_SEPARATORS) {
    const match = sep.exec(text);
    if (match?.index !== undefined && match.index > 50) {
      return [text.slice(0, match.index).trim(), text.slice(match.index).trim()];
    }
  }
  return [text];
}

/** Extract a reply header from a thread part (Von/From + Gesendet/Sent). */
function extractReplyHeader(text: string): string {
  const lines = text.split("\n").slice(0, 8);
  const headerLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(\*\*)?(?:Von|From|Gesendet|Sent|An|To|Cc|Betreff|Subject)\b/i.test(trimmed)) {
      headerLines.push(trimmed);
    }
  }
  return headerLines.join("\n");
}

/** Remove email signature from text. */
export function removeSignature(text: string): string {
  let cutIndex = text.length;
  for (const pattern of SIGNATURE_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.index !== undefined && match.index > 50 && match.index < cutIndex) {
      cutIndex = match.index;
    }
  }
  return text.slice(0, cutIndex).trim();
}

/** Convert HTML email body to clean Markdown. */
export function htmlToMarkdown(html: string): string {
  return htmlFragmentToMarkdown(html);
}

/** Render an email body for LLM consumption. */
export function renderMail(opts: {
  body: string;
  bodyType: "html" | "text";
  depth?: number;
  maxLength?: number;
  format?: "markdown" | "raw" | "plain";
}): string {
  const { body, bodyType, depth = 1, maxLength = 4000, format = "markdown" } = opts;

  if (format === "raw") return truncate(body, maxLength);

  if (format === "plain") {
    const text = bodyType === "html" ? htmlFragmentToMarkdown(body) : body;
    return truncate(removeSignature(text), maxLength);
  }

  // Markdown format: split thread, apply depth.
  let threadParts: string[];

  if (bodyType === "html") {
    // Split in HTML first (more reliable markers), then convert each part.
    const htmlParts = splitHtmlThread(body);
    threadParts = htmlParts.map((part) => htmlFragmentToMarkdown(part));
  } else {
    threadParts = splitTextThread(body);
  }

  // Apply depth.
  const selected = depth === 0 ? threadParts : threadParts.slice(0, depth);

  const rendered = selected.map((part, i) => {
    const cleaned = removeSignature(part);
    if (i === 0) return cleaned;
    const header = extractReplyHeader(part);
    return header ? `\n---\n${header}\n\n${cleaned}` : `\n---\n\n${cleaned}`;
  });

  let result = rendered.join("\n");

  if (depth > 0 && threadParts.length > depth) {
    result += `\n\n[...${String(threadParts.length - depth)} earlier message(s), use depth=0 for full thread]`;
  }

  return truncate(result, maxLength);
}

function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0 || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n\n[...truncated at " + String(maxLength) + " chars]";
}

/** Split an email thread (exported for testing). */
export function splitThread(text: string): ThreadMessage[] {
  const parts = splitTextThread(text);
  return parts.map((p) => ({ header: extractReplyHeader(p), body: p }));
}
