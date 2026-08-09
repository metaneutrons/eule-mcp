import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fs so ConfigManager reads/writes a virtual ~/.eule/config.yaml.
let files: Record<string, string> = {};
vi.mock("node:fs", () => ({
  existsSync: (p: string) => p in files,
  readFileSync: (p: string) => files[p],
  writeFileSync: (p: string, data: string) => {
    files[p] = data;
  },
  renameSync: (from: string, to: string) => {
    files[to] = files[from] ?? "";
    delete files[from];
  },
  rmSync: (p: string) => {
    delete files[p];
  },
  mkdirSync: () => undefined,
  chmodSync: () => undefined,
}));

import { ConfigManager } from "../src/config/config-manager.js";
import type { ConnectorConfig } from "../src/types/index.js";

describe("ConfigManager mutations (backing the MCP config tools)", () => {
  beforeEach(() => {
    files = {};
  });

  it("setOAuth patches only the given fields", () => {
    const cm = new ConfigManager();
    cm.setOAuth({
      apiVersion: "v1",
      clientId: "apple",
      redirectUri: "urn:ietf:wg:oauth:2.0:oob",
    });
    cm.setOAuth({
      tenant: "organizations",
      clientId: undefined,
      apiVersion: undefined,
      redirectUri: undefined,
    });
    expect(cm.get().oauth.clientId).toBe("apple");
    expect(cm.get().oauth.apiVersion).toBe("v1");
    expect(cm.get().oauth.tenant).toBe("organizations");
    expect(cm.get().oauth.redirectUri).toBe("urn:ietf:wg:oauth:2.0:oob");
    cm.setOAuth({ redirectUri: null });
    expect(cm.get().oauth.redirectUri).toBeUndefined();
  });

  it("adds/removes connectors and rejects duplicate ids; survives a YAML round-trip", () => {
    const cm = new ConfigManager();
    cm.addRole({ id: "work", name: "Work", weeklyHours: 40, contexts: [], connectors: {} });
    const conn: ConnectorConfig = {
      id: "hs-mail",
      type: "m365",
      account: "me@x.de",
      mailbox: "shared@x.de",
    };
    cm.addConnector("work", "mail", conn);
    expect(cm.get().roles[0]?.connectors.mail?.[0]?.mailbox).toBe("shared@x.de");

    expect(() => cm.addConnector("work", "mail", conn)).toThrow(/already exists/);
    expect(() => cm.addConnector("nope", "mail", conn)).toThrow(/not found/);

    // A fresh manager re-parses the written YAML — proves persistence + schema.
    const reloaded = new ConfigManager();
    expect(reloaded.get().roles[0]?.connectors.mail?.[0]?.id).toBe("hs-mail");

    cm.removeConnector("work", "mail", "hs-mail");
    expect(cm.get().roles[0]?.connectors.mail ?? []).toHaveLength(0);
    expect(() => cm.removeConnector("work", "mail", "hs-mail")).toThrow(/not found/);
  });

  it("upsertAutoAuth updates one entry and migrates inline TOTP to a reference", () => {
    const cm = new ConfigManager();
    cm.upsertAutoAuth("me@x.de", { totpSecret: "GEZDGNBVGY3TQOJQ" });
    // parseAutoAuth must keep an entry that has a totpSecret.
    let entry = new ConfigManager().get().autoAuth?.find((a) => a.account === "me@x.de");
    expect(entry?.totpSecret).toBe("GEZDGNBVGY3TQOJQ");

    cm.upsertAutoAuth("me@x.de", { totpSecret: "MFRGGZDFMZTWQ2LK" });
    entry = new ConfigManager().get().autoAuth?.find((a) => a.account === "me@x.de");
    expect(entry?.totpSecret).toBe("MFRGGZDFMZTWQ2LK"); // updated in place
    expect(new ConfigManager().get().autoAuth).toHaveLength(1); // still one entry

    cm.upsertAutoAuth("me@x.de", { totpSecretRef: "totp/a1b2.c3d4" });
    entry = new ConfigManager().get().autoAuth?.find((a) => a.account === "me@x.de");
    expect(entry?.totpSecret).toBeUndefined();
    expect(entry?.totpSecretRef).toBe("totp/a1b2.c3d4");
  });

  it("rejects an interactive commit based on a stale disk revision", () => {
    const first = new ConfigManager();
    const expectedRevision = first.revision;
    const second = new ConfigManager();
    second.setOAuth({ tenant: "organizations" });

    expect(() =>
      first.setGoogleOAuth(
        { clientId: "google-client", clientSecretRef: "oauth/google/client-secret.a1b2" },
        expectedRevision,
      ),
    ).toThrow(/changed while the operation was in progress/);
    expect(new ConfigManager().get().oauth.tenant).toBe("organizations");
  });

  it("removeRole drops the role", () => {
    const cm = new ConfigManager();
    cm.addRole({ id: "r", name: "R", weeklyHours: 0, contexts: [], connectors: {} });
    cm.removeRole("r");
    expect(cm.get().roles).toHaveLength(0);
    expect(() => cm.removeRole("r")).toThrow(/not found/);
  });
});
