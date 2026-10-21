import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { logger } from "../utils/logger.js";

/** Longest signature (inline HTML or file) the control plane accepts. */
export const SIGNATURE_MAX_LENGTH = 20_000;

/** A value without markup that ends in `.html`/`.htm` names a file. */
export function isSignatureFile(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed.includes("<") && /\.html?$/i.test(trimmed);
}

function expandHome(value: string): string {
  return value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
}

/**
 * HTML for a role's signature at the time a mail is built. A file reference is
 * read now, not when the config loads, so editing the file takes effect on the
 * next mail without a restart. A reference that cannot be read yields no
 * signature rather than the path as text.
 */
export function resolveSignature(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!isSignatureFile(value)) return value;
  const path = expandHome(value.trim());
  try {
    return readFileSync(path, "utf-8");
  } catch {
    logger.warn(`Signature file "${value}" cannot be read; sending without signature.`);
    return undefined;
  }
}

/**
 * Checks a signature that arrives through the MCP tools. Whatever it names is
 * appended to every mail of the role, so a file must live below `~/.eule`
 * (symbolic links resolved) and the content has a size limit.
 */
export function assertSignatureAllowed(value: string, home: string = homedir()): void {
  if (!isSignatureFile(value)) {
    if (value.length > SIGNATURE_MAX_LENGTH)
      throw new Error(`Signature HTML is longer than ${String(SIGNATURE_MAX_LENGTH)} characters.`);
    return;
  }
  const trimmed = value.trim();
  const path = trimmed.startsWith("~") ? join(home, trimmed.slice(1)) : trimmed;
  const baseDir = join(home, ".eule");
  if (!existsSync(path)) throw new Error(`Signature file "${value}" does not exist.`);
  const real = realpathSync(path);
  const base = existsSync(baseDir) ? realpathSync(baseDir) : baseDir;
  if (!real.startsWith(base + sep))
    throw new Error("Signature files must be stored below ~/.eule/.");
  if (readFileSync(real, "utf-8").length > SIGNATURE_MAX_LENGTH)
    throw new Error(`Signature file is longer than ${String(SIGNATURE_MAX_LENGTH)} characters.`);
}

/** One-line description for config_get and role_list; never the HTML itself. */
export function describeSignature(value: string | undefined): string {
  if (!value) return "—";
  return isSignatureFile(value)
    ? `file ${value.trim()}`
    : `inline HTML (${String(value.length)} chars)`;
}
