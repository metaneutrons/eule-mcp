import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ConfigService } from "../src/services/config-service.js";
import type { AppConfig } from "../src/types/index.js";
import { registerConfigTools } from "../src/tools/config-tools.js";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const config: AppConfig = {
  language: "de",
  oauth: { clientId: "client", tenant: "common", extraScopes: ["scope.a"] },
  updates: { check: false },
  roles: [
    {
      id: "lexict",
      name: "lexICT",
      weeklyHours: 0,
      connectors: {},
      signature: "<p>Fabian</p>",
      displayName: "Fabian Schmieder",
    },
  ],
};

function register(service: Partial<ConfigService>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _schema: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerConfigTools(server, { get: () => config, ...service } as unknown as ConfigService);
  return handlers;
}

describe("configuration tools cover signature, display name and general settings", () => {
  it("role_upsert hands signature and display name to the service, null included", async () => {
    const upsertRole = vi.fn().mockReturnValue("updated");
    const handlers = register({ upsertRole });
    const result = await handlers.get("role_upsert")!({
      id: "lexict",
      signature: null,
      displayName: "Fabian",
    });
    expect(result.isError).not.toBe(true);
    expect(upsertRole).toHaveBeenCalledWith({
      id: "lexict",
      signature: null,
      displayName: "Fabian",
    });
  });

  it("config_set_general updates language and update check, and refuses an empty call", async () => {
    const setGeneral = vi.fn();
    const handlers = register({ setGeneral });
    const ok = await handlers.get("config_set_general")!({ language: "en", updatesCheck: true });
    expect(ok.isError).not.toBe(true);
    expect(setGeneral).toHaveBeenCalledWith({ language: "en", updatesCheck: true });
    const empty = await handlers.get("config_set_general")!({});
    expect(empty.isError).toBe(true);
    expect(setGeneral).toHaveBeenCalledTimes(1);
  });

  it("config_set_oauth passes extraScopes on", async () => {
    const setOAuth = vi.fn();
    const handlers = register({ setOAuth });
    await handlers.get("config_set_oauth")!({ extraScopes: null });
    expect(setOAuth).toHaveBeenCalledWith({ extraScopes: null });
  });

  it("config_get and role_list show the new settings without printing the signature HTML", async () => {
    const handlers = register({});
    const got = await handlers.get("config_get")!({});
    const text = (got.content[0] as { text: string }).text;
    expect(text).toContain("updates: check=off");
    expect(text).toContain("extraScopes=scope.a");
    expect(text).toContain("displayName=Fabian Schmieder");
    expect(text).toContain("signature=inline HTML (13 chars)");
    expect(text).not.toContain("<p>Fabian</p>");
    const listed = await handlers.get("role_list")!({});
    const listText = (listed.content[0] as { text: string }).text;
    expect(listText).toContain("Display name: Fabian Schmieder");
    expect(listText).toContain("Signature: inline HTML (13 chars)");
  });
});
