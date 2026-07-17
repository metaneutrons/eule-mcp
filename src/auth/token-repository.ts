import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountToken, TokenStore } from "../types/index.js";
import { logger } from "../utils/logger.js";

export interface TokenRepository {
  load(): TokenStore;
  save(store: TokenStore): void;
  remove(account: string): boolean;
}

export class FileTokenRepository implements TokenRepository {
  constructor(private readonly path = join(homedir(), ".eule", "tokens.json")) {}
  load(): TokenStore {
    if (!existsSync(this.path)) return { accounts: {} };
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || !("accounts" in parsed))
        throw new Error("missing accounts object");
      const raw = parsed.accounts;
      if (typeof raw !== "object" || raw === null) throw new Error("invalid accounts object");
      return { accounts: raw as Record<string, AccountToken> };
    } catch (error) {
      logger.error(
        `Token store is invalid; starting empty (${error instanceof Error ? error.message : "unknown error"})`,
      );
      return { accounts: {} };
    }
  }
  save(store: TokenStore): void {
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }
  remove(account: string): boolean {
    const store = this.load();
    const key = Object.keys(store.accounts).find(
      (candidate) => candidate.toLowerCase() === account.toLowerCase(),
    );
    if (!key) return false;
    const accounts = Object.fromEntries(
      Object.entries(store.accounts).filter(([candidate]) => candidate !== key),
    );
    this.save({ accounts });
    return true;
  }
}

export const tokenRepository = new FileTokenRepository();
