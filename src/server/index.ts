/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-deprecated */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConfigManager } from "../config/index.js";
import { DatabaseManager, TaskManager } from "../db/index.js";
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

// --- role CRUD tools ---

server.tool(
  "role_add",
  "Add a new role",
  {
    id: z.string().describe("Role ID (e.g. VPDIT, teaching)"),
    name: z.string().describe("Display name"),
    weeklyHours: z.number().optional().describe("Weekly hours (default: 0)"),
  },
  async ({ id, name, weeklyHours }) => {
    try {
      configManager.addRole({ id, name, weeklyHours: weeklyHours ?? 0, connectors: {} });
      return { content: [{ type: "text" as const, text: `✅ Role "${id}" added.` }] };
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
  "role_update",
  "Update a role's properties",
  {
    id: z.string().describe("Role ID to update"),
    name: z.string().optional().describe("New display name"),
    weeklyHours: z.number().optional().describe("New weekly hours"),
  },
  async ({ id, ...updates }) => {
    try {
      const role = configManager.updateRole(id, updates);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Role "${role.id}" updated: ${role.name} (${String(role.weeklyHours)}h/week)`,
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
  "role_remove",
  "Remove a role",
  { id: z.string().describe("Role ID to remove") },
  async ({ id }) => {
    try {
      configManager.removeRole(id);
      return { content: [{ type: "text" as const, text: `✅ Role "${id}" removed.` }] };
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
      return {
        content: [
          { type: "text" as const, text: "No mail connectors available. Run auth_login first." },
        ],
      };
    }

    const allMessages: MailMessage[] = [];
    for (const c of connectors) {
      try {
        const msgs = await c.listMessages(undefined, limit ?? 10);
        allMessages.push(...msgs);
      } catch (err) {
        allMessages.push({
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

    allMessages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));

    const lines = allMessages.map(
      (m) =>
        `[${m.account}] ${m.isRead ? " " : "●"} ${m.receivedAt.slice(0, 16)} | ${m.from} | ${m.subject}${m.snippet ? `\n  ${m.snippet.slice(0, 100)}${m.snippet.length > 100 ? "..." : ""}` : ""}\n  ID: ${m.id}`,
    );

    return {
      content: [{ type: "text" as const, text: lines.join("\n\n") || "No messages found." }],
    };
  },
);

// --- mail_read tool ---
server.tool(
  "mail_read",
  "Read a specific email by ID. Returns clean Markdown by default (latest reply only). Use depth=0 for full thread, format=raw for original HTML.",
  {
    id: z.string().describe("Message ID"),
    account: z.string().describe("Account email address"),
    depth: z
      .number()
      .optional()
      .describe("Thread depth: 1=latest reply (default), 0=full thread, N=last N replies"),
    maxLength: z.number().optional().describe("Max chars (default 4000). 0=unlimited"),
    format: z
      .enum(["markdown", "raw", "plain"])
      .optional()
      .describe("Output format (default: markdown)"),
  },
  async ({ id, account, depth, maxLength, format }) => {
    const connector = registry.getMailConnectorForAccount(account);
    if (!connector) {
      return {
        content: [{ type: "text" as const, text: `No connector for ${account}` }],
        isError: true,
      };
    }
    try {
      const msg = await connector.getMessage(id);
      const header = [
        `From: ${msg.from}`,
        `To: ${msg.to.join(", ")}`,
        `Subject: ${msg.subject}`,
        `Date: ${msg.receivedAt}`,
        msg.attachments.length > 0
          ? `Attachments: ${msg.attachments.map((a) => `${a.name} (${String(Math.round(a.size / 1024))}KB, ${a.contentType})`).join(", ")}`
          : "",
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
        results.push(...(await c.searchMessages(query, limit ?? 10)));
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
      return {
        content: [{ type: "text" as const, text: "No mail connector available for sending." }],
        isError: true,
      };
    }
    try {
      const recipients = to.split(",").map((s) => s.trim());
      await connector.sendMessage(recipients, subject, body);
      return {
        content: [{ type: "text" as const, text: `✅ Sent from ${connector.account} to ${to}` }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ Send failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
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
      return {
        content: [{ type: "text" as const, text: `No connector for ${account}` }],
        isError: true,
      };
    }
    try {
      await connector.replyToMessage(id, body);
      return { content: [{ type: "text" as const, text: `✅ Reply sent from ${account}` }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ Reply failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- mail_attachment_list tool ---
server.tool(
  "mail_attachment_list",
  "List attachments of an email",
  {
    id: z.string().describe("Message ID"),
    account: z.string().describe("Account email address"),
  },
  async ({ id, account }) => {
    const connector = registry.getMailConnectorForAccount(account);
    if (!connector) {
      return {
        content: [{ type: "text" as const, text: `No connector for ${account}` }],
        isError: true,
      };
    }
    try {
      const msg = await connector.getMessage(id);
      if (msg.attachments.length === 0) {
        return { content: [{ type: "text" as const, text: "No attachments." }] };
      }
      const lines = msg.attachments.map(
        (a) =>
          `- ${a.name} (${String(Math.round(a.size / 1024))}KB, ${a.contentType})\n  ID: ${a.id}`,
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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

// --- mail_attachment_get tool ---
server.tool(
  "mail_attachment_get",
  "Download an email attachment to disk and return the file path",
  {
    messageId: z.string().describe("Message ID"),
    attachmentId: z.string().describe("Attachment ID (from mail_attachment_list)"),
    account: z.string().describe("Account email address"),
    name: z.string().describe("Filename for saving"),
    path: z.string().optional().describe("Custom save path (default: ~/.eule/attachments/)"),
  },
  async ({ messageId, attachmentId, account, name, path: customPath }) => {
    const connector = registry.getMailConnectorForAccount(account);
    if (!connector) {
      return {
        content: [{ type: "text" as const, text: `No connector for ${account}` }],
        isError: true,
      };
    }
    try {
      const data = await connector.downloadAttachment(messageId, attachmentId);
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const { mkdirSync, writeFileSync } = await import("node:fs");

      let savePath: string;
      if (customPath) {
        savePath = customPath;
      } else {
        const dir = join(homedir(), ".eule", "attachments", messageId.slice(0, 32));
        mkdirSync(dir, { recursive: true });
        savePath = join(dir, name);
      }

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

// --- Task tools ---
const taskManager = new TaskManager(dbManager);

server.tool("task_inbox", "Show unprocessed inbox tasks", {}, async () => {
  const tasks = taskManager.inbox();
  if (tasks.length === 0)
    return { content: [{ type: "text" as const, text: "Inbox is empty ✨" }] };
  const lines = tasks.map(
    (t) =>
      `#${String(t.id)} ${t.title}${t.due_date ? ` 📅 ${t.due_date}` : ""}${t.body ? `\n  ${t.body.split("\n")[0] ?? ""}` : ""}`,
  );
  return {
    content: [
      { type: "text" as const, text: `📥 Inbox (${String(tasks.length)}):\n\n${lines.join("\n")}` },
    ],
  };
});

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

// --- Server startup ---
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("Eule MCP server failed to start:", error);
  process.exit(1);
});
