import type {
  MailConnector,
  MailMessage,
  MailMessageFull,
  MailSendOpts,
} from "../../types/index.js";
import { assembleHtml } from "../../utils/mail-html.js";
import { mimeEncode } from "../../utils/mime.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailMsg {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
  internalDate?: string;
}
interface GmailPayload {
  headers?: { name?: string; value?: string }[];
  body?: { data?: string };
  parts?: GmailPayload[];
  mimeType?: string;
}
interface GmailListItem {
  id?: string;
  threadId?: string;
}

const FOLDER_MAP: Record<string, string> = {
  inbox: "INBOX",
  sentitems: "SENT",
  drafts: "DRAFT",
  deleteditems: "TRASH",
  junkemail: "SPAM",
};

export class GoogleMailConnector implements MailConnector {
  readonly tier = "google";
  signature?: string;
  displayName?: string;

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private get fromHeader(): string {
    return this.displayName ? `${this.displayName} <${this.account}>` : this.account;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return { Authorization: `Bearer ${token}` };
  }

  async listMessages(folder = "inbox", limit = 10): Promise<MailMessage[]> {
    const h = await this.headers();
    const label = FOLDER_MAP[folder] ?? folder.toUpperCase();
    const res = await fetch(`${BASE}/messages?labelIds=${label}&maxResults=${String(limit)}`, {
      headers: h,
    });
    if (!res.ok) throw new Error(`Gmail list: ${String(res.status)}`);
    const data = (await res.json()) as { messages?: GmailListItem[] };
    const msgs: MailMessage[] = [];
    for (const item of (data.messages ?? []).slice(0, limit)) {
      const msg = await this.fetchMsg(item.id ?? "", h);
      if (msg) msgs.push(this.mapSummary(msg));
    }
    return msgs;
  }

  async getMessage(id: string): Promise<MailMessageFull> {
    const h = await this.headers();
    const msg = await this.fetchMsg(id, h);
    if (!msg) throw new Error(`Message ${id} not found`);
    const body = extractBody(msg.payload);
    return {
      ...this.mapSummary(msg),
      body,
      bodyType: "html",
      attachments: extractAttachments(msg.payload, id),
    };
  }

  async searchMessages(query: string, limit = 10, _folder?: string): Promise<MailMessage[]> {
    const h = await this.headers();
    const res = await fetch(
      `${BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${String(limit)}`,
      { headers: h },
    );
    if (!res.ok) throw new Error(`Gmail search: ${String(res.status)}`);
    const data = (await res.json()) as { messages?: GmailListItem[] };
    const msgs: MailMessage[] = [];
    for (const item of (data.messages ?? []).slice(0, limit)) {
      const msg = await this.fetchMsg(item.id ?? "", h);
      if (msg) msgs.push(this.mapSummary(msg));
    }
    return msgs;
  }

