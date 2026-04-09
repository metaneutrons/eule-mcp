import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ConnectorRegistry } from "../connectors/index.js";
import type { TaskManager } from "../db/task-manager.js";
import type { MailMessage, CalendarEvent } from "../types/index.js";

const BRIEFING_DIR = join(homedir(), ".eule", "knowledge", "briefings");

export interface Briefing {
  date: string;
  calendar: CalendarEvent[];
  unreadMail: MailMessage[];
  inboxTasks: { id: number; title: string; due_date: string | null }[];
  nextTasks: { id: number; title: string; due_date: string | null; context: string | null }[];
  waitingTasks: { id: number; title: string; waiting_for: string | null }[];
}

export class BriefingService {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly taskManager: TaskManager,
  ) {}

  async generate(): Promise<Briefing> {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    // Parallel fetch: calendar + mail.
    const [calendar, unreadMail] = await Promise.all([
      this.fetchCalendar(dayStart, dayEnd),
      this.fetchUnreadMail(),
    ]);

    // Tasks are synchronous (SQLite).
    const inboxTasks = this.taskManager
      .inbox()
      .map((t) => ({ id: t.id, title: t.title, due_date: t.due_date }));
    const nextTasks = this.taskManager
      .list({ status: "next" })
      .map((t) => ({ id: t.id, title: t.title, due_date: t.due_date, context: t.context }));
    const waitingTasks = this.taskManager
      .list({ status: "waiting" })
      .map((t) => ({ id: t.id, title: t.title, waiting_for: t.waiting_for }));

    const briefing: Briefing = {
      date: dateStr,
      calendar,
      unreadMail,
      inboxTasks,
      nextTasks,
      waitingTasks,
    };

    this.exportMarkdown(briefing);
    return briefing;
  }

  private async fetchCalendar(start: string, end: string): Promise<CalendarEvent[]> {
    try {
      const connectors = this.registry.getCalendarConnectors();
      const all: CalendarEvent[] = [];
      for (const c of connectors) {
        all.push(...(await c.listEvents(start, end)));
      }
      return all.sort((a, b) => a.start.localeCompare(b.start));
    } catch {
      return [];
    }
  }

  private async fetchUnreadMail(): Promise<MailMessage[]> {
    try {
      const connectors = this.registry.getMailConnectors();
      const all: MailMessage[] = [];
      for (const c of connectors) {
        const msgs = await c.listMessages("inbox", 20);
        all.push(...msgs.filter((m) => !m.isRead));
      }
      return all.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    } catch {
      return [];
    }
  }

  private exportMarkdown(b: Briefing): void {
    mkdirSync(BRIEFING_DIR, { recursive: true });
    const lines: string[] = [`# Daily Briefing — ${b.date}`, ""];

    // Calendar.
    lines.push("## 📅 Today's Schedule", "");
    if (b.calendar.length === 0) {
      lines.push("No events today.", "");
    } else {
      for (const e of b.calendar) {
        const time = e.isAllDay ? "All day" : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`;
        const loc = e.location ? ` 📍 ${e.location}` : "";
        const att = e.attendees.length > 0 ? ` (${e.attendees.join(", ")})` : "";
        lines.push(`- ${time}: **${e.subject}**${loc}${att}`);
      }
      lines.push("");
    }

    // Unread mail.
    lines.push(`## 📧 Unread Mail (${String(b.unreadMail.length)})`, "");
    if (b.unreadMail.length === 0) {
      lines.push("Inbox zero! 🎉", "");
    } else {
      for (const m of b.unreadMail.slice(0, 10)) {
        lines.push(`- ${m.receivedAt.slice(0, 16)} | ${m.from} | ${m.subject}`);
      }
      if (b.unreadMail.length > 10) lines.push(`- ...and ${String(b.unreadMail.length - 10)} more`);
      lines.push("");
    }

    // Inbox tasks.
    if (b.inboxTasks.length > 0) {
      lines.push(`## 📥 Inbox (${String(b.inboxTasks.length)} unprocessed)`, "");
      for (const t of b.inboxTasks) {
        lines.push(`- #${String(t.id)} ${t.title}${t.due_date ? ` 📅 ${t.due_date}` : ""}`);
      }
      lines.push("");
    }

    // Next actions.
    if (b.nextTasks.length > 0) {
      lines.push(`## ⚡ Next Actions (${String(b.nextTasks.length)})`, "");
      for (const t of b.nextTasks) {
        lines.push(
          `- #${String(t.id)} ${t.title}${t.due_date ? ` 📅 ${t.due_date}` : ""}${t.context ? ` @${t.context}` : ""}`,
        );
      }
      lines.push("");
    }

    // Waiting for.
    if (b.waitingTasks.length > 0) {
      lines.push(`## ⏳ Waiting For (${String(b.waitingTasks.length)})`, "");
      for (const t of b.waitingTasks) {
        lines.push(`- #${String(t.id)} ${t.title}${t.waiting_for ? ` → ${t.waiting_for}` : ""}`);
      }
      lines.push("");
    }

    writeFileSync(join(BRIEFING_DIR, `${b.date}.md`), lines.join("\n"));
    // Also write as latest.md for easy KB indexing.
    writeFileSync(join(BRIEFING_DIR, "latest.md"), lines.join("\n"));
  }
}
