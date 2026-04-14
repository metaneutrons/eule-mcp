import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import type { FileConnector } from "../types/index.js";

const CACHE_DIR = join(homedir(), ".eule", "cache");
const FRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 min before metadata check

/** File extensions pandoc can convert to markdown. */
const PANDOC_FORMATS: Record<string, string> = {
  ".docx": "docx",
  ".pptx": "pptx",
  ".odt": "odt",
  ".epub": "epub",
  ".rtf": "rtf",
  ".html": "html",
  ".htm": "html",
  ".csv": "csv",
  ".tsv": "tsv",
  ".tex": "latex",
  ".rst": "rst",
  ".org": "org",
};

interface CacheMeta {
  lastModified: string;
  checkedAt: number;
  name: string;
}

let pandocAvailable: boolean | undefined;

function hasPandoc(): boolean {
  if (pandocAvailable !== undefined) return pandocAvailable;
  try {
    execFileSync("pandoc", ["--version"], { stdio: "ignore" });
    pandocAvailable = true;
  } catch {
    pandocAvailable = false;
  }
  return pandocAvailable;
}

function cacheKey(account: string, fileId: string): string {
  return createHash("sha256").update(`${account}:${fileId}`).digest("hex").slice(0, 16);
}

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function convertWithPandoc(srcPath: string, format: string): string {
  return execFileSync("pandoc", ["-f", format, "-t", "markdown", srcPath], {
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * Read a remote file with smart caching and optional pandoc conversion.
 * Returns { content, name, converted } where converted indicates pandoc was used.
 */
export async function cachedFileRead(
  connector: FileConnector,
  fileId: string,
): Promise<{ content: string; name: string; converted: boolean }> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKey(connector.account, fileId);
  const mdPath = join(CACHE_DIR, `${key}.md`);
  const metaPath = join(CACHE_DIR, `${key}.meta.json`);

  // Check cache
  if (existsSync(mdPath) && existsSync(metaPath)) {
    const meta: CacheMeta = JSON.parse(readFileSync(metaPath, "utf-8")) as CacheMeta;
    const age = Date.now() - meta.checkedAt;

    if (age < FRESH_THRESHOLD_MS) {
      // Fresh enough — serve from cache
      return { content: readFileSync(mdPath, "utf-8"), name: meta.name, converted: true };
    }

    // Stale — lightweight metadata check
    if (connector.getMetadata) {
      const remote = await connector.getMetadata(fileId);
      if (remote.lastModified === meta.lastModified) {
        // Unchanged — refresh checkedAt and serve cache
        meta.checkedAt = Date.now();
        writeFileSync(metaPath, JSON.stringify(meta));
        return { content: readFileSync(mdPath, "utf-8"), name: meta.name, converted: true };
      }
    }
  }

  // Cache miss or stale — get metadata + download
  let name = fileId;
  let lastModified = "";
  if (connector.getMetadata) {
    const meta = await connector.getMetadata(fileId);
    name = meta.name;
    lastModified = meta.lastModified;
  }

  const format = PANDOC_FORMATS[ext(name)];
  if (format && hasPandoc() && connector.downloadFile) {
    // Download binary + convert via pandoc
    const buf = await connector.downloadFile(fileId);
    const srcPath = join(CACHE_DIR, `${key}${ext(name)}`);
    writeFileSync(srcPath, buf);
    const md = convertWithPandoc(srcPath, format);
    writeFileSync(mdPath, md);
    writeFileSync(
      metaPath,
      JSON.stringify({ lastModified, checkedAt: Date.now(), name } satisfies CacheMeta),
    );
    return { content: md, name, converted: true };
  }

  // Fallback: text-based getContent
  const content = await connector.getContent(fileId);
  return { content, name, converted: false };
}
