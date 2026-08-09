import { currentExecutionSignal } from "./execution-context.js";

/**
 * Shared security primitives used across connectors and the MCP server.
 *
 * These centralize the escaping / validation logic that prevents the classes
 * of bug an office assistant is most exposed to: header injection into
 * outgoing mail, SOAP/OData/iCal injection into upstream APIs, cleartext
 * credential transport, and unbounded network calls.
 */

/** Escapes text for XML element content and attribute values (EWS SOAP). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Escapes a value for a single-quoted OData string literal (Microsoft Graph
 * `$filter`). Per the OData spec a literal single quote is doubled.
 * `encodeURIComponent` does NOT encode `'`, so this must be applied before
 * URL-encoding the whole query.
 */
export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Escapes a text value for an iCalendar / vCard property value per RFC 5545
 * §3.3.11 and RFC 6350. Also neutralizes CR/LF so a value cannot inject
 * additional properties/lines into the object.
 */
export function escapeICalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/**
 * Inverse of {@link escapeICalText}: decodes an iCalendar/vCard TEXT value back
 * to its raw form. A single left-to-right pass so escaped backslashes are not
 * re-interpreted. Apply when READING a TEXT property so escape-on-write /
 * unescape-on-read round-trips symmetrically (otherwise repeated edits would
 * accumulate backslashes).
 */
export function unescapeICalText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/**
 * Rejects header-injection attempts in a value destined for an email header
 * (To/Cc/Bcc/Subject/From). Throws on CR or LF; returns the value otherwise.
 */
export function assertNoHeaderInjection(value: string, field = "header value"): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid ${field}: line breaks are not allowed in email headers.`);
  }
  return value;
}

/** Applies {@link assertNoHeaderInjection} to each address in a list. */
export function assertSafeAddresses(addrs: readonly string[], field = "recipient"): string[] {
  return addrs.map((a) => assertNoHeaderInjection(a, field));
}

/**
 * Turns a raw user string into a safe SQLite FTS5 MATCH expression by wrapping
 * it as a single quoted phrase (embedded double quotes doubled). This prevents
 * FTS syntax errors and operator injection from arbitrary input.
 */
export function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/**
 * True if `s` is a plausible base32 TOTP secret (RFC 4648 alphabet A–Z/2–7,
 * spaces/dashes allowed as grouping, optional `=` padding, ≥ 16 symbols). Used
 * to reject a mistyped/wrong-format secret before it's written to config.yaml —
 * the Rust helper only accepts base32.
 */
export function isBase32Secret(s: string): boolean {
  const cleaned = s.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z2-7]{16,}=*$/.test(cleaned);
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * Validates that a connector URL uses TLS. `https:` is always allowed; `http:`
 * is allowed only for loopback (local dev tools such as signal-cli). Any other
 * scheme/host throws — this stops credentials/tokens from being sent in
 * cleartext to a remote or hostile host.
 */
export function assertSecureUrl(rawUrl: string, label = "URL"): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${label}: ${rawUrl}`);
  }
  if (u.protocol === "https:") return rawUrl;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return rawUrl;
  throw new Error(
    `${label} must use https:// (refusing to send credentials over ${u.protocol}// to ${u.hostname}).`,
  );
}

/**
 * `fetch` with a hard timeout so a slow/hostile endpoint cannot hang a tool
 * call indefinitely. Aborts after `timeoutMs` and surfaces a clear error.
 */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const executionSignal = currentExecutionSignal();
  const signals = [init.signal, executionSignal, controller.signal].filter(
    (signal): signal is AbortSignal => signal != null,
  );
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if ((init.signal?.aborted || executionSignal?.aborted) && !controller.signal.aborted) {
        throw new Error(`Request cancelled: ${String(input)}`, { cause: err });
      }
      throw new Error(`Request timed out after ${String(timeoutMs)}ms: ${String(input)}`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Default cap (bytes) for buffering a remote response body into memory. */
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/**
 * Rejects a response whose declared Content-Length exceeds `maxBytes`, guarding
 * against memory-exhaustion from a hostile/huge body before it is buffered.
 */
export function assertResponseSize(res: Response, maxBytes = MAX_RESPONSE_BYTES): void {
  const len = res.headers.get("content-length");
  if (len && Number(len) > maxBytes) {
    throw new Error(`Response too large (${len} bytes > ${String(maxBytes)} byte limit).`);
  }
}
