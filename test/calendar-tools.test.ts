import { describe, expect, it } from "vitest";
import { calendarDateTimeSchema } from "../src/tools/calendar-tools.js";

describe("calendar date-time input", () => {
  it.each([
    "2026-09-08T10:00Z",
    "2026-09-08T10:00+02:00",
    "2026-09-08T10:00:00Z",
    "2026-09-08T10:00:00.123Z",
    "2026-09-08T10:00",
  ])("accepts supported ISO 8601 precision in %s", (value) => {
    expect(calendarDateTimeSchema.safeParse(value).success).toBe(true);
  });

  it.each(["2026-09-08", "2026-09-08 10:00Z", "not-a-date"])(
    "rejects invalid date-time input %s",
    (value) => {
      expect(calendarDateTimeSchema.safeParse(value).success).toBe(false);
    },
  );
});
