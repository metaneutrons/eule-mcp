import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MessengerService } from "../services/messenger-service.js";
import { executeTool, textResult } from "./tool-runtime.js";

export function registerMessengerTools(server: McpServer, messenger: MessengerService): void {
  server.registerTool(
    "chat_list",
    {
      description: "List recent conversations",
      inputSchema: {
        role: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ role, limit }) =>
      executeTool("chat_list", async () => {
        const result = await messenger.list(role, limit);
        const lines = result.conversations.map(
          (c) =>
            `[${c.platform}] ${c.title}${c.participants.length ? ` (${c.participants.join(", ")})` : ""}${c.lastTimestamp ? ` — ${c.lastTimestamp.slice(0, 16)}` : ""}\n  ID: ${c.id}`,
        );
        return textResult(
          [...lines, ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`)].join(
            "\n\n",
          ) || "No conversations.",
        );
      }),
  );
  server.registerTool(
    "chat_read",
    {
      description: "Read messages from a conversation",
      inputSchema: {
        conversationId: z.string().min(1),
        account: z.string().min(1),
        role: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ conversationId, account, role, limit }) =>
      executeTool("chat_read", async () =>
        textResult(
          (await messenger.read(conversationId, account, role, limit))
            .map((m) => `[${m.timestamp.slice(0, 16)}] ${m.from}: ${m.body}`)
            .join("\n") || "No messages.",
        ),
      ),
  );
  server.registerTool(
    "chat_send",
    {
      description: "Send a message to a conversation",
      inputSchema: {
        conversationId: z.string().min(1),
        account: z.string().min(1),
        role: z.string().optional(),
        body: z.string().trim().min(1).max(10_000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ conversationId, account, role, body }) =>
      executeTool("chat_send", async () =>
        textResult(`✅ Sent via ${await messenger.send(conversationId, account, body, role)}`),
      ),
  );
}
