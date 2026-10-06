import { describe, expect, it, vi } from "vitest";
import { M365Reauth, SAFARI_RETRY_AFTER_MS } from "../src/auth/m365-reauth.js";
import type { ConfigManager } from "../src/config/index.js";
import { InteractionRequiredError } from "../src/providers/m365/index.js";
import type { AppConfig } from "../src/types/index.js";

const account = "user@example.com";

function config(login: boolean): ConfigManager {
  const current: AppConfig = {
    language: "en",
    oauth: { clientId: "client", tenant: "common" },
    roles: [],
    autoAuth: [login ? { account, login: "safari" } : { account, totpSecretRef: "totp/a1.b2" }],
  };
  return { get: () => current } as unknown as ConfigManager;
}

/** A token source whose refresh token Microsoft rejects until it is renewed. */
function deadSignIn() {
  let renewed = false;
  return {
    getToken: vi.fn(async () => {
      if (!renewed) throw new InteractionRequiredError(account);
      return "fresh-token";
    }),
    renew: vi.fn(async (_account: string) => {
      renewed = true;
    }),
  };
}

describe("M365Reauth", () => {
  it("renews a rejected sign-in once through Safari and asks for the token again", async () => {
    const signIn = deadSignIn();
    const reauth = new M365Reauth(config(true), signIn.renew);
    await expect(reauth.tokenSource("User@Example.com", signIn.getToken)()).resolves.toBe(
      "fresh-token",
    );
    expect(signIn.renew).toHaveBeenCalledOnce();
    expect(signIn.renew).toHaveBeenCalledWith(account);
    expect(signIn.getToken).toHaveBeenCalledTimes(2);
  });

  it("passes tokens, empty results and other failures through untouched", async () => {
    const renew = vi.fn(async () => undefined);
    const reauth = new M365Reauth(config(true), renew);
    await expect(reauth.tokenSource(account, async () => "token")()).resolves.toBe("token");
    await expect(reauth.tokenSource(account, async () => null)()).resolves.toBeNull();
    await expect(
      reauth.tokenSource(account, async () => {
        throw new Error("network down");
      })(),
    ).rejects.toThrow("network down");
    expect(renew).not.toHaveBeenCalled();
  });

  it("leaves accounts without login: safari to the usual error", async () => {
    const signIn = deadSignIn();
    const reauth = new M365Reauth(config(false), signIn.renew);
    await expect(reauth.tokenSource(account, signIn.getToken)()).rejects.toBeInstanceOf(
      InteractionRequiredError,
    );
    expect(signIn.renew).not.toHaveBeenCalled();
  });

  it("lets concurrent requests share one sign-in", async () => {
    let finish!: () => void;
    let renewed = false;
    const renew = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            renewed = true;
            resolve();
          };
        }),
    );
    const getToken = async (): Promise<string> => {
      if (!renewed) throw new InteractionRequiredError(account);
      return "fresh-token";
    };
    const reauth = new M365Reauth(config(true), renew);
    const first = reauth.tokenSource(account, getToken)();
    const second = reauth.tokenSource(account, getToken)();
    await vi.waitFor(() => {
      expect(renew).toHaveBeenCalledOnce();
    });
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual(["fresh-token", "fresh-token"]);
    expect(renew).toHaveBeenCalledOnce();
  });

  it("does not open Safari again for a while after a failed sign-in", async () => {
    let now = 1_000_000;
    const renew = vi.fn(async () => {
      throw new Error("The Safari sign-in timed out");
    });
    const getToken = async (): Promise<string> => {
      throw new InteractionRequiredError(account);
    };
    const reauth = new M365Reauth(config(true), renew, () => now);
    const token = reauth.tokenSource(account, getToken);

    await expect(token()).rejects.toThrow("timed out");
    now += SAFARI_RETRY_AFTER_MS - 1;
    await expect(token()).rejects.toThrow(/failed recently/);
    expect(renew).toHaveBeenCalledOnce();

    now += 1;
    await expect(token()).rejects.toThrow("timed out");
    expect(renew).toHaveBeenCalledTimes(2);
  });
});
