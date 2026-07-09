import { DAVClient } from "tsdav";
import type {
  CalendarConnector,
  CalendarEvent,
  CalendarEventInput,
  CalendarInfo,
} from "../../types/index.js";
import { assertSecureUrl, escapeICalText, unescapeICalText } from "../../utils/security.js";

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

/** Property name at the start of an (unfolded) iCal content line, uppercased. */
function propName(line: string): string {
  return /^([A-Za-z0-9-]+)/.exec(line)?.[1]?.toUpperCase() ?? "";
}

/** Reads the first VEVENT-level value of `name`, or "" if absent. */
function readVeventProp(ics: string, name: string): string {
  const target = name.toUpperCase();
  const stack: string[] = [];
  for (const line of ics.split(/\r?\n/)) {
    const u = line.toUpperCase();
    if (u.startsWith("BEGIN:")) stack.push(u.slice(6).trim());
    else if (u.startsWith("END:")) stack.pop();
    else if (
      stack[stack.length - 1] === "VEVENT" &&
      !/^[ \t]/.test(line) &&
      propName(line) === target
    ) {
      return line.slice(line.indexOf(":") + 1).trim();
    }
  }
  return "";
}

/**
 * Rewrites the given VEVENT-level properties in an iCalendar object *in place*,
 * preserving every untouched property (DESCRIPTION, ATTENDEE, RRULE, VALARM,
 * VALUE=DATE flags, …) byte-for-byte, and bumping SEQUENCE / DTSTAMP /
 * LAST-MODIFIED. Edits are scoped to the VEVENT component only — never a nested
 * VALARM's SUMMARY/DESCRIPTION nor a VTIMEZONE's DTSTART. Exported for testing.
 */
export function applyEventUpdates(
  ics: string,
  updates: Partial<CalendarEventInput>,
  nowStamp: string,
): string {
  const edits = new Map<string, string>([
    ["DTSTAMP", nowStamp],
    ["LAST-MODIFIED", nowStamp],
    ["SEQUENCE", String((Number(readVeventProp(ics, "SEQUENCE")) || 0) + 1)],
  ]);
  if (updates.subject !== undefined) edits.set("SUMMARY", escapeICalText(updates.subject));
  if (updates.location !== undefined) edits.set("LOCATION", escapeICalText(updates.location));
  if (updates.start !== undefined) edits.set("DTSTART", isoToIcal(updates.start));
  if (updates.end !== undefined) edits.set("DTEND", isoToIcal(updates.end));

  // TEXT props keep any parameters (e.g. ;LANGUAGE=); date props are replaced
  // wholesale so a UTC value can't collide with a leftover ;TZID= parameter.
  const keepParams = new Set(["SUMMARY", "LOCATION"]);
  const lines = ics.split(/\r?\n/);
  const remaining = new Map(edits);
  const stack: string[] = [];
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const u = line.toUpperCase();

    if (u.startsWith("BEGIN:")) {
      stack.push(u.slice(6).trim());
      out.push(line);
    } else if (u.startsWith("END:")) {
      if (u.slice(4).trim() === "VEVENT" && remaining.size) {
        for (const [name, value] of remaining) out.push(`${name}:${value}`);
        remaining.clear();
      }
      stack.pop();
      out.push(line);
    } else if (/^[ \t]/.test(line)) {
      out.push(line); // folded continuation of the previous property
    } else if (stack[stack.length - 1] === "VEVENT" && remaining.has(propName(line))) {
      const name = propName(line);
      const value = remaining.get(name) ?? "";
      remaining.delete(name);
      const colon = line.indexOf(":");
      const semi = line.indexOf(";");
      if (keepParams.has(name) && semi >= 0 && semi < colon) {
        out.push(`${line.slice(0, colon)}:${value}`); // NAME;params:value
      } else {
        out.push(`${name}:${value}`);
      }
      // Drop the folded continuation lines of the property we just replaced.
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1] ?? "")) i++;
    } else {
      out.push(line);
    }
  }
  return out.join("\r\n");
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
