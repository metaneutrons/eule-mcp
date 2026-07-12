import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { secureReadPath } from "./path-sandbox.js";
import { assertNoHeaderInjection } from "./security.js";
import type { OutgoingAttachment } from "../types/index.js";

/** Per-attachment and total-payload byte cap for outgoing mail. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Minimal extension → MIME type map for sniffing when the OS doesn't tell us. */
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".ics": "text/calendar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

function sniffContentType(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a list of user/LLM-supplied file paths into {@link OutgoingAttachment}s.
 *
 * Every path is confined to `~/Downloads`, `~/Documents`, `~/Desktop` via
 * {@link secureReadPath} — this deliberately excludes `~/.eule` (config +
 * tokens) so a prompt-injected model cannot attach secrets to an outgoing mail.
 * Per-file and cumulative size are capped, and the derived filename is checked
 * for header-injection before it ever reaches a MIME/Content-Disposition header.
 */
export function resolveAttachmentPaths(paths: readonly string[]): OutgoingAttachment[] {
  let total = 0;
  return paths.map((p) => {
    const abs = secureReadPath(p);
    const filename = assertNoHeaderInjection(basename(abs), "attachment filename");
    if (!filename || filename === "." || filename === "..")
      throw new Error(`Invalid attachment filename for path: ${p}`);

    const { size } = statSync(abs);
    if (size > MAX_ATTACHMENT_BYTES)
      throw new Error(
        `Attachment ${filename} is ${String(Math.round(size / 1024 / 1024))}MB — exceeds the ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit.`,
      );
    total += size;
    if (total > MAX_ATTACHMENT_BYTES)
      throw new Error(
        `Total attachment size exceeds the ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit.`,
      );

    return { filename, content: readFileSync(abs), contentType: sniffContentType(filename) };
  });
}
