/** Minimal mail message representation returned by connectors. */
export interface MailMessage {
  readonly id: string;
  readonly account: string;
  readonly role?: string;
  readonly subject: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly receivedAt: string;
  readonly snippet: string;
  readonly isRead: boolean;
}

/** Full mail message with body. */
export interface MailMessageFull extends MailMessage {
  readonly body: string;
  readonly bodyType: "text" | "html";
  readonly attachments: readonly MailAttachment[];
}

/** Attachment metadata. */
export interface MailAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
}

/** Calendar event representation. */
export interface CalendarEvent {
  readonly id: string;
  readonly account: string;
  readonly role?: string;
  readonly subject: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly isAllDay: boolean;
  readonly attendees: readonly string[];
}

/** Input for creating a calendar event. */
export interface CalendarEventInput {
  readonly subject: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly body?: string;
  readonly attendees?: readonly string[];
}

/** Mail connector interface — implemented per API tier. */
export interface MailConnector {
  readonly account: string;
  readonly tier: string;
  listMessages(folder?: string, limit?: number): Promise<MailMessage[]>;
  getMessage(id: string): Promise<MailMessageFull>;
  searchMessages(query: string, limit?: number, folder?: string): Promise<MailMessage[]>;
  sendMessage(to: string[], subject: string, body: string): Promise<void>;
  replyToMessage(id: string, body: string): Promise<void>;
  forwardMessage(id: string, to: string[], body?: string): Promise<void>;
  downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  markRead(id: string, isRead: boolean): Promise<void>;
  moveMessage(id: string, folder: string): Promise<void>;
  deleteMessage(id: string): Promise<void>;
}

/** Calendar connector interface — implemented per API tier. */
export interface CalendarConnector {
  readonly account: string;
  readonly tier: string;
  readonly readOnly: boolean;
  listEvents(start: string, end: string): Promise<CalendarEvent[]>;
  createEvent(event: CalendarEventInput): Promise<CalendarEvent>;
  updateEvent(id: string, updates: Partial<CalendarEventInput>): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}

/** Contact from a remote provider (Graph, EWS, CardDAV). */
export interface RemoteContact {
  readonly id: string;
  readonly account: string;
  readonly displayName: string;
  readonly email?: string;
  readonly phone?: string;
  readonly organization?: string;
  readonly jobTitle?: string;
}

/** Contact connector interface — implemented per API tier. */
export interface ContactConnector {
  readonly account: string;
  readonly tier: string;
  listContacts(limit?: number): Promise<RemoteContact[]>;
  searchContacts(query: string, limit?: number): Promise<RemoteContact[]>;
}

/** Chat conversation from a messenger. */
export interface Conversation {
  readonly id: string;
  readonly account: string;
  readonly platform: string;
  readonly title: string;
  readonly lastMessage?: string;
  readonly lastTimestamp?: string;
  readonly participants: readonly string[];
}

/** Single chat message. */
export interface ChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly account: string;
  readonly platform: string;
  readonly from: string;
  readonly body: string;
  readonly timestamp: string;
}

/** Messenger connector interface. */
export interface MessengerConnector {
  readonly account: string;
  readonly platform: string;
  listConversations(limit?: number): Promise<Conversation[]>;
  getMessages(conversationId: string, limit?: number): Promise<ChatMessage[]>;
  sendMessage(conversationId: string, body: string): Promise<void>;
}

/** File search result. */
export interface FileResult {
  readonly id: string;
  readonly account: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly lastModified: string;
  readonly webUrl?: string;
}

/** File connector interface (SharePoint, OneDrive, etc.). */
export interface FileConnector {
  readonly account: string;
  search(query: string, limit?: number): Promise<FileResult[]>;
  getContent(id: string): Promise<string>;
  listRecent(limit?: number): Promise<FileResult[]>;
}
