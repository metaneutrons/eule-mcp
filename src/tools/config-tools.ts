import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONNECTOR_KINDS, SIGNATURE_MAX_LENGTH, describeSignature } from "../config/index.js";
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
          if (role.displayName) lines.push(`  Display name: ${role.displayName}`);
          lines.push(`  Signature: ${describeSignature(role.signature)}`);
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
          `updates: check=${current.updates?.check === false ? "off" : "on"}`,
          `oauth: clientId=${current.oauth.clientId} tenant=${current.oauth.tenant} apiVersion=${current.oauth.apiVersion ?? "v2"} redirectUri=${current.oauth.redirectUri ?? "—"} extraScopes=${current.oauth.extraScopes?.join(",") ?? "—"}`,
          `google: ${current.google ? `configured (clientSecret=${current.google.clientSecret || current.google.clientSecretRef ? "set" : "—"})` : "—"}`,
          `autoAuth (${String(current.autoAuth?.length ?? 0)}):`,
          ...(current.autoAuth ?? []).map(
            (entry) =>
              `  ${entry.account}: totp=${entry.totpYubikey ? `yubikey(${entry.totpYubikey.credential}${entry.totpYubikey.touch ? ", touch" : ""})` : entry.totpSecret || entry.totpSecretRef ? "set" : "—"} password=${entry.passwordSecretRef ? "set" : "—"}${entry.login ? ` login=${entry.login}` : ""}`,
          ),
          `roles (${String(current.roles.length)}):`,
        ];
        for (const role of current.roles) {
          lines.push(
            `  ${role.id}: ${role.name} (${String(role.weeklyHours)}h) displayName=${role.displayName ?? "—"} signature=${describeSignature(role.signature)}`,
          );
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
        signature: z
          .string()
          .max(SIGNATURE_MAX_LENGTH)
          .nullable()
          .optional()
          .describe(
            "HTML appended to every outgoing mail of this role, or the path of a .html file below ~/.eule (read at send time). null or an empty string removes it",
          ),
        displayName: z
          .string()
          .max(200)
          .nullable()
          .optional()
          .describe("Sender display name for outgoing mail of this role. null removes it"),
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
        "Set the public M365 OAuth client, tenant, endpoint generation, registered webview redirect, or extra scopes. [WRITES config.yaml]",
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
        extraScopes: z
          .array(z.string().trim().min(1))
          .nullable()
          .optional()
          .describe(
            "Extra v2 scopes appended to the tier defaults, e.g. https://graph.microsoft.com/Tasks.ReadWrite; replaces the list, null removes it. The client's app registration must grant them, otherwise every login fails",
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

  server.registerTool(
    "config_set_general",
    {
      description:
        "Set the interface language (de or en) and switch the daily check for a newer Eule release on or off. [WRITES config.yaml]",
      inputSchema: {
        language: z.enum(["de", "en"]).optional(),
        updatesCheck: z
          .boolean()
          .optional()
          .describe("Check GitHub for a newer release at most once a day"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) =>
      executeTool("config_set_general", () => {
        if (input.language === undefined && input.updatesCheck === undefined)
          throw new Error("Give language and/or updatesCheck.");
        config.setGeneral(input);
        return textResult("✅ Updated general settings.");
      }),
  );
}
