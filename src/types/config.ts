/** Connector configuration for a single mail or calendar account. */
export interface ConnectorConfig {
  readonly id: string;
  readonly type:
    | "m365"
    | "imap"
    | "caldav"
    | "carddav"
    | "ical"
    | "signal"
    | "google"
    | "paperless";
  readonly account: string;
  /** For shared/delegate mailboxes. Auth uses `account`, access targets `mailbox`. */
  readonly mailbox?: string;
  // IMAP-specific fields (type: "imap").
  readonly host?: string;
  readonly port?: number;
  readonly smtpHost?: string;
  readonly smtpPort?: number;
  readonly auth?: "oauth" | "password";
  readonly password?: string;
  // CalDAV/CardDAV/iCal fields.
  readonly url?: string;
  // Paperless-NGX fields (type: "paperless").
  readonly token?: string;
  // Signal fields (type: "signal").
  readonly signalCliUrl?: string;
}

/** Optional auto-authentication credentials for an account. */
export interface AutoAuthConfig {
  readonly account: string;
  readonly password: string;
  readonly totpSecret: string;
}

/** Connectors grouped by domain. */
export interface RoleConnectors {
  readonly mail?: readonly ConnectorConfig[];
  readonly calendar?: readonly ConnectorConfig[];
  readonly contacts?: readonly ConnectorConfig[];
  readonly messenger?: readonly ConnectorConfig[];
  readonly files?: readonly ConnectorConfig[];
  readonly documents?: readonly ConnectorConfig[];
}

/** A single role definition. */
export interface RoleConfig {
  readonly id: string;
  readonly name: string;
  readonly weeklyHours: number;
  readonly contexts?: readonly string[];
  readonly connectors: RoleConnectors;
}

/** OAuth configuration with sensible defaults. */
export interface OAuthConfig {
  readonly clientId: string;
  readonly tenant: string;
}

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Root application configuration loaded from config.yaml. */
export interface AppConfig {
  readonly language: "de" | "en";
  readonly oauth: OAuthConfig;
  readonly google?: GoogleOAuthConfig;
  readonly autoAuth?: readonly AutoAuthConfig[];
  readonly roles: readonly RoleConfig[];
}

/** API tier determined by the auth probe. */
export type ApiTier = "graph" | "ews" | "imap" | "google";

/** Stored token data for a single account. */
export interface AccountToken {
  readonly account: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly tier: ApiTier;
  readonly icalUrl?: string;
  readonly provider?: "m365" | "google";
}

/** Persisted token store (all accounts). */
export interface TokenStore {
  accounts: Record<string, AccountToken>;
}
