import { DAVClient } from "tsdav";
import type {
  CalendarConnector,
  CalendarEvent,
  CalendarEventInput,
  CalendarInfo,
} from "../../types/index.js";

export interface CalDavConfig {
  account: string;
  url: string;
  password: string;
}

function ical(val: string, key: string): string {
  const re = new RegExp(`${key}[^:]*:([^\\r\\n]+)`, "i");
  return re.exec(val)?.[1]?.trim() ?? "";
}

function icalToIso(dt: string): string {
  // 20260410T140000Z → 2026-04-10T14:00:00Z
  if (dt.length < 15) return dt;
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(9, 11)}:${dt.slice(11, 13)}:${dt.slice(13, 15)}${dt.endsWith("Z") ? "Z" : ""}`;
}

function isoToIcal(iso: string): string {
  return iso.replace(/[-:]/g, "").split(".")[0] ?? iso;
}

export class CalDavCalendarConnector implements CalendarConnector {
  readonly tier = "caldav";
  readonly readOnly = false;

  constructor(
    readonly account: string,
    private readonly cfg: CalDavConfig,
  ) {}

  private async client(): Promise<DAVClient> {
    const c = new DAVClient({
      serverUrl: this.cfg.url,
      credentials: { username: this.cfg.account, password: this.cfg.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    await c.login();
    return c;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const c = await this.client();
    const calendars = await c.fetchCalendars();
    return calendars.map((cal, i) => ({
      id: cal.url,
      name: typeof cal.displayName === "string" ? cal.displayName : `Calendar ${String(i + 1)}`,
      account: this.account,
      isDefault: i === 0,
    }));
  }

  async listEvents(start: string, end: string): Promise<CalendarEvent[]> {
    const c = await this.client();
    const calendars = await c.fetchCalendars();
    const events: CalendarEvent[] = [];

    for (const cal of calendars) {
      const objects = await c.fetchCalendarObjects({
        calendar: cal,
        timeRange: { start: isoToIcal(start), end: isoToIcal(end) },
      });
      for (const obj of objects) {
        const data = String(obj.data ?? "");
        if (!data.includes("VEVENT")) continue;
        events.push(this.parse(data, obj.url));
      }
    }

    return events.sort((a, b) => a.start.localeCompare(b.start));
  }

  async createEvent(event: CalendarEventInput): Promise<CalendarEvent> {
    const c = await this.client();
    const calendars = await c.fetchCalendars();
    const cal = event.calendarId
      ? (calendars.find((cc) => cc.url === event.calendarId) ?? calendars[0])
      : calendars[0];
    if (!cal) throw new Error("No calendars found");

    const uid = `eule-${String(Date.now())}@eule-mcp`;
    const stamp = isoToIcal(new Date().toISOString());
    const attendees = (event.attendees ?? []).map((a) => `ATTENDEE:mailto:${a}`).join("\r\n");

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//eule-mcp//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${isoToIcal(event.start)}`,
      `DTEND:${isoToIcal(event.end)}`,
      `SUMMARY:${event.subject}`,
      event.location ? `LOCATION:${event.location}` : "",
      event.body ? `DESCRIPTION:${event.body}` : "",
      attendees,
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .filter(Boolean)
      .join("\r\n");

    await c.createCalendarObject({ calendar: cal, iCalString: ics, filename: `${uid}.ics` });

    return {
      id: uid,
      account: this.account,
      subject: event.subject,
      start: event.start,
      end: event.end,
      isAllDay: false,
      attendees: event.attendees ?? [],
    };
  }

  async updateEvent(id: string, updates: Partial<CalendarEventInput>): Promise<CalendarEvent> {
    // CalDAV update = fetch + modify + PUT. Simplified: delete + create.
    const c = await this.client();
    const calendars = await c.fetchCalendars();

    for (const cal of calendars) {
      const objects = await c.fetchCalendarObjects({ calendar: cal });
      const obj = objects.find((o) => String(o.data ?? "").includes(id));
      if (!obj) continue;

      const data = String(obj.data ?? "");
      const current = this.parse(data, obj.url);
      const merged: CalendarEventInput = {
        subject: updates.subject ?? current.subject,
        start: updates.start ?? current.start,
        end: updates.end ?? current.end,
        location: updates.location ?? current.location,
      };

      if (obj.etag) {
        await c.deleteCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag } });
      }
      return this.createEvent(merged);
    }

    throw new Error(`Event ${id} not found`);
  }

  async deleteEvent(id: string): Promise<void> {
    const c = await this.client();
    const calendars = await c.fetchCalendars();

    for (const cal of calendars) {
      const objects = await c.fetchCalendarObjects({ calendar: cal });
      const obj = objects.find((o) => String(o.data ?? "").includes(id));
      if (obj?.etag) {
        await c.deleteCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag } });
        return;
      }
    }
    throw new Error(`Event ${id} not found`);
  }

  private parse(data: string, url: string): CalendarEvent {
    const dtstart = ical(data, "DTSTART");
    const dtend = ical(data, "DTEND");
    const isAllDay = dtstart.length === 8; // 20260410 vs 20260410T140000Z

    const attendeeMatches = data.match(/ATTENDEE[^:]*:mailto:([^\r\n]+)/gi) ?? [];
    const attendees = attendeeMatches.map((a) => a.replace(/.*mailto:/i, "").trim());

    return {
      id: ical(data, "UID") || url,
      account: this.account,
      subject: ical(data, "SUMMARY"),
      start: isAllDay ? dtstart : icalToIso(dtstart),
      end: isAllDay ? dtend || dtstart : icalToIso(dtend || dtstart),
      location: ical(data, "LOCATION") || undefined,
      isAllDay,
      attendees,
    };
  }
}
