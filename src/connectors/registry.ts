import type {
  MailConnector,
  CalendarConnector,
  ContactConnector,
  MessengerConnector,
  FileConnector,
} from "../types/index.js";
import type { ConfigManager } from "../config/index.js";
import { loadTokens, getAccessToken } from "../providers/m365/index.js";
import { GraphMailConnector } from "../providers/m365/graph-mail.js";
import { EwsMailConnector } from "../providers/m365/ews-mail.js";
import { ImapMailConnector } from "../providers/imap/index.js";
import { EwsCalendarConnector } from "../providers/m365/ews-calendar.js";
import { GraphCalendarConnector } from "../providers/m365/graph-calendar.js";
import { GraphContactConnector } from "../providers/m365/graph-contacts.js";
import { EwsContactConnector } from "../providers/m365/ews-contacts.js";
import { CalDavCalendarConnector } from "../providers/caldav/index.js";
import { CardDavContactConnector } from "../providers/caldav/index.js";
import { ICalFeedConnector } from "../providers/ical/index.js";
import { GraphTeamsConnector } from "../providers/m365/graph-teams.js";
import { GraphFileConnector } from "../providers/m365/graph-files.js";
import { SignalMessengerConnector } from "../providers/signal/index.js";

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
        const authAccount = mc.tokenAccount ?? mc.account;
        const token = tokens.accounts[authAccount];
        if (!token) continue;

        const getToken = () => getAccessToken(authAccount, oauth);

        switch (token.tier) {
          case "graph":
            connectors.push(new GraphMailConnector(mc.account, getToken, mc.shared));
            break;
          case "ews":
            connectors.push(new EwsMailConnector(mc.account, getToken, mc.shared));
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
        if (cc.type === "caldav") {
          if (cc.url && cc.password) {
            connectors.push(
              new CalDavCalendarConnector(cc.account, {
                account: cc.account,
                url: cc.url,
                password: cc.password,
              }),
            );
          }
          continue;
        }

        if (cc.type === "ical") {
          if (cc.url) connectors.push(new ICalFeedConnector(cc.account || cc.id, cc.url));
          continue;
        }

        // M365 provider.
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

  /** Get all contact connectors, optionally filtered by role. */
  getContactConnectors(role?: string): ContactConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: ContactConnector[] = [];

    const roles = role ? cfg.roles.filter((r) => r.id === role) : cfg.roles;

    for (const r of roles) {
      for (const cc of r.connectors.contacts ?? []) {
        if (cc.type === "carddav") {
          if (cc.url && cc.password) {
            connectors.push(
              new CardDavContactConnector(cc.account, {
                account: cc.account,
                url: cc.url,
                password: cc.password,
              }),
            );
          }
          continue;
        }

        if (cc.type !== "m365") continue;
        const token = tokens.accounts[cc.account];
        if (!token) continue;
        const getToken = () => getAccessToken(cc.account, oauth);
        switch (token.tier) {
          case "graph":
            connectors.push(new GraphContactConnector(cc.account, getToken, cc.shared));
            break;
          case "ews":
            connectors.push(new EwsContactConnector(cc.account, getToken));
            break;
        }
      }
    }

    return connectors;
  }

  /** Get all messenger connectors, optionally filtered by role. */
  getMessengerConnectors(role?: string): MessengerConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: MessengerConnector[] = [];
    const roles = role ? cfg.roles.filter((r) => r.id === role) : cfg.roles;

    for (const r of roles) {
      for (const mc of r.connectors.messenger ?? []) {
        if (mc.type === "signal") {
          if (mc.signalCliUrl)
            connectors.push(new SignalMessengerConnector(mc.account, mc.signalCliUrl));
          continue;
        }
        // M365 Teams.
        const token = tokens.accounts[mc.account];
        if (token?.tier !== "graph") continue;
        connectors.push(
          new GraphTeamsConnector(mc.account, () => getAccessToken(mc.account, oauth)),
        );
      }
    }
    return connectors;
  }

  /** Get all file connectors, optionally filtered by role. */
  getFileConnectors(role?: string): FileConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: FileConnector[] = [];
    const roles = role ? cfg.roles.filter((r) => r.id === role) : cfg.roles;

    for (const r of roles) {
      for (const fc of r.connectors.files ?? []) {
        if (fc.type !== "m365") continue;
        const token = tokens.accounts[fc.account];
        if (token?.tier !== "graph") continue;
        connectors.push(
          new GraphFileConnector(fc.account, () => getAccessToken(fc.account, oauth)),
        );
      }
    }
    return connectors;
  }
}
