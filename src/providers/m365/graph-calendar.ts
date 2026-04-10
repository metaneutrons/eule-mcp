import type {
  CalendarConnector,
  CalendarEvent,
  CalendarEventInput,
  CalendarInfo,
} from "../../types/index.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  isAllDay?: boolean;
  attendees?: { emailAddress?: { address?: string } }[];
  body?: { contentType?: string; content?: string };
}

export class GraphCalendarConnector implements CalendarConnector {
  readonly tier = "graph";
  readonly readOnly = false;

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

  async listCalendars(): Promise<CalendarInfo[]> {
    const h = await this.headers();
    const res = await fetch(`${this.base}/calendars?$select=id,name,color,isDefaultCalendar`, {
      headers: h,
    });
    if (!res.ok) throw new Error(`Graph calendars: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as {
      value: { id?: string; name?: string; color?: string; isDefaultCalendar?: boolean }[];
    };
    return data.value.map((c) => ({
      id: c.id ?? "",
      name: c.name ?? "",
      account: this.account,
      color: c.color,
      isDefault: c.isDefaultCalendar,
    }));
  }

  async listEvents(start: string, end: string): Promise<CalendarEvent[]> {
    const h = await this.headers();
    const url = `${this.base}/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$orderby=start/dateTime&$top=50&$select=id,subject,start,end,location,isAllDay,attendees`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Graph calendarView: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: GraphEvent[] };
    return data.value.map((e) => this.mapEvent(e));
  }

  async createEvent(event: CalendarEventInput): Promise<CalendarEvent> {
    const h = await this.headers();
    const body: Record<string, unknown> = {
      subject: event.subject,
      start: { dateTime: event.start, timeZone: "UTC" },
      end: { dateTime: event.end, timeZone: "UTC" },
    };
    if (event.location) body.location = { displayName: event.location };
    if (event.body) body.body = { contentType: "Text", content: event.body };
    if (event.attendees?.length) {
      body.attendees = event.attendees.map((a) => ({
        emailAddress: { address: a },
        type: "required",
      }));
    }

    const calPath = event.calendarId ? `calendars/${event.calendarId}/events` : "events";
    const res = await fetch(`${this.base}/${calPath}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Graph createEvent: ${String(res.status)} ${await res.text()}`);
    return this.mapEvent((await res.json()) as GraphEvent);
  }

  async updateEvent(id: string, updates: Partial<CalendarEventInput>): Promise<CalendarEvent> {
    const h = await this.headers();
    const body: Record<string, unknown> = {};
    if (updates.subject) body.subject = updates.subject;
    if (updates.start) body.start = { dateTime: updates.start, timeZone: "UTC" };
    if (updates.end) body.end = { dateTime: updates.end, timeZone: "UTC" };
    if (updates.location) body.location = { displayName: updates.location };

    const res = await fetch(`${this.base}/events/${id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Graph updateEvent: ${String(res.status)} ${await res.text()}`);
    return this.mapEvent((await res.json()) as GraphEvent);
  }

  async deleteEvent(id: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${this.base}/events/${id}`, { method: "DELETE", headers: h });
    if (!res.ok) throw new Error(`Graph deleteEvent: ${String(res.status)} ${await res.text()}`);
  }

  private mapEvent(e: GraphEvent): CalendarEvent {
    return {
      id: e.id ?? "",
      account: this.account,
      subject: e.subject ?? "",
      start: e.start?.dateTime ?? "",
      end: e.end?.dateTime ?? "",
      location: e.location?.displayName ?? undefined,
      isAllDay: e.isAllDay ?? false,
      attendees: (e.attendees ?? []).map((a) => a.emailAddress?.address ?? "").filter(Boolean),
    };
  }
}
