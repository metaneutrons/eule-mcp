import { describe, expect, it } from "vitest";
import { collectProviderResults, selectConnector } from "../src/services/provider-orchestration.js";

describe("provider orchestration", () => {
  it("returns successful values and explicit per-account failures", async () => {
    const result = await collectProviderResults(
      [{ account: "ok" }, { account: "down" }],
      async (connector) => {
        if (connector.account === "down") throw new Error("timeout");
        return [1, 2];
      },
    );
    expect(result.values).toEqual([1, 2]);
    expect(result.failures).toEqual([{ account: "down", message: "timeout" }]);
  });

  it("selects only the requested capable account", () => {
    const connectors = [
      { account: "a", writable: false },
      { account: "b", writable: true },
    ];
    expect(selectConnector(connectors, undefined, (item) => item.writable)?.account).toBe("b");
    expect(selectConnector(connectors, "a", (item) => item.writable)).toBeUndefined();
  });

  it("bounds provider concurrency", async () => {
    let active = 0;
    let peak = 0;
    await collectProviderResults(
      Array.from({ length: 8 }, (_, index) => ({ account: String(index) })),
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return [];
      },
      2,
    );
    expect(peak).toBe(2);
  });
});
