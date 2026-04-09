import type { MailConnector, MailMessage, MailMessageFull } from "../../types/index.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphMessage {
  id: string;
  subject: string;
  from?: { emailAddress?: { address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  body?: { contentType?: string; content?: string };
  attachments?: { name?: string; size?: number }[];
}

export class GraphMailConnector implements MailConnector {
  readonly tier = "graph";

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
      attachments: (m.attachments ?? []).map((a) => ({ name: a.name ?? "", size: a.size ?? 0 })),
    };
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
    const res = await fetch(`${this.base}/sendMail`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "Text", content: body },
          toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
        },
      }),
    });
    if (!res.ok) throw new Error(`Graph sendMessage: ${String(res.status)} ${await res.text()}`);
  }

  async replyToMessage(id: string, body: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${this.base}/messages/${id}/reply`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ comment: body }),
    });
    if (!res.ok) throw new Error(`Graph replyToMessage: ${String(res.status)} ${await res.text()}`);
  }

  private mapMessage(m: GraphMessage): MailMessage {
    return {
      id: m.id,
      account: this.account,
      subject: m.subject ?? "",
      from: m.from?.emailAddress?.address ?? "",
      to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? ""),
      receivedAt: m.receivedDateTime ?? "",
      snippet: m.bodyPreview ?? "",
      isRead: m.isRead ?? false,
    };
  }
}
