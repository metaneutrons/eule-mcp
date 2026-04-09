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
  searchMessages(query: string, limit?: number): Promise<MailMessage[]>;
  sendMessage(to: string[], subject: string, body: string): Promise<void>;
  replyToMessage(id: string, body: string): Promise<void>;
  downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
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
