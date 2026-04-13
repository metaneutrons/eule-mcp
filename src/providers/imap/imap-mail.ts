import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { assembleHtml } from "../../utils/mail-html.js";
import type { MailConnector, MailMessage, MailMessageFull } from "../../types/index.js";

export interface ImapConfig {
  account: string;
  host: string;
  port?: number;
  smtpHost: string;
  smtpPort?: number;
  auth: "oauth" | "password";
  getToken?: () => Promise<string | null>;
  password?: string;
}

export class ImapMailConnector implements MailConnector {
  readonly tier = "imap";
  signature?: string;

  constructor(
    readonly account: string,
    private readonly cfg: ImapConfig,
  ) {}

  private async connect(): Promise<ImapFlow> {
    const auth =
      this.cfg.auth === "oauth"
        ? { user: this.cfg.account, accessToken: await this.getTokenOrThrow() }
        : { user: this.cfg.account, pass: this.cfg.password ?? "" };

    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port ?? 993,
      secure: true,
      auth,
      logger: false,
    });
    await client.connect();
    return client;
  }

  private async getTokenOrThrow(): Promise<string> {
    if (!this.cfg.getToken) throw new Error(`No token provider for ${this.account}`);
    const token = await this.cfg.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return token;
  }

  async listMessages(folder = "INBOX", limit = 10): Promise<MailMessage[]> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const messages: MailMessage[] = [];
        const mailbox = client.mailbox;
        const total = mailbox && typeof mailbox === "object" ? mailbox.exists : 0;
        const from = Math.max(1, total - limit + 1);

        for await (const raw of client.fetch(`${String(from)}:*`, {
          envelope: true,
          flags: true,
        })) {
          const msg = raw as {
            uid: number;
            envelope?: {
              subject?: string;
              date?: Date;
              from?: { address?: string }[];
              to?: { address?: string }[];
            };
            flags?: Set<string>;
          };
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
        const raw = await client.fetchOne(
          id,
          { envelope: true, flags: true, source: true },
          { uid: true },
        );
        const msg = raw as {
          uid: number;
          source?: Buffer;
          envelope?: {
            subject?: string;
            date?: Date;
            from?: { address?: string }[];
            to?: { address?: string }[];
          };
          flags?: Set<string>;
        };
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

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const part = await client.download(messageId, attachmentId, { uid: true });
        const chunks: Buffer[] = [];
        for await (const chunk of part.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        return Buffer.concat(chunks);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async searchMessages(query: string, limit = 10, folder = "INBOX"): Promise<MailMessage[]> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const results: MailMessage[] = [];
        for await (const raw of client.fetch({ text: query } as unknown as string, {
          envelope: true,
          flags: true,
        })) {
          const msg = raw as {
            uid: number;
            envelope?: {
              subject?: string;
              date?: Date;
              from?: { address?: string }[];
              to?: { address?: string }[];
            };
            flags?: Set<string>;
          };
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
    const auth =
      this.cfg.auth === "oauth"
        ? {
            type: "OAuth2" as const,
            user: this.cfg.account,
            accessToken: await this.getTokenOrThrow(),
          }
        : { user: this.cfg.account, pass: this.cfg.password ?? "" };

    const transport = createTransport({
      host: this.cfg.smtpHost,
      port: this.cfg.smtpPort ?? 587,
      secure: false,
      auth,
    });
    await transport.sendMail({
      from: this.account,
      to: to.join(", "),
      subject,
      html: assembleHtml(body, this.signature),
    });
  }

  async replyToMessage(id: string, body: string): Promise<void> {
    const original = await this.getMessage(id);
    const auth =
      this.cfg.auth === "oauth"
        ? {
            type: "OAuth2" as const,
            user: this.cfg.account,
            accessToken: await this.getTokenOrThrow(),
          }
        : { user: this.cfg.account, pass: this.cfg.password ?? "" };

    const transport = createTransport({
      host: this.cfg.smtpHost,
      port: this.cfg.smtpPort ?? 587,
      secure: false,
      auth,
    });
    await transport.sendMail({
      from: this.account,
      to: original.from,
      subject: `Re: ${original.subject}`,
      html: assembleHtml(body, this.signature),
      inReplyTo: id,
    });
  }

  async forwardMessage(id: string, to: string[], body?: string): Promise<void> {
    const original = await this.getMessage(id);
    const auth =
      this.cfg.auth === "oauth"
        ? {
            type: "OAuth2" as const,
            user: this.cfg.account,
            accessToken: await this.getTokenOrThrow(),
          }
        : { user: this.cfg.account, pass: this.cfg.password ?? "" };
    const transport = createTransport({
      host: this.cfg.smtpHost,
      port: this.cfg.smtpPort ?? 587,
      secure: false,
      auth,
    });
    await transport.sendMail({
      from: this.account,
      to: to.join(", "),
      subject: `Fwd: ${original.subject}`,
      html: assembleHtml(
        body ?? "",
        this.signature,
        `<p><b>Von:</b> ${original.from}<br><b>Betreff:</b> ${original.subject}</p><pre>${original.body}</pre>`,
      ),
    });
  }

  async createDraft(to: string[], subject: string, body: string): Promise<MailMessage> {
    const html = assembleHtml(body, this.signature);
    const mime = `From: ${this.account}\r\nTo: ${to.join(", ")}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\nMIME-Version: 1.0\r\n\r\n${html}`;
    const client = await this.connect();
    try {
      const result = await client.append("Drafts", Buffer.from(mime), ["\\Draft", "\\Seen"]);
      const uid =
        result && typeof result === "object"
          ? String(Number((result as unknown as Record<string, unknown>).uid) || 0)
          : "";
      return {
        id: uid,
        account: this.account,
        subject,
        from: this.account,
        to,
        receivedAt: new Date().toISOString(),
        snippet: body.slice(0, 100),
        isRead: true,
      };
    } finally {
      await client.logout();
    }
  }

  async sendDraft(id: string): Promise<void> {
    const client = await this.connect();
    try {
      await client.mailboxOpen("Drafts");
      const msg = await client.fetchOne(id, { source: true }, { uid: true });
      if (!msg || typeof msg !== "object" || !("source" in msg) || !msg.source)
        throw new Error(`Draft ${id} not found`);
      const raw = (msg.source).toString();

      const auth =
        this.cfg.auth === "oauth"
          ? {
              type: "OAuth2" as const,
              user: this.cfg.account,
              accessToken: await this.getTokenOrThrow(),
            }
          : { user: this.cfg.account, pass: this.cfg.password ?? "" };
      const transport = createTransport({
        host: this.cfg.smtpHost,
        port: this.cfg.smtpPort ?? 587,
        secure: false,
        auth,
      });
      await transport.sendMail({ envelope: false as never, raw });

      // Move to Sent, delete from Drafts
      await client.append("Sent", Buffer.from(raw), ["\\Seen"]);
      await client.messageFlagsAdd(id, ["\\Deleted"], { uid: true });
      await client.messageDelete(id, { uid: true });
    } finally {
      await client.logout();
    }
  }

  async markRead(id: string, isRead: boolean): Promise<void> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageFlagsAdd(id, ["\\Seen"], { uid: true });
        if (!isRead) await client.messageFlagsRemove(id, ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async moveMessage(id: string, folder: string): Promise<void> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageMove(id, folder, { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async deleteMessage(id: string): Promise<void> {
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        await client.messageFlagsAdd(id, ["\\Deleted"], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }
}
