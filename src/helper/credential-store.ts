import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { currentExecutionSignal } from "../utils/execution-context.js";
import { helperPath } from "./download.js";
import { credentialPrompt, oathPrompt } from "./run.js";

export type CredentialState = "configured" | "missing" | "unavailable";
export interface CredentialCaptureOptions {
  readonly format?: "opaque" | "totp";
}

export interface CredentialBroker {
  capture(reference: string, label: string, options?: CredentialCaptureOptions): Promise<void>;
  read(reference: string, euleDir: string): string;
  status(reference: string): CredentialState;
  remove(reference: string): void;
}

/** Native credential broker. No secret crosses stdout, argv, MCP, or model context. */
export class NativeCredentialBroker implements CredentialBroker {
  private readonly cache = new Map<string, string>();
  private captureTail: Promise<void> = Promise.resolve();

  async capture(
    reference: string,
    label: string,
    options?: CredentialCaptureOptions,
  ): Promise<void> {
    const previous = this.captureTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.captureTail = previous.then(() => gate);
    await previous;
    try {
      const code = await credentialPrompt(
        label,
        reference,
        currentExecutionSignal(),
        options?.format,
      );
      if (code !== 0)
        throw new Error(code === 3 ? "Credential entry cancelled" : "Credential entry failed");
      this.cache.delete(reference);
    } finally {
      release();
    }
  }

  read(reference: string, euleDir: string): string {
    const cached = this.cache.get(reference);
    if (cached !== undefined) return cached;
    const output = join(euleDir, `.credential-${randomBytes(12).toString("hex")}.tmp`);
    try {
      execFileSync(helperPath(), ["credential", "get", reference, output], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 30_000,
      });
      const secret = readFileSync(output, "utf8");
      this.cache.set(reference, secret);
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

  status(reference: string): CredentialState {
    try {
      const result = execFileSync(helperPath(), ["credential", "status", reference], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      }).trim();
      return result === "configured" ? "configured" : "missing";
    } catch {
      return "unavailable";
    }
  }

  remove(reference: string): void {
    execFileSync(helperPath(), ["credential", "delete", reference], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
    this.cache.delete(reference);
  }
}

export const nativeCredentialBroker = new NativeCredentialBroker();

/** State of a YubiKey credential; `detail` says why the key is unavailable. */
export interface OathCredentialStatus {
  readonly state: CredentialState;
  readonly detail?: string;
}

/** TOTP credentials on a YubiKey. The seed goes from the helper's local window
 *  straight to the key; Node only ever handles the credential name. */
export interface OathCredentialBroker {
  provision(
    name: string,
    label: string,
    options: { readonly touch: boolean; readonly replace: boolean },
  ): Promise<void>;
  status(name: string): OathCredentialStatus;
  remove(name: string): void;
}

export class NativeOathBroker implements OathCredentialBroker {
  async provision(
    name: string,
    label: string,
    options: { readonly touch: boolean; readonly replace: boolean },
  ): Promise<void> {
    const code = await oathPrompt(label, name, options, currentExecutionSignal());
    if (code !== 0)
      throw new Error(
        code === 3 ? "Credential entry cancelled" : "Writing the YubiKey credential failed",
      );
  }

  status(name: string): OathCredentialStatus {
    try {
      const result = execFileSync(helperPath(), ["oath", "status", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      }).trim();
      if (result === "configured" || result === "missing") return { state: result };
      return { state: "unavailable", detail: result.replace(/^unavailable:\s*/, "") };
    } catch {
      return { state: "unavailable", detail: "the native helper could not be run" };
    }
  }

  remove(name: string): void {
    execFileSync(helperPath(), ["oath", "delete", name], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30_000,
    });
  }
}

export const nativeOathBroker = new NativeOathBroker();

/** Compatibility wrappers for existing consumers. */
export function readCredential(reference: string, euleDir: string): string {
  return nativeCredentialBroker.read(reference, euleDir);
}

export function deleteCredential(reference: string): void {
  nativeCredentialBroker.remove(reference);
}