  async sendMessage(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<void> {
    const h = await this.headers();
    const html = assembleHtml(body, this.signature);
    let mime = `From: ${this.fromHeader}\r\nTo: ${to.join(", ")}`;
    if (opts?.cc?.length) mime += `\r\nCc: ${opts.cc.join(", ")}`;
    if (opts?.bcc?.length) mime += `\r\nBcc: ${opts.bcc.join(", ")}`;
    mime += `\r\nSubject: ${mimeEncode(subject)}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;
    const raw = Buffer.from(mime).toString("base64url");
    const res = await fetch(`${BASE}/messages/send`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`Gmail send: ${String(res.status)} ${await res.text()}`);
  }

  async createDraft(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<MailMessage> {
    const h = await this.headers();
    const html = assembleHtml(body, this.signature);
    let mime = `From: ${this.fromHeader}\r\nTo: ${to.join(", ")}`;
    if (opts?.cc?.length) mime += `\r\nCc: ${opts.cc.join(", ")}`;
    if (opts?.bcc?.length) mime += `\r\nBcc: ${opts.bcc.join(", ")}`;
    mime += `\r\nSubject: ${mimeEncode(subject)}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;
    const raw = Buffer.from(mime).toString("base64url");
    const res = await fetch(`${BASE}/drafts`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    });
    if (!res.ok) throw new Error(`Gmail createDraft: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { id?: string; message?: { id?: string } };
    return {
      id: data.id ?? data.message?.id ?? "",
      account: this.account,
      subject,
      from: this.account,
      to,
      receivedAt: new Date().toISOString(),
      snippet: body.slice(0, 100),
      isRead: true,
    };
  }

  async sendDraft(id: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${BASE}/drafts/send`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(`Gmail sendDraft: ${String(res.status)} ${await res.text()}`);
  }

  async replyToMessage(id: string, body: string, opts?: MailSendOpts): Promise<void> {
    const h = await this.headers();
    const orig = await this.fetchMsg(id, h);
    if (!orig) throw new Error("Original not found");
    const from = getHeader(orig.payload, "From") ?? "";
    const subject = getHeader(orig.payload, "Subject") ?? "";
    const html = assembleHtml(body, this.signature);
    let mime = `From: ${this.fromHeader}\r\nTo: ${from}`;
    if (opts?.cc?.length) mime += `\r\nCc: ${opts.cc.join(", ")}`;
    if (opts?.bcc?.length) mime += `\r\nBcc: ${opts.bcc.join(", ")}`;
    mime += `\r\nSubject: ${mimeEncode(`Re: ${subject}`)}\r\nIn-Reply-To: ${getHeader(orig.payload, "Message-ID") ?? ""}\r\nReferences: ${getHeader(orig.payload, "Message-ID") ?? ""}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;
    const raw = Buffer.from(mime).toString("base64url");
    const res = await fetch(`${BASE}/messages/send`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ raw, threadId: orig.threadId }),
    });
    if (!res.ok) throw new Error(`Gmail reply: ${String(res.status)}`);
  }

  async forwardMessage(id: string, to: string[], body?: string): Promise<void> {
    const orig = await this.getMessage(id);
    const origBody = orig.bodyType === "html" ? orig.body : `<pre>${orig.body}</pre>`;
    const html = assembleHtml(
      body ?? "",
      this.signature,
      `<p><b>Von:</b> ${orig.from}<br><b>Betreff:</b> ${orig.subject}</p>${origBody}`,
    );
    const raw = Buffer.from(
      `To: ${to.join(", ")}\r\nSubject: ${mimeEncode(`Fwd: ${orig.subject}`)}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`,
    ).toString("base64url");
    const h = await this.headers();
    const res = await fetch(`${BASE}/messages/send`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`Gmail forward: ${String(res.status)}`);
  }

  async markRead(id: string, isRead: boolean): Promise<void> {
    const h = await this.headers();
    const body = isRead ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] };
    const res = await fetch(`${BASE}/messages/${id}/modify`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gmail markRead: ${String(res.status)}`);
  }

  async moveMessage(id: string, folder: string): Promise<void> {
    const h = await this.headers();
    const label = FOLDER_MAP[folder] ?? folder.toUpperCase();
    const res = await fetch(`${BASE}/messages/${id}/modify`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds: [label] }),
    });
    if (!res.ok) throw new Error(`Gmail move: ${String(res.status)}`);
  }

  async deleteMessage(id: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${BASE}/messages/${id}/trash`, { method: "POST", headers: h });
    if (!res.ok) throw new Error(`Gmail delete: ${String(res.status)}`);
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const h = await this.headers();
    const res = await fetch(`${BASE}/messages/${messageId}/attachments/${attachmentId}`, {
      headers: h,
    });
    if (!res.ok) throw new Error(`Gmail attachment: ${String(res.status)}`);
    const data = (await res.json()) as { data?: string };
    return Buffer.from(data.data ?? "", "base64url");
  }

  private async fetchMsg(id: string, h: Record<string, string>): Promise<GmailMsg | null> {
    const res = await fetch(`${BASE}/messages/${id}?format=full`, { headers: h });
    if (!res.ok) return null;
    return (await res.json()) as GmailMsg;
  }

  private mapSummary(msg: GmailMsg): MailMessage {
    const p = msg.payload;
    return {
      id: msg.id ?? "",
      account: this.account,
      subject: getHeader(p, "Subject") ?? "",
      from: getHeader(p, "From") ?? "",
      to: (getHeader(p, "To") ?? "").split(",").map((s) => s.trim()),
      receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : "",
      snippet: msg.snippet ?? "",
      isRead: !(msg.labelIds ?? []).includes("UNREAD"),
    };
  }
}

function getHeader(payload: GmailPayload | undefined, name: string): string | undefined {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

function extractBody(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString();
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/html" && part.body?.data)
      return Buffer.from(part.body.data, "base64url").toString();
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data)
      return Buffer.from(part.body.data, "base64url").toString();
  }
  return "";
}

function extractAttachments(
  payload: GmailPayload | undefined,
  msgId: string,
): { id: string; name: string; size: number; contentType: string }[] {
  const result: { id: string; name: string; size: number; contentType: string }[] = [];
  for (const part of payload?.parts ?? []) {
    const name = part.headers?.find((h) => h.name?.toLowerCase() === "content-disposition")?.value;
    if (part.body && !part.body.data && name?.includes("attachment")) {
      result.push({
        id: `${msgId}/${part.mimeType ?? ""}`,
        name: name.split("filename=")[1]?.replace(/"/g, "") ?? "attachment",
        size: 0,
        contentType: part.mimeType ?? "",
      });
    }
  }
  return result;
}
