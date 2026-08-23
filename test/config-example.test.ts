import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// js-yaml v5 is ESM-only and exposes named module exports.
import * as yaml from "js-yaml";
import { parseAppConfig, CONNECTOR_KINDS } from "../src/config/schema.js";

/**
 * config.example.yaml is what users copy, so a stale example is a real bug.
 * Validating it against the live schema catches drift such as a connector
 * domain that exists in the example but not in CONNECTOR_KINDS.
 */
describe("config.example.yaml", () => {
  const raw = yaml.load(readFileSync("config.example.yaml", "utf-8"));

  it("validates against the application config schema", () => {
    expect(() => parseAppConfig(raw)).not.toThrow();
  });

  it("does not demonstrate a connector domain a role policy then forbids", () => {
    const config = parseAppConfig(raw);
    for (const role of config.roles) {
      const allowed = role.policy?.allowedConnectorKinds;
      if (!allowed) continue;
      for (const kind of CONNECTOR_KINDS) {
        const configured = role.connectors[kind] ?? [];
        if (configured.length > 0) expect(allowed).toContain(kind);
      }
    }
  });
});
