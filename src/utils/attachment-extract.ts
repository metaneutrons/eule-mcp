import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docxToText, NoTextError, pdfToText } from "./document-text.js";
import { convertWithPandoc, ext, hasPandoc, PANDOC_FORMATS } from "./file-cache.js";

/** Extensions we treat as plain UTF-8 text (no conversion needed). */
const TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".log",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".ics",
  ".eml",
  ".srt",
]);

/** Binary office formats only pandoc can read; decoding them as UTF-8 yields garbage. */
const PANDOC_ONLY = new Set([".pptx", ".odt", ".epub", ".rtf"]);

const SAVE_HINT = 'Use mode "save" to store the file and open it locally.';

export interface ExtractResult {
  text: string;
  /** How the text was produced: unpdf | pandoc | docx | utf-8 | utf-8-fallback. */
  method: string;
}

/**
 * Extract readable text from attachment bytes without depending on anything
 * outside the Node runtime: PDFs through unpdf, DOCX through the built-in
 * reader. pandoc, when installed, still handles DOCX and the other office
 * formats because its Markdown is richer. Temp files for pandoc are named with
 * random bytes and passed as literal arguments, so an attacker-chosen filename
 * cannot inject anything.
 */
export async function extractAttachmentText(buf: Buffer, filename: string): Promise<ExtractResult> {
  const e = ext(filename);

  if (TEXT_EXTS.has(e)) return { text: buf.toString("utf-8"), method: "utf-8" };

  try {
    if (e === ".pdf") return { text: await pdfToText(buf), method: "unpdf" };

    const pandocFormat = hasPandoc() ? PANDOC_FORMATS[e] : undefined;
    if (pandocFormat) return { text: pandocText(buf, e, pandocFormat), method: "pandoc" };

    if (e === ".docx") return { text: docxToText(buf), method: "docx" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${filename}: ${message} ${SAVE_HINT}`, { cause: error });
  }

  if (PANDOC_ONLY.has(e))
    throw new Error(
      `${filename}: reading ${e} files needs pandoc, which is not installed. ${SAVE_HINT}`,
    );
  return { text: buf.toString("utf-8"), method: "utf-8-fallback" };
}

function pandocText(buf: Buffer, extension: string, format: string): string {
  const tmp = join(tmpdir(), `eule-att-${randomBytes(8).toString("hex")}${extension}`);
  try {
    writeFileSync(tmp, buf);
    return convertWithPandoc(tmp, format);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp file may not exist — ignore */
    }
  }
}

export { NoTextError };
