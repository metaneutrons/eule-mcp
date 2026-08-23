import { randomUUID } from "node:crypto";
import { DAVClient, type DAVCalendar, type DAVCalendarObject } from "tsdav";
import type {
  RemoteTask,
  RemoteTaskInput,
  RemoteTaskUpdate,
  TaskConnector,
  TaskListInfo,
} from "../../types/index.js";
import { assertSecureUrl, escapeICalText, unescapeICalText } from "../../utils/security.js";
import type { CalDavConfig } from "./caldav-calendar.js";
import { applyComponentUpdates, icalToIso, isoToIcal, readComponentProp } from "./ics.js";

/** RFC 5545 PRIORITY: 1-4 high, 5 normal, 6-9 low, 0 undefined. */
function priorityToImportance(value: string): "low" | "normal" | "high" | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return undefined;
  if (n <= 4) return "high";
  if (n === 5) return "normal";
  return "low";
}

function importanceToPriority(importance: "low" | "normal" | "high"): string {
  return importance === "high" ? "1" : importance === "low" ? "9" : "5";
}

/**
 * A date-only DUE needs an explicit VALUE=DATE parameter to stay all-day.
 * Returns an {@link applyComponentUpdates} edit value, so a leading `;` means
 * "these are my own parameters".
 */
function dueEdit(due: string): string {
  const value = isoToIcal(due);
  return value.length === 8 ? `;VALUE=DATE:${value}` : value;
}

/** The same value rendered as a complete content line for a fresh object. */
function dueLine(due: string): string {
  const edit = dueEdit(due);
  return edit.startsWith(";") ? `DUE${edit}` : `DUE:${edit}`;
}

/**
 * Tasks as VTODO over CalDAV. This covers Apple Reminders (iCloud CalDAV) and
 * Nextcloud Tasks, and reuses the same credentials as the CalDAV calendar
 * connector. Task ids are the CalDAV object URLs, list ids the collection URLs.
 */
export class CalDavTaskConnector implements TaskConnector {
  readonly tier = "caldav";
  readonly readOnly = false;

  constructor(
    readonly account: string,
    private readonly cfg: CalDavConfig,
  ) {}

