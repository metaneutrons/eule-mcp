import { ConfigManager } from "../config/index.js";
import {
  authenticateAccount,
  authenticateAccountDeviceCode,
  tierAuthParam,
  loadTokens,
} from "../providers/m365/index.js";
import { oauthCapture, secretPrompt } from "../helper/run.js";
import { isBase32Secret } from "../utils/security.js";
import { readFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ApiTier, OAuthConfig } from "../types/index.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

/** Minimal --flag / --flag value parser for the flags after the command word. */
function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** Deprecated — kept as a thin alias so existing docs/muscle-memory still work.
 *  `login` is the real entry (device-code / webview capture / browser). */
async function setup(): Promise<void> {
  const tokens = loadTokens();
  console.log("Note: `setup` is deprecated — use `login`. Delegating…\n");
  if (Object.keys(tokens.accounts).length > 0) {
    console.log("Authenticated accounts:");
    for (const [account, token] of Object.entries(tokens.accounts)) {
      const expired = token.expiresAt < Date.now() ? " (expired, will refresh)" : "";
      console.log(`  ${account}: tier ${token.tier}${expired}`);
    }
    console.log(
      "\nTip: eule-mcp login --device --tier ews   (or --capture for broker-only clients)\n",
    );
  }
  // Any flags after `setup` are honoured by login() (it parses args.slice(1)).
  await login();
}

