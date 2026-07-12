import { ImapFlow } from "imapflow";
import { createTransport, type Transporter } from "nodemailer";
import { assembleHtml } from "../../utils/mail-html.js";
import { buildMimeMessage } from "../../utils/mime-build.js";
import {
  assertNoHeaderInjection,
  assertSafeAddresses,
  MAX_RESPONSE_BYTES,
} from "../../utils/security.js";
import type {
  MailAttachment,
  MailConnector,
  MailMessage,
  MailMessageFull,
  MailSendOpts,
  OutgoingAttachment,
} from "../../types/index.js";

/** Map connector attachments to nodemailer's attachment shape. */
function nodemailerAttachments(
  attachments?: readonly OutgoingAttachment[],
): { filename: string; content: Buffer; contentType?: string; cid?: string }[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map((a) => ({
    filename: a.filename,
    content: a.content,
    contentType: a.contentType,
    ...(a.cid ? { cid: a.cid } : {}),
  }));
}

/** An imapflow bodyStructure node (loosely typed — the lib types are permissive). */
interface BodyStructureNode {
  part?: string;
  type?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  size?: number;
  id?: string;
  childNodes?: BodyStructureNode[];
}

/** Walk a bodyStructure tree and collect attachment/inline parts with their part ids. */
function walkAttachments(node: BodyStructureNode | undefined, out: MailAttachment[]): void {
  if (!node) return;
  const disposition = node.disposition?.toLowerCase();
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (node.part && (disposition === "attachment" || disposition === "inline" || filename)) {
    out.push({
      id: node.part,
      name: filename ?? `attachment-${String(out.length + 1)}`,
      size: node.size ?? 0,
      contentType: node.type ?? "application/octet-stream",
      isInline: disposition === "inline",
      ...(node.id ? { contentId: node.id.replace(/[<>]/g, "") } : {}),
    });
  }
  for (const child of node.childNodes ?? []) walkAttachments(child, out);
}

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
  displayName?: string;

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
          { envelope: true, flags: true, source: true, bodyStructure: true },
          { uid: true },
        );
        const msg = raw as {
          uid: number;
          source?: Buffer;
          bodyStructure?: BodyStructureNode;
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

        const attachments: MailAttachment[] = [];
        walkAttachments(msg.bodyStructure, attachments);

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
          attachments,
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
        let total = 0;
        for await (const chunk of part.content) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          total += buf.length;
          // No Content-Length on a streamed IMAP part — cap as bytes arrive.
          if (total > MAX_RESPONSE_BYTES) {
            throw new Error(`Attachment exceeds the ${String(MAX_RESPONSE_BYTES)}-byte limit.`);
          }
          chunks.push(buf);
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
        for await (const raw of client.fetch(
          { text: query },
          {
            envelope: true,
            flags: true,
          },
        )) {
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

  private get fromAddress(): string {
    const header = this.displayName ? `${this.displayName} <${this.account}>` : this.account;
    return assertNoHeaderInjection(header, "From");
  }

  /**
   * Builds an SMTP transport that refuses to fall back to cleartext:
   * implicit TLS on 465, STARTTLS elsewhere, and `requireTLS` so a MITM that
   * strips the STARTTLS capability cannot downgrade the auth exchange.
   */
  private async makeTransport(): Promise<Transporter> {
    const auth =
      this.cfg.auth === "oauth"
        ? {
            type: "OAuth2" as const,
            user: this.cfg.account,
            accessToken: await this.getTokenOrThrow(),
          }
        : { user: this.cfg.account, pass: this.cfg.password ?? "" };
    const port = this.cfg.smtpPort ?? 587;
    return createTransport({
      host: this.cfg.smtpHost,
      port,
      secure: port === 465,
      requireTLS: true,
      auth,
    });
  }

  async sendMessage(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<void> {
    const transport = await this.makeTransport();
    try {
      await transport.sendMail({
        from: this.fromAddress,
        to: assertSafeAddresses(to, "To").join(", "),
        cc: opts?.cc && assertSafeAddresses(opts.cc, "Cc").join(", "),
        bcc: opts?.bcc && assertSafeAddresses(opts.bcc, "Bcc").join(", "),
        subject,
        html: assembleHtml(body, this.signature),
        attachments: nodemailerAttachments(opts?.attachments),
      });
    } finally {
      transport.close();
    }
  }

  async replyToMessage(id: string, body: string, opts?: MailSendOpts): Promise<void> {
    const original = await this.getMessage(id);
    const transport = await this.makeTransport();
    try {
      await transport.sendMail({
        from: this.fromAddress,
        to: assertNoHeaderInjection(original.from, "To"),
        cc: opts?.cc && assertSafeAddresses(opts.cc, "Cc").join(", "),
        bcc: opts?.bcc && assertSafeAddresses(opts.bcc, "Bcc").join(", "),
        subject: `Re: ${original.subject}`,
        html: assembleHtml(body, this.signature),
        inReplyTo: id,
        attachments: nodemailerAttachments(opts?.attachments),
      });
    } finally {
      transport.close();
    }
  }

  async forwardMessage(
    id: string,
    to: string[],
    body?: string,
    opts?: MailSendOpts,
  ): Promise<void> {
    const original = await this.getMessage(id);
    const transport = await this.makeTransport();
    try {
      await transport.sendMail({
        from: this.fromAddress,
        to: assertSafeAddresses(to, "To").join(", "),
        cc: opts?.cc && assertSafeAddresses(opts.cc, "Cc").join(", "),
        bcc: opts?.bcc && assertSafeAddresses(opts.bcc, "Bcc").join(", "),
        subject: `Fwd: ${original.subject}`,
        html: assembleHtml(
          body ?? "",
          this.signature,
          `<p><b>Von:</b> ${original.from}<br><b>Betreff:</b> ${original.subject}</p><pre>${original.body}</pre>`,
        ),
        attachments: nodemailerAttachments(opts?.attachments),
      });
    } finally {
      transport.close();
    }
  }

  async createDraft(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<MailMessage> {
    const mime = buildMimeMessage(
      {
        from: this.fromAddress,
        to: assertSafeAddresses(to, "To").join(", "),
        cc: opts?.cc?.length ? assertSafeAddresses(opts.cc, "Cc").join(", ") : undefined,
        bcc: opts?.bcc?.length ? assertSafeAddresses(opts.bcc, "Bcc").join(", ") : undefined,
        subject,
      },
      assembleHtml(body, this.signature),
      opts?.attachments,
    );
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
      const raw = msg.source.toString();

      const transport = await this.makeTransport();
      try {
        await transport.sendMail({ envelope: false as never, raw });
      } finally {
        transport.close();
      }

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
