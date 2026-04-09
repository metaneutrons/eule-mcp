import type { MailConnector } from "../types/index.js";
import type { ConfigManager } from "../config/index.js";
import { loadTokens, getAccessToken } from "../auth/index.js";
import { GraphMailConnector } from "./graph-mail.js";
import { EwsMailConnector } from "./ews-mail.js";
import { ImapMailConnector } from "./imap-mail.js";

export class ConnectorRegistry {
  constructor(private readonly config: ConfigManager) {}

  /** Get all mail connectors, optionally filtered by role. */
  getMailConnectors(role?: string): MailConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: MailConnector[] = [];

    const roles = role ? cfg.roles.filter((r) => r.id === role) : cfg.roles;

    for (const r of roles) {
      for (const mc of r.connectors.mail ?? []) {
        const token = tokens.accounts[mc.account];
        if (!token) continue;

        const getToken = () => getAccessToken(mc.account, oauth);

        switch (token.tier) {
          case "graph":
            connectors.push(new GraphMailConnector(mc.account, getToken, mc.shared));
            break;
          case "ews":
            connectors.push(new EwsMailConnector(mc.account, getToken));
            break;
          case "imap":
            connectors.push(new ImapMailConnector(mc.account, getToken));
            break;
        }
      }
    }

    return connectors;
  }

  /** Get a single mail connector by account email. */
  getMailConnectorForAccount(account: string): MailConnector | undefined {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const token = tokens.accounts[account];
    if (!token) return undefined;

    const getToken = () => getAccessToken(account, oauth);

    switch (token.tier) {
      case "graph":
        return new GraphMailConnector(account, getToken);
      case "ews":
        return new EwsMailConnector(account, getToken);
      case "imap":
        return new ImapMailConnector(account, getToken);
    }
  }
}
