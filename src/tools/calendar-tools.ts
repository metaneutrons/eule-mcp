import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CalendarService } from "../services/calendar-service.js";
import type { CalendarEvent } from "../types/index.js";
import { executeTool, textResult } from "./tool-runtime.js";

export const calendarDateTimeSchema = z.union([
  z.iso.datetime({ offset: true, local: true }),
  z.iso.datetime({ offset: true, local: true, precision: -1 }),
]);
/**
 * `YYYY-MM-DD` and `HH:MM` in the server's local time zone. Providers report
 * UTC ("…Z") or offset times; slicing those strings printed UTC wall-clock
 * times without saying so. Strings without zone stay as they are.
 */
export function localParts(iso: string, timeZone?: string): { date: string; time: string } {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso))
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

export const renderEvent = (event: CalendarEvent, timeZone?: string): string => {
  const location = event.location ? ` 📍 ${event.location}` : "";
  const id = event.id ? `\n  ID: ${event.id}` : "";
  const start = localParts(event.start, timeZone);
  if (event.isAllDay) return `${start.date} (all day) | ${event.subject}${location}${id}`;
  const end = localParts(event.end, timeZone);
  const attendees = event.attendees.length ? ` 👥 ${String(event.attendees.length)}` : "";
  const endText = end.date === start.date ? end.time : `${end.date} ${end.time}`;
  return `${start.date} ${start.time}–${endText} | ${event.subject}${location}${attendees}${id}`;
};

export function registerCalendarTools(server: McpServer, calendars: CalendarService): void {
  server.registerTool(
    "calendar_list",
    {
      description:
        "List upcoming calendar events in local time, each with its ID for calendar_update and calendar_delete",
      inputSchema: {
        role: z.string().optional(),
        days: z.number().int().min(1).max(365).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ role, days }) =>
      executeTool("calendar_list", async () => {
        const start = new Date();
        const end = new Date(start);
        end.setDate(end.getDate() + (days ?? 7));
        const result = await calendars.events(start.toISOString(), end.toISOString(), role);
        return textResult(
          [
            ...result.events.map((event) => renderEvent(event)),
            ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
          ].join("\n") || "No events found.",
        );
      }),
  );
  server.registerTool(
    "calendar_today",
    {
      description: "Show today's schedule",
      inputSchema: { role: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ role }) =>
      executeTool("calendar_today", async () => {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const result = await calendars.events(start.toISOString(), end.toISOString(), role);
        if (!result.events.length && !result.failures.length)
          return textResult("📅 No events today.");
        return textResult(
          `📅 Today (${String(result.events.length)} events):\n\n${[...result.events.map((event) => renderEvent(event)), ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`)].join("\n")}`,
        );
      }),
  );
  server.registerTool(
    "calendar_calendars",
    {
      description: "List available calendars",
      inputSchema: { role: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ role }) =>
      executeTool("calendar_calendars", async () => {
        const result = await calendars.calendars(role);
        return textResult(
          [
            ...result.calendars.map(
              (c) => `[${c.account}] ${c.name}${c.isDefault ? " (default)" : ""}\n  ID: ${c.id}`,
            ),
            ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
          ].join("\n\n") || "No calendars found.",
        );
      }),
  );
  const eventInput = {
    subject: z.string().trim().min(1).max(500),
    start: calendarDateTimeSchema,
    end: calendarDateTimeSchema,
    location: z.string().max(1000).optional(),
    body: z.string().max(100_000).optional(),
    attendees: z.array(z.email()).max(500).optional(),
    calendarId: z.string().optional(),
    role: z.string().optional(),
    account: z.string().min(1).describe("Account to act on (see account_list)"),
  };
  server.registerTool(
    "calendar_create",
    {
      description: "Create a calendar event",
      inputSchema: eventInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ role, account, ...event }) =>
      executeTool("calendar_create", async () => {
        const created = await calendars.create(event, role, account);
        return textResult(
          created.id
            ? `📅 Event created: ${renderEvent(created)}`
            : `📅 Event created: ${event.subject} (the provider returned no id)`,
        );
      }),
  );
  server.registerTool(
    "calendar_update",
    {
      description: "Update a calendar event",
      inputSchema: {
        id: z.string(),
        subject: z.string().trim().min(1).max(500).optional(),
        start: calendarDateTimeSchema.optional(),
        end: calendarDateTimeSchema.optional(),
        location: z.string().max(1000).optional(),
        role: z.string().optional(),
        account: z.string().min(1).describe("Account to act on (see account_list)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, role, account, ...updates }) =>
      executeTool("calendar_update", async () =>
        textResult(
          `📅 Event updated: ${(await calendars.update(id, updates, role, account)).subject}`,
        ),
      ),
  );
  server.registerTool(
    "calendar_delete",
    {
      description: "Delete a calendar event",
      inputSchema: {
        id: z.string(),
        role: z.string().optional(),
        account: z.string().min(1).describe("Account holding the event (see account_list)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, role, account }) =>
      executeTool("calendar_delete", async () => {
        await calendars.delete(id, role, account);
        return textResult("📅 Event deleted.");
      }),
  );
}
