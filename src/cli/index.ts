import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ConfigManager } from "../config/index.js";
import { authenticateAccount, loadTokens } from "../auth/index.js";
import type { ApiTier } from "../types/index.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

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
  const tier: ApiTier = (["graph", "ews", "imap"].includes(tierInput) ? tierInput : "graph") as ApiTier;

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

async function main(): Promise<void> {
  switch (command) {
    case "setup":
      await setup();
      break;
    case "serve":
      await import("../server/index.js");
      break;
    default:
      console.log("Eule MCP — Kiro Office Agent 🦉\n");
      console.log("Usage:");
      console.log("  eule-mcp setup          Interactive account setup");
      console.log("  eule-mcp setup --probe  Re-probe API tiers");
      console.log("  eule-mcp serve          Start MCP server (stdio)");
      console.log("  eule-mcp help           Show this help");
  }
}

main().catch((error: unknown) => {
  console.error("Error:", error);
  process.exit(1);
});
