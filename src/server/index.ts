/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-deprecated */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConfigManager } from "../config/index.js";
import { DatabaseManager, TaskManager, NoteManager, ContactManager } from "../db/index.js";
import { loadTokens, authenticateAccount, getAccessToken } from "../providers/m365/index.js";
import { ConnectorRegistry } from "../connectors/index.js";
import { renderMail } from "../renderer/index.js";
import type { ApiTier, MailMessage, CalendarEvent } from "../types/index.js";

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
    let testResult = "unknown"; // eslint-disable-line no-useless-assignment

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
          {
            type: "text" as const,
            text: "No roles configured. Edit ~/.eule/config.yaml or use role_add.",
          },
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
            lines.push(`    - ${c.id}: ${c.mailbox ?? c.account}${c.mailbox ? " (shared)" : ""}`);
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
  "List recent emails from a folder (default: inbox)",
  {
    role: z.string().optional().describe("Filter by role ID"),
    folder: z
      .string()
      .optional()
      .describe("Folder name (inbox, sentitems, drafts, deleteditems, junkemail)"),
    limit: z.number().optional().describe("Max messages per account (default 10)"),
  },
  async ({ role, folder, limit }) => {
    const connectors = registry.getMailConnectors(role);
    if (connectors.length === 0)
      return {
        content: [
          { type: "text" as const, text: "No mail connectors available. Run auth_login first." },
        ],
      };

    const all: MailMessage[] = [];
    for (const c of connectors) {
      try {
        all.push(...(await c.listMessages(folder ?? "inbox", limit ?? 10)));
      } catch (err) {
        all.push({
          id: "error",
          account: c.account,
          subject: `Error: ${err instanceof Error ? err.message : String(err)}`,
          from: "",
          to: [],
          receivedAt: "",
          snippet: "",
          isRead: false,
        });
      }
    }
    all.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const lines = all.map(
      (m) =>
        `[${m.account}] ${m.isRead ? " " : "●"} ${m.receivedAt.slice(0, 16)} | ${m.from} | ${m.subject}${m.snippet ? `\n  ${m.snippet.slice(0, 100)}` : ""}\n  ID: ${m.id}`,
    );
    return {
      content: [{ type: "text" as const, text: lines.join("\n\n") || "No messages found." }],
    };
  },
);

