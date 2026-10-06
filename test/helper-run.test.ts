import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { oathPrompt, oauthCapture, oauthSafari } from "../src/helper/run.js";

/** Every helper invocation, recorded instead of spawned. */
const spawned: string[][] = [];

vi.mock("../src/helper/download.js", () => ({ ensureHelper: async () => "/opt/eule-helper" }));
vi.mock("node:child_process", () => ({
  spawn: vi.fn((_bin: string, args: string[]) => {
    spawned.push(args);
    const child = Object.assign(new EventEmitter(), { kill: () => undefined });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  }),
}));

const capture = { clientId: "client", tier: "ews", apiVersion: "v1" as const, resource: "r" };

describe("helper arguments for YubiKey TOTP", () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it("names the YubiKey credential for the login window", async () => {
    await oauthCapture({ ...capture, totpYubikeyCredential: "eule:user@example.com" });
    const args = spawned[0] ?? [];
    expect(args[0]).toBe("oauth-capture");
    expect(args.slice(args.indexOf("--totp-yubikey"), args.indexOf("--totp-yubikey") + 2)).toEqual([
      "--totp-yubikey",
      "eule:user@example.com",
    ]);
  });

  it("never passes both TOTP sources, which the helper would refuse", async () => {
    await oauthCapture({
      ...capture,
      totpCredentialRef: "totp/a1b2.c3d4",
      totpYubikeyCredential: "eule:user@example.com",
    });
    expect(spawned[0]).toContain("--totp-credential-ref");
    expect(spawned[0]).not.toContain("--totp-yubikey");
  });

  it("asks the secret window to write a TOTP seed to the key, with touch only when wanted", async () => {
    await oathPrompt("TOTP seed for u", "eule:u", { touch: true, replace: false });
    await oathPrompt("TOTP seed for u", "eule:u", { touch: false, replace: true });
    expect(spawned).toEqual([
      [
        "secret-prompt",
        "--label",
        "TOTP seed for u",
        "--format",
        "totp",
        "--oath-name",
        "eule:u",
        "--touch",
      ],
      [
        "secret-prompt",
        "--label",
        "TOTP seed for u",
        "--format",
        "totp",
        "--oath-name",
        "eule:u",
        "--replace",
      ],
    ]);
  });

  it("starts the Safari sign-in with the client parameters only", async () => {
    await oauthSafari({ ...capture, tenant: "organizations", loginHint: "user@example.com" });
    expect(spawned[0]).toEqual([
      "oauth-safari",
      "--client-id",
      "client",
      "--tier",
      "ews",
      "--api-version",
      "v1",
      "--resource",
      "r",
      "--tenant",
      "organizations",
      "--login-hint",
      "user@example.com",
    ]);
  });
});
