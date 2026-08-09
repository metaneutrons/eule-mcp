import type { ConnectorRegistry } from "../connectors/index.js";
import type { ChatMessage, Conversation } from "../types/index.js";
import {
  collectProviderResults,
  selectConnector,
  type ProviderFailure,
} from "./provider-orchestration.js";

export class MessengerService {
  constructor(private readonly registry: ConnectorRegistry) {}
  async list(
    role?: string,
    limit = 20,
  ): Promise<{ conversations: Conversation[]; failures: ProviderFailure[] }> {
    const result = await collectProviderResults(this.registry.getMessengerConnectors(role), (c) =>
      c.listConversations(limit),
    );
    return { conversations: result.values, failures: result.failures };
  }
  async read(
    conversationId: string,
    account: string,
    role?: string,
    limit = 20,
  ): Promise<ChatMessage[]> {
    const connector = selectConnector(this.registry.getMessengerConnectors(role), account);
    if (!connector) throw new Error(`No messenger connector for ${account}`);
    return connector.getMessages(conversationId, limit);
  }
  async send(
    conversationId: string,
    account: string,
    body: string,
    role?: string,
  ): Promise<string> {
    const connector = selectConnector(this.registry.getMessengerConnectors(role, "write"), account);
    if (!connector) throw new Error(`No messenger connector for ${account}`);
    await connector.sendMessage(conversationId, body);
    return connector.platform;
  }
}
