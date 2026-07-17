import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { helperPath } from "./download.js";

const cache = new Map<string, string>();

/** Retrieve a secret through the native helper without exposing it on stdout. */
export function readCredential(reference: string, euleDir: string): string {
  const cached = cache.get(reference);
  if (cached !== undefined) return cached;
  const output = join(euleDir, `.credential-${randomBytes(12).toString("hex")}.tmp`);
  try {
    execFileSync(helperPath(), ["credential", "get", reference, output], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
    const secret = readFileSync(output, "utf8");
    cache.set(reference, secret);
    return secret;
  } catch (error) {
    throw new Error(`Unable to retrieve credential "${reference}" from the OS credential store`, {
      cause: error,
    });
  } finally {
    try {
      unlinkSync(output);
    } catch {
      // The helper may have failed before creating the file.
    }
  }
}

/** Delete a connector credential after its configuration binding is removed. */
export function deleteCredential(reference: string): void {
  execFileSync(helperPath(), ["credential", "delete", reference], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 30_000,
  });
  cache.delete(reference);
}
