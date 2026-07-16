import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ConfigManager } from "../config/index.js";
import {
  authenticateAccount,
  authenticateAccountDeviceCode,
  tierAuthParam,
  loadTokens,
} from "../providers/m365/index.js";
import { oauthCapture } from "../helper/run.js";
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

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function setup(): Promise<void> {
  const configManager = new ConfigManager();
  const config = configManager.get();
  const tokens = loadTokens();

  console.log("Eule MCP — Setup 🦉\n");
  console.log(`Config: ${configManager.euleDirPath}/config.yaml`);
  console.log(`Roles: ${String(config.roles.length)} configured`);
  console.log(`Accounts: ${String(Object.keys(tokens.accounts).length)} authenticated\n`);

  // Show existing accounts.
  if (Object.keys(tokens.accounts).length > 0) {
    console.log("Authenticated accounts:");
    for (const [account, token] of Object.entries(tokens.accounts)) {
      const expired = token.expiresAt < Date.now() ? " (expired, will refresh)" : "";
      console.log(`  ${account}: tier ${token.tier}${expired}`);
    }
    console.log("");
  }

  const action = await prompt("Add a new account? (y/n): ");
  if (action.toLowerCase() !== "y") {
    console.log("Done.");
    return;
  }

  const accountHint = await prompt("Email address (login hint, optional): ");

  // Start with Graph (tier 1), user can re-probe later.
  const tierInput = await prompt("Try which tier first? (graph/ews/imap) [graph]: ");
  const tier: ApiTier = (
    ["graph", "ews", "imap"].includes(tierInput) ? tierInput : "graph"
  ) as ApiTier;

  console.log(`\nAuthenticating with tier: ${tier}`);
  console.log("A browser window will open for Microsoft login...\n");

  try {
    const autoAuth = config.autoAuth?.find((a) => a.account === accountHint);
    const token = await authenticateAccount(tier, accountHint || undefined, config.oauth, autoAuth);
    console.log(`\n✅ Success! Account: ${token.account}`);
    console.log(`   Tier: ${token.tier}`);
    console.log(`   Token expires: ${new Date(token.expiresAt).toLocaleString()}`);
  } catch (err) {
    console.error("\n❌ Authentication failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
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
    const autoAuth = account ? config.autoAuth?.find((a) => a.account === account) : undefined;
    const token = await authenticateAccount(tier, account, oauth, autoAuth);
    console.log(`\n✅ Success! ${token.account} (tier ${token.tier})`);
    console.log(`   Expires: ${new Date(token.expiresAt).toLocaleString()}`);
  } catch (err) {
    console.error("\n❌ Login failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "setup":
      await setup();
      break;
    case "login":
      await login();
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
      console.log("  eule-mcp serve                        Start MCP server (stdio)");
      console.log("  eule-mcp help                         Show this help");
  }
}

main().catch((error: unknown) => {
  console.error("Error:", error);
  process.exit(1);
});
