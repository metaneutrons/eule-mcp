import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONNECTOR_KINDS } from "../config/index.js";
import type { ConfigService } from "../services/config-service.js";
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
          `oauth: clientId=${current.oauth.clientId} tenant=${current.oauth.tenant} apiVersion=${current.oauth.apiVersion ?? "v2"} redirectUri=${current.oauth.redirectUri ?? "—"}`,
          `google: ${current.google ? `configured (clientSecret=${current.google.clientSecret || current.google.clientSecretRef ? "set" : "—"})` : "—"}`,
          `autoAuth (${String(current.autoAuth?.length ?? 0)}):`,
          ...(current.autoAuth ?? []).map(
            (entry) =>
              `  ${entry.account}: totp=${entry.totpSecret || entry.totpSecretRef ? "set" : "—"} password=${entry.passwordSecretRef ? "set" : "—"}`,
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
        "Set the public M365 OAuth client, tenant, endpoint generation, or registered webview redirect. [WRITES config.yaml]",
      inputSchema: {
        clientId: z.string().optional(),
        tenant: z.string().optional(),
        apiVersion: z.enum(["v1", "v2"]).optional(),
        redirectUri: z
          .url()
          .nullable()
          .optional()
          .describe(
            "Broker/custom redirect registered for this M365 public client; null removes it",
          ),
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
