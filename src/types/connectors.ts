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
/** Calendar info. */
export interface CalendarInfo {
  readonly id: string;
  readonly name: string;
  readonly account: string;
  readonly color?: string;
  readonly isDefault?: boolean;
}

export interface CalendarEvent {
  readonly id: string;
  readonly account: string;
  readonly role?: string;
  readonly calendarId?: string;
  readonly calendarName?: string;
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
  readonly calendarId?: string;
}

/** Mail connector interface — implemented per API tier. */
export interface MailConnector {
  readonly account: string;
  readonly tier: string;
  listMessages(folder?: string, limit?: number): Promise<MailMessage[]>;
  getMessage(id: string): Promise<MailMessageFull>;
  searchMessages(query: string, limit?: number, folder?: string): Promise<MailMessage[]>;
  sendMessage(to: string[], subject: string, body: string): Promise<void>;
  createDraft?(to: string[], subject: string, body: string): Promise<MailMessage>;
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
  listCalendars(): Promise<CalendarInfo[]>;
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

/** Input for creating a contact. */
export interface ContactInput {
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
  readonly readOnly: boolean;
  listContacts(limit?: number): Promise<RemoteContact[]>;
  searchContacts(query: string, limit?: number): Promise<RemoteContact[]>;
  createContact(contact: ContactInput): Promise<RemoteContact>;
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

/** File connector interface (SharePoint, OneDrive, Google Drive, etc.). */
export interface FileConnector {
  readonly account: string;
  readonly readOnly?: boolean;
  search(query: string, limit?: number): Promise<FileResult[]>;
  getContent(id: string): Promise<string>;
  listRecent(limit?: number): Promise<FileResult[]>;
  uploadFile?(name: string, content: Buffer, parentId?: string): Promise<FileResult>;
}

/** DMS tag. */
export interface DocTag {
  readonly id: number;
  readonly name: string;
  readonly color?: string;
  readonly match?: string;
  readonly matchingAlgorithm?: string;
}

/** DMS correspondent. */
export interface DocCorrespondent {
  readonly id: number;
  readonly name: string;
  readonly match?: string;
}

/** DMS document type. */
export interface DocDocumentType {
  readonly id: number;
  readonly name: string;
  readonly match?: string;
}

/** DMS document. */
export interface DocDocument {
  readonly id: number;
  readonly title: string;
  readonly content?: string;
  readonly correspondent?: DocCorrespondent | null;
  readonly documentType?: DocDocumentType | null;
  readonly tags: readonly DocTag[];
  readonly created?: string;
  readonly modified?: string;
  readonly added?: string;
  readonly archiveSerialNumber?: number | null;
  readonly originalFileName?: string;
}

/** Bulk edit method. */
export type DocBulkMethod =
  | "add_tag"
  | "remove_tag"
  | "set_correspondent"
  | "set_document_type"
  | "delete"
  | "reprocess"
  | "merge";

/** Document management connector (Paperless-NGX, etc.). */
export interface DocumentConnector {
  readonly account: string;
  readonly tier: string;
  searchDocuments(query: string, limit?: number): Promise<DocDocument[]>;
  listDocuments(page?: number, pageSize?: number): Promise<DocDocument[]>;
  getDocument(id: number): Promise<DocDocument>;
  downloadDocument(id: number, original?: boolean): Promise<Buffer>;
  uploadDocument(
    file: Buffer,
    filename: string,
    meta?: { title?: string; correspondent?: number; documentType?: number; tags?: number[] },
  ): Promise<DocDocument>;
  updateDocument(
    id: number,
    updates: {
      title?: string;
      correspondent?: number | null;
      documentType?: number | null;
      tags?: number[];
    },
  ): Promise<DocDocument>;
  bulkEdit(ids: number[], method: DocBulkMethod, params?: Record<string, unknown>): Promise<void>;
  listTags(): Promise<DocTag[]>;
  createTag(
    name: string,
    opts?: { color?: string; match?: string; matchingAlgorithm?: string },
  ): Promise<DocTag>;
  listCorrespondents(): Promise<DocCorrespondent[]>;
  createCorrespondent(name: string, opts?: { match?: string }): Promise<DocCorrespondent>;
  listDocumentTypes(): Promise<DocDocumentType[]>;
  createDocumentType(name: string, opts?: { match?: string }): Promise<DocDocumentType>;
}
