import type { ConfigManager } from "../config/index.js";
import type { TokenRepository } from "../auth/token-repository.js";
import type { AccountToken, ApiTier, TokenStore } from "../types/index.js";
import { authenticateAccount, getAccessToken, tierAuthParam } from "../providers/m365/index.js";
import { authenticateGoogle } from "../providers/google/index.js";
import {
  currentExecutionSignal,
  fetchWithExecutionContext as fetch,
} from "../utils/execution-context.js";
import { logger } from "../utils/logger.js";
import { ConfiguredCredentialResolver } from "../helper/configured-credential-resolver.js";
import { oauthCapture, type OauthCaptureOpts } from "../helper/run.js";

export type AuthLoginMethod = "auto" | "browser" | "webview";

export interface AuthLoginRequest {
  readonly tier: ApiTier;
  readonly account?: string;
  readonly method?: AuthLoginMethod;
  readonly redirectUri?: string;
}

type M365WebviewCapture = (options: OauthCaptureOpts) => Promise<number>;

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
    private readonly captureM365: M365WebviewCapture = oauthCapture,
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

  async login(request: AuthLoginRequest): Promise<AccountToken> {
    const { tier, redirectUri } = request;
    const account = request.account?.trim().toLowerCase();
    const method = request.method ?? "auto";
    if (tier === "google" && (method === "webview" || redirectUri !== undefined))
      throw new Error("The native Eule webview login is available only for M365 accounts");
    const configuredRedirectUri =
      tier === "google" ? undefined : (redirectUri ?? this.config.get().oauth.redirectUri);
    const useWebview =
      tier !== "google" &&
      (method === "webview" || (method === "auto" && configuredRedirectUri !== undefined));
    const webview = useWebview
      ? { account: this.requireWebviewAccount(account), redirectUri: configuredRedirectUri }
      : undefined;
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
        if (webview) return await this.loginM365Webview(tier, webview.account, webview.redirectUri);
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

  private hasTotpBinding(account: string | undefined): boolean {
    if (!account) return false;
    return Boolean(
      this.config
        .get()
        .autoAuth?.some((entry) => entry.account.toLowerCase() === account.toLowerCase()),
    );
  }

  private requireWebviewAccount(account: string | undefined): string {
    if (!account) throw new Error("An account email is required for the native Eule webview login");
    return account;
  }

  private async loginM365Webview(
    tier: Exclude<ApiTier, "google">,
    account: string,
    redirectUri: string | undefined,
  ): Promise<AccountToken> {
    const oauth = this.config.get().oauth;
    const authParam = tierAuthParam(oauth, tier);
    const before = this.tokens.load();
    const exitCode = await this.captureM365({
      clientId: oauth.clientId,
      tier,
      apiVersion: oauth.apiVersion === "v1" ? "v1" : "v2",
      resource: "resource" in authParam ? authParam.resource : undefined,
      scope: "scope" in authParam ? authParam.scope : undefined,
      tenant: oauth.tenant,
      loginHint: account,
      redirectUri,
      totpSecret: this.hasTotpBinding(account) ? this.secrets.totp(account) : undefined,
      signal: currentExecutionSignal(),
    });
    if (exitCode !== 0)
      throw new Error(
        exitCode === 3
          ? "M365 webview login was cancelled"
          : `M365 webview login failed (helper exit code ${String(exitCode)})`,
      );
    return this.capturedToken(account, tier, before, this.tokens.load());
  }

  private capturedToken(
    account: string,
    tier: Exclude<ApiTier, "google">,
    before: TokenStore,
    after: TokenStore,
  ): AccountToken {
    const changed = Object.entries(after.accounts).filter(([key, token]) => {
      const previous = before.accounts[key];
      return (
        token.tier === tier &&
        (previous?.accessToken !== token.accessToken || previous.expiresAt !== token.expiresAt)
      );
    });
    const exact = changed.find(([key]) => key.toLowerCase() === account.toLowerCase())?.[1];
    if (exact) return exact;
    const onlyChanged = changed.length === 1 ? changed[0]?.[1] : undefined;
    if (onlyChanged) return onlyChanged;
    throw new Error("M365 helper completed without writing an unambiguous account token");
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
