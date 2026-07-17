import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONNECTOR_KINDS, CONNECTOR_TYPES } from "../config/index.js";
import type { ConfigService } from "../services/config-service.js";
import type { ConnectorConfig } from "../types/index.js";
import { executeTool, textResult } from "./tool-runtime.js";

export function registerConfigTools(server: McpServer, config: ConfigService): void {
  server.registerTool(
    "role_list",
    {
      description: "List configured roles, policies, and connector bindings",
      inputSchema: { format: z.enum(["summary", "detailed"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ format }) =>
      executeTool("role_list", () => {
        const roles = config.get().roles;
        if (!roles.length)
          return textResult("No roles configured. Edit config.yaml or use role_upsert.");
        const lines: string[] = [];
        for (const role of roles) {
          lines.push(`## ${role.id}: ${role.name}`);
          lines.push(`  Weekly hours: ${String(role.weeklyHours)}`);
          lines.push(
            `  Policy: ${role.policy?.enabled === false ? "disabled" : role.policy?.readOnly ? "read-only" : "read/write"}`,
          );
          if (role.contexts?.length) lines.push(`  Contexts: ${role.contexts.join(", ")}`);
          if (format === "detailed")
            for (const kind of CONNECTOR_KINDS)
              for (const connector of role.connectors[kind] ?? [])
                lines.push(
                  `  ${kind}: ${connector.id} [${connector.type}] ${connector.mailbox ?? connector.account}`,
                );
          lines.push("");
        }
        return textResult(lines.join("\n"));
      }),
  );

  server.registerTool(
    "config_get",
    {
      description: "Show the current configuration with every secret redacted. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      executeTool("config_get", () => {
        const current = config.get();
        const lines = [
          `language: ${current.language}`,
          `oauth: clientId=${current.oauth.clientId} tenant=${current.oauth.tenant} apiVersion=${current.oauth.apiVersion ?? "v2"}`,
          `google: ${current.google ? "configured (clientSecret set)" : "—"}`,
          `autoAuth (${String(current.autoAuth?.length ?? 0)}):`,
          ...(current.autoAuth ?? []).map(
            (entry) => `  ${entry.account}: totpSecret=${entry.totpSecret ? "set" : "—"}`,
          ),
          `roles (${String(current.roles.length)}):`,
        ];
        for (const role of current.roles) {
          lines.push(`  ${role.id}: ${role.name} (${String(role.weeklyHours)}h)`);
          for (const kind of CONNECTOR_KINDS)
            for (const connector of role.connectors[kind] ?? [])
              lines.push(
                `    ${kind}: ${connector.id} [${connector.type}] ${connector.mailbox ?? connector.account}${connector.mailbox ? " (shared)" : ""}`,
              );
        }
        return textResult(lines.join("\n"));
      }),
  );

  server.registerTool(
    "role_upsert",
    {
      description: "Create or update a role's metadata. [WRITES config.yaml]",
      inputSchema: {
        id: z.string().describe("Role id (stable key)"),
        name: z.string().optional().describe("Display name (required when creating a new role)"),
        weeklyHours: z.number().optional(),
        contexts: z.array(z.string()).optional(),
        enabled: z.boolean().optional().describe("Enable or disable all access through this role"),
        readOnly: z.boolean().optional().describe("Deny every mutating connector operation"),
        allowedConnectorKinds: z.array(z.enum(CONNECTOR_KINDS)).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) =>
      executeTool("role_upsert", () => {
        const outcome = config.upsertRole(input);
        return textResult(
          `✅ ${outcome === "created" ? "Created" : "Updated"} role "${input.id}".`,
        );
      }),
  );

  server.registerTool(
    "account_list",
    {
      description:
        "List the SSOT account inventory, including every role and connector using each account",
      inputSchema: { role: z.string().optional().describe("Restrict inventory to one role") },
      annotations: { readOnlyHint: true },
    },
    async ({ role }) =>
      executeTool("account_list", () => {
        const accounts = config.listAccounts(role);
        return textResult(
          accounts
            .map(
              (entry) =>
                `${entry.account} [${entry.types.join(", ")}]\n  ${entry.bindings.join("\n  ")}`,
            )
            .join("\n\n") || "No accounts configured.",
        );
      }),
  );

  server.registerTool(
    "role_remove",
    {
      description: "Remove a role and its connectors. [WRITES config.yaml]",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ id }) =>
      executeTool("role_remove", () => {
        config.removeRole(id);
        return textResult(`✅ Removed role "${id}".`);
      }),
  );

  server.registerTool(
    "account_add",
    {
      description:
        "Add a structural connector binding to a role; secrets must be set locally. [WRITES config.yaml]",
      inputSchema: {
        role: z.string(),
        kind: z.enum(CONNECTOR_KINDS),
        type: z.enum(CONNECTOR_TYPES),
        account: z.string(),
        id: z.string().optional().describe("Connector id (default derived from type+account)"),
        mailbox: z.string().optional().describe("Shared/delegate mailbox to target"),
        host: z.string().optional(),
        port: z.number().optional(),
        smtpHost: z.string().optional(),
        smtpPort: z.number().optional(),
        url: z.string().optional().describe("CalDAV/CardDAV/iCal/Paperless base URL"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      executeTool("account_add", () => {
        const id = input.id ?? `${input.type}-${input.account.replace(/[^a-zA-Z0-9]+/g, "-")}`;
        const connector: ConnectorConfig = {
          id,
          type: input.type,
          account: input.account,
          ...(input.mailbox ? { mailbox: input.mailbox } : {}),
          ...(input.host ? { host: input.host } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.smtpHost ? { smtpHost: input.smtpHost } : {}),
          ...(input.smtpPort !== undefined ? { smtpPort: input.smtpPort } : {}),
          ...(input.url ? { url: input.url } : {}),
        };
        config.addAccount(input.role, input.kind, connector);
        const note = ["imap", "caldav", "carddav", "paperless"].includes(input.type)
          ? " ⚠ Needs a secret configured through the local CLI."
          : "";
        return textResult(
          `✅ Added ${input.kind} connector "${id}" to role "${input.role}".${note}`,
        );
      }),
  );

  server.registerTool(
    "account_remove",
    {
      description: "Remove a connector binding from a role. [WRITES config.yaml]",
      inputSchema: { role: z.string(), kind: z.enum(CONNECTOR_KINDS), id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ role, kind, id }) =>
      executeTool("account_remove", () => {
        config.removeAccount(role, kind, id);
        return textResult(`✅ Removed ${kind} connector "${id}".`);
      }),
  );

  server.registerTool(
    "config_set_oauth",
    {
      description:
        "Set the public M365 OAuth client, tenant, or endpoint generation. [WRITES config.yaml]",
      inputSchema: {
        clientId: z.string().optional(),
        tenant: z.string().optional(),
        apiVersion: z.enum(["v1", "v2"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) =>
      executeTool("config_set_oauth", () => {
        config.setOAuth(input);
        return textResult("✅ Updated oauth settings.");
      }),
  );
}