  private async client(): Promise<DAVClient> {
    // Basic-auth credentials must never cross a cleartext connection.
    assertSecureUrl(this.cfg.url, "CalDAV URL");
    const client = new DAVClient({
      serverUrl: this.cfg.url,
      credentials: { username: this.cfg.account, password: this.cfg.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    await client.login();
    return client;
  }

  /** Only collections that advertise VTODO support; a calendar is not a list. */
  private async todoCalendars(client: DAVClient): Promise<DAVCalendar[]> {
    const calendars = await client.fetchCalendars();
    return calendars.filter((calendar) => {
      const components = calendar.components ?? [];
      return components.some((component) => component.toUpperCase() === "VTODO");
    });
  }

  async listTaskLists(): Promise<TaskListInfo[]> {
    const client = await this.client();
    const calendars = await this.todoCalendars(client);
    return calendars.map((calendar, index) => ({
      id: calendar.url,
      account: this.account,
      name:
        typeof calendar.displayName === "string"
          ? calendar.displayName
          : `Tasks ${String(index + 1)}`,
      isDefault: index === 0,
    }));
  }

  async listTasks(
    opts: { listId?: string; includeCompleted?: boolean; limit?: number } = {},
  ): Promise<RemoteTask[]> {
    const client = await this.client();
    const calendars = (await this.todoCalendars(client)).filter(
      (calendar) => !opts.listId || calendar.url === opts.listId,
    );
    const limit = opts.limit ?? 100;
    const tasks: RemoteTask[] = [];

    for (const calendar of calendars) {
      if (tasks.length >= limit) break;
      const objects = await client.fetchCalendarObjects({ calendar });
      const name = typeof calendar.displayName === "string" ? calendar.displayName : undefined;
      for (const object of objects) {
        const data = String(object.data ?? "");
        if (!data.includes("VTODO")) continue;
        const task = this.parse(data, object.url, calendar.url, name);
        if (!opts.includeCompleted && task.completed) continue;
        tasks.push(task);
        if (tasks.length >= limit) break;
      }
    }
    return tasks;
  }

  async createTask(input: RemoteTaskInput): Promise<RemoteTask> {
    const client = await this.client();
    const calendars = await this.todoCalendars(client);
    const calendar = input.listId
      ? (calendars.find((c) => c.url === input.listId) ?? calendars[0])
      : calendars[0];
    if (!calendar) throw new Error(`No VTODO collection available for ${this.account}`);

    // randomUUID, not a timestamp: two tasks created in the same millisecond
    // would otherwise share a UID and collide in the collection.
    const uid = `eule-${randomUUID()}@eule-mcp`;
    const stamp = isoToIcal(new Date().toISOString());
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//eule-mcp//EN",
      "BEGIN:VTODO",
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `SUMMARY:${escapeICalText(input.title)}`,
      input.notes ? `DESCRIPTION:${escapeICalText(input.notes)}` : "",
      input.due ? dueLine(input.due) : "",
      input.importance ? `PRIORITY:${importanceToPriority(input.importance)}` : "",
      "STATUS:NEEDS-ACTION",
      "END:VTODO",
      "END:VCALENDAR",
    ]
      .filter(Boolean)
      .join("\r\n");

    const filename = `${uid}.ics`;
    await client.createCalendarObject({ calendar, iCalString: ics, filename });
    const url = new URL(filename, calendar.url).toString();
    return this.parse(ics, url, calendar.url);
  }

  /** Locates the collection an object URL belongs to, plus the object itself. */
  private async findTaskObject(
    client: DAVClient,
    id: string,
  ): Promise<{ calendar: DAVCalendar; object: DAVCalendarObject }> {
    const calendar = (await this.todoCalendars(client)).find((c) => id.startsWith(c.url));
    if (!calendar) throw new Error(`Task ${id} not found`);
    const object = (await client.fetchCalendarObjects({ calendar, objectUrls: [id] }))[0];
    if (!object) throw new Error(`Task ${id} not found`);
    return { calendar, object };
  }

  async updateTask(id: string, updates: RemoteTaskUpdate): Promise<RemoteTask> {
    const client = await this.client();
    const { calendar, object } = await this.findTaskObject(client, id);

    const original = String(object.data ?? "");
    const stamp = isoToIcal(new Date().toISOString());
    const edits = new Map<string, string | null>([
      ["DTSTAMP", stamp],
      ["LAST-MODIFIED", stamp],
      ["SEQUENCE", String((Number(readComponentProp(original, "VTODO", "SEQUENCE")) || 0) + 1)],
    ]);
    if (updates.title !== undefined) edits.set("SUMMARY", escapeICalText(updates.title));
    if (updates.notes !== undefined) edits.set("DESCRIPTION", escapeICalText(updates.notes));
    if (updates.due !== undefined)
      edits.set("DUE", updates.due === null ? null : dueEdit(updates.due));
    if (updates.importance !== undefined)
      edits.set("PRIORITY", importanceToPriority(updates.importance));
    if (updates.completed !== undefined) {
      // Reopening must clear COMPLETED and PERCENT-COMPLETE, otherwise clients
      // keep showing the task as done despite STATUS:NEEDS-ACTION.
      edits.set("STATUS", updates.completed ? "COMPLETED" : "NEEDS-ACTION");
      edits.set("COMPLETED", updates.completed ? stamp : null);
      edits.set("PERCENT-COMPLETE", updates.completed ? "100" : null);
    }

    const updated = applyComponentUpdates(
      original,
      "VTODO",
      edits,
      new Set(["SUMMARY", "DESCRIPTION"]),
    );
    await client.updateCalendarObject({
      calendarObject: { url: object.url, data: updated, etag: object.etag },
    });
    const name = typeof calendar.displayName === "string" ? calendar.displayName : undefined;
    return this.parse(updated, object.url, calendar.url, name);
  }

  async deleteTask(id: string): Promise<void> {
    const client = await this.client();
    const { object } = await this.findTaskObject(client, id);
    await client.deleteCalendarObject({
      calendarObject: { url: object.url, etag: object.etag },
    });
  }

  private parse(data: string, url: string, listId: string, listName?: string): RemoteTask {
    // Read VTODO-scoped, never with a global regex. A DISPLAY alarm carries its
    // own SUMMARY and DESCRIPTION, so an unscoped read can return the alarm's
    // reminder text as the task's notes whenever the task has none of its own.
    const prop = (name: string): string => readComponentProp(data, "VTODO", name);
    const status = prop("STATUS").toUpperCase();
    const percent = Number(prop("PERCENT-COMPLETE"));
    const completedAt = prop("COMPLETED");
    const due = prop("DUE");
    return {
      id: url,
      account: this.account,
      listId,
      listName,
      title: unescapeICalText(prop("SUMMARY")),
      notes: unescapeICalText(prop("DESCRIPTION")) || undefined,
      completed: status === "COMPLETED" || percent === 100,
      due: due ? icalToIso(due) : undefined,
      completedAt: completedAt ? icalToIso(completedAt) : undefined,
      importance: priorityToImportance(prop("PRIORITY")),
    };
  }
}
