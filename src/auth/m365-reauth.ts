import type { ConfigManager } from "../config/index.js";
import { InteractionRequiredError } from "../providers/m365/index.js";
import { logger } from "../utils/logger.js";

/** After a failed renewal, wait this long before opening Safari again on its own. */
export const SAFARI_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * Renews a dead M365 sign-in through Safari for accounts whose `autoAuth` entry
 * has `login: "safari"`. Only a refresh token Microsoft has rejected
 * (InteractionRequiredError) triggers it, never a transient failure. Concurrent
 * token requests share one sign-in, and a failed one is not retried for a while,
 * so an unattended server does not keep opening Safari.
 */
export class M365Reauth {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly config: ConfigManager,
    private readonly renew: (account: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Wrap a token source so a rejected refresh token is renewed once through Safari. */
  tokenSource(
    account: string,
    getToken: () => Promise<string | null>,
  ): () => Promise<string | null> {
    return async () => {
      try {
        return await getToken();
      } catch (error) {
        if (!(error instanceof InteractionRequiredError) || !this.usesSafari(account)) throw error;
        await this.renewOnce(account.trim().toLowerCase(), error);
        return getToken();
      }
    };
  }

  private usesSafari(account: string): boolean {
    const normalized = account.trim().toLowerCase();
    return (
      this.config.get().autoAuth?.find((entry) => entry.account.toLowerCase() === normalized)
        ?.login === "safari"
    );
  }

  private async renewOnce(account: string, cause: InteractionRequiredError): Promise<void> {
    const failed = this.failedAt.get(account);
    if (failed !== undefined && this.now() - failed < SAFARI_RETRY_AFTER_MS)
      throw new Error(
        `The Safari sign-in for ${account} failed recently; sign in again with auth_login (method "safari")`,
        { cause },
      );
    let pending = this.inFlight.get(account);
    if (!pending) {
      logger.info(JSON.stringify({ event: "auth.safari_renewal", account }));
      pending = this.renew(account)
        .then(
          () => {
            this.failedAt.delete(account);
          },
          (error: unknown) => {
            this.failedAt.set(account, this.now());
            throw error;
          },
        )
        .finally(() => this.inFlight.delete(account));
      this.inFlight.set(account, pending);
    }
    await pending;
  }
}
