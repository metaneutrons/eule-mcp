import { describe, expect, it } from "vitest";
import { renderUpdateOutcomes } from "../src/tools/mail-tools.js";
import type { MailUpdateOutcome } from "../src/services/mail-service.js";

function outcome(n: number, from: string, subject = `Subject ${String(n)}`): MailUpdateOutcome {
  return { id: `id-${String(n)}`, subject, from, actions: ["deleted"] };
}

describe("renderUpdateOutcomes", () => {
  it("lists every message with subject and sender for a small batch", () => {
    const text = renderUpdateOutcomes([outcome(1, "a@example.com"), outcome(2, "b@example.com")]);
    expect(text).toContain("2 message(s): deleted");
    expect(text).toContain("Subject 1 — a@example.com");
    expect(text).toContain("Subject 2 — b@example.com");
    expect(text).toContain("id: id-1");
  });

  it("groups by sender once the batch is large, so a wrong sender stands out", () => {
    const many = [
      ...Array.from({ length: 25 }, (_, i) => outcome(i, "notification@codacy.com", "has results")),
      ...Array.from({ length: 10 }, (_, i) => outcome(100 + i, "team@example.com")),
    ];
    const text = renderUpdateOutcomes(many);
    expect(text).toContain("35 message(s): deleted");
    expect(text).toContain('25× notification@codacy.com — e.g. "has results"');
    expect(text).toContain("10× team@example.com");
    // Even grouped output must still carry the exact ids for targeted undo.
    expect(text).toContain("ids: ");
    expect(text).toContain("id-0");
  });

  it("orders sender groups by size", () => {
    const many = [
      ...Array.from({ length: 5 }, (_, i) => outcome(i, "few@example.com")),
      ...Array.from({ length: 40 }, (_, i) => outcome(100 + i, "many@example.com")),
    ];
    const text = renderUpdateOutcomes(many);
    expect(text.indexOf("many@example.com")).toBeLessThan(text.indexOf("few@example.com"));
  });

  it("names failures separately from successes", () => {
    const text = renderUpdateOutcomes([
      outcome(1, "a@example.com"),
      { id: "id-2", actions: [], error: "not found" },
    ]);
    expect(text).toContain("1 message(s): deleted");
    expect(text).toContain("❌ 1 failed:");
    expect(text).toContain("id-2: not found");
  });

  it("says so when metadata could not be resolved instead of implying success blindly", () => {
    const text = renderUpdateOutcomes([{ id: "id-9", actions: ["deleted"] }]);
    expect(text).toContain("(subject unavailable)");
    expect(text).toContain("(sender unavailable)");
  });
});
