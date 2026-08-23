import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AttachmentService } from "../services/attachment-service.js";
import type { MailService, MailSendInput, MailUpdateOutcome } from "../services/mail-service.js";
import { renderMail } from "../renderer/index.js";
import { SAVE_PATH_HINT } from "../utils/path-sandbox.js";
import { executeTool, textResult } from "./tool-runtime.js";

const accountScope = { account: z.string().min(1), role: z.string().optional() };

/** Above this many results, list per sender instead of per message. */
const GROUPED_OUTPUT_THRESHOLD = 30;

/**
 * Renders what a bulk update actually touched.
 *
 * A bare "✅ deleted" cannot be told apart from the same message about the wrong
 * mail, so subject and sender are always included. Small batches list every
 * message; large ones group by sender with one example each, because a wrong
 * sender stands out in a grouped view while nobody reads 200 lines.
 */
export function renderUpdateOutcomes(outcomes: readonly MailUpdateOutcome[]): string {
  const failed = outcomes.filter((o) => o.error);
  const ok = outcomes.filter((o) => !o.error);
  const describe = (o: MailUpdateOutcome): string =>
    `${o.subject ?? "(subject unavailable)"} — ${o.from ?? "(sender unavailable)"}`;
  const actions = [...new Set(ok.flatMap((o) => o.actions))].join(", ") || "no change";
  const lines: string[] = [`✅ ${String(ok.length)} message(s): ${actions}`];

  if (ok.length > 0 && ok.length <= GROUPED_OUTPUT_THRESHOLD) {
    lines.push("", ...ok.map((o) => `  ${describe(o)}\n    id: ${o.id}`));
  } else if (ok.length > GROUPED_OUTPUT_THRESHOLD) {
    const bySender = new Map<string, MailUpdateOutcome[]>();
    for (const outcome of ok) {
      const key = outcome.from ?? "(sender unavailable)";
      bySender.set(key, [...(bySender.get(key) ?? []), outcome]);
    }
    lines.push("");
    for (const [sender, group] of [...bySender.entries()].sort((a, b) => b[1].length - a[1].length))
      lines.push(
        `  ${String(group.length)}× ${sender} — e.g. "${group[0]?.subject ?? "(subject unavailable)"}"`,
      );
    lines.push("", `  ids: ${ok.map((o) => o.id).join(", ")}`);
  }

  if (failed.length > 0) {
    lines.push("", `❌ ${String(failed.length)} failed:`);
    for (const outcome of failed)
      lines.push(`  ${outcome.id}: ${outcome.error ?? "unknown error"}`);
  }
  return lines.join("\n");
}
const sendInput = {
  to: z.string().max(32_000),
  subject: z.string().max(998).optional(),
  body: z.string().max(1_000_000),
  role: z.string().optional(),
  account: z.string().optional(),
  reply_to: z.string().optional(),
  forward_id: z.string().optional(),
  signature: z.boolean().optional(),
  cc: z.string().max(32_000).optional(),
  bcc: z.string().max(32_000).optional(),
  attachments: z.array(z.string()).max(20).optional(),
  idempotency_key: z.string().min(8).max(200).optional(),
};
const mapSend = (input: z.infer<z.ZodObject<typeof sendInput>>): MailSendInput => ({
  ...input,
  replyTo: input.reply_to,
  forwardId: input.forward_id,
  idempotencyKey: input.idempotency_key,
});

