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
