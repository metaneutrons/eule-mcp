import { DAVClient } from "tsdav";
import type {
  CalendarConnector,
  CalendarEvent,
  CalendarEventInput,
  CalendarInfo,
} from "../../types/index.js";
import { assertSecureUrl, escapeICalText, unescapeICalText } from "../../utils/security.js";
import {
  applyComponentUpdates,
  icalToIso,
  icalValue as ical,
  isoToIcal,
  readComponentProp,
} from "./ics.js";

export interface CalDavConfig {
  account: string;
  url: string;
  password: string;
}

/**
 * Rewrites the given VEVENT-level properties in place, preserving every
 * untouched property and bumping SEQUENCE / DTSTAMP / LAST-MODIFIED. Exported
 * for testing; see {@link applyComponentUpdates} for the scoping rules.
 */
export function applyEventUpdates(
  ics: string,
  updates: Partial<CalendarEventInput>,
  nowStamp: string,
): string {
  const edits = new Map<string, string | null>([
    ["DTSTAMP", nowStamp],
    ["LAST-MODIFIED", nowStamp],
    ["SEQUENCE", String((Number(readComponentProp(ics, "VEVENT", "SEQUENCE")) || 0) + 1)],
  ]);
  if (updates.subject !== undefined) edits.set("SUMMARY", escapeICalText(updates.subject));
  if (updates.location !== undefined) edits.set("LOCATION", escapeICalText(updates.location));
  if (updates.start !== undefined) edits.set("DTSTART", isoToIcal(updates.start));
  if (updates.end !== undefined) edits.set("DTEND", isoToIcal(updates.end));
  return applyComponentUpdates(ics, "VEVENT", edits, new Set(["SUMMARY", "LOCATION"]));
}

export class CalDavCalendarConnector implements CalendarConnector {
  readonly tier = "caldav";
  readonly readOnly = false;

  constructor(
    readonly account: string,
    private readonly cfg: CalDavConfig,
  ) {}

  private async client(): Promise<DAVClient> {
    // Basic-auth credentials must never cross a cleartext connection.
    assertSecureUrl(this.cfg.url, "CalDAV URL");
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
    const attendees = (event.attendees ?? [])
      .map((a) => `ATTENDEE:mailto:${escapeICalText(a)}`)
      .join("\r\n");

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//eule-mcp//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${isoToIcal(event.start)}`,
      `DTEND:${isoToIcal(event.end)}`,
      `SUMMARY:${escapeICalText(event.subject)}`,
      event.location ? `LOCATION:${escapeICalText(event.location)}` : "",
      event.body ? `DESCRIPTION:${escapeICalText(event.body)}` : "",
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
    // Proper CalDAV update: fetch the object, rewrite only the changed VEVENT
    // properties in place, and PUT it back (If-Match on the etag). This keeps
    // the UID and preserves recurrence, attendees, description and alarms —
    // unlike a delete+recreate, which dropped them and minted a new UID.
    const c = await this.client();
    const calendars = await c.fetchCalendars();

    for (const cal of calendars) {
      const objects = await c.fetchCalendarObjects({ calendar: cal });
      // Match on the parsed UID, not a substring of the whole ICS — a substring
      // hit could target an unrelated event whose body merely contains `id`.
      const obj = objects.find((o) => this.matchesId(String(o.data ?? ""), o.url, id));
      if (!obj) continue;

      const original = String(obj.data ?? "");
      const updated = applyEventUpdates(original, updates, isoToIcal(new Date().toISOString()));
      await c.updateCalendarObject({
        calendarObject: { url: obj.url, data: updated, etag: obj.etag },
      });
      return this.parse(updated, obj.url);
    }

    throw new Error(`Event ${id} not found`);
  }

  async deleteEvent(id: string): Promise<void> {
    const c = await this.client();
    const calendars = await c.fetchCalendars();

    for (const cal of calendars) {
      const objects = await c.fetchCalendarObjects({ calendar: cal });
      const obj = objects.find((o) => this.matchesId(String(o.data ?? ""), o.url, id));
      if (obj?.etag) {
        await c.deleteCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag } });
        return;
      }
    }
    throw new Error(`Event ${id} not found`);
  }

  /** True if the ICS object's UID (or its URL fallback) exactly equals `id`. */
  private matchesId(data: string, url: string, id: string): boolean {
    if (!data.includes("VEVENT")) return false;
    return this.parse(data, url).id === id;
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
      // SUMMARY/LOCATION are iCal TEXT — unescape so a later updateEvent (which
      // re-escapes on write) round-trips instead of accumulating backslashes.
      subject: unescapeICalText(ical(data, "SUMMARY")),
      start: isAllDay ? dtstart : icalToIso(dtstart),
      end: isAllDay ? dtend || dtstart : icalToIso(dtend || dtstart),
      location: unescapeICalText(ical(data, "LOCATION")) || undefined,
      isAllDay,
      attendees,
    };
  }
}
