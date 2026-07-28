import { describe, expect, it, vi } from "vitest";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import { DocumentService } from "../src/services/document-service.js";
import type { DocumentConnector } from "../src/types/index.js";

function registryWith(connectors: readonly DocumentConnector[]): ConnectorRegistry {
  return {
    getDocumentConnectors: vi.fn(() => [...connectors]),
  } as unknown as ConnectorRegistry;
}

describe("DocumentService connector semantics", () => {
  it("rejects list and search when no usable connector is configured", async () => {
    const service = new DocumentService(registryWith([]));

    await expect(service.list()).rejects.toThrow(/No usable document connector is configured/);
    await expect(service.search("invoice", "work")).rejects.toThrow(
      /No usable document connector is configured for role "work"/,
    );
  });

  it("preserves an empty successful provider response as a real empty result", async () => {
    const connector = {
      account: "paperless.example.com",
      listDocuments: vi.fn(async () => []),
      searchDocuments: vi.fn(async () => []),
    } as unknown as DocumentConnector;
    const service = new DocumentService(registryWith([connector]));

    await expect(service.list()).resolves.toEqual({ values: [], failures: [] });
    await expect(service.search("invoice")).resolves.toEqual({ values: [], failures: [] });
  });
});
