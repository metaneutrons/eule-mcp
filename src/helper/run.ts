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
  /** base32 TOTP secret — passed to the helper via env (never argv) to
   *  auto-fill the MFA code. Password stays manual. */
  totpSecret?: string;
}

function run(subcommand: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    void ensureHelper()
      .then((bin) => {
        const child = spawn(bin, [subcommand, ...args], {
          stdio: "inherit",
          env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        });
        child.on("error", reject);
        child.on("close", (code) => {
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
  // Secret goes via env so it never appears in the process argument list.
  const extraEnv = o.totpSecret ? { EULE_TOTP_SECRET: o.totpSecret } : undefined;
  return run("oauth-capture", args, extraEnv);
}

/** Prompt for a secret in a local window; the helper writes it 0600 to `out`. */
export async function secretPrompt(label: string, out: string): Promise<number> {
  return run("secret-prompt", ["--label", label, "--out", out]);
}
