import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConfigManager } from "../config/index.js";
import { DatabaseManager } from "../db/index.js";
import { loadTokens, authenticateAccount, getAccessToken } from "../auth/index.js";
import type { ApiTier } from "../types/index.js";

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
  const tokens = loadTokens();

  const roles = config.roles.map((r) => {
    const mailCount = r.connectors.mail?.length ?? 0;
    const calCount = r.connectors.calendar?.length ?? 0;
    return `  ${r.id}: ${r.name} (${String(r.weeklyHours)}h/week, ${String(mailCount)} mail, ${String(calCount)} cal)`;
  });

  const accounts = Object.entries(tokens.accounts).map(([account, token]) => {
    const status = token.expiresAt > Date.now() ? "valid" : "expired (will refresh)";
    return `  ${account}: tier ${token.tier}, ${status}`;
  });

  const lines = [
    `Language: ${config.language}`,
    `Roles (${String(config.roles.length)}):`,
    ...roles,
    "",
    `Authenticated accounts (${String(accounts.length)}):`,
    ...(accounts.length > 0 ? accounts : ["  none — run 'eule-mcp setup' to add accounts"]),
    "",
    `Data: ${configManager.euleDirPath}`,
  ];

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// --- auth_login tool ---
server.tool(
  "auth_login",
  "Authenticate or re-authenticate an M365 account via browser OAuth flow",
  {
    account: z.string().optional().describe("Email address hint for login"),
    tier: z
      .enum(["graph", "ews", "imap"])
      .optional()
      .describe("API tier to authenticate for (default: graph)"),
  },
  async ({ account, tier }) => {
    const apiTier: ApiTier = tier ?? "graph";
    try {
      const token = await authenticateAccount(apiTier, account);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Authenticated: ${token.account}\nTier: ${token.tier}\nExpires: ${new Date(token.expiresAt).toLocaleString()}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ Authentication failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- auth_probe tool ---
server.tool(
  "auth_probe",
  "Test which M365 API tier works for an account (Graph → EWS → IMAP)",
  {
    account: z.string().describe("Email address of the account to probe"),
  },
  async ({ account }) => {
    // Try to get a valid token first.
    const accessToken = await getAccessToken(account);
    if (!accessToken) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No token found for ${account}. Run auth_login first.`,
          },
        ],
        isError: true,
      };
    }

    const tokens = loadTokens();
    const tokenData = tokens.accounts[account];
    if (!tokenData) {
      return {
        content: [{ type: "text" as const, text: `No token data for ${account}.` }],
        isError: true,
      };
    }

    // Test the current tier.
    const tier = tokenData.tier;
    let testResult = "unknown";

    if (tier === "graph") {
      try {
        const res = await fetch("https://graph.microsoft.com/v1.0/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        testResult = res.ok ? "✅ Graph API works" : `❌ Graph API returned ${String(res.status)}`;
      } catch (err) {
        testResult = `❌ Graph API error: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (tier === "ews") {
      try {
        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <soap:Body>
    <GetFolder xmlns="http://schemas.microsoft.com/exchange/services/2006/messages">
      <FolderShape><t:BaseShape>IdOnly</t:BaseShape></FolderShape>
      <FolderIds><t:DistinguishedFolderId Id="inbox"/></FolderIds>
    </GetFolder>
  </soap:Body>
</soap:Envelope>`;
        const res = await fetch("https://outlook.office365.com/EWS/Exchange.asmx", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "text/xml; charset=utf-8",
          },
          body: soapBody,
        });
        testResult = res.ok ? "✅ EWS works" : `❌ EWS returned ${String(res.status)}`;
      } catch (err) {
        testResult = `❌ EWS error: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      testResult = "⚠️ IMAP tier — probe requires IMAP connection (not tested via HTTP)";
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Account: ${account}\nCurrent tier: ${tier}\nProbe result: ${testResult}`,
        },
      ],
    };
  },
);

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
        content: [
          { type: "text" as const, text: "No roles configured. Edit ~/.eule/config.yaml or use role_add." },
        ],
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
