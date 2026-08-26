/** Spawn the native eule-helper, inheriting stdio so its window + status show. */
import { spawn } from "node:child_process";
import { ensureHelper } from "./download.js";

export interface OauthCaptureOpts {
  clientId: string;
  tier: string;
  apiVersion: "v1" | "v2";
  resource?: string;
  scope?: string;
  tenant?: string;
  loginHint?: string;
  redirectUri?: string;
  /** Opaque OS-store reference; the native helper resolves it directly. */
  totpCredentialRef?: string;
  /** Opaque OS-store reference for opt-in Microsoft password autofill. */
  passwordCredentialRef?: string;
  /** Cancels the local helper when the owning MCP operation is cancelled. */
  signal?: AbortSignal;
}

function run(
  subcommand: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Local helper request was cancelled"));
      return;
    }
    void ensureHelper()
      .then((bin) => {
        if (signal?.aborted) {
          reject(new Error("Local helper request was cancelled"));
          return;
        }
        const child = spawn(bin, [subcommand, ...args], {
          // stdout is the MCP transport when invoked by the server; never inherit it.
          stdio: ["ignore", "ignore", "inherit"],
          env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        });
        const abort = (): void => {
          child.kill();
        };
        signal?.addEventListener("abort", abort, { once: true });
        child.on("error", reject);
        child.on("close", (code) => {
          signal?.removeEventListener("abort", abort);
          resolve(code ?? 1);
        });
      })
      .catch(reject);
  });
}

/** Interactive webview OAuth capture; the helper writes ~/.eule/tokens.json itself. */
export async function oauthCapture(o: OauthCaptureOpts): Promise<number> {
  const args = ["--client-id", o.clientId, "--tier", o.tier, "--api-version", o.apiVersion];
  if (o.resource) args.push("--resource", o.resource);
  if (o.scope) args.push("--scope", o.scope);
  if (o.tenant) args.push("--tenant", o.tenant);
  if (o.loginHint) args.push("--login-hint", o.loginHint);
  if (o.redirectUri) args.push("--redirect-uri", o.redirectUri);
  if (o.totpCredentialRef) args.push("--totp-credential-ref", o.totpCredentialRef);
  if (o.passwordCredentialRef) args.push("--password-credential-ref", o.passwordCredentialRef);
  return run("oauth-capture", args, undefined, o.signal);
}

/** Prompt for a secret in a local window; the helper writes it 0600 to `out`. */
export async function secretPrompt(label: string, out: string): Promise<number> {
  return run("secret-prompt", ["--label", label, "--out", out]);
}

/** Prompt locally and save directly to the native OS credential store. */
export async function credentialPrompt(
  label: string,
  reference: string,
  signal?: AbortSignal,
  format?: "opaque" | "totp",
): Promise<number> {
  const args = ["--label", label, "--credential", reference];
  if (format) args.push("--format", format);
  return run("secret-prompt", args, undefined, signal);
}
