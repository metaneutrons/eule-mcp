/** Connector configuration for a single mail or calendar account. */
export interface ConnectorConfig {
  readonly id: string;
  readonly type: "m365";
  readonly account: string;
  readonly shared?: boolean;
}

/** Connectors grouped by domain. */
export interface RoleConnectors {
  readonly mail?: readonly ConnectorConfig[];
  readonly calendar?: readonly ConnectorConfig[];
}

/** A single role definition. */
export interface RoleConfig {
  readonly id: string;
  readonly name: string;
  readonly weeklyHours: number;
  readonly contexts?: readonly string[];
  readonly connectors: RoleConnectors;
}

/** Root application configuration loaded from config.yaml. */
export interface AppConfig {
  readonly language: "de" | "en";
  readonly roles: readonly RoleConfig[];
}

/** M365 API tier determined by the auth probe. */
export type ApiTier = "graph" | "ews" | "imap";

/** Stored token data for a single M365 account. */
export interface AccountToken {
  readonly account: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly tier: ApiTier;
  readonly icalUrl?: string;
}

/** Persisted token store (all accounts). */
export interface TokenStore {
  accounts: Record<string, AccountToken>;
}
