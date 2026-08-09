import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/services/auth-service.js";
import type { ConfigManager } from "../src/config/index.js";
import type { TokenRepository } from "../src/auth/token-repository.js";

describe("AuthService inventory", () => {
  it("exposes health metadata without token material and delegates logout", () => {
    const remove = vi.fn(() => true);
    const repository: TokenRepository = {
      load: () => ({
        accounts: {
          "user@example.com": {
            account: "user@example.com",
            accessToken: "must-not-leak",
            refreshToken: "must-not-leak",
            expiresAt: Date.now() + 60 * 60 * 1000,
            tier: "graph",
          },
        },
      }),
      save: vi.fn(),
      remove,
    };
    const config = {
      get: () => ({ language: "en", oauth: { clientId: "id", tenant: "common" }, roles: [] }),
      euleDirPath: "/data",
    } as unknown as ConfigManager;
    const auth = new AuthService(config, repository);
    const serialized = JSON.stringify(auth.inventory());
    expect(serialized).toContain("user@example.com");
    expect(serialized).not.toContain("must-not-leak");
    expect(auth.logout("USER@example.com")).toBe(true);
    expect(remove).toHaveBeenCalledWith("USER@example.com");
  });
});
