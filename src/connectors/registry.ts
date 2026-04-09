import type { MailConnector, CalendarConnector } from "../types/index.js";
import type { ConfigManager } from "../config/index.js";
import { loadTokens, getAccessToken } from "../providers/m365/index.js";
import { GraphMailConnector } from "../providers/m365/graph-mail.js";
import { EwsMailConnector } from "../providers/m365/ews-mail.js";
import { ImapMailConnector } from "../providers/m365/imap-mail.js";
import { EwsCalendarConnector } from "../providers/m365/ews-calendar.js";

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

  /** Get all calendar connectors, optionally filtered by role. */
  getCalendarConnectors(role?: string): CalendarConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: CalendarConnector[] = [];

    const roles = role ? cfg.roles.filter((r) => r.id === role) : cfg.roles;

    for (const r of roles) {
      for (const cc of r.connectors.calendar ?? []) {
        const token = tokens.accounts[cc.account];
        if (!token) continue;
        const getToken = () => getAccessToken(cc.account, oauth);
        if (token.tier === "graph" || token.tier === "ews") {
          connectors.push(new EwsCalendarConnector(cc.account, getToken));
        }
      }
    }

    return connectors;
  }
}
