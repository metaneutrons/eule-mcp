import { describe, expect, it } from "vitest";
import { parseAppConfig } from "../src/config/schema.js";
import { RolePolicyService } from "../src/config/role-policy.js";
import type { AppConfig } from "../src/types/index.js";

const base: AppConfig = {
  language: "en",
  oauth: { clientId: "client", tenant: "common" },
  roles: [],
};

describe("configuration SSOT schema", () => {
  it("retains backwards-compatible defaults for existing minimal configs", () => {
    const parsed = parseAppConfig({ roles: [] });
    expect(parsed.language).toBe("de");
    expect(parsed.oauth.tenant).toBe("common");
  });

  it("rejects duplicate role and connector identities", () => {
    expect(() =>
      parseAppConfig({
        ...base,
        roles: [
          { id: "work", name: "A", weeklyHours: 1, connectors: {} },
          { id: "work", name: "B", weeklyHours: 1, connectors: {} },
        ],
      }),
    ).toThrow(/duplicate role id/);

    expect(() =>
      parseAppConfig({
        ...base,
        roles: [
          {
            id: "work",
            name: "Work",
            weeklyHours: 40,
            connectors: {
              mail: [{ id: "same", type: "m365", account: "a@example.com" }],
              calendar: [{ id: "same", type: "m365", account: "a@example.com" }],
            },
          },
        ],
      }),
    ).toThrow(/connector id must be unique/);
  });

  it("rejects invalid identifiers, ports, URLs and unknown keys", () => {
    expect(() => parseAppConfig({ ...base, surprise: true })).toThrow(/Unrecognized key/);
    expect(() =>
      parseAppConfig({
        ...base,
        roles: [{ id: "bad id", name: "Bad", weeklyHours: 1, connectors: {} }],
      }),
    ).toThrow();
  });

  it("formats validation failures with the supported Zod 4 API", () => {
    expect(() => parseAppConfig({ roles: "not-an-array" })).toThrow(
      /Invalid config:[\s\S]*expected array/i,
    );
  });

  it("accepts opaque OS credential references and rejects arbitrary references", () => {
    const connector = {
      id: "icloud",
      type: "imap",
      account: "user@example.com",
      credentialRef: "connector/personal/mail/icloud",
    };
    expect(
      parseAppConfig({
        ...base,
        roles: [
          {
            id: "personal",
            name: "Personal",
            weeklyHours: 0,
            connectors: { mail: [connector] },
          },
        ],
      }).roles[0]?.connectors.mail?.[0]?.credentialRef,
    ).toBe(connector.credentialRef);
    expect(() =>
      parseAppConfig({
        ...base,
        roles: [
          {
            id: "personal",
            name: "Personal",
            weeklyHours: 0,
            connectors: { mail: [{ ...connector, credentialRef: "other-app/key" }] },
          },
        ],
      }),
    ).toThrow(/credentialRef/);
    expect(() =>
      parseAppConfig({
        ...base,
        roles: [
          {
            id: "personal",
            name: "Personal",
            weeklyHours: 0,
            connectors: { mail: [{ ...connector, password: "legacy" }] },
          },
        ],
      }),
    ).toThrow(/cannot be combined/);
  });
});

describe("role policy enforcement", () => {
  const config: AppConfig = {
    ...base,
    roles: [
      {
        id: "disabled",
        name: "Disabled",
        weeklyHours: 0,
        connectors: {},
        policy: { enabled: false },
      },
      {
        id: "audit",
        name: "Audit",
        weeklyHours: 1,
        connectors: {},
        policy: { readOnly: true, allowedConnectorKinds: ["mail"] },
      },
    ],
  };
  const policy = new RolePolicyService(() => config);

  it("allows reads but denies writes for read-only roles", () => {
    expect(policy.select("audit", "mail", "read")).toHaveLength(1);
    expect(policy.select("audit", "mail", "write")).toHaveLength(0);
    expect(() => policy.assert("audit", "mail", "write")).toThrow(/does not permit/);
  });

  it("denies disabled roles and non-allowlisted domains", () => {
    expect(policy.select("disabled", "mail", "read")).toHaveLength(0);
    expect(policy.select("audit", "calendar", "read")).toHaveLength(0);
  });
});
