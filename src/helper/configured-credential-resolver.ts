import type { ConfigManager } from "../config/index.js";
import type { ConnectorConfig, ResolvedGoogleOAuthConfig } from "../types/index.js";
import { nativeCredentialBroker, type CredentialBroker } from "./credential-store.js";

export interface M365AutoAuthReferences {
  readonly totpCredentialRef?: string;
  readonly passwordCredentialRef?: string;
}

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

  /** Return opaque native-helper references only. M365 secrets must never be
   *  resolved into the Node process. Legacy inline TOTP is intentionally not
   *  forwarded and can be migrated with totp_configure. */
  m365AutoAuth(accountInput: string): M365AutoAuthReferences {
    const account = accountInput.trim().toLowerCase();
    const entry = this.config
      .get()
      .autoAuth?.find((candidate) => candidate.account.toLowerCase() === account);
    return {
      ...(entry?.totpSecretRef ? { totpCredentialRef: entry.totpSecretRef } : {}),
      ...(entry?.passwordSecretRef ? { passwordCredentialRef: entry.passwordSecretRef } : {}),
    };
  }
}