// --- mail_read tool ---
server.tool(
  "mail_read",
  "Read a specific email by ID. Returns clean Markdown with attachment metadata.",
  {
    id: z.string().describe("Message ID"),
    account: z.string().describe("Account email address"),
    depth: z.number().optional().describe("Thread depth: 1=latest reply (default), 0=full thread"),
    maxLength: z.number().optional().describe("Max chars (default 4000). 0=unlimited"),
    format: z
      .enum(["markdown", "raw", "plain"])
      .optional()
      .describe("Output format (default: markdown)"),
  },
  async ({ id, account, depth, maxLength, format }) => {
    const connector = registry.getMailConnectorForAccount(account);
    if (!connector)
      return {
        content: [{ type: "text" as const, text: `No connector for ${account}` }],
        isError: true,
      };
    try {
      const msg = await connector.getMessage(id);
      const attachInfo =
        msg.attachments.length > 0
          ? `\nAttachments:\n${msg.attachments.map((a) => `  - ${a.name} (${String(Math.round(a.size / 1024))}KB, ${a.contentType}) ID: ${a.id}`).join("\n")}`
          : "";
      const header = [
        `From: ${msg.from}`,
        `To: ${msg.to.join(", ")}`,
        `Subject: ${msg.subject}`,
        `Date: ${msg.receivedAt}`,
        attachInfo,
      ]
        .filter(Boolean)
        .join("\n");
      const body = renderMail({
        body: msg.body,
        bodyType: msg.bodyType,
        depth: depth ?? 1,
        maxLength: maxLength ?? 4000,
        format: format ?? "markdown",
      });
      return { content: [{ type: "text" as const, text: `${header}\n\n${body}` }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
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
    folder: z.string().optional().describe("Folder to search in (EWS/IMAP only, ignored by Graph)"),
    limit: z.number().optional().describe("Max results per account (default 10)"),
  },
  async ({ query, role, folder, limit }) => {
    const connectors = registry.getMailConnectors(role);
    if (connectors.length === 0)
      return { content: [{ type: "text" as const, text: "No mail connectors available." }] };

    const results: MailMessage[] = [];
    for (const c of connectors) {
      try {
        results.push(...(await c.searchMessages(query, limit ?? 10, folder)));
      } catch (err) {
        results.push({
          id: "error",
          account: c.account,
          subject: `Search error: ${err instanceof Error ? err.message : String(err)}`,
          from: "",
          to: [],
          receivedAt: "",
          snippet: "",
          isRead: false,
        });
      }
    }
    results.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const lines = results.map(
      (m) =>
        `[${m.account}] ${m.receivedAt.slice(0, 16)} | ${m.from} | ${m.subject}\n  ID: ${m.id}`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n\n") || "No results." }] };
  },
);

// --- mail_send tool ---
server.tool(
  "mail_send",
  "Send, reply to, or forward an email",
  {
    to: z.string().describe("Recipient(s), comma-separated"),
    subject: z.string().optional().describe("Email subject (ignored for reply)"),
    body: z.string().describe("Email body text"),
    role: z.string().optional().describe("Send from this role's first account"),
    account: z.string().optional().describe("Send from specific account"),
    reply_to: z.string().optional().describe("Message ID to reply to"),
    forward_id: z.string().optional().describe("Message ID to forward"),
  },
  async ({ to, subject, body, role, account, reply_to, forward_id }) => {
    const connector = account
      ? registry.getMailConnectorForAccount(account)
      : registry.getMailConnectors(role)[0];
    if (!connector)
      return {
        content: [{ type: "text" as const, text: "No mail connector available." }],
        isError: true,
      };

    try {
      const recipients = to.split(",").map((s) => s.trim());
      if (reply_to) {
        await connector.replyToMessage(reply_to, body);
        return {
          content: [{ type: "text" as const, text: `✅ Reply sent from ${connector.account}` }],
        };
      }
      if (forward_id) {
        await connector.forwardMessage(forward_id, recipients, body);
        return {
          content: [
            { type: "text" as const, text: `✅ Forwarded from ${connector.account} to ${to}` },
          ],
        };
      }
      await connector.sendMessage(recipients, subject ?? "(no subject)", body);
      return {
        content: [{ type: "text" as const, text: `✅ Sent from ${connector.account} to ${to}` }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ Failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- mail_update tool ---
server.tool(
  "mail_update",
  "Update an email: mark read/unread, move to folder, or delete",
  {
    id: z.string().describe("Message ID"),
    account: z.string().describe("Account email address"),
    is_read: z.boolean().optional().describe("Mark as read (true) or unread (false)"),
    move_to: z.string().optional().describe("Move to folder (inbox, archive, deleteditems, ...)"),
    delete: z.boolean().optional().describe("Delete the message"),
  },
  async ({ id, account, is_read, move_to, delete: del }) => {
    const connector = registry.getMailConnectorForAccount(account);
    if (!connector)
      return {
        content: [{ type: "text" as const, text: `No connector for ${account}` }],
        isError: true,
      };

    try {
      const actions: string[] = [];
      if (is_read !== undefined) {
        await connector.markRead(id, is_read);
        actions.push(is_read ? "marked read" : "marked unread");
      }
      if (move_to) {
        await connector.moveMessage(id, move_to);
        actions.push(`moved to ${move_to}`);
      }
      if (del) {
        await connector.deleteMessage(id);
        actions.push("deleted");
      }
      return { content: [{ type: "text" as const, text: `✅ ${actions.join(", ")}` }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ Failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- mail_attachment_get tool ---
server.tool(
  "mail_attachment_get",
  "Download an email attachment to disk",
  {
    messageId: z.string().describe("Message ID"),
    attachmentId: z.string().describe("Attachment ID (from mail_read)"),
    account: z.string().describe("Account email address"),
    name: z.string().describe("Filename for saving"),
    path: z.string().optional().describe("Custom save path (default: ~/.eule/attachments/)"),
  },
  async ({ messageId, attachmentId, account, name, path: customPath }) => {
    const connector = registry.getMailConnectorForAccount(account);
    if (!connector)
      return {
        content: [{ type: "text" as const, text: `No connector for ${account}` }],
        isError: true,
      };
    try {
      const data = await connector.downloadAttachment(messageId, attachmentId);
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const dir = customPath ?? join(homedir(), ".eule", "attachments", messageId.slice(0, 32));
      mkdirSync(dir, { recursive: true });
      const savePath = customPath ?? join(dir, name);
      writeFileSync(savePath, data);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Saved: ${savePath} (${String(Math.round(data.length / 1024))}KB)`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- Chat tools (Messenger) ---
server.tool(
  "chat_list",
  "List recent conversations from all messengers (Signal, Teams)",
  {
    role: z.string().optional().describe("Filter by role ID"),
    limit: z.number().optional().describe("Max conversations per connector (default 20)"),
  },
  async ({ role, limit }) => {
    const connectors = registry.getMessengerConnectors(role);
    if (connectors.length === 0)
      return { content: [{ type: "text" as const, text: "No messenger connectors configured." }] };
    const all: {
      platform: string;
      id: string;
      title: string;
      participants: string;
      lastTimestamp?: string;
    }[] = [];
    for (const c of connectors) {
      try {
        const convos = await c.listConversations(limit ?? 20);
        for (const cv of convos)
          all.push({
            platform: cv.platform,
            id: cv.id,
            title: cv.title,
            participants: cv.participants.join(", "),
            lastTimestamp: cv.lastTimestamp,
          });
      } catch (err) {
        all.push({
          platform: c.platform,
          id: "error",
          title: `Error: ${err instanceof Error ? err.message : String(err)}`,
          participants: "",
        });
      }
    }
    const lines = all.map(
      (c) =>
        `[${c.platform}] ${c.title}${c.participants ? ` (${c.participants})` : ""}${c.lastTimestamp ? ` — ${c.lastTimestamp.slice(0, 16)}` : ""}\n  ID: ${c.id}`,
    );
    return {
      content: [{ type: "text" as const, text: lines.join("\n\n") || "No conversations." }],
    };
  },
);

server.tool(
  "chat_read",
  "Read messages from a conversation",
  {
    conversationId: z.string().describe("Conversation ID (from chat_list)"),
    account: z.string().describe("Account identifier"),
    limit: z.number().optional().describe("Max messages (default 20)"),
  },
  async ({ conversationId, account, limit }) => {
    const connectors = registry.getMessengerConnectors();
    const connector = connectors.find((c) => c.account === account);
    if (!connector)
      return {
        content: [{ type: "text" as const, text: `No messenger connector for ${account}` }],
        isError: true,
      };
    try {
      const msgs = await connector.getMessages(conversationId, limit ?? 20);
      const lines = msgs.map((m) => `[${m.timestamp.slice(0, 16)}] ${m.from}: ${m.body}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") || "No messages." }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "chat_send",
  "Send a message to a conversation",
  {
    conversationId: z.string().describe("Conversation ID"),
    account: z.string().describe("Account identifier"),
    body: z.string().describe("Message text"),
  },
  async ({ conversationId, account, body }) => {
    const connectors = registry.getMessengerConnectors();
    const connector = connectors.find((c) => c.account === account);
    if (!connector)
      return {
        content: [{ type: "text" as const, text: `No messenger connector for ${account}` }],
        isError: true,
      };
    try {
      await connector.sendMessage(conversationId, body);
      return { content: [{ type: "text" as const, text: `✅ Sent via ${connector.platform}` }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ Failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- File tools (SharePoint/OneDrive) ---
server.tool(
  "file_search",
  "Search files in SharePoint/OneDrive",
  {
    query: z.string().describe("Search query"),
    role: z.string().optional().describe("Filter by role ID"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, role, limit }) => {
    const connectors = registry.getFileConnectors(role);
    if (connectors.length === 0)
      return { content: [{ type: "text" as const, text: "No file connectors configured." }] };
    const results: {
      name: string;
      path: string;
      size: string;
      modified: string;
      id: string;
      webUrl?: string;
    }[] = [];
    for (const c of connectors) {
      try {
        const files = await c.search(query, limit ?? 20);
        for (const f of files)
          results.push({
            name: f.name,
            path: f.path,
            size: `${String(Math.round(f.size / 1024))}KB`,
            modified: f.lastModified.slice(0, 16),
            id: f.id,
            webUrl: f.webUrl,
          });
      } catch (err) {
        results.push({
          name: `Error: ${err instanceof Error ? err.message : String(err)}`,
          path: "",
          size: "",
          modified: "",
          id: "error",
        });
      }
    }
    const lines = results.map(
      (f) =>
        `${f.name} (${f.size}, ${f.modified})\n  ${f.path}${f.webUrl ? `\n  ${f.webUrl}` : ""}\n  ID: ${f.id}`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n\n") || "No files found." }] };
  },
);

server.tool(
  "file_read",
  "Read file content from SharePoint/OneDrive (text files only)",
  {
    id: z.string().describe("File ID (from file_search or file_list)"),
    account: z.string().describe("Account email address"),
  },
  async ({ id, account }) => {
    const connectors = registry.getFileConnectors();
    const connector = connectors.find((c) => c.account === account);
    if (!connector)
      return {
        content: [{ type: "text" as const, text: `No file connector for ${account}` }],
        isError: true,
      };
    try {
      const content = await connector.getContent(id);
      return { content: [{ type: "text" as const, text: content }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "file_list",
  "List recently modified files in SharePoint/OneDrive",
  {
    role: z.string().optional().describe("Filter by role ID"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ role, limit }) => {
    const connectors = registry.getFileConnectors(role);
    if (connectors.length === 0)
      return { content: [{ type: "text" as const, text: "No file connectors configured." }] };
    const results: { name: string; size: string; modified: string; id: string; webUrl?: string }[] =
      [];
    for (const c of connectors) {
      try {
        const files = await c.listRecent(limit ?? 20);
        for (const f of files)
          results.push({
            name: f.name,
            size: `${String(Math.round(f.size / 1024))}KB`,
            modified: f.lastModified.slice(0, 16),
            id: f.id,
            webUrl: f.webUrl,
          });
      } catch (err) {
        results.push({
          name: `Error: ${err instanceof Error ? err.message : String(err)}`,
          size: "",
          modified: "",
          id: "error",
        });
      }
    }
    const lines = results.map(
      (f) =>
        `${f.name} (${f.size}, ${f.modified})${f.webUrl ? `\n  ${f.webUrl}` : ""}\n  ID: ${f.id}`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n\n") || "No recent files." }] };
  },
);

import { BriefingService } from "../services/index.js";

// --- Calendar tools ---

server.tool(
  "calendar_list",
  "List upcoming calendar events",
  {
    role: z.string().optional().describe("Filter by role ID"),
    days: z.number().optional().describe("Number of days to look ahead (default: 7)"),
  },
  async ({ role, days }) => {
    const connectors = registry.getCalendarConnectors(role);
    if (connectors.length === 0)
      return { content: [{ type: "text" as const, text: "No calendar connectors configured." }] };

    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + (days ?? 7));

    const allEvents: CalendarEvent[] = [];
    for (const c of connectors) {
      const events = await c.listEvents(now.toISOString(), end.toISOString());
      allEvents.push(...events);
    }

    allEvents.sort((a, b) => a.start.localeCompare(b.start));

    if (allEvents.length === 0)
      return { content: [{ type: "text" as const, text: "No events found." }] };

    const lines = allEvents.map((e) => {
      const start = e.start.slice(0, 16).replace("T", " ");
      const end = e.end.slice(11, 16);
      const loc = e.location ? ` 📍 ${e.location}` : "";
      const att = e.attendees.length > 0 ? ` 👥 ${String(e.attendees.length)}` : "";
      return e.isAllDay
        ? `${e.start.slice(0, 10)} (all day) | ${e.subject}${loc}`
        : `${start}–${end} | ${e.subject}${loc}${att}`;
    });

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "calendar_today",
  "Show today's schedule",
  {
    role: z.string().optional().describe("Filter by role ID"),
  },
  async ({ role }) => {
    const connectors = registry.getCalendarConnectors(role);
    if (connectors.length === 0)
      return { content: [{ type: "text" as const, text: "No calendar connectors configured." }] };

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const allEvents: CalendarEvent[] = [];
    for (const c of connectors) {
      const events = await c.listEvents(start, end);
      allEvents.push(...events);
    }

    allEvents.sort((a, b) => a.start.localeCompare(b.start));

    if (allEvents.length === 0)
      return { content: [{ type: "text" as const, text: "📅 No events today." }] };

    const lines = allEvents.map((e) => {
      const s = e.start.slice(11, 16);
      const en = e.end.slice(11, 16);
      const loc = e.location ? ` 📍 ${e.location}` : "";
      const att = e.attendees.length > 0 ? ` (${e.attendees.join(", ")})` : "";
      return e.isAllDay ? `🔵 All day: ${e.subject}${loc}` : `${s}–${en} ${e.subject}${loc}${att}`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `📅 Today (${String(allEvents.length)} events):\n\n${lines.join("\n")}`,
        },
      ],
    };
  },
);

server.tool(
  "calendar_create",
  "Create a new calendar event",
  {
    subject: z.string().describe("Event subject"),
    start: z.string().describe("Start time (ISO 8601, e.g. 2026-04-10T14:00:00)"),
    end: z.string().describe("End time (ISO 8601)"),
    location: z.string().optional().describe("Location"),
    body: z.string().optional().describe("Event description"),
    attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
    role: z.string().optional().describe("Role ID (uses first calendar connector)"),
  },
  async ({ role, ...event }) => {
    const connectors = registry.getCalendarConnectors(role);
    if (connectors.length === 0)
      return {
        content: [{ type: "text" as const, text: "No calendar connectors configured." }],
        isError: true,
      };
    const c = connectors[0];
    if (!c)
      return {
        content: [{ type: "text" as const, text: "No calendar connectors configured." }],
        isError: true,
      };
    const created = await c.createEvent(event);
    return {
      content: [
        {
          type: "text" as const,
          text: `📅 Event created: ${created.subject} (${created.start.slice(0, 16)})`,
        },
      ],
    };
  },
);

server.tool(
  "calendar_update",
  "Update an existing calendar event",
  {
    id: z.string().describe("Event ID (from calendar_list)"),
    subject: z.string().optional().describe("New subject"),
    start: z.string().optional().describe("New start time (ISO 8601)"),
    end: z.string().optional().describe("New end time (ISO 8601)"),
    location: z.string().optional().describe("New location"),
    role: z.string().optional().describe("Role ID"),
  },
  async ({ id, role, ...updates }) => {
    const connectors = registry.getCalendarConnectors(role);
    if (connectors.length === 0)
      return {
        content: [{ type: "text" as const, text: "No calendar connectors configured." }],
        isError: true,
      };
    const c = connectors[0];
    if (!c)
      return {
        content: [{ type: "text" as const, text: "No calendar connectors configured." }],
        isError: true,
      };
    const updated = await c.updateEvent(id, updates);
    return { content: [{ type: "text" as const, text: `📅 Event updated: ${updated.subject}` }] };
  },
);

server.tool(
  "calendar_delete",
  "Delete a calendar event",
  {
    id: z.string().describe("Event ID (from calendar_list)"),
    role: z.string().optional().describe("Role ID"),
  },
  async ({ id, role }) => {
    const connectors = registry.getCalendarConnectors(role);
    if (connectors.length === 0)
      return {
        content: [{ type: "text" as const, text: "No calendar connectors configured." }],
        isError: true,
      };
    const c = connectors[0];
    if (!c)
      return {
        content: [{ type: "text" as const, text: "No calendar connectors configured." }],
        isError: true,
      };
    await c.deleteEvent(id);
    return { content: [{ type: "text" as const, text: "📅 Event deleted." }] };
  },
);

// --- Task tools ---
const taskManager = new TaskManager(dbManager);

server.tool(
  "task_add",
  "Add a new task (defaults to inbox)",
  {
    title: z.string().describe("Task title"),
    body: z.string().optional().describe("Task details/notes"),
    status: z
      .enum(["inbox", "next", "waiting", "someday"])
      .optional()
      .describe("GTD status (default: inbox)"),
    role_id: z.string().optional().describe("Role ID"),
    project_id: z.number().optional().describe("Project ID"),
    context: z.string().optional().describe("GTD context (e.g. @computer, @phone, @office)"),
    priority: z.number().optional().describe("Priority (0=normal, higher=more urgent)"),
    due_date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    waiting_for: z.string().optional().describe("Who/what are we waiting for"),
    source_type: z.string().optional().describe("Source type (e.g. email, meeting)"),
    source_id: z.string().optional().describe("Source ID (e.g. email message ID)"),
    estimated_hours: z.number().optional().describe("Estimated hours to complete"),
  },
  async (input) => {
    const task = taskManager.add(input);
    return {
      content: [
        {
          type: "text" as const,
          text: `✅ Task #${String(task.id)} added: ${task.title} [${task.status}]`,
        },
      ],
    };
  },
);

server.tool(
  "task_list",
  "List active tasks, optionally filtered",
  {
    status: z.enum(["inbox", "next", "waiting", "someday"]).optional().describe("Filter by status"),
    project_id: z.number().optional().describe("Filter by project ID"),
    context: z.string().optional().describe("Filter by context"),
    role_id: z.string().optional().describe("Filter by role"),
  },
  async (opts) => {
    const tasks = taskManager.list(opts);
    if (tasks.length === 0)
      return { content: [{ type: "text" as const, text: "No tasks found." }] };
    const lines = tasks.map(
      (t) =>
        `[${t.status}] #${String(t.id)} ${t.title}${t.due_date ? ` 📅 ${t.due_date}` : ""}${t.waiting_for ? ` ⏳ ${t.waiting_for}` : ""}${t.context ? ` @${t.context}` : ""}`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "task_update",
  "Update a task's properties",
  {
    id: z.number().describe("Task ID"),
    title: z.string().optional(),
    body: z.string().optional(),
    status: z.enum(["inbox", "next", "waiting", "someday"]).optional(),
    role_id: z.string().optional(),
    project_id: z.number().nullable().optional(),
    context: z.string().optional(),
    priority: z.number().optional(),
    due_date: z.string().nullable().optional(),
    waiting_for: z.string().nullable().optional(),
    estimated_hours: z.number().nullable().optional(),
  },
  async ({ id, ...updates }) => {
    try {
      const task = taskManager.update(id, updates);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Task #${String(task.id)} updated: ${task.title} [${task.status}]`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "task_complete",
  "Mark a task as done",
  { id: z.number().describe("Task ID") },
  async ({ id }) => {
    try {
      const task = taskManager.complete(id);
      return {
        content: [
          { type: "text" as const, text: `✅ Task #${String(task.id)} completed: ${task.title}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "task_search",
  "Full-text search across tasks",
  { query: z.string().describe("Search query") },
  async ({ query }) => {
    const tasks = taskManager.search(query);
    if (tasks.length === 0)
      return { content: [{ type: "text" as const, text: "No tasks found." }] };
    const lines = tasks.map((t) => `[${t.status}] #${String(t.id)} ${t.title}`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// --- Note tools ---
const noteManager = new NoteManager(dbManager);

server.tool(
  "note_add",
  "Create a note",
  {
    title: z.string().describe("Note title"),
    body: z.string().describe("Note content (Markdown)"),
    role_id: z.string().optional().describe("Role ID"),
    project_id: z.number().optional().describe("Project ID"),
    tags: z.string().optional().describe("Comma-separated tags"),
  },
  async ({ title, body, ...opts }) => {
    const note = noteManager.add(title, body, opts);
    return {
      content: [
        { type: "text" as const, text: `📝 Note #${String(note.id)} created: ${note.title}` },
      ],
    };
  },
);

server.tool(
  "note_list",
  "List notes",
  { role_id: z.string().optional().describe("Filter by role") },
  async ({ role_id }) => {
    const notes = noteManager.list(role_id);
    if (notes.length === 0) return { content: [{ type: "text" as const, text: "No notes yet." }] };
    const lines = notes.map(
      (n) =>
        `#${String(n.id)} ${n.title}${n.tags ? ` [${n.tags}]` : ""} (${n.updated_at.slice(0, 10)})`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "note_search",
  "Full-text search across notes",
  { query: z.string().describe("Search query") },
  async ({ query }) => {
    const notes = noteManager.search(query);
    if (notes.length === 0)
      return { content: [{ type: "text" as const, text: "No notes found." }] };
    const lines = notes.map(
      (n) =>
        `#${String(n.id)} ${n.title}\n  ${n.body.slice(0, 100)}${n.body.length > 100 ? "..." : ""}`,
    );
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// --- Contact tools ---
const contactManager = new ContactManager(dbManager);

server.tool(
  "contact_add",
  "Add a local contact (for contacts not in your address book)",
  {
    name: z.string().describe("Full name"),
    email: z.string().optional().describe("Email address"),
    organization: z.string().optional().describe("Organization"),
    role_id: z.string().optional().describe("Role ID"),
    notes: z.string().optional().describe("Notes about this contact"),
  },
  async ({ name, ...opts }) => {
    const contact = contactManager.add(name, opts);
    return {
      content: [
        { type: "text" as const, text: `👤 Contact #${String(contact.id)} added: ${contact.name}` },
      ],
    };
  },
);

server.tool(
  "contact_list",
  "List contacts from all sources (address book + local)",
  { role: z.string().optional().describe("Filter by role") },
  async ({ role }) => {
    const lines: string[] = [];

    // Remote contacts from connectors.
    const connectors = registry.getContactConnectors(role);
    for (const c of connectors) {
      try {
        const remote = await c.listContacts(50);
        for (const r of remote) {
          lines.push(
            `${r.displayName}${r.email ? ` <${r.email}>` : ""}${r.organization ? ` @ ${r.organization}` : ""}${r.jobTitle ? ` (${r.jobTitle})` : ""}`,
          );
        }
      } catch {
        /* skip failed connectors */
      }
    }

    // Local contacts.
    const local = contactManager.list(role);
    for (const c of local) {
      lines.push(
        `[local] ${c.name}${c.email ? ` <${c.email}>` : ""}${c.organization ? ` @ ${c.organization}` : ""}${c.notes ? ` — ${c.notes}` : ""}`,
      );
    }

    if (lines.length === 0)
      return { content: [{ type: "text" as const, text: "No contacts found." }] };
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "contact_search",
  "Search contacts across all sources",
  { query: z.string().describe("Search query (name, email, organization)") },
  async ({ query }) => {
    const lines: string[] = [];

    // Remote search.
    const connectors = registry.getContactConnectors();
    for (const c of connectors) {
      try {
        const results = await c.searchContacts(query);
        for (const r of results) {
          lines.push(
            `${r.displayName}${r.email ? ` <${r.email}>` : ""}${r.organization ? ` @ ${r.organization}` : ""}`,
          );
        }
      } catch {
        /* skip */
      }
    }

    // Local search (simple name match).
    const local = contactManager.list();
    for (const c of local) {
      const hay = `${c.name} ${c.email ?? ""} ${c.organization ?? ""}`.toLowerCase();
      if (hay.includes(query.toLowerCase())) {
        lines.push(
          `[local] ${c.name}${c.email ? ` <${c.email}>` : ""}${c.notes ? ` — ${c.notes}` : ""}`,
        );
      }
    }

    if (lines.length === 0)
      return { content: [{ type: "text" as const, text: "No contacts found." }] };
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

// --- Briefing tool ---
const briefingService = new BriefingService(registry, taskManager);

server.tool(
  "briefing_today",
  "Generate a daily briefing: today's calendar, unread mail, active tasks",
  {},
  async () => {
    const b = await briefingService.generate();

    const sections: string[] = [];

    // Calendar.
    sections.push(`📅 **Schedule** (${String(b.calendar.length)} events)`);
    if (b.calendar.length > 0) {
      for (const e of b.calendar) {
        const time = e.isAllDay ? "All day" : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`;
        const loc = e.location ? ` 📍 ${e.location}` : "";
        sections.push(`  ${time}: ${e.subject}${loc}`);
      }
    }

    // Mail.
    sections.push("", `📧 **Unread Mail** (${String(b.unreadMail.length)})`);
    for (const m of b.unreadMail.slice(0, 8)) {
      sections.push(`  ${m.receivedAt.slice(11, 16)} ${m.from} — ${m.subject}`);
    }
    if (b.unreadMail.length > 8) sections.push(`  ...+${String(b.unreadMail.length - 8)} more`);

    // Tasks.
    if (b.inboxTasks.length > 0) {
      sections.push("", `📥 **Inbox** (${String(b.inboxTasks.length)} unprocessed)`);
      for (const t of b.inboxTasks) sections.push(`  #${String(t.id)} ${t.title}`);
    }
    if (b.nextTasks.length > 0) {
      sections.push("", `⚡ **Next Actions** (${String(b.nextTasks.length)})`);
      for (const t of b.nextTasks)
        sections.push(`  #${String(t.id)} ${t.title}${t.context ? ` @${t.context}` : ""}`);
    }
    if (b.waitingTasks.length > 0) {
      sections.push("", `⏳ **Waiting For** (${String(b.waitingTasks.length)})`);
      for (const t of b.waitingTasks)
        sections.push(`  #${String(t.id)} ${t.title}${t.waiting_for ? ` → ${t.waiting_for}` : ""}`);
    }

    sections.push("", `_Briefing saved to ~/.eule/knowledge/briefings/${b.date}.md_`);

    return { content: [{ type: "text" as const, text: sections.join("\n") }] };
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
