import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConfigManager } from "../config/index.js";
import { DatabaseManager } from "../db/index.js";

const configManager = new ConfigManager();
// Database initialized at startup, used by task/idea/note tools in Phase 2+.
export const dbManager = new DatabaseManager();

const server = new McpServer({
  name: "eule",
  version: "0.0.1",
});

// --- auth_status tool ---
server.tool("auth_status", "Show authentication status and configuration summary", {}, async () => {
  const config = configManager.get();
  const roles = config.roles.map((r) => {
    const mailCount = r.connectors.mail?.length ?? 0;
    const calCount = r.connectors.calendar?.length ?? 0;
    return `  ${r.id}: ${r.name} (${String(r.weeklyHours)}h/week, ${String(mailCount)} mail, ${String(calCount)} calendar connectors)`;
  });

  const summary = [
    `Language: ${config.language}`,
    `Roles (${String(config.roles.length)}):`,
    ...roles,
    ``,
    `Data directory: ${configManager.euleDirPath}`,
    `Knowledge directory: ${configManager.knowledgeDirPath}`,
    `Database: initialized`,
    `Authentication: not yet configured (run 'eule-mcp setup')`,
  ].join("\n");

  return { content: [{ type: "text" as const, text: summary }] };
});

// --- role_list tool ---
server.tool(
  "role_list",
  "List all configured roles with their connectors and weekly hours",
  {
    format: z
      .enum(["summary", "detailed"])
      .optional()
      .describe("Output format: summary (default) or detailed"),
  },
  async ({ format }) => {
    const config = configManager.get();

    if (config.roles.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No roles configured. Edit ~/.eule/config.yaml or use role_add." }],
      };
    }

    const lines: string[] = [];
    for (const role of config.roles) {
      lines.push(`## ${role.id}: ${role.name}`);
      lines.push(`  Weekly hours: ${String(role.weeklyHours)}`);
      if (role.contexts && role.contexts.length > 0) {
        lines.push(`  Contexts: ${role.contexts.join(", ")}`);
      }
      if (format === "detailed") {
        if (role.connectors.mail && role.connectors.mail.length > 0) {
          lines.push(`  Mail connectors:`);
          for (const c of role.connectors.mail) {
            lines.push(`    - ${c.id}: ${c.account}${c.shared ? " (shared)" : ""}`);
          }
        }
        if (role.connectors.calendar && role.connectors.calendar.length > 0) {
          lines.push(`  Calendar connectors:`);
          for (const c of role.connectors.calendar) {
            lines.push(`    - ${c.id}: ${c.account}`);
          }
        }
      }
      lines.push("");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// --- Server startup ---
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("Eule MCP server failed to start:", error);
  process.exit(1);
});
