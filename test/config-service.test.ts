import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "../src/services/config-service.js";
import type { ConfigManager } from "../src/config/config-manager.js";
import type { AppConfig } from "../src/types/index.js";

function manager(config: AppConfig): ConfigManager {
  return {
    get: () => config,
    removeRole: vi.fn(),
    removeConnector: vi.fn(),
  } as unknown as ConfigManager;
}

describe("ConfigService credential lifecycle", () => {
  const config: AppConfig = {
    language: "en",
    oauth: { clientId: "client", tenant: "common" },
    roles: [
      {
        id: "personal",
        name: "Personal",
        weeklyHours: 0,
        connectors: {
          mail: [
            {
              id: "icloud",
              type: "imap",
              account: "user@example.com",
              credentialRef: "connector/personal/mail/icloud",
            },
          ],
          documents: [
            {
              id: "paperless",
              type: "paperless",
              account: "paperless",
              credentialRef: "connector/personal/documents/paperless",
            },
          ],
        },
      },
    ],
  };

  it("deletes every referenced credential after removing a role", () => {
    const removeCredential = vi.fn();
    new ConfigService(manager(config), removeCredential).removeRole("personal");
    expect(removeCredential).toHaveBeenCalledTimes(2);
    expect(removeCredential).toHaveBeenCalledWith("connector/personal/mail/icloud");
    expect(removeCredential).toHaveBeenCalledWith("connector/personal/documents/paperless");
  });

  it("deletes the referenced credential after removing one connector", () => {
    const removeCredential = vi.fn();
    new ConfigService(manager(config), removeCredential).removeAccount(
      "personal",
      "mail",
      "icloud",
    );
    expect(removeCredential).toHaveBeenCalledWith("connector/personal/mail/icloud");
  });
});

describe("ConfigService.upsertRole signature and display name", () => {
  const base: AppConfig = {
    language: "de",
    oauth: { clientId: "client", tenant: "common" },
    roles: [
      {
        id: "work",
        name: "Work",
        weeklyHours: 0,
        connectors: {},
        signature: "<p>old</p>",
        displayName: "Old Name",
      },
    ],
  };

  function setup() {
    const updateRole = vi.fn();
    const addRole = vi.fn();
    const setGeneral = vi.fn();
    const service = new ConfigService({
      get: () => base,
      updateRole,
      addRole,
      setGeneral,
    } as unknown as ConfigManager);
    return { service, updateRole, addRole, setGeneral };
  }

  it("sets inline HTML and a display name", () => {
    const { service, updateRole } = setup();
    expect(
      service.upsertRole({ id: "work", signature: "<p>new</p>", displayName: " Fabian " }),
    ).toBe("updated");
    expect(updateRole).toHaveBeenCalledWith("work", {
      signature: "<p>new</p>",
      displayName: "Fabian",
    });
  });

  it.each([null, "", "   "])("clears both for %j", (value) => {
    const { service, updateRole } = setup();
    service.upsertRole({ id: "work", signature: value, displayName: value });
    const updates = updateRole.mock.calls[0]?.[1] as Record<string, unknown>;
    expect("signature" in updates).toBe(true);
    expect(updates["signature"]).toBeUndefined();
    expect("displayName" in updates).toBe(true);
    expect(updates["displayName"]).toBeUndefined();
  });

  it("leaves signature and display name alone when they are not given", () => {
    const { service, updateRole } = setup();
    service.upsertRole({ id: "work", weeklyHours: 5 });
    const updates = updateRole.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updates).toEqual({ weeklyHours: 5 });
  });

  it("refuses a signature file that is not below ~/.eule", () => {
    const { service, updateRole } = setup();
    expect(() => service.upsertRole({ id: "work", signature: "/etc/passwd.html" })).toThrow(
      /does not exist|below ~\/\.eule/,
    );
    expect(updateRole).not.toHaveBeenCalled();
  });

  it("creates a role with signature and display name", () => {
    const { service, addRole } = setup();
    expect(
      service.upsertRole({ id: "new", name: "New", signature: "<p>s</p>", displayName: "N" }),
    ).toBe("created");
    expect(addRole).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new", signature: "<p>s</p>", displayName: "N" }),
    );
  });

  it("passes general settings to the manager", () => {
    const { service, setGeneral } = setup();
    service.setGeneral({ language: "en", updatesCheck: false });
    expect(setGeneral).toHaveBeenCalledWith({ language: "en", updatesCheck: false });
  });
});
