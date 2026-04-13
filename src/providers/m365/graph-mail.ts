import type { MailConnector, MailMessage, MailMessageFull } from "../../types/index.js";
import { assembleHtml } from "../../utils/mail-html.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphAttachment {
  id?: string;
  name?: string;
  size?: number;
  contentType?: string;
  contentBytes?: string;
}

interface GraphMessage {
  id: string;
  subject: string;
  from?: { emailAddress?: { address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  body?: { contentType?: string; content?: string };
  attachments?: GraphAttachment[];
}

export class GraphMailConnector implements MailConnector {
  readonly tier = "graph";
  signature?: string;

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly shared = false,
  ) {}

  private get base(): string {
    return this.shared ? `${GRAPH_BASE}/users/${this.account}` : `${GRAPH_BASE}/me`;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  async listMessages(folder = "inbox", limit = 10): Promise<MailMessage[]> {
    const h = await this.headers();
    const url = `${this.base}/mailFolders/${folder}/messages?$top=${String(limit)}&$orderby=receivedDateTime desc&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Graph listMessages: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: GraphMessage[] };
    return data.value.map((m) => this.mapMessage(m));
  }

  async getMessage(id: string): Promise<MailMessageFull> {
    const h = await this.headers();
    const url = `${this.base}/messages/${id}?$expand=attachments`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Graph getMessage: ${String(res.status)} ${await res.text()}`);
    const m = (await res.json()) as GraphMessage;
    return {
      ...this.mapMessage(m),
      body: m.body?.content ?? "",
      bodyType: m.body?.contentType === "html" ? "html" : "text",
      attachments: (m.attachments ?? []).map((a) => ({
        id: a.id ?? "",
        name: a.name ?? "",
        size: a.size ?? 0,
        contentType: a.contentType ?? "application/octet-stream",
      })),
    };
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const h = await this.headers();
    const url = `${this.base}/messages/${messageId}/attachments/${attachmentId}/$value`;
    const res = await fetch(url, { headers: h });
    if (!res.ok)
      throw new Error(`Graph downloadAttachment: ${String(res.status)} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async searchMessages(query: string, limit = 10): Promise<MailMessage[]> {
    const h = await this.headers();
    const url = `${this.base}/messages?$search="${encodeURIComponent(query)}"&$top=${String(limit)}&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Graph searchMessages: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: GraphMessage[] };
    return data.value.map((m) => this.mapMessage(m));
  }

  async sendMessage(to: string[], subject: string, body: string): Promise<void> {
    const h = await this.headers();
    const html = assembleHtml(body, this.signature);
    const res = await fetch(`${this.base}/sendMail`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
        },
      }),
    });
    if (!res.ok) throw new Error(`Graph sendMessage: ${String(res.status)} ${await res.text()}`);
  }

  async createDraft(to: string[], subject: string, body: string): Promise<MailMessage> {
    const h = await this.headers();
    const html = assembleHtml(body, this.signature);
    const res = await fetch(`${this.base}/messages`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        subject,
        body: { contentType: "HTML", content: html },
        toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
        isDraft: true,
      }),
    });
    if (!res.ok) throw new Error(`Graph createDraft: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as {
      id?: string;
      subject?: string;
      from?: { emailAddress?: { address?: string } };
      toRecipients?: { emailAddress?: { address?: string } }[];
      receivedDateTime?: string;
    };
    return {
      id: data.id ?? "",
      account: this.account,
      subject: data.subject ?? subject,
      from: this.account,
      to,
      receivedAt: data.receivedDateTime ?? new Date().toISOString(),
      snippet: body.slice(0, 100),
      isRead: true,
    };
  }

  async sendDraft(id: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${this.base}/messages/${id}/send`, { method: "POST", headers: h });
    if (!res.ok) throw new Error(`Graph sendDraft: ${String(res.status)} ${await res.text()}`);
  }

  async replyToMessage(id: string, body: string): Promise<void> {
    const h = await this.headers();
    // Create reply draft (Graph includes quoted original automatically)
    const r1 = await fetch(`${this.base}/messages/${id}/createReply`, {
      method: "POST",
      headers: h,
    });
    if (!r1.ok) throw new Error(`Graph createReply: ${String(r1.status)} ${await r1.text()}`);
    const draft = (await r1.json()) as { id: string; body?: { content?: string } };
    // Assemble HTML: our reply + signature + Graph's quoted original
    const html = assembleHtml(body, this.signature, draft.body?.content);
    // Update draft body
    const r2 = await fetch(`${this.base}/messages/${draft.id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ body: { contentType: "HTML", content: html } }),
    });
    if (!r2.ok) throw new Error(`Graph updateReply: ${String(r2.status)} ${await r2.text()}`);
    // Send
    const r3 = await fetch(`${this.base}/messages/${draft.id}/send`, {
      method: "POST",
      headers: h,
    });
    if (!r3.ok) throw new Error(`Graph sendReply: ${String(r3.status)} ${await r3.text()}`);
  }

  async forwardMessage(id: string, to: string[], body?: string): Promise<void> {
    const h = await this.headers();
    // Create forward draft (Graph includes original)
    const r1 = await fetch(`${this.base}/messages/${id}/createForward`, {
      method: "POST",
      headers: h,
    });
    if (!r1.ok) throw new Error(`Graph createForward: ${String(r1.status)} ${await r1.text()}`);
    const draft = (await r1.json()) as { id: string; body?: { content?: string } };
    const html = body
      ? assembleHtml(body, this.signature, draft.body?.content)
      : assembleHtml("", this.signature, draft.body?.content);
    // Update draft
    const r2 = await fetch(`${this.base}/messages/${draft.id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({
        body: { contentType: "HTML", content: html },
        toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
      }),
    });
    if (!r2.ok) throw new Error(`Graph updateForward: ${String(r2.status)} ${await r2.text()}`);
    // Send
    const r3 = await fetch(`${this.base}/messages/${draft.id}/send`, {
      method: "POST",
      headers: h,
    });
    if (!r3.ok) throw new Error(`Graph sendForward: ${String(r3.status)} ${await r3.text()}`);
  }

  async markRead(id: string, isRead: boolean): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${this.base}/messages/${id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ isRead }),
    });
    if (!res.ok) throw new Error(`Graph markRead: ${String(res.status)} ${await res.text()}`);
  }

  async moveMessage(id: string, folder: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${this.base}/messages/${id}/move`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ destinationId: folder }),
    });
    if (!res.ok) throw new Error(`Graph moveMessage: ${String(res.status)} ${await res.text()}`);
  }

  async deleteMessage(id: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${this.base}/messages/${id}`, { method: "DELETE", headers: h });
    if (!res.ok) throw new Error(`Graph deleteMessage: ${String(res.status)} ${await res.text()}`);
  }

  private mapMessage(m: GraphMessage): MailMessage {
    return {
      id: m.id,
      account: this.account,
      subject: m.subject,
      from: m.from?.emailAddress?.address ?? "",
      to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? ""),
      receivedAt: m.receivedDateTime ?? "",
      snippet: m.bodyPreview ?? "",
      isRead: m.isRead ?? false,
    };
  }
}
