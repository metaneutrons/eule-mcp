import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/services/auth-service.js";
import type { ConfigManager } from "../src/config/index.js";
import type { TokenRepository } from "../src/auth/token-repository.js";
import type { AccountToken, TokenStore } from "../src/types/index.js";
import { ConfiguredCredentialResolver } from "../src/helper/configured-credential-resolver.js";
import { runWithExecutionContext } from "../src/utils/execution-context.js";

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

describe("AuthService M365 webview login", () => {
  it("passes only credential references to the local helper", async () => {
    const account = "user@example.com";
    const totpCredentialRef = "totp/a1b2.c3d4";
    const passwordCredentialRef = "oauth/m365/password/a1b2.c3d4";
    let store: TokenStore = { accounts: {} };
    const repository: TokenRepository = {
      load: () => store,
      save: vi.fn(),
      remove: vi.fn(() => false),
    };
    const config = {
      get: () => ({
        language: "en",
        oauth: {
          clientId: "public-client",
          tenant: "organizations",
          apiVersion: "v1",
          redirectUri: "urn:ietf:wg:oauth:2.0:oob",
        },
        autoAuth: [
          { account, totpSecretRef: totpCredentialRef, passwordSecretRef: passwordCredentialRef },
        ],
        roles: [],
      }),
      euleDirPath: "/data",
    } as unknown as ConfigManager;
    const capturedToken: AccountToken = {
      account,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1_000,
      tier: "ews",
      clientId: "public-client",
      apiVersion: "v1",
    };
    const capture = vi.fn(async () => {
      store = { accounts: { [account]: capturedToken } };
      return 0;
    });
    const credentialBroker = {
      capture: vi.fn(),
      read: vi.fn(() => {
        throw new Error("M365 secret must not enter Node");
      }),
      status: vi.fn(),
      remove: vi.fn(),
    };
    const auth = new AuthService(
      config,
      repository,
      new ConfiguredCredentialResolver(config, credentialBroker),
      capture,
    );
    const execution = new AbortController();

    const token = await runWithExecutionContext(
      {
        correlationId: "m365-webview-login",
        operation: "auth_login",
        startedAt: Date.now(),
        signal: execution.signal,
      },
      () =>
        auth.login({
          tier: "ews",
          account: "USER@example.com",
          method: "auto",
        }),
    );

    expect(token).toEqual(capturedToken);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "public-client",
        tier: "ews",
        apiVersion: "v1",
        resource: "https://outlook.office.com",
        tenant: "organizations",
        loginHint: account,
        redirectUri: "urn:ietf:wg:oauth:2.0:oob",
        totpCredentialRef,
        passwordCredentialRef,
        signal: execution.signal,
      }),
    );
    expect(credentialBroker.read).not.toHaveBeenCalled();
  });

  it("requires an account for an explicitly selected M365 webview", async () => {
    const repository: TokenRepository = {
      load: () => ({ accounts: {} }),
      save: vi.fn(),
      remove: vi.fn(() => false),
    };
    const config = {
      get: () => ({
        language: "en",
        oauth: { clientId: "public-client", tenant: "common" },
        roles: [],
      }),
      euleDirPath: "/data",
    } as unknown as ConfigManager;
    const capture = vi.fn(async () => 0);
    const auth = new AuthService(
      config,
      repository,
      new ConfiguredCredentialResolver(config),
      capture,
    );

    const error = await auth
      .login({ tier: "graph", method: "webview" })
      .catch((reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))));

    expect(error.message).toMatch(/account email is required/i);
    expect(capture).not.toHaveBeenCalled();
  });
});
