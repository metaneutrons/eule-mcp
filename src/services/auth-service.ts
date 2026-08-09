import type { ConfigManager } from "../config/index.js";
import type { TokenRepository } from "../auth/token-repository.js";
import type { AccountToken, ApiTier } from "../types/index.js";
import { authenticateAccount, getAccessToken } from "../providers/m365/index.js";
import { authenticateGoogle } from "../providers/google/index.js";
import { fetchWithExecutionContext as fetch } from "../utils/execution-context.js";
import { logger } from "../utils/logger.js";
import { ConfiguredCredentialResolver } from "../helper/configured-credential-resolver.js";

export interface AuthAccountSummary {
  readonly account: string;
  readonly provider: "m365" | "google";
  readonly tier: ApiTier;
  readonly expiresAt: number;
  readonly health: "valid" | "expiring" | "expired";
}

export class AuthService {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(
    private readonly config: ConfigManager,
    private readonly tokens: TokenRepository,
    private readonly secrets: ConfiguredCredentialResolver = new ConfiguredCredentialResolver(
      config,
    ),
  ) {}

  inventory(): AuthAccountSummary[] {
    const now = Date.now();
    return Object.entries(this.tokens.load().accounts)
      .map(([account, token]) => ({
        account,
        provider:
          token.provider === "google" || token.tier === "google"
            ? ("google" as const)
            : ("m365" as const),
        tier: token.tier,
        expiresAt: token.expiresAt,
        health:
          token.expiresAt <= now
            ? ("expired" as const)
            : token.expiresAt - now < 10 * 60 * 1000
              ? ("expiring" as const)
              : ("valid" as const),
      }))
      .sort((a, b) => a.account.localeCompare(b.account));
  }

  status() {
    const config = this.config.get();
    return {
      language: config.language,
      dataPath: this.config.euleDirPath,
      roles: config.roles.map((role) => ({
        id: role.id,
        name: role.name,
        weeklyHours: role.weeklyHours,
        mail: role.connectors.mail?.length ?? 0,
        calendar: role.connectors.calendar?.length ?? 0,
      })),
      accounts: this.inventory(),
    };
  }

  async login(tier: ApiTier, accountHint?: string): Promise<AccountToken> {
    const account = accountHint?.trim().toLowerCase();
    // Google uses one fixed localhost redirect port registered with the OAuth
    // client, so interactive Google logins must be process-wide exclusive.
    const lockKey =
      tier === "google" ? "google:interactive" : `${tier}:${account ?? "interactive"}`;
    return this.exclusive(lockKey, async () => {
      try {
        if (tier === "google") {
          const google = this.secrets.googleOAuth();
          if (!google) throw new Error("Google OAuth is not configured");
          return await authenticateGoogle(google, account);
        }
        return await authenticateAccount(tier, account, this.config.get().oauth);
      } catch (error) {
        logger.error(
          JSON.stringify({
            event: "auth.login_failed",
            provider: tier === "google" ? "google" : "m365",
            tier,
            errorType: error instanceof Error ? error.name : "unknown",
          }),
        );
        throw new Error(`Authentication failed for ${tier}`, { cause: error });
      }
    });
  }

  logout(account: string): boolean {
    return this.tokens.remove(account.trim());
  }

  async probe(accountInput: string): Promise<{ tier: ApiTier; result: string }> {
    const account = accountInput.trim().toLowerCase();
    return this.exclusive(`probe:${account}`, async () => {
      const stored = Object.entries(this.tokens.load().accounts).find(
        ([key]) => key.toLowerCase() === account,
      )?.[1];
      if (!stored) throw new Error(`No token data for ${account}`);
      if (stored.tier === "google")
        return { tier: stored.tier, result: "Google account configured" };
      const accessToken = await getAccessToken(stored.account, this.config.get().oauth);
      if (!accessToken) throw new Error(`No valid token for ${account}`);
      if (stored.tier === "imap")
        return { tier: stored.tier, result: "IMAP requires a protocol connection probe" };
      const response =
        stored.tier === "graph"
          ? await fetch("https://graph.microsoft.com/v1.0/me", {
              headers: { Authorization: `Bearer ${accessToken}` },
            })
          : await fetch("https://outlook.office365.com/EWS/Exchange.asmx", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "text/xml; charset=utf-8",
              },
              body: `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetFolder xmlns="http://schemas.microsoft.com/exchange/services/2006/messages"><FolderShape><BaseShape xmlns="http://schemas.microsoft.com/exchange/services/2006/types">IdOnly</BaseShape></FolderShape><FolderIds><DistinguishedFolderId xmlns="http://schemas.microsoft.com/exchange/services/2006/types" Id="inbox"/></FolderIds></GetFolder></soap:Body></soap:Envelope>`,
            });
      return {
        tier: stored.tier,
        result: response.ok
          ? `${stored.tier.toUpperCase()} API works`
          : `${stored.tier.toUpperCase()} API returned ${String(response.status)}`,
      };
    });
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
