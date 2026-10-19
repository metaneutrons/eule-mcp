import { describe, expect, it } from "vitest";
import { localParts, renderEvent } from "../src/tools/calendar-tools.js";
import type { CalendarEvent } from "../src/types/index.js";

const BERLIN = "Europe/Berlin";

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "AAMk-1",
    account: "user@example.com",
    subject: "JF eAkte",
    start: "2026-11-02T14:00:00Z",
    end: "2026-11-02T14:30:00Z",
    isAllDay: false,
    attendees: [],
    ...overrides,
  };
}

describe("localParts", () => {
  it("converts UTC to local wall-clock time across daylight saving", () => {
    expect(localParts("2026-10-21T07:00:00Z", BERLIN)).toEqual({
      date: "2026-10-21",
      time: "09:00",
    });
    expect(localParts("2026-11-04T08:00:00Z", BERLIN)).toEqual({
      date: "2026-11-04",
      time: "09:00",
    });
  });

  it("respects an explicit offset and leaves zone-less strings alone", () => {
    expect(localParts("2026-10-26T15:00:00+01:00", BERLIN).time).toBe("15:00");
    expect(localParts("2026-10-26T15:00:00", BERLIN)).toEqual({
      date: "2026-10-26",
      time: "15:00",
    });
  });

  it("moves a late-evening UTC time onto the next local day", () => {
    expect(localParts("2026-10-11T22:00:00Z", BERLIN).date).toBe("2026-10-12");
  });
});

describe("renderEvent", () => {
  it("prints local times and the event id", () => {
    expect(renderEvent(event({ location: "Teams" }), BERLIN)).toBe(
      "2026-11-02 15:00–15:30 | JF eAkte 📍 Teams\n  ID: AAMk-1",
    );
  });

  it("names the end date when an event crosses midnight", () => {
    expect(
      renderEvent(event({ start: "2026-11-06T16:30:00Z", end: "2026-11-06T23:30:00Z" }), BERLIN),
    ).toBe("2026-11-06 17:30–2026-11-07 00:30 | JF eAkte\n  ID: AAMk-1");
  });

  it("shows all-day events on their local date", () => {
    expect(
      renderEvent(event({ isAllDay: true, start: "2026-10-11T22:00:00Z", id: "" }), BERLIN),
    ).toBe("2026-10-12 (all day) | JF eAkte");
  });
});
