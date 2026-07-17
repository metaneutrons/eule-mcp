import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

// In-memory fs so loadTokens/saveTokens operate on a virtual token store.
let files: Record<string, string> = {};
vi.mock("node:fs", () => ({
  existsSync: (p: string) => p in files,
  readFileSync: (p: string) => files[p],
  writeFileSync: (p: string, data: string) => {
    files[p] = data;
  },
  chmodSync: () => {},
  renameSync: (from: string, to: string) => {
    files[to] = files[from] ?? "";
    delete files[from];
  },
  rmSync: (p: string) => {
    delete files[p];
  },
}));

const TOKENS_PATH = join(homedir(), ".eule", "tokens.json");

import {
  authEndpoint,
  tokenEndpoint,
  tierAuthParam,
  parseTokenResponse,
  refreshAccessToken,
  authenticateAccountDeviceCode,
  loadTokens,
  InteractionRequiredError,
} from "../src/providers/m365/auth/oauth.js";
import { EwsCalendarConnector } from "../src/providers/m365/ews-calendar.js";
import { EwsContactConnector } from "../src/providers/m365/ews-contacts.js";

/** A minimal unsigned JWT whose payload carries a upn, for extractEmail(). */
function fakeJwt(upn: string): string {
  const payload = Buffer.from(JSON.stringify({ upn })).toString("base64url");
  return `x.${payload}.y`;
}

const V1 = { clientId: "cid", tenant: "common", apiVersion: "v1" as const };
const V2 = { clientId: "cid", tenant: "common", apiVersion: "v2" as const };

describe("endpoint builders", () => {
  it("v1 uses the legacy /oauth2 endpoints", () => {
    expect(authEndpoint(V1)).toBe("https://login.microsoftonline.com/common/oauth2/authorize");
    expect(tokenEndpoint(V1)).toBe("https://login.microsoftonline.com/common/oauth2/token");
  });
  it("v2 (and default) uses the /oauth2/v2.0 endpoints", () => {
    expect(authEndpoint(V2)).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(tokenEndpoint({ clientId: "c", tenant: "common" })).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
  });
});

describe("tierAuthParam", () => {
  it("v1 identifies the API by resource=", () => {
    expect(tierAuthParam(V1, "ews")).toEqual({ resource: "https://outlook.office.com" });
    expect(tierAuthParam(V1, "graph")).toEqual({ resource: "https://graph.microsoft.com" });
  });
  it("v2 identifies the API by scope=", () => {
    expect(tierAuthParam(V2, "ews")).toHaveProperty("scope");
    expect(tierAuthParam(V2, "ews").scope).toContain("EWS.AccessAsUser.All");
    expect(tierAuthParam(V2, "ews")).not.toHaveProperty("resource");
  });
});

describe("parseTokenResponse", () => {
  it("accepts a well-formed response", () => {
    const r = parseTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    expect(r).toEqual({ access_token: "a", refresh_token: "r", expires_in: 3600 });
  });
  it("throws when access_token is missing", () => {
    expect(() => parseTokenResponse({ expires_in: 3600 })).toThrow();
    expect(() => parseTokenResponse(null)).toThrow();
  });
  it("defaults a missing/NaN expires_in to 3600 (never NaN)", () => {
    expect(parseTokenResponse({ access_token: "a" }).expires_in).toBe(3600);
    expect(parseTokenResponse({ access_token: "a", expires_in: "x" }).expires_in).toBe(3600);
  });
});

describe("refreshAccessToken", () => {
  beforeEach(() => {
    files = {};
    vi.restoreAllMocks();
  });

  function seed(store: object) {
    files[TOKENS_PATH] = JSON.stringify(store);
  }

  it("reuses the token's own clientId + apiVersion (not the global config)", async () => {
    seed({
      accounts: {
        "u@hs.de": {
          account: "u@hs.de",
          accessToken: "old",
          refreshToken: "rt0",
          expiresAt: 0,
          tier: "ews",
          clientId: "apple-id",
          apiVersion: "v1",
        },
      },
    });
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: "new", refresh_token: "rt1", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Global config says v2/other-id — the token's own v1/apple-id must win.
    const res = await refreshAccessToken("u@hs.de", V2);
    expect(res?.accessToken).toBe("new");

    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/token"); // v1
    const body = new URLSearchParams(opts.body);
    expect(body.get("client_id")).toBe("apple-id");
    expect(body.get("resource")).toBe("https://outlook.office.com"); // v1 resource=
    expect(body.get("scope")).toBeNull();
  });

  it("persists the rotated refresh token and preserves sibling accounts", async () => {
    seed({
      accounts: {
        "a@x.de": { account: "a@x.de", accessToken: "a0", refreshToken: "art", expiresAt: 0, tier: "ews", clientId: "id", apiVersion: "v1" },
        "b@x.de": { account: "b@x.de", accessToken: "b0", refreshToken: "brt", expiresAt: 0, tier: "google" },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "a1", refresh_token: "art2", expires_in: 3600 })),
    );
    await refreshAccessToken("a@x.de", V1);
    const store = loadTokens();
    expect(store.accounts["a@x.de"].refreshToken).toBe("art2"); // rotated + saved
    expect(store.accounts["b@x.de"].refreshToken).toBe("brt"); // sibling intact
  });

  it("maps a dead refresh token to InteractionRequiredError, not a silent null", async () => {
    seed({
      accounts: {
        "u@x.de": { account: "u@x.de", accessToken: "o", refreshToken: "rt", expiresAt: 0, tier: "ews", clientId: "id", apiVersion: "v1" },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "AADSTS700082 expired" }), { status: 400 }),
      ),
    );
    await expect(refreshAccessToken("u@x.de", V1)).rejects.toBeInstanceOf(InteractionRequiredError);
  });

  it("returns null for an unclassified transient error", async () => {
    seed({
      accounts: {
        "u@x.de": { account: "u@x.de", accessToken: "o", refreshToken: "rt", expiresAt: 0, tier: "ews", clientId: "id", apiVersion: "v1" },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 })),
    );
    expect(await refreshAccessToken("u@x.de", V1)).toBeNull();
  });
});

