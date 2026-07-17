import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthService } from "../services/auth-service.js";
import { executeTool, textResult } from "./tool-runtime.js";

export function registerAuthTools(server: McpServer, auth: AuthService): void {
  server.registerTool(
    "auth_status",
    {
      description: "Show authentication and configuration status",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      executeTool("auth_status", () => {
        const status = auth.status();
        const roles = status.roles.map(
          (r) =>
            `  ${r.id}: ${r.name} (${String(r.weeklyHours)}h/week, ${String(r.mail)} mail, ${String(r.calendar)} cal)`,
        );
        const accounts = status.accounts.map(
          (a) =>
            `  ${a.account}: ${a.provider}/${a.tier}, ${a.health}, expires ${new Date(a.expiresAt).toISOString()}`,
        );
        return textResult(
          [
            `Language: ${status.language}`,
            `Roles (${String(status.roles.length)}):`,
            ...roles,
            "",
            `Authenticated accounts (${String(accounts.length)}):`,
            ...(accounts.length ? accounts : ["  none — run 'eule-mcp setup' to add accounts"]),
            "",
            `Data: ${status.dataPath}`,
          ].join("\n"),
        );
      }),
  );
  server.registerTool(
    "auth_accounts",
    {
      description: "List authenticated accounts without exposing tokens",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      executeTool("auth_accounts", () =>
        textResult(
          auth
            .inventory()
            .map(
              (a) =>
                `${a.account} [${a.provider}/${a.tier}] ${a.health}\n  Expires: ${new Date(a.expiresAt).toISOString()}`,
            )
            .join("\n\n") || "No authenticated accounts.",
        ),
      ),
  );
  server.registerTool(
    "auth_login",
    {
      description: "Authenticate an M365 or Google account",
      inputSchema: {
        account: z.email().optional(),
        tier: z.enum(["graph", "ews", "imap", "google"]).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account, tier }) =>
      executeTool(
        "auth_login",
        async () => {
          const token = await auth.login(tier ?? "graph", account);
          return textResult(
            `✅ Authenticated: ${token.account}\nTier: ${token.tier}\nExpires: ${new Date(token.expiresAt).toISOString()}`,
          );
        },
        { timeoutMs: 10 * 60 * 1000 },
      ),
  );
  server.registerTool(
    "auth_probe",
    {
      description: "Probe the configured API tier for an account",
      inputSchema: { account: z.email() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account }) =>
      executeTool("auth_probe", async () => {
        const result = await auth.probe(account);
        return textResult(
          `Account: ${account.toLowerCase()}\nCurrent tier: ${result.tier}\nProbe result: ${result.result}`,
        );
      }),
  );
  server.registerTool(
    "auth_logout",
    {
      description: "Remove locally stored tokens for an account; remote grants are not revoked",
      inputSchema: { account: z.email() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ account }) =>
      executeTool("auth_logout", () =>
        textResult(
          auth.logout(account)
            ? `✅ Removed local tokens for ${account.toLowerCase()}`
            : `No stored tokens for ${account.toLowerCase()}`,
        ),
      ),
  );
}
