import type { ConfigManager } from "../config/index.js";
import type { ConnectorConfig, ResolvedGoogleOAuthConfig } from "../types/index.js";
import { nativeCredentialBroker, type CredentialBroker } from "./credential-store.js";

/** SSOT for resolving keychain-backed credentials with legacy-inline fallback. */
export class ConfiguredCredentialResolver {
  constructor(
    private readonly config: ConfigManager,
    private readonly credentials: CredentialBroker = nativeCredentialBroker,
  ) {}

  connector(connector: ConnectorConfig): string | undefined {
    return connector.credentialRef
      ? this.credentials.read(connector.credentialRef, this.config.euleDirPath)
      : (connector.password ?? connector.token);
  }

  googleOAuth(): ResolvedGoogleOAuthConfig | undefined {
    const google = this.config.get().google;
    if (!google) return undefined;
    const clientSecret = google.clientSecretRef
      ? this.credentials.read(google.clientSecretRef, this.config.euleDirPath)
      : google.clientSecret;
    if (!clientSecret) throw new Error("Google OAuth client secret is missing");
    return { clientId: google.clientId, clientSecret };
  }

  totp(accountInput: string): string | undefined {
    const account = accountInput.trim().toLowerCase();
    const entry = this.config
      .get()
      .autoAuth?.find((candidate) => candidate.account.toLowerCase() === account);
    return entry?.totpSecretRef
      ? this.credentials.read(entry.totpSecretRef, this.config.euleDirPath)
      : entry?.totpSecret;
  }
}
