import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

// Remove images (tracking pixels, logos).
turndown.addRule("removeImages", {
  filter: "img",
  replacement: () => "",
});

// Remove style/script tags.
turndown.addRule("removeStyle", {
  filter: ["style", "script"],
  replacement: () => "",
});

/** Patterns that indicate the start of a quoted reply. */
const THREAD_SEPARATORS = [
  /^-{3,}\s*Original Message\s*-{3,}/im,
  /^-{3,}\s*Ursprüngliche Nachricht\s*-{3,}/im,
  /^-{3,}\s*Weitergeleitete Nachricht\s*-{3,}/im,
  /^-{3,}\s*Forwarded message\s*-{3,}/im,
  /^Am .+ schrieb .+:$/m,
  /^On .+ wrote:$/m,
  /^Von:\s*.+$/m,
  /^From:\s*.+$/m,
  /^Gesendet:\s*.+$/m,
  /^Sent:\s*.+$/m,
  /^>{3,}/m,
];

/** Patterns that indicate an email signature. */
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

export interface ThreadMessage {
  header: string;
  body: string;
}

/** Unescape XML/HTML entities that may come from SOAP responses. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n as string, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n as string, 16)));
}

/** Convert HTML email body to clean Markdown. */
export function htmlToMarkdown(html: string): string {
  // Unescape entities from XML wrapping, then strip noise.
  let cleaned = unescapeHtml(html)
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<o:p>[\s\S]*?<\/o:p>/gi, "")
    .replace(/&nbsp;/g, " ");

  return turndown.turndown(cleaned).trim();
}

/** Split an email body into thread messages (newest first). */
export function splitThread(text: string): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  let remaining = text;

  for (const sep of THREAD_SEPARATORS) {
    const match = sep.exec(remaining);
    if (match && match.index !== undefined && match.index > 50) {
      // Found a separator — everything before it is the current message.
      messages.push({
        header: "",
        body: remaining.slice(0, match.index).trim(),
      });
      remaining = remaining.slice(match.index).trim();
      break;
    }
  }

  // If no separator found, the whole text is one message.
  if (messages.length === 0) {
    return [{ header: "", body: remaining.trim() }];
  }

  // The rest is the quoted thread — split further recursively.
  if (remaining.length > 0) {
    // Extract header line(s) from the separator.
    const lines = remaining.split("\n");
    let headerEnd = 0;
    for (let i = 0; i < Math.min(lines.length, 6); i++) {
      if (lines[i]?.trim() === "") {
        headerEnd = i + 1;
        break;
      }
      headerEnd = i + 1;
    }
    const header = lines.slice(0, headerEnd).join("\n").trim();
    const body = lines.slice(headerEnd).join("\n").trim();

    // Recursively split the quoted part.
    const nested = splitThread(body);
    if (nested.length > 0 && nested[0]) {
      nested[0].header = header;
    }
    messages.push(...nested);
  }

  return messages;
}

/** Remove email signature from text. */
export function removeSignature(text: string): string {
  let cutIndex = text.length;

  for (const pattern of SIGNATURE_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index !== undefined && match.index > 50 && match.index < cutIndex) {
      cutIndex = match.index;
    }
  }

  return text.slice(0, cutIndex).trim();
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

  // Raw: return as-is.
  if (format === "raw") {
    return truncate(body, maxLength);
  }

  // Convert HTML to text/markdown.
  let text = bodyType === "html" ? htmlToMarkdown(body) : body;

  // Plain: just strip HTML, no thread splitting.
  if (format === "plain") {
    return truncate(removeSignature(text), maxLength);
  }

  // Markdown: split thread, apply depth, remove signatures.
  const thread = splitThread(text);

  const selected = depth === 0 ? thread : thread.slice(0, depth);

  const parts = selected.map((msg, i) => {
    const cleaned = removeSignature(msg.body);
    if (i === 0) return cleaned;
    const header = msg.header ? `\n---\n${msg.header}\n\n` : "\n---\n\n";
    return header + cleaned;
  });

  let result = parts.join("\n");

  if (depth > 0 && thread.length > depth) {
    result += `\n\n[...${String(thread.length - depth)} earlier message(s) truncated, use depth=0 for full thread]`;
  }

  return truncate(result, maxLength);
}

function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0 || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n\n[...truncated at " + String(maxLength) + " chars]";
}
