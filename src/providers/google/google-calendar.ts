import type {
  CalendarConnector,
  CalendarEvent,
  CalendarEventInput,
  CalendarInfo,
} from "../../types/index.js";

const BASE = "https://www.googleapis.com/calendar/v3";

interface GEvent {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  attendees?: { email?: string }[];
  description?: string;
}
interface GCalendar {
  id?: string;
  summary?: string;
  backgroundColor?: string;
  primary?: boolean;
}

export class GoogleCalendarConnector implements CalendarConnector {
  readonly tier = "google";
  readonly readOnly = false;

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const h = await this.headers();
    const res = await fetch(`${BASE}/users/me/calendarList`, { headers: h });
    if (!res.ok) throw new Error(`Google calendars: ${String(res.status)}`);
    const data = (await res.json()) as { items?: GCalendar[] };
    return (data.items ?? []).map((c) => ({
      id: c.id ?? "",
      name: c.summary ?? "",
      account: this.account,
      color: c.backgroundColor,
      isDefault: c.primary,
    }));
  }

  async listEvents(start: string, end: string): Promise<CalendarEvent[]> {
    const h = await this.headers();
    const cals = await this.listCalendars();
    const events: CalendarEvent[] = [];
    for (const cal of cals) {
      const url = `${BASE}/calendars/${encodeURIComponent(cal.id)}/events?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}&singleEvents=true&orderBy=startTime&maxResults=50`;
      const res = await fetch(url, { headers: h });
      if (!res.ok) continue;
      const data = (await res.json()) as { items?: GEvent[] };
      for (const e of data.items ?? []) events.push(this.map(e, cal.id, cal.name));
    }
    return events.sort((a, b) => a.start.localeCompare(b.start));
  }

  async createEvent(event: CalendarEventInput): Promise<CalendarEvent> {
    const h = await this.headers();
    const calId = event.calendarId ?? "primary";
    const body: Record<string, unknown> = {
      summary: event.subject,
      start: { dateTime: event.start },
      end: { dateTime: event.end },
    };
    if (event.location) body.location = event.location;
    if (event.body) body.description = event.body;
    if (event.attendees?.length) body.attendees = event.attendees.map((a) => ({ email: a }));
    const res = await fetch(`${BASE}/calendars/${encodeURIComponent(calId)}/events`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Google createEvent: ${String(res.status)} ${await res.text()}`);
    return this.map((await res.json()) as GEvent, calId);
  }

  async updateEvent(id: string, updates: Partial<CalendarEventInput>): Promise<CalendarEvent> {
    const h = await this.headers();
    const calId = updates.calendarId ?? "primary";
    const body: Record<string, unknown> = {};
    if (updates.subject) body.summary = updates.subject;
    if (updates.start) body.start = { dateTime: updates.start };
    if (updates.end) body.end = { dateTime: updates.end };
    if (updates.location) body.location = updates.location;
    const res = await fetch(`${BASE}/calendars/${encodeURIComponent(calId)}/events/${id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Google updateEvent: ${String(res.status)} ${await res.text()}`);
    return this.map((await res.json()) as GEvent, calId);
  }

  async deleteEvent(id: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${BASE}/calendars/primary/events/${id}`, {
      method: "DELETE",
      headers: h,
    });
    if (!res.ok) throw new Error(`Google deleteEvent: ${String(res.status)}`);
  }

  private map(e: GEvent, calId?: string, calName?: string): CalendarEvent {
    return {
      id: e.id ?? "",
      account: this.account,
      calendarId: calId,
      calendarName: calName,
      subject: e.summary ?? "",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      location: e.location,
      isAllDay: !e.start?.dateTime,
      attendees: (e.attendees ?? []).map((a) => a.email ?? ""),
    };
  }
}
