import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileTokenRepository } from "../src/auth/token-repository.js";

describe("FileTokenRepository", () => {
  it("persists owner-only tokens atomically and removes accounts case-insensitively", () => {
    const directory = mkdtempSync(join(tmpdir(), "eule-token-test-"));
    const path = join(directory, "tokens.json");
    try {
      const repository = new FileTokenRepository(path);
      repository.save({
        accounts: {
          "User@Example.com": {
            account: "User@Example.com",
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: Date.now() + 1000,
            tier: "graph",
          },
        },
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(repository.load().accounts["User@Example.com"]?.tier).toBe("graph");
      expect(repository.remove("user@example.com")).toBe(true);
      expect(repository.load().accounts).toEqual({});
      expect(readFileSync(path, "utf8")).not.toContain("User@Example.com");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
