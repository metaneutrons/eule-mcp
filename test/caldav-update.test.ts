import { describe, it, expect } from "vitest";
import { applyEventUpdates } from "../src/providers/caldav/caldav-calendar.js";
import { readComponentProp, unfold } from "../src/providers/caldav/ics.js";

// A realistic object: a VTIMEZONE (with its own DTSTART), a recurring VEVENT
// with attendees/description, and a VALARM (with its own SUMMARY/DESCRIPTION).
const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Test//EN",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:evt-123@test",
  "DTSTAMP:20260101T000000Z",
  "DTSTART:20260410T120000Z",
  "DTEND:20260410T130000Z",
  "SUMMARY:Original title",
  "LOCATION:Room A",
  "DESCRIPTION:The full agenda",
  "RRULE:FREQ=WEEKLY;COUNT=5",
  "ATTENDEE:mailto:a@x.com",
  "SEQUENCE:2",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "SUMMARY:Alarm summary",
  "DESCRIPTION:Reminder",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const NOW = "20260202T000000Z";

describe("applyEventUpdates (CalDAV in-place update)", () => {
  it("changes SUMMARY while preserving every untouched property", () => {
    const out = applyEventUpdates(ICS, { subject: "New title" }, NOW);
    expect(out).toContain("SUMMARY:New title");
    expect(out).not.toContain("SUMMARY:Original title");
    // Preserved VEVENT properties:
    expect(out).toContain("DESCRIPTION:The full agenda");
    expect(out).toContain("RRULE:FREQ=WEEKLY;COUNT=5");
    expect(out).toContain("ATTENDEE:mailto:a@x.com");
    expect(out).toContain("LOCATION:Room A");
    // UID must not change (delete+recreate used to mint a new one):
    expect(out).toContain("UID:evt-123@test");
    // The VALARM's own SUMMARY/DESCRIPTION must NOT be rewritten:
    expect(out).toContain("SUMMARY:Alarm summary");
    expect(out).toContain("DESCRIPTION:Reminder");
  });

  it("bumps SEQUENCE and refreshes DTSTAMP / LAST-MODIFIED", () => {
    const out = applyEventUpdates(ICS, { subject: "x" }, NOW);
    expect(out).toContain("SEQUENCE:3");
    expect(out).not.toContain("SEQUENCE:2");
    expect(out).toContain("DTSTAMP:20260202T000000Z");
    expect(out).toContain("LAST-MODIFIED:20260202T000000Z"); // inserted (absent before)
  });

  it("edits the VEVENT DTSTART only — never the VTIMEZONE's DTSTART", () => {
    const out = applyEventUpdates(ICS, { start: "2026-05-01T09:00:00Z" }, NOW);
    expect(out).toContain("DTSTART:20260501T090000Z"); // event moved
    expect(out).toContain("DTSTART:19701025T030000"); // timezone rule untouched
  });

  it("escapes new TEXT values exactly once (no backslash accumulation)", () => {
    const out = applyEventUpdates(ICS, { subject: "Lunch, review" }, NOW);
    expect(out).toContain("SUMMARY:Lunch\\, review");
    expect(out).not.toContain("SUMMARY:Lunch\\\\, review");
  });

  it("does NOT re-escape a stored value when that field is not being updated", () => {
    // SUMMARY already stored escaped; updating only the start must leave it as-is.
    const stored = ICS.replace("SUMMARY:Original title", "SUMMARY:Lunch\\, review");
    const out = applyEventUpdates(stored, { start: "2026-05-01T09:00:00Z" }, NOW);
    expect(out).toContain("SUMMARY:Lunch\\, review");
    expect(out).not.toContain("SUMMARY:Lunch\\\\, review");
  });

  it("leaves an all-day VALUE=DATE DTSTART intact when only the title changes", () => {
    const allDay = ICS.replace("DTSTART:20260410T120000Z", "DTSTART;VALUE=DATE:20260410");
    const out = applyEventUpdates(allDay, { subject: "renamed" }, NOW);
    expect(out).toContain("DTSTART;VALUE=DATE:20260410");
  });
});

describe("component-scoped reads (Codacy finding on PR #42)", () => {
  // A VTODO whose only DESCRIPTION/SUMMARY sit in a nested DISPLAY alarm. A
  // DISPLAY alarm is required to carry a DESCRIPTION, so this is the normal
  // shape of a reminder, not a contrived one.
  const TASK_WITH_ALARM = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:task-1@test",
    "SUMMARY:Pay the invoice",
    "STATUS:NEEDS-ACTION",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "SUMMARY:Alarm headline",
    "DESCRIPTION:Reminder text",
    "TRIGGER:-PT15M",
    "END:VALARM",
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n");

  it("does not return a nested alarm's DESCRIPTION as the task's own", () => {
    // The task has no DESCRIPTION at all, so an unscoped read returns the
    // alarm's reminder text as the task notes.
    expect(readComponentProp(TASK_WITH_ALARM, "VTODO", "DESCRIPTION")).toBe("");
    expect(readComponentProp(TASK_WITH_ALARM, "VALARM", "DESCRIPTION")).toBe("Reminder text");
  });

  it("returns the component's own SUMMARY, not the alarm's", () => {
    expect(readComponentProp(TASK_WITH_ALARM, "VTODO", "SUMMARY")).toBe("Pay the invoice");
    expect(readComponentProp(TASK_WITH_ALARM, "VALARM", "SUMMARY")).toBe("Alarm headline");
  });
});

describe("RFC 5545 line folding", () => {
  const FOLDED = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:evt@test",
    "SUMMARY:This subject is long enough that a server will fold it acro",
    " ss several lines rather than emit one very long line",
    "LOCATION:Room 1",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("joins continuation lines instead of truncating at the fold", () => {
    expect(readComponentProp(FOLDED, "VEVENT", "SUMMARY")).toBe(
      "This subject is long enough that a server will fold it across several lines rather than emit one very long line",
    );
  });

  it("still reads the property after a folded one", () => {
    expect(readComponentProp(FOLDED, "VEVENT", "LOCATION")).toBe("Room 1");
  });

  it("unfold leaves an unfolded object untouched", () => {
    const plain = "BEGIN:VEVENT\r\nSUMMARY:Short\r\nEND:VEVENT";
    expect(unfold(plain)).toBe(plain);
  });
});
