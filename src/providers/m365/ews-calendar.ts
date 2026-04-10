import { XMLParser } from "fast-xml-parser";
import type {
  CalendarConnector,
  CalendarEvent,
  CalendarEventInput,
  CalendarInfo,
} from "../../types/index.js";

const EWS_URL = "https://outlook.office365.com/EWS/Exchange.asmx";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ["CalendarItem", "Attendee", "Mailbox"].includes(name),
  processEntities: { enabled: true, maxTotalExpansions: 50000 },
  htmlEntities: true,
  numberParseOptions: { hex: false, leadingZeros: false, skipLike: /.*/ },
});

function soap(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function str(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "object" && "#text" in (val as Record<string, unknown>))
    return String((val as Record<string, unknown>)["#text"]);
  return JSON.stringify(val);
}

function dig(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export class EwsCalendarConnector implements CalendarConnector {
  readonly tier = "ews";
  readonly readOnly = false;

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private async post(body: string): Promise<unknown> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    const res = await fetch(EWS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/xml; charset=utf-8" },
      body: soap(body),
    });
    if (!res.ok) throw new Error(`EWS ${String(res.status)}: ${await res.text()}`);
    return parser.parse(await res.text());
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const data = await this.post(`
    <m:FindFolder Traversal="Shallow">
      <m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape>
      <m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></m:ParentFolderIds>
    </m:FindFolder>`);
    const body = dig(
      data,
      "Envelope",
      "Body",
      "FindFolderResponse",
      "ResponseMessages",
      "FindFolderResponseMessage",
      "RootFolder",
      "Folders",
    ) as Record<string, unknown> | undefined;
    const folders = body?.CalendarFolder;
    const arr = Array.isArray(folders) ? folders : folders ? [folders] : [];
    const result: CalendarInfo[] = [
      { id: "calendar", name: "Calendar", account: this.account, isDefault: true },
    ];
    for (const f of arr as Record<string, unknown>[]) {
      const fid = f.FolderId as Record<string, unknown> | undefined;
      result.push({
        id: str(fid?.["@_Id"] ?? fid),
        name: str(f.DisplayName),
        account: this.account,
      });
    }
    return result;
  }

  async listEvents(start: string, end: string): Promise<CalendarEvent[]> {
    const data = await this.post(`
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="calendar:Start"/>
          <t:FieldURI FieldURI="calendar:End"/>
          <t:FieldURI FieldURI="calendar:Location"/>
          <t:FieldURI FieldURI="calendar:IsAllDayEvent"/>
          <t:FieldURI FieldURI="calendar:RequiredAttendees"/>
          <t:FieldURI FieldURI="calendar:OptionalAttendees"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:CalendarView StartDate="${start}" EndDate="${end}"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="calendar"/>
      </m:ParentFolderIds>
    </m:FindItem>`);

    return this.extractItems(data).map((item) => this.mapEvent(item));
  }

  async createEvent(event: CalendarEventInput): Promise<CalendarEvent> {
    const attendeesXml = (event.attendees ?? [])
      .map(
        (a) =>
          `<t:Attendee><t:Mailbox><t:EmailAddress>${escapeXml(a)}</t:EmailAddress></t:Mailbox></t:Attendee>`,
      )
      .join("");

    const data = await this.post(`
    <m:CreateItem SendMeetingInvitations="SendToAllAndSaveCopy">
      <m:Items>
        <t:CalendarItem>
          <t:Subject>${escapeXml(event.subject)}</t:Subject>
          <t:Start>${event.start}</t:Start>
          <t:End>${event.end}</t:End>
          ${event.location ? `<t:Location>${escapeXml(event.location)}</t:Location>` : ""}
          ${event.body ? `<t:Body BodyType="Text">${escapeXml(event.body)}</t:Body>` : ""}
          ${attendeesXml ? `<t:RequiredAttendees>${attendeesXml}</t:RequiredAttendees>` : ""}
        </t:CalendarItem>
      </m:Items>
    </m:CreateItem>`);

    const items = this.extractItems(data);
    if (items[0]) return this.mapEvent(items[0]);
    return {
      id: "",
      account: this.account,
      subject: event.subject,
      start: event.start,
      end: event.end,
      isAllDay: false,
      attendees: [],
    };
  }

  async updateEvent(id: string, updates: Partial<CalendarEventInput>): Promise<CalendarEvent> {
    const fields: string[] = [];
    if (updates.subject)
      fields.push(
        `<t:SetItemField><t:FieldURI FieldURI="item:Subject"/><t:CalendarItem><t:Subject>${escapeXml(updates.subject)}</t:Subject></t:CalendarItem></t:SetItemField>`,
      );
    if (updates.start)
      fields.push(
        `<t:SetItemField><t:FieldURI FieldURI="calendar:Start"/><t:CalendarItem><t:Start>${updates.start}</t:Start></t:CalendarItem></t:SetItemField>`,
      );
    if (updates.end)
      fields.push(
        `<t:SetItemField><t:FieldURI FieldURI="calendar:End"/><t:CalendarItem><t:End>${updates.end}</t:End></t:CalendarItem></t:SetItemField>`,
      );
    if (updates.location)
      fields.push(
        `<t:SetItemField><t:FieldURI FieldURI="calendar:Location"/><t:CalendarItem><t:Location>${escapeXml(updates.location)}</t:Location></t:CalendarItem></t:SetItemField>`,
      );

    await this.post(`
    <m:UpdateItem ConflictResolution="AutoResolve" SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy">
      <m:ItemChanges>
        <t:ItemChange>
          <t:ItemId Id="${id}"/>
          <t:Updates>${fields.join("")}</t:Updates>
        </t:ItemChange>
      </m:ItemChanges>
    </m:UpdateItem>`);

    return {
      id,
      account: this.account,
      subject: updates.subject ?? "",
      start: updates.start ?? "",
      end: updates.end ?? "",
      isAllDay: false,
      attendees: [],
    };
  }

  async deleteEvent(id: string): Promise<void> {
    await this.post(`
    <m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToAllAndSaveCopy">
      <m:ItemIds><t:ItemId Id="${id}"/></m:ItemIds>
    </m:DeleteItem>`);
  }

  private extractItems(data: unknown): Record<string, unknown>[] {
    const body = dig(data, "Envelope", "Body") as Record<string, unknown> | undefined;
    if (!body) return [];
    for (const key of Object.keys(body)) {
      const response = body[key] as Record<string, unknown>;
      const rm = dig(response, "ResponseMessages") as Record<string, unknown> | undefined;
      if (!rm) continue;
      for (const rmKey of Object.keys(rm)) {
        const msg = rm[rmKey] as Record<string, unknown>;
        const rootFolder = msg.RootFolder as Record<string, unknown> | undefined;
        const items = (rootFolder ? dig(rootFolder, "Items") : dig(msg, "Items")) as
          | Record<string, unknown>
          | undefined;
        if (!items) continue;
        const calItems = items.CalendarItem;
        if (Array.isArray(calItems)) return calItems as Record<string, unknown>[];
        if (calItems && typeof calItems === "object") return [calItems as Record<string, unknown>];
      }
    }
    return [];
  }

  private mapEvent(item: Record<string, unknown>): CalendarEvent {
    const reqAttendees = dig(item, "RequiredAttendees", "Attendee") as
      | Record<string, unknown>[]
      | undefined;
    const optAttendees = dig(item, "OptionalAttendees", "Attendee") as
      | Record<string, unknown>[]
      | undefined;
    const allAttendees = [...(reqAttendees ?? []), ...(optAttendees ?? [])];

    return {
      id: str(dig(item, "ItemId", "@_Id")),
      account: this.account,
      subject: str(item.Subject),
      start: str(item.Start),
      end: str(item.End),
      location: str(item.Location) || undefined,
      isAllDay: str(item.IsAllDayEvent) === "true",
      attendees: allAttendees
        .map((a) => {
          const mailboxes = dig(a, "Mailbox") as Record<string, unknown>[] | undefined;
          return str(mailboxes?.[0]?.EmailAddress);
        })
        .filter(Boolean),
    };
  }
}