describe("authenticateAccountDeviceCode", () => {
  beforeEach(() => {
    files = {};
    vi.restoreAllMocks();
  });

  function deviceCodeFetch(pollResponses: Response[]) {
    // call 0 = /devicecode init; subsequent calls = /token polls.
    let call = 0;
    return vi.fn(async (url: string) => {
      if (String(url).includes("/devicecode")) {
        call = 0;
        return Response.json({
          device_code: "DEV",
          user_code: "ABC-123",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 900,
          interval: 0.01, // 10ms — keep the poll loop fast in tests
        });
      }
      return pollResponses[call++] ?? pollResponses[pollResponses.length - 1];
    });
  }

  it("v1: init uses resource=, poll uses grant_type=device_code + code= + resource=", async () => {
    const fetchMock = deviceCodeFetch([
      Response.json({ access_token: fakeJwt("u@hs.de"), refresh_token: "rt", expires_in: 3600 }),
    ]);
    vi.stubGlobal("fetch", fetchMock);

    let prompted = "";
    const token = await authenticateAccountDeviceCode(
      "ews",
      { clientId: "apple", tenant: "common", apiVersion: "v1" },
      (p) => (prompted = p.verificationUrl),
    );
    expect(prompted).toBe("https://microsoft.com/devicelogin");
    expect(token.account).toBe("u@hs.de");
    expect(token.tier).toBe("ews");
    expect(token.clientId).toBe("apple");
    expect(token.apiVersion).toBe("v1");
    expect(loadTokens().accounts["u@hs.de"].refreshToken).toBe("rt"); // merged + saved

    const initBody = new URLSearchParams((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(initBody.get("resource")).toBe("https://outlook.office.com");
    expect(initBody.get("scope")).toBeNull();
    const pollBody = new URLSearchParams((fetchMock.mock.calls[1] as [string, { body: string }])[1].body);
    expect(pollBody.get("grant_type")).toBe("device_code");
    expect(pollBody.get("code")).toBe("DEV");
    expect(pollBody.get("resource")).toBe("https://outlook.office.com");
  });

  it("v2: init uses scope=, poll uses the urn grant_type + device_code=", async () => {
    const fetchMock = deviceCodeFetch([
      Response.json({ access_token: fakeJwt("u@x.de"), refresh_token: "rt", expires_in: 3600 }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    await authenticateAccountDeviceCode("ews", { clientId: "c", tenant: "common", apiVersion: "v2" });
    const initBody = new URLSearchParams((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(initBody.get("scope")).toContain("EWS.AccessAsUser.All");
    const pollBody = new URLSearchParams((fetchMock.mock.calls[1] as [string, { body: string }])[1].body);
    expect(pollBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(pollBody.get("device_code")).toBe("DEV");
    expect(pollBody.get("resource")).toBeNull();
  });

  it("keeps polling through authorization_pending, then succeeds", async () => {
    const fetchMock = deviceCodeFetch([
      new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
      Response.json({ access_token: fakeJwt("u@x.de"), refresh_token: "rt", expires_in: 3600 }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const token = await authenticateAccountDeviceCode("ews", { clientId: "c", tenant: "common", apiVersion: "v1" });
    expect(token.account).toBe("u@x.de");
    expect(fetchMock.mock.calls.length).toBe(3); // init + pending + success
  });

  it("throws on a hard failure (CA block / declined)", async () => {
    const fetchMock = deviceCodeFetch([
      new Response(JSON.stringify({ error: "access_denied", error_description: "blocked" }), { status: 400 }),
    ]);
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      authenticateAccountDeviceCode("ews", { clientId: "c", tenant: "common", apiVersion: "v1" }),
    ).rejects.toThrow(/access_denied/);
  });
});

describe("EWS shared-mailbox folderId", () => {
  const getToken = async () => "tok";
  let lastBody = "";
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts: { body: string }) => {
        lastBody = opts.body;
        return new Response("<r/>", { status: 200 });
      }),
    );
  });

  it("calendar shared=true emits the Mailbox EmailAddress for the target mailbox", async () => {
    const c = new EwsCalendarConnector("vp@x.de", getToken, true);
    await c.listEvents(new Date(0).toISOString(), new Date(1).toISOString());
    expect(lastBody).toContain("<t:Mailbox><t:EmailAddress>vp@x.de</t:EmailAddress></t:Mailbox>");
  });

  it("calendar shared=false emits a bare DistinguishedFolderId (no Mailbox)", async () => {
    const c = new EwsCalendarConnector("me@x.de", getToken, false);
    await c.listEvents(new Date(0).toISOString(), new Date(1).toISOString());
    expect(lastBody).toContain('<t:DistinguishedFolderId Id="calendar"/>');
    expect(lastBody).not.toContain("<t:Mailbox>");
  });

  it("contacts shared=true targets the shared mailbox", async () => {
    const c = new EwsContactConnector("vp@x.de", getToken, true);
    await c.listContacts(1);
    expect(lastBody).toContain("<t:Mailbox><t:EmailAddress>vp@x.de</t:EmailAddress></t:Mailbox>");
  });
});