async function login(): Promise<void> {
  const flags = parseFlags(args.slice(1));
  const config = new ConfigManager().get();

  const tier: ApiTier = (
    ["graph", "ews", "imap"].includes(String(flags.tier)) ? String(flags.tier) : "ews"
  ) as ApiTier;
  const account = typeof flags.account === "string" ? flags.account : undefined;

  // Overlay CLI flags on the configured oauth defaults. --client-id lets you
  // pick the app the tenant actually consents (e.g. Apple Internet Accounts for
  // EWS); --api-version v1 is required for legacy public clients.
  const apiVersion =
    flags["api-version"] === "v1" || flags["api-version"] === "v2"
      ? flags["api-version"]
      : config.oauth.apiVersion;
  const oauth: OAuthConfig = {
    clientId: typeof flags["client-id"] === "string" ? flags["client-id"] : config.oauth.clientId,
    tenant: typeof flags.tenant === "string" ? flags.tenant : config.oauth.tenant,
    apiVersion,
  };

  try {
    if (flags.capture) {
      // Webview capture via the native eule-helper — for clients whose only
      // redirect URIs are broker-bound (e.g. Apple Internet Accounts EWS), where
      // neither the paste-redirect nor device-code flow works. The helper writes
      // tokens.json itself; the secret/code never returns through this process.
      const param = tierAuthParam(oauth, tier);
      // Opt-in MFA autofill: if this account has a TOTP secret in autoAuth, hand
      // it to the helper (via env, not argv) so it auto-enters the code. Skipped
      // with --no-totp. The password is always typed by the user.
      const totpSecret =
        flags["no-totp"] || !account
          ? undefined
          : config.autoAuth?.find((a) => a.account === account)?.totpSecret;
      console.log(
        `\nWebview capture — tier ${tier}, client ${oauth.clientId}` +
          `${totpSecret ? " (auto-TOTP)" : ""}\n`,
      );
      const code = await oauthCapture({
        clientId: oauth.clientId,
        tier,
        apiVersion: oauth.apiVersion === "v1" ? "v1" : "v2",
        resource: "resource" in param ? param.resource : undefined,
        scope: "scope" in param ? param.scope : undefined,
        tenant: oauth.tenant,
        loginHint: account,
        redirectUri: typeof flags["redirect-uri"] === "string" ? flags["redirect-uri"] : undefined,
        totpSecret,
      });
      if (code !== 0) process.exit(code);
      console.log("\n✅ Token written to ~/.eule/tokens.json");
      return;
    }
    if (flags.device) {
      console.log(`\nDevice-code login — tier ${tier}, client ${oauth.clientId}\n`);
      const token = await authenticateAccountDeviceCode(tier, oauth, (p) => {
        console.log("==================================================");
        console.log(`  Open:  ${p.verificationUrl}`);
        console.log(`  Code:  ${p.userCode}`);
        console.log("==================================================");
        console.log("  Waiting for you to complete sign-in…\n");
      });
      console.log(`\n✅ Success! ${token.account} (tier ${token.tier})`);
      console.log(`   Expires: ${new Date(token.expiresAt).toLocaleString()}`);
      return;
    }
    // Browser authorization-code (paste-the-redirect) fallback.
    const token = await authenticateAccount(tier, account, oauth);
    console.log(`\n✅ Success! ${token.account} (tier ${token.tier})`);
    console.log(`   Expires: ${new Date(token.expiresAt).toLocaleString()}`);
  } catch (err) {
    console.error("\n❌ Login failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function secretCmd(): Promise<void> {
  const sub = args[1];
  const flags = parseFlags(args.slice(2));
  if (sub !== "totp") {
    console.log("Usage: eule-mcp secret totp --account <email>");
    process.exit(1);
  }
  const account = typeof flags.account === "string" ? flags.account : undefined;
  if (!account) {
    console.error("--account <email> is required");
    process.exit(1);
  }

  // The secret is entered in the helper's local window → written 0600 to a temp
  // file → folded into config.yaml → temp file unlinked. It never appears in
  // argv, this process's output, or the model context.
  const cfgMgr = new ConfigManager();
  const out = join(cfgMgr.euleDirPath, `.totp-${randomBytes(8).toString("hex")}.tmp`);
  let exitCode = 0;
  try {
    const code = await secretPrompt(`TOTP secret (base32) for ${account}`, out);
    if (code !== 0) {
      console.error("\n❌ Cancelled.");
      exitCode = code;
    } else {
      const secret = readFileSync(out, "utf-8").trim();
      if (!isBase32Secret(secret)) {
        console.error("\n❌ That isn't a base32 TOTP secret (A–Z, 2–7) — not stored.");
        exitCode = 1;
      } else {
        cfgMgr.upsertAutoAuth(account, { totpSecret: secret });
        console.log(`\n✅ TOTP secret stored for ${account} (config.yaml, 0600).`);
        console.log(`   Use it:  eule-mcp login --capture --account ${account} …`);
      }
    }
  } catch (err) {
    console.error("\n❌ Failed:", err instanceof Error ? err.message : String(err));
    exitCode = 1;
  } finally {
    try {
      unlinkSync(out);
    } catch {
      /* already gone / never created */
    }
  }
  if (exitCode) process.exit(exitCode);
}

async function main(): Promise<void> {
  switch (command) {
    case "setup":
      await setup();
      break;
    case "login":
      await login();
      break;
    case "secret":
      await secretCmd();
      break;
    case "serve":
      await import("../server/index.js");
      break;
    default:
      console.log("Eule MCP — Kiro Office Agent 🦉\n");
      console.log("Usage:");
      console.log("  eule-mcp setup                        Interactive account setup");
      console.log("  eule-mcp login --device [--tier ews]  Cross-platform device-code login");
      console.log("       [--account <email>] [--client-id <id>] [--api-version v1|v2]");
      console.log("  eule-mcp login --capture [--tier ews] Webview capture (broker-only clients)");
      console.log("  eule-mcp login [--tier graph] …       Browser (paste-redirect) login");
      console.log(
        "  eule-mcp secret totp --account <email> Store a TOTP secret via a local window",
      );
      console.log("  eule-mcp serve                        Start MCP server (stdio)");
      console.log("  eule-mcp help                         Show this help");
  }
}

main().catch((error: unknown) => {
  console.error("Error:", error);
  process.exit(1);
});
