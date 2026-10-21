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

import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "../src/config/config-manager.js";
import { logger } from "../src/utils/logger.js";
import type { ConnectorConfig } from "../src/types/index.js";

const CONFIG_PATH = join(homedir(), ".eule", "config.yaml");

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

    cm.upsertAutoAuth("me@x.de", {
      passwordSecretRef: "oauth/m365/password/a1b2.c3d4",
    });
    entry = new ConfigManager().get().autoAuth?.find((a) => a.account === "me@x.de");
    expect(entry?.totpSecretRef).toBe("totp/a1b2.c3d4");
    expect(entry?.passwordSecretRef).toBe("oauth/m365/password/a1b2.c3d4");

    cm.removeAutoAuthCredential("me@x.de", "totp");
    entry = new ConfigManager().get().autoAuth?.find((a) => a.account === "me@x.de");
    expect(entry?.totpSecretRef).toBeUndefined();
    expect(entry?.passwordSecretRef).toBe("oauth/m365/password/a1b2.c3d4");

    cm.removeAutoAuthCredential("me@x.de", "password");
    expect(new ConfigManager().get().autoAuth).toBeUndefined();
  });

  it("keeps one TOTP source per account and removes a YubiKey binding with the TOTP kind", () => {
    const cm = new ConfigManager();
    cm.upsertAutoAuth("me@x.de", {
      totpSecretRef: "totp/a1b2.c3d4",
      passwordSecretRef: "oauth/m365/password/a1b2.c3d4",
    });
    cm.upsertAutoAuth("me@x.de", { totpYubikey: { credential: "eule:me@x.de", touch: true } });
    let entry = new ConfigManager().get().autoAuth?.find((a) => a.account === "me@x.de");
    expect(entry?.totpSecretRef).toBeUndefined();
    expect(entry?.totpYubikey).toEqual({ credential: "eule:me@x.de", touch: true });
    expect(entry?.passwordSecretRef).toBe("oauth/m365/password/a1b2.c3d4");

    cm.removeAutoAuthCredential("me@x.de", "password");
    entry = new ConfigManager().get().autoAuth?.find((a) => a.account === "me@x.de");
    expect(entry?.totpYubikey).toEqual({ credential: "eule:me@x.de", touch: true });

    cm.upsertAutoAuth("me@x.de", { totpSecretRef: "totp/e5f6.a7b8" });
    entry = new ConfigManager().get().autoAuth?.find((a) => a.account === "me@x.de");
    expect(entry?.totpYubikey).toBeUndefined();

    cm.upsertAutoAuth("me@x.de", { totpYubikey: { credential: "eule:me@x.de" } });
    cm.removeAutoAuthCredential("me@x.de", "totp");
    expect(new ConfigManager().get().autoAuth).toBeUndefined();
  });

  it("keeps login: safari when other bindings come and go", () => {
    const cm = new ConfigManager();
    cm.upsertAutoAuth("me@x.de", { login: "safari" });
    cm.upsertAutoAuth("me@x.de", { totpSecretRef: "totp/a1b2.c3d4" });
    cm.removeAutoAuthCredential("me@x.de", "totp");
    expect(new ConfigManager().get().autoAuth).toEqual([{ account: "me@x.de", login: "safari" }]);
    cm.upsertAutoAuth("me@x.de", { login: null });
    expect(new ConfigManager().get().autoAuth).toBeUndefined();
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

describe("ConfigManager picks up changes made outside the process", () => {
  beforeEach(() => {
    files = {};
    vi.restoreAllMocks();
  });

  const work = { id: "work", name: "Work", weeklyHours: 0, contexts: [], connectors: {} };

  it("reads an edit of config.yaml on the next get()", () => {
    const cm = new ConfigManager();
    cm.addRole(work);
    const before = cm.revision;
    files[CONFIG_PATH] = (files[CONFIG_PATH] ?? "").replace("name: Work", "name: Edited");
    expect(cm.get().roles[0]?.name).toBe("Edited");
    expect(cm.revision).not.toBe(before);
  });

  it("keeps the last good configuration for an invalid edit and reports it once", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const cm = new ConfigManager();
    cm.addRole(work);
    const good = files[CONFIG_PATH] ?? "";
    files[CONFIG_PATH] = "roles: not-a-list\n";
    expect(cm.get().roles).toHaveLength(1);
    expect(cm.get().roles).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
    files[CONFIG_PATH] = good.replace("name: Work", "name: Fixed");
    expect(cm.get().roles[0]?.name).toBe("Fixed");
  });

  it("does not recreate a config file that was deleted", () => {
    const cm = new ConfigManager();
    cm.addRole(work);
    delete files[CONFIG_PATH];
    expect(cm.get().roles).toHaveLength(1);
    expect(CONFIG_PATH in files).toBe(false);
  });

  it("does not take its own writes for outside changes", () => {
    const cm = new ConfigManager();
    cm.addRole(work);
    const revision = cm.revision;
    cm.get();
    cm.get();
    expect(cm.revision).toBe(revision);
  });
});

describe("ConfigManager role signature, general settings and extra scopes", () => {
  beforeEach(() => {
    files = {};
  });

  it("writes a signature file reference back as the reference, not as its content", () => {
    const cm = new ConfigManager();
    cm.addRole({
      id: "work",
      name: "Work",
      weeklyHours: 0,
      contexts: [],
      connectors: {},
      signature: "~/.eule/signatures/work.html",
      displayName: "Fabian",
    });
    cm.setOAuth({ tenant: "organizations" });
    const reloaded = new ConfigManager().get().roles[0];
    expect(reloaded?.signature).toBe("~/.eule/signatures/work.html");
    expect(reloaded?.displayName).toBe("Fabian");
  });

  it("removes signature and display name from config.yaml when they are cleared", () => {
    const cm = new ConfigManager();
    cm.addRole({
      id: "work",
      name: "Work",
      weeklyHours: 0,
      contexts: [],
      connectors: {},
      signature: "<p>Fabian</p>",
      displayName: "Fabian",
    });
    cm.updateRole("work", { signature: undefined, displayName: undefined });
    expect(files[CONFIG_PATH]).not.toContain("signature");
    expect(files[CONFIG_PATH]).not.toContain("displayName");
    expect(new ConfigManager().get().roles[0]?.signature).toBeUndefined();
  });

  it("setGeneral changes language and update check independently", () => {
    const cm = new ConfigManager();
    cm.setGeneral({ language: "en" });
    expect(cm.get().language).toBe("en");
    expect(cm.get().updates).toBeUndefined();
    cm.setGeneral({ updatesCheck: false });
    const reloaded = new ConfigManager().get();
    expect(reloaded.language).toBe("en");
    expect(reloaded.updates).toEqual({ check: false });
    cm.setGeneral({ updatesCheck: true });
    expect(new ConfigManager().get().updates).toEqual({ check: true });
  });

  it("setOAuth sets, keeps and clears extraScopes", () => {
    const cm = new ConfigManager();
    cm.setOAuth({ extraScopes: ["https://graph.microsoft.com/Tasks.ReadWrite"] });
    expect(new ConfigManager().get().oauth.extraScopes).toEqual([
      "https://graph.microsoft.com/Tasks.ReadWrite",
    ]);
    cm.setOAuth({ tenant: "organizations" });
    expect(cm.get().oauth.extraScopes).toHaveLength(1);
    cm.setOAuth({ extraScopes: null });
    expect(new ConfigManager().get().oauth.extraScopes).toBeUndefined();
  });
});
