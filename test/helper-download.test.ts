import { describe, it, expect } from "vitest";
import { assetName } from "../src/helper/download.js";

describe("assetName", () => {
  it("maps every supported platform/arch to its release asset", () => {
    expect(assetName("darwin", "arm64")).toBe("eule-helper-darwin-universal");
    expect(assetName("darwin", "x64")).toBe("eule-helper-darwin-universal");
    expect(assetName("linux", "x64")).toBe("eule-helper-linux-x64");
    expect(assetName("linux", "arm64")).toBe("eule-helper-linux-arm64");
    expect(assetName("win32", "x64")).toBe("eule-helper-win32-x64.exe");
    expect(assetName("win32", "arm64")).toBe("eule-helper-win32-arm64.exe");
  });

  it("throws for an unsupported platform/arch", () => {
    expect(() => assetName("linux", "ia32")).toThrow();
    expect(() => assetName("aix", "ppc64")).toThrow();
  });
});
