import type { MessengerConnector, Conversation, ChatMessage } from "../../types/index.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface TeamsChat {
  id?: string;
  topic?: string;
  chatType?: string;
  lastUpdatedDateTime?: string;
  members?: { displayName?: string; email?: string }[];
}
interface TeamsMessage {
  id?: string;
  from?: { user?: { displayName?: string } };
  body?: { content?: string };
  createdDateTime?: string;
}

export class GraphTeamsConnector implements MessengerConnector {
  readonly platform = "teams";

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return { Authorization: `Bearer ${token}` };
  }

  async listConversations(limit = 20): Promise<Conversation[]> {
    const h = await this.headers();
    const url = `${GRAPH_BASE}/me/chats?$top=${String(limit)}&$orderby=lastUpdatedDateTime desc&$expand=members`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Teams chats: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: TeamsChat[] };
    return data.value.map((c) => ({
      id: c.id ?? "",
      account: this.account,
      platform: "teams",
      title: c.topic ?? c.chatType ?? "Chat",
      lastTimestamp: c.lastUpdatedDateTime,
      participants: (c.members ?? []).map((m) => m.displayName ?? m.email ?? ""),
    }));
  }

  async getMessages(conversationId: string, limit = 20): Promise<ChatMessage[]> {
    const h = await this.headers();
    const url = `${GRAPH_BASE}/me/chats/${conversationId}/messages?$top=${String(limit)}`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Teams messages: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: TeamsMessage[] };
    return data.value.map((m) => ({
      id: m.id ?? "",
      conversationId,
      account: this.account,
      platform: "teams",
      from: m.from?.user?.displayName ?? "",
      body: m.body?.content ?? "",
      timestamp: m.createdDateTime ?? "",
    }));
  }

  async sendMessage(conversationId: string, body: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${GRAPH_BASE}/me/chats/${conversationId}/messages`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ body: { content: body } }),
    });
    if (!res.ok) throw new Error(`Teams send: ${String(res.status)} ${await res.text()}`);
  }
}