export function registerMailTools(
  server: McpServer,
  mail: MailService,
  attachments: AttachmentService,
): void {
  server.registerTool(
    "mail_list",
    {
      description: "List recent emails from a folder",
      inputSchema: {
        role: z.string().optional(),
        folder: z.string().max(256).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ role, folder, limit }) =>
      executeTool("mail_list", async () => {
        const result = await mail.list(role, folder, limit);
        const lines = result.messages.map(
          (m) =>
            `[${m.account}] ${m.isRead ? " " : "●"} ${m.receivedAt.slice(0, 16)} | ${m.from} | ${m.subject}${m.snippet ? `\n  ${m.snippet.slice(0, 100)}` : ""}\n  ID: ${m.id}`,
        );
        return textResult(
          [...lines, ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`)].join(
            "\n\n",
          ) || "No messages found.",
        );
      }),
  );
  server.registerTool(
    "mail_search",
    {
      description: "Search emails across connected accounts",
      inputSchema: {
        query: z.string().trim().min(1).max(1000),
        role: z.string().optional(),
        folder: z.string().max(256).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, role, folder, limit }) =>
      executeTool("mail_search", async () => {
        const result = await mail.search(query, role, folder, limit);
        const lines = result.messages.map(
          (m) =>
            `[${m.account}] ${m.receivedAt.slice(0, 16)} | ${m.from} | ${m.subject}\n  ID: ${m.id}`,
        );
        return textResult(
          [...lines, ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`)].join(
            "\n\n",
          ) || "No results.",
        );
      }),
  );
  server.registerTool(
    "mail_read",
    {
      description: "Read a specific email",
      inputSchema: {
        id: z.string().min(1),
        ...accountScope,
        depth: z.number().int().min(0).max(100).optional(),
        maxLength: z.number().int().min(0).max(1_000_000).optional(),
        format: z.enum(["markdown", "raw", "plain"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, account, role, depth, maxLength, format }) =>
      executeTool("mail_read", async () => {
        const message = await mail.read(id, account, role);
        const formatAttachment = (a: (typeof message.attachments)[number]) =>
          `  - ${a.name} (${String(Math.round(a.size / 1024))}KB, ${a.contentType}) ID: ${a.id}`;
        const regular = message.attachments.filter((a) => !a.isInline);
        const inline = message.attachments.filter((a) => a.isInline);
        const header = [
          `From: ${message.from}`,
          `To: ${message.to.join(", ")}`,
          `Subject: ${message.subject}`,
          `Date: ${message.receivedAt}`,
          regular.length ? `\nAttachments:\n${regular.map(formatAttachment).join("\n")}` : "",
          inline.length ? `\nInline images:\n${inline.map(formatAttachment).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return textResult(
          `${header}\n\n${renderMail({ body: message.body, bodyType: message.bodyType, depth: depth ?? 1, maxLength: maxLength ?? 4000, format: format ?? "markdown" })}`,
        );
      }),
  );
  server.registerTool(
    "mail_send",
    {
      description: "Send, reply to, or forward an email",
      inputSchema: sendInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      executeTool("mail_send", async () => textResult(await mail.send(mapSend(input)))),
  );
  server.registerTool(
    "mail_draft",
    {
      description: "Create an email draft",
      inputSchema: {
        ...sendInput,
        subject: z.string().min(1).max(998),
        reply_to: z.never().optional(),
        forward_id: z.never().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      executeTool("mail_draft", async () => {
        const draft = await mail.draft(mapSend(input));
        return textResult(`📝 Draft created: "${input.subject}" → ${input.to}\nID: ${draft.id}`);
      }),
  );
  server.registerTool(
    "mail_send_draft",
    {
      description: "Send an existing draft",
      inputSchema: {
        id: z.string().min(1),
        ...accountScope,
        idempotency_key: z.string().min(8).max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ id, account, role, idempotency_key }) =>
      executeTool("mail_send_draft", async () => {
        await mail.sendDraft(id, account, role, idempotency_key);
        return textResult("✅ Draft sent successfully");
      }),
  );
  server.registerTool(
    "mail_update",
    {
      description:
        "Mark, move, or delete one or many emails. Deleting always moves to the trash folder, never purges. The result names the subject and sender of every message touched, so a wrong id is visible.",
      inputSchema: {
        id: z.string().min(1).optional().describe("Single message id; or use ids"),
        ids: z
          .array(z.string().min(1))
          .min(1)
          .max(200)
          .optional()
          .describe("Message ids to apply the same action to"),
        ...accountScope,
        is_read: z.boolean().optional(),
        move_to: z.string().min(1).max(256).optional(),
        delete: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, ids, account, role, is_read, move_to, delete: remove }) =>
      executeTool("mail_update", async () => {
        const targets = ids ?? (id ? [id] : []);
        if (targets.length === 0) throw new Error("Provide either id or ids");
        const outcomes = await mail.update(targets, account, role, {
          isRead: is_read,
          moveTo: move_to,
          delete: remove,
        });
        return textResult(renderUpdateOutcomes(outcomes));
      }),
  );
  server.registerTool(
    "mail_attachment_get",
    {
      description: "Fetch, extract, or inline an email attachment",
      inputSchema: {
        messageId: z.string().min(1),
        attachmentId: z.string().min(1),
        ...accountScope,
        name: z.string().min(1).max(255),
        mode: z.enum(["save", "text", "inline"]).optional(),
        path: z.string().optional().describe(SAVE_PATH_HINT),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) =>
      executeTool("mail_attachment_get", async () => {
        const result = await attachments.get({ ...input, mode: input.mode ?? "save" });
        if (result.kind === "image")
          return {
            content: [{ type: "image" as const, data: result.data, mimeType: result.mimeType }],
          };
        if (result.kind === "text") return textResult(result.text);
        return textResult(`✅ Saved: ${result.dest} (${String(Math.round(result.size / 1024))}KB)`);
      }),
  );
}
