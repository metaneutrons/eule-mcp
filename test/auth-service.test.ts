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

  it("reuses the stored tier when no tier is requested", async () => {
    const account = "user@example.com";
    let store: TokenStore = {
      accounts: {
        [account]: {
          account,
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: Date.now() - 1_000,
          tier: "ews",
        },
      },
    };
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
          tenant: "common",
          redirectUri: "https://login.microsoftonline.com/common/oauth2/nativeclient",
        },
        roles: [],
      }),
      euleDirPath: "/data",
    } as unknown as ConfigManager;
    const capture = vi.fn(async () => {
      store = {
        accounts: {
          [account]: {
            account,
            accessToken: "new-access",
            refreshToken: "new-refresh",
            expiresAt: Date.now() + 60 * 60 * 1_000,
            tier: "ews",
          },
        },
      };
      return 0;
    });
    const auth = new AuthService(
      config,
      repository,
      new ConfiguredCredentialResolver(config),
      capture,
    );

    const token = await runWithExecutionContext(
      {
        correlationId: "m365-stored-tier-login",
        operation: "auth_login",
        startedAt: Date.now(),
        signal: new AbortController().signal,
      },
      () => auth.login({ account: "USER@example.com" }),
    );

    expect(token.tier).toBe("ews");
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "ews", loginHint: account }),
    );
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

describe("AuthService Safari sign-in", () => {
  const account = "user@example.com";

  function harness(stored?: AccountToken["tier"]) {
    let store: TokenStore = {
      accounts: stored
        ? {
            [account]: {
              account,
              accessToken: "old",
              refreshToken: "dead",
              expiresAt: 0,
              tier: stored,
            },
          }
        : {},
    };
    const repository: TokenRepository = {
      load: () => store,
      save: vi.fn(),
      remove: vi.fn(() => false),
    };
    const upsertAutoAuth = vi.fn();
    const config = {
      get: () => ({
        language: "en",
        oauth: {
          clientId: "public-client",
          tenant: "organizations",
          apiVersion: "v1",
          redirectUri: "urn:ietf:wg:oauth:2.0:oob",
        },
        roles: [],
      }),
      upsertAutoAuth,
      euleDirPath: "/data",
    } as unknown as ConfigManager;
    let exitCode = 0;
    const safari = vi.fn(async (options: { tier: string }) => {
      if (exitCode === 0)
        store = {
          accounts: {
            [account]: {
              account,
              accessToken: "fresh",
              refreshToken: "fresh",
              expiresAt: Date.now() + 3_600_000,
              tier: options.tier as AccountToken["tier"],
            },
          },
        };
      return exitCode;
    });
    const auth = new AuthService(config, repository, undefined, undefined, safari);
    return {
      auth,
      safari,
      upsertAutoAuth,
      exitWith: (code: number) => {
        exitCode = code;
      },
    };
  }

  const context = (signal: AbortSignal) => ({
    correlationId: "safari",
    operation: "auth_login",
    startedAt: Date.now(),
    signal,
  });

  it("signs in through Safari without the webview redirect and remembers Safari for the account", async () => {
    const { auth, safari, upsertAutoAuth } = harness();
    const execution = new AbortController();
    const token = await runWithExecutionContext(context(execution.signal), () =>
      auth.login({ account: "USER@example.com", tier: "ews", method: "safari" }),
    );
    expect(token.accessToken).toBe("fresh");
    expect(safari).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "public-client",
        tier: "ews",
        apiVersion: "v1",
        resource: "https://outlook.office.com",
        tenant: "organizations",
        loginHint: account,
        signal: execution.signal,
      }),
    );
    expect(safari.mock.calls[0]?.[0]).not.toHaveProperty("redirectUri");
    expect(upsertAutoAuth).toHaveBeenCalledWith(account, { login: "safari" });
  });

  it("renews on the stored tier and cannot be cancelled by the tool call that needed it", async () => {
    const { auth, safari, upsertAutoAuth } = harness("ews");
    const execution = new AbortController();
    await runWithExecutionContext(context(execution.signal), () =>
      auth.renewWithSafari("User@Example.com"),
    );
    expect(safari).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "ews", loginHint: account }),
    );
    expect(safari.mock.calls[0]?.[0]).not.toHaveProperty("signal");
    expect(upsertAutoAuth).not.toHaveBeenCalled();
  });

  it("reports a closed window and a timeout", async () => {
    const closed = harness();
    closed.exitWith(3);
    await expect(closed.auth.login({ account, tier: "graph", method: "safari" })).rejects.toThrow(
      /window was closed/,
    );
    const timedOut = harness("graph");
    timedOut.exitWith(2);
    await expect(timedOut.auth.renewWithSafari(account)).rejects.toThrow(/timed out/);
    expect(closed.upsertAutoAuth).not.toHaveBeenCalled();
  });

  it("needs an M365 account", async () => {
    const { auth, safari } = harness();
    await expect(auth.login({ tier: "graph", method: "safari" })).rejects.toThrow(/account email/);
    await expect(auth.login({ account, tier: "google", method: "safari" })).rejects.toThrow(
      /only for M365/,
    );
    expect(safari).not.toHaveBeenCalled();
  });
});
