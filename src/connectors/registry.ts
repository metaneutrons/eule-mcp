import type { MailConnector, CalendarConnector } from "../types/index.js";
import type { ConfigManager } from "../config/index.js";
import { loadTokens, getAccessToken } from "../providers/m365/index.js";
import { GraphMailConnector } from "../providers/m365/graph-mail.js";
import { EwsMailConnector } from "../providers/m365/ews-mail.js";
import { ImapMailConnector } from "../providers/imap/index.js";
import { EwsCalendarConnector } from "../providers/m365/ews-calendar.js";
import { GraphCalendarConnector } from "../providers/m365/graph-calendar.js";

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
        if (mc.type === "imap") {
          // Generic IMAP provider — host/auth from config.
          connectors.push(
            new ImapMailConnector(mc.account, {
              account: mc.account,
              host: mc.host ?? "localhost",
              smtpHost: mc.smtpHost ?? "localhost",
              port: mc.port,
              smtpPort: mc.smtpPort,
              auth: mc.auth ?? "password",
              password: mc.password,
            }),
          );
          continue;
        }

        // M365 provider — tier-based routing.
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
            connectors.push(
              new ImapMailConnector(mc.account, {
                account: mc.account,
                host: "outlook.office365.com",
                smtpHost: "smtp.office365.com",
                auth: "oauth",
                getToken,
              }),
            );
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

    // Find the connector config for this account.
    for (const r of cfg.roles) {
      for (const mc of r.connectors.mail ?? []) {
        if (mc.account !== account) continue;

        if (mc.type === "imap") {
          return new ImapMailConnector(mc.account, {
            account: mc.account,
            host: mc.host ?? "localhost",
            smtpHost: mc.smtpHost ?? "localhost",
            port: mc.port,
            smtpPort: mc.smtpPort,
            auth: mc.auth ?? "password",
            password: mc.password,
          });
        }

        const token = tokens.accounts[account];
        if (!token) return undefined;
        const getToken = () => getAccessToken(account, oauth);

        switch (token.tier) {
          case "graph":
            return new GraphMailConnector(account, getToken);
          case "ews":
            return new EwsMailConnector(account, getToken);
          case "imap":
            return new ImapMailConnector(account, {
              account,
              host: "outlook.office365.com",
              smtpHost: "smtp.office365.com",
              auth: "oauth",
              getToken,
            });
        }
      }
    }
    return undefined;
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
        switch (token.tier) {
          case "graph":
            connectors.push(new GraphCalendarConnector(cc.account, getToken, cc.shared));
            break;
          case "ews":
            connectors.push(new EwsCalendarConnector(cc.account, getToken));
            break;
        }
      }
    }

    return connectors;
  }
}
