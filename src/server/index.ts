import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConfigManager } from "../config/index.js";
import { DatabaseManager } from "../db/index.js";
import { loadTokens, authenticateAccount, getAccessToken } from "../auth/index.js";
import { ConnectorRegistry } from "../connectors/index.js";
import type { ApiTier, MailMessage } from "../types/index.js";

const configManager = new ConfigManager();
const registry = new ConnectorRegistry(configManager);

// Database initialized at startup, used by task/idea/note tools in Phase 2+.
export const dbManager = new DatabaseManager();

const server = new McpServer({
  name: "eule",
  version: "0.1.0",
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
      const config = configManager.get();
      const autoAuth = account ? config.autoAuth?.find((a) => a.account === account) : undefined;
      const token = await authenticateAccount(apiTier, account, config.oauth, autoAuth);
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
    const config = configManager.get();
    const accessToken = await getAccessToken(account, config.oauth);
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

// --- mail_list tool ---
server.tool(
  "mail_list",
  "List recent emails from connected accounts, optionally filtered by role",
  {
    role: z.string().optional().describe("Filter by role ID (e.g. VPDIT, lexICT)"),
    limit: z.number().optional().describe("Max messages per account (default 10)"),
  },
  async ({ role, limit }) => {
    const connectors = registry.getMailConnectors(role);
    if (connectors.length === 0) {
      return { content: [{ type: "text" as const, text: "No mail connectors available. Run auth_login first." }] };
    }

    const allMessages: MailMessage[] = [];
    for (const c of connectors) {
      try {
        const msgs = await c.listMessages(undefined, limit ?? 10);
        allMessages.push(...msgs);
      } catch (err) {
        allMessages.push({
          id: "error", account: c.account, subject: `Error: ${err instanceof Error ? err.message : String(err)}`,
          from: "", to: [], receivedAt: "", snippet: "", isRead: false,
        });
      }
    }

    allMessages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

    const lines = allMessages.map((m) =>
      `[${m.account}] ${m.isRead ? " " : "●"} ${m.receivedAt.slice(0, 16)} | ${m.from} | ${m.subject}\n  ${m.snippet.slice(0, 100)}${m.snippet.length > 100 ? "..." : ""}\n  ID: ${m.id}`,
    );

    return { content: [{ type: "text" as const, text: lines.join("\n\n") || "No messages found." }] };
  },
);

// --- mail_read tool ---
server.tool(
  "mail_read",
  "Read a specific email by ID",
  {
    id: z.string().describe("Message ID"),
    account: z.string().describe("Account email address"),
  },
  async ({ id, account }) => {
    const connector = registry.getMailConnectorForAccount(account);
    if (!connector) {
      return { content: [{ type: "text" as const, text: `No connector for ${account}` }], isError: true };
    }
    try {
      const msg = await connector.getMessage(id);
      const text = [
        `From: ${msg.from}`,
        `To: ${msg.to.join(", ")}`,
        `Subject: ${msg.subject}`,
        `Date: ${msg.receivedAt}`,
        msg.attachments.length > 0 ? `Attachments: ${msg.attachments.map((a) => `${a.name} (${String(a.size)}B)`).join(", ")}` : "",
        `\n${msg.body}`,
      ].filter(Boolean).join("\n");
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// --- mail_search tool ---
server.tool(
  "mail_search",
  "Search emails across connected accounts",
  {
    query: z.string().describe("Search query"),
    role: z.string().optional().describe("Filter by role ID"),
    limit: z.number().optional().describe("Max results per account (default 10)"),
  },
  async ({ query, role, limit }) => {
    const connectors = registry.getMailConnectors(role);
    if (connectors.length === 0) {
      return { content: [{ type: "text" as const, text: "No mail connectors available." }] };
    }

    const results: MailMessage[] = [];
    for (const c of connectors) {
      try {
        results.push(...await c.searchMessages(query, limit ?? 10));
      } catch (err) {
        results.push({
          id: "error", account: c.account, subject: `Search error: ${err instanceof Error ? err.message : String(err)}`,
          from: "", to: [], receivedAt: "", snippet: "", isRead: false,
        });
      }
    }

    results.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const lines = results.map((m) =>
      `[${m.account}] ${m.receivedAt.slice(0, 16)} | ${m.from} | ${m.subject}\n  ID: ${m.id}`,
    );

    return { content: [{ type: "text" as const, text: lines.join("\n\n") || "No results." }] };
  },
);

// --- mail_send tool ---
server.tool(
  "mail_send",
  "Send an email",
  {
    to: z.string().describe("Recipient(s), comma-separated"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body text"),
    role: z.string().optional().describe("Send from this role's first account"),
  },
  async ({ to, subject, body, role }) => {
    const connectors = registry.getMailConnectors(role);
    const connector = connectors[0];
    if (!connector) {
      return { content: [{ type: "text" as const, text: "No mail connector available for sending." }], isError: true };
    }
    try {
      const recipients = to.split(",").map((s) => s.trim());
      await connector.sendMessage(recipients, subject, body);
      return { content: [{ type: "text" as const, text: `✅ Sent from ${connector.account} to ${to}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Send failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// --- mail_reply tool ---
server.tool(
  "mail_reply",
  "Reply to an email",
  {
    id: z.string().describe("Original message ID"),
    account: z.string().describe("Account email address"),
    body: z.string().describe("Reply body text"),
  },
  async ({ id, account, body }) => {
    const connector = registry.getMailConnectorForAccount(account);
    if (!connector) {
      return { content: [{ type: "text" as const, text: `No connector for ${account}` }], isError: true };
    }
    try {
      await connector.replyToMessage(id, body);
      return { content: [{ type: "text" as const, text: `✅ Reply sent from ${account}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `❌ Reply failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
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
