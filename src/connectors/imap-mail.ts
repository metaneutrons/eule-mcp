import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import type { MailConnector, MailMessage, MailMessageFull } from "../types/index.js";

export class ImapMailConnector implements MailConnector {
  readonly tier = "imap";

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private async connect(): Promise<ImapFlow> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    const client = new ImapFlow({
      host: "outlook.office365.com",
      port: 993,
      secure: true,
      auth: { user: this.account, accessToken: token },
      logger: false,
    });
    await client.connect();
    return client;
  }

  async listMessages(folder = "INBOX", limit = 10): Promise<MailMessage[]> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const messages: MailMessage[] = [];
        const mailbox = client.mailbox;
        const total = mailbox && typeof mailbox === "object" ? (mailbox.exists ?? 0) : 0;
        const from = Math.max(1, total - limit + 1);

        for await (const raw of client.fetch(`${String(from)}:*`, {
          envelope: true,
          flags: true,
          bodyStructure: true,
        })) {
          const msg = raw as { uid: number; envelope?: { subject?: string; date?: Date; from?: { address?: string }[]; to?: { address?: string }[] }; flags?: Set<string> };
          messages.push({
            id: String(msg.uid),
            account: this.account,
            subject: msg.envelope?.subject ?? "",
            from: msg.envelope?.from?.[0]?.address ?? "",
            to: (msg.envelope?.to ?? []).map((a) => a.address ?? ""),
            receivedAt: msg.envelope?.date?.toISOString() ?? "",
            snippet: "",
            isRead: msg.flags?.has("\\Seen") ?? false,
          });
        }

        return messages.reverse();
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async getMessage(id: string): Promise<MailMessageFull> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const raw = await client.fetchOne(id, {
          envelope: true,
          flags: true,
          bodyStructure: true,
          source: true,
        }, { uid: true });

        const msg = raw as { uid: number; source?: Buffer; envelope?: { subject?: string; date?: Date; from?: { address?: string }[]; to?: { address?: string }[] }; flags?: Set<string> };
        const body = msg.source?.toString() ?? "";
        const bodyStart = body.indexOf("\r\n\r\n");
        const textBody = bodyStart >= 0 ? body.slice(bodyStart + 4) : "";

        return {
          id: String(msg.uid),
          account: this.account,
          subject: msg.envelope?.subject ?? "",
          from: msg.envelope?.from?.[0]?.address ?? "",
          to: (msg.envelope?.to ?? []).map((a) => a.address ?? ""),
          receivedAt: msg.envelope?.date?.toISOString() ?? "",
          snippet: textBody.slice(0, 200),
          isRead: msg.flags?.has("\\Seen") ?? false,
          body: textBody,
          bodyType: "text",
          attachments: [],
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async searchMessages(query: string, limit = 10): Promise<MailMessage[]> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const results: MailMessage[] = [];
        for await (const raw of client.fetch(
          { text: query } as unknown as string,
          { envelope: true, flags: true },
        )) {
          const msg = raw as { uid: number; envelope?: { subject?: string; date?: Date; from?: { address?: string }[]; to?: { address?: string }[] }; flags?: Set<string> };
          results.push({
            id: String(msg.uid),
            account: this.account,
            subject: msg.envelope?.subject ?? "",
            from: msg.envelope?.from?.[0]?.address ?? "",
            to: (msg.envelope?.to ?? []).map((a) => a.address ?? ""),
            receivedAt: msg.envelope?.date?.toISOString() ?? "",
            snippet: "",
            isRead: msg.flags?.has("\\Seen") ?? false,
          });
          if (results.length >= limit) break;
        }
        return results;
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async sendMessage(to: string[], subject: string, body: string): Promise<void> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    const transport = createTransport({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      auth: { type: "OAuth2", user: this.account, accessToken: token },
    });
    await transport.sendMail({ from: this.account, to: to.join(", "), subject, text: body });
  }

  async replyToMessage(id: string, body: string): Promise<void> {
    // Fetch original to get headers, then send reply.
    const original = await this.getMessage(id);
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    const transport = createTransport({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      auth: { type: "OAuth2", user: this.account, accessToken: token },
    });
    await transport.sendMail({
      from: this.account,
      to: original.from,
      subject: `Re: ${original.subject}`,
      text: body,
      inReplyTo: id,
    });
  }
}
