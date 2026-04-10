import type {
  CalendarConnector,
  CalendarEvent,
  CalendarEventInput,
  CalendarInfo,
} from "../../types/index.js";

function ical(block: string, key: string): string {
  const re = new RegExp(`${key}[^:]*:([^\\r\\n]+)`, "i");
  return re.exec(block)?.[1]?.trim() ?? "";
}

function icalToIso(dt: string): string {
  if (dt.length < 8) return dt;
  if (dt.length === 8) return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(9, 11)}:${dt.slice(11, 13)}:${dt.slice(13, 15)}${dt.endsWith("Z") ? "Z" : ""}`;
}

export class ICalFeedConnector implements CalendarConnector {
  readonly tier = "ical";
  readonly readOnly = true;

  constructor(
    readonly account: string,
    private readonly url: string,
  ) {}

  listCalendars(): Promise<CalendarInfo[]> {
    return Promise.resolve([
      { id: this.url, name: this.account, account: this.account, isDefault: true },
    ]);
  }

  async listEvents(start: string, end: string): Promise<CalendarEvent[]> {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`iCal feed ${String(res.status)}: ${this.url}`);
    const text = await res.text();

    const events: CalendarEvent[] = [];
    const blocks = text.split("BEGIN:VEVENT");

    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i] ?? "";
      const dtstart = ical(block, "DTSTART");
      const dtend = ical(block, "DTEND");
      const isAllDay = dtstart.length === 8;
      const startIso = icalToIso(dtstart);
      const endIso = icalToIso(dtend || dtstart);

      if (startIso > end || endIso < start) continue;

      events.push({
        id: ical(block, "UID") || `ical-${String(i)}`,
        account: this.account,
        subject: ical(block, "SUMMARY"),
        start: startIso,
        end: endIso,
        location: ical(block, "LOCATION") || undefined,
        isAllDay,
        attendees: [],
      });
    }

    return events.sort((a, b) => a.start.localeCompare(b.start));
  }

  createEvent(_event: CalendarEventInput): Promise<CalendarEvent> {
    return Promise.reject(new Error("iCal feeds are read-only"));
  }
  updateEvent(_id: string, _updates: Partial<CalendarEventInput>): Promise<CalendarEvent> {
    return Promise.reject(new Error("iCal feeds are read-only"));
  }
  deleteEvent(_id: string): Promise<void> {
    return Promise.reject(new Error("iCal feeds are read-only"));
  }
}
