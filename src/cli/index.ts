import { ConfigManager } from "../config/index.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

async function main(): Promise<void> {
  switch (command) {
    case "setup": {
      const configManager = new ConfigManager();
      const config = configManager.get();
      console.log("Eule MCP — Setup");
      console.log(`Config directory: ${configManager.euleDirPath}`);
      console.log(`Roles configured: ${String(config.roles.length)}`);
      console.log("");
      console.log("OAuth setup not yet implemented (Task 2).");
      break;
    }
    case "serve": {
      // Delegate to server entry point via dynamic import
      await import("../server/index.js");
      break;
    }
    default: {
      console.log("Eule MCP — Kiro Office Agent 🦉");
      console.log("");
      console.log("Usage:");
      console.log("  eule-mcp setup         Interactive account setup");
      console.log("  eule-mcp setup --probe  Re-probe API tiers");
      console.log("  eule-mcp serve         Start MCP server (stdio)");
      console.log("  eule-mcp help          Show this help");
    }
  }
}

main().catch((error: unknown) => {
  console.error("Error:", error);
  process.exit(1);
});
