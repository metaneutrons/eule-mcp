import type { MessengerConnector, Conversation, ChatMessage } from "../../types/index.js";

interface SignalGroup {
  id: string;
  name?: string;
  members?: string[];
}
interface SignalMsg {
  timestamp?: number;
  sourceNumber?: string;
  groupInfo?: { groupId?: string };
  dataMessage?: { message?: string; timestamp?: number };
}

export class SignalMessengerConnector implements MessengerConnector {
  readonly platform = "signal";

  constructor(
    readonly account: string,
    private readonly baseUrl: string,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`Signal ${String(res.status)}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  async listConversations(limit = 20): Promise<Conversation[]> {
    const groups = await this.get<SignalGroup[]>(`/v1/groups/${encodeURIComponent(this.account)}`);
    return groups.slice(0, limit).map((g) => ({
      id: g.id,
      account: this.account,
      platform: "signal",
      title: g.name ?? g.id,
      participants: g.members ?? [],
    }));
  }

  async getMessages(conversationId: string, limit = 20): Promise<ChatMessage[]> {
    const msgs = await this.get<SignalMsg[]>(`/v1/receive/${encodeURIComponent(this.account)}`);
    return msgs
      .filter((m) => m.groupInfo?.groupId === conversationId || (!conversationId && !m.groupInfo))
      .slice(0, limit)
      .map((m) => ({
        id: String(m.timestamp ?? m.dataMessage?.timestamp ?? Date.now()),
        conversationId,
        account: this.account,
        platform: "signal",
        from: m.sourceNumber ?? "",
        body: m.dataMessage?.message ?? "",
        timestamp: new Date(m.timestamp ?? m.dataMessage?.timestamp ?? 0).toISOString(),
      }));
  }

  async sendMessage(conversationId: string, body: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: body, number: this.account, recipients: [conversationId] }),
    });
    if (!res.ok) throw new Error(`Signal send ${String(res.status)}: ${await res.text()}`);
  }
}
