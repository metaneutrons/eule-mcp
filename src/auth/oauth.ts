import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import open from "open";
import type { ApiTier, AutoAuthConfig, OAuthConfig, TokenStore, AccountToken } from "../types/index.js";

const TOKENS_PATH = join(homedir(), ".eule", "tokens.json");

/** Default OAuth config — Thunderbird's registered app ID. */
const DEFAULT_OAUTH: OAuthConfig = {
  clientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
  tenant: "common",
};

/**
 * Redirect URI registered on Thunderbird's app.
 * Microsoft will redirect to this URL with ?code=... in the query string.
 * We use a local HTTP server that intercepts requests to ANY path and
 * extracts the code, then we exchange it using this exact redirect_uri.
 */
const REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";

function authEndpoint(oauth: OAuthConfig): string {
  return `https://login.microsoftonline.com/${oauth.tenant}/oauth2/v2.0/authorize`;
}

function tokenEndpoint(oauth: OAuthConfig): string {
  return `https://login.microsoftonline.com/${oauth.tenant}/oauth2/v2.0/token`;
}

/** Scope sets per API tier. */
export const TIER_SCOPES: Record<ApiTier, string> = {
  graph:
    "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Contacts.Read offline_access",
  ews: "https://outlook.office.com/EWS.AccessAsUser.All offline_access",
  imap: "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access",
};

/** Thrown when CA policy requires interactive re-authentication (e.g. sign-in frequency). */
export class InteractionRequiredError extends Error {
  constructor(public readonly account: string) {
    super(
      `Re-authentication required for ${account}. Your tenant's Conditional Access policy requires a fresh login. Run auth_login to re-authenticate.`,
    );
    this.name = "InteractionRequiredError";
  }
}

/** Generate PKCE code verifier + challenge. */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Load token store from disk. */
export function loadTokens(): TokenStore {
  if (!existsSync(TOKENS_PATH)) return { accounts: {} };
  const raw = readFileSync(TOKENS_PATH, "utf-8");
  return JSON.parse(raw) as TokenStore;
}

/** Save token store to disk. */
export function saveTokens(store: TokenStore): void {
  writeFileSync(TOKENS_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Refresh an expired access token using the refresh token. */
export async function refreshAccessToken(
  account: string,
  oauth: OAuthConfig = DEFAULT_OAUTH,
): Promise<AccountToken | null> {
  const store = loadTokens();
  const token = store.accounts[account];
  if (!token?.refreshToken) return null;

  const body = new URLSearchParams({
    client_id: oauth.clientId,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    scope: TIER_SCOPES[token.tier],
  });

  const res = await fetch(tokenEndpoint(oauth), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errBody = await res.text();
    // Detect CA sign-in frequency or MFA re-prompt.
    if (errBody.includes("interaction_required") || errBody.includes("AADSTS50076") || errBody.includes("AADSTS50078")) {
      throw new InteractionRequiredError(account);
    }
    return null;
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const updated: AccountToken = {
    ...token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? token.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  store.accounts[account] = updated;
  saveTokens(store);
  return updated;
}

/** Get a valid access token for an account, refreshing if needed. */
export async function getAccessToken(
  account: string,
  oauth: OAuthConfig = DEFAULT_OAUTH,
): Promise<string | null> {
  const store = loadTokens();
  const token = store.accounts[account];
  if (!token) return null;

  if (token.expiresAt - Date.now() < 5 * 60 * 1000) {
    const refreshed = await refreshAccessToken(account, oauth);
    return refreshed?.accessToken ?? null;
  }

  return token.accessToken;
}

/**
 * Exchange an authorization code for tokens.
 */
async function exchangeCode(
  code: string,
  verifier: string,
  scope: string,
  oauth: OAuthConfig,
): Promise<AccountToken> {
  const body = new URLSearchParams({
    client_id: oauth.clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    scope,
  });

  const res = await fetch(tokenEndpoint(oauth), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token exchange failed: ${errText}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const account = extractEmail(data.access_token) ?? "unknown";
  return {
    account,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    tier: "graph", // Will be set by caller
  };
}

/**
 * Run the interactive browser-based OAuth2 authorization code flow with PKCE.
 *
 * Uses the nativeclient redirect URI registered on Thunderbird's app.
 * After login, Microsoft redirects to the nativeclient URL with ?code=...
 * We start a local server that shows a page asking the user to paste the
 * full redirect URL, OR we try to intercept it automatically.
 */
export async function authenticateAccount(
  tier: ApiTier,
  accountHint?: string,
  oauth: OAuthConfig = DEFAULT_OAUTH,
  autoAuthCredentials?: AutoAuthConfig,
): Promise<AccountToken> {
  // Try headless auto-auth if TOTP credentials are configured.
  if (autoAuthCredentials) {
    try {
      const { autoAuthenticate } = await import("./auto-auth.js");
      const result = await autoAuthenticate(tier, autoAuthCredentials, oauth);
      if (result) {
        console.log(`✅ Auto-authenticated: ${result.account} (headless)`);
        return result;
      }
    } catch (err) {
      console.log(`Auto-auth unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("Falling back to manual browser auth...\n");
  }

  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const scope = TIER_SCOPES[tier];

  const params = new URLSearchParams({
    client_id: oauth.clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    response_mode: "query",
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });

  if (accountHint) {
    params.set("login_hint", accountHint);
  }

  const authUrl = `${authEndpoint(oauth)}?${params.toString()}`;

  return new Promise<AccountToken>((resolve, reject) => {
    // Start a local server that serves a page to capture the redirect URL.
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      // Check if this is a POST with the pasted URL.
      if (req.method === "POST" && url.pathname === "/submit") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const formData = new URLSearchParams(body);
          const pastedUrl = formData.get("url") ?? "";

          let code: string | null = null;
          try {
            const parsed = new URL(pastedUrl);
            code = parsed.searchParams.get("code");
            const returnedState = parsed.searchParams.get("state");
            if (returnedState !== state) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end("<h1>❌ State mismatch</h1><p>Try again.</p>");
              return;
            }
          } catch {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h1>❌ Invalid URL</h1><p>Paste the full URL from the browser address bar.</p>");
            return;
          }

          if (!code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h1>❌ No code found</h1><p>Paste the full URL including ?code=...</p>");
            return;
          }

          void (async () => {
            try {
              const tokenData = await exchangeCode(code, verifier, scope, oauth);
              const result: AccountToken = { ...tokenData, tier };

              const store = loadTokens();
              store.accounts[result.account] = result;
              saveTokens(store);

              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(
                `<h1>✅ Authenticated!</h1><p>Account: ${result.account}</p><p>Tier: ${tier}</p><p>You can close this window.</p>`,
              );
              server.close();
              resolve(result);
            } catch (err) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(`<h1>❌ Error</h1><pre>${err instanceof Error ? err.message : String(err)}</pre>`);
              server.close();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })();
        });
        return;
      }

      // Serve the capture page.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html><head><title>Eule MCP — OAuth Callback</title>
<style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px}
input[type=text]{width:100%;padding:8px;font-size:14px;margin:8px 0}
button{padding:10px 20px;font-size:16px;cursor:pointer;background:#0078d4;color:white;border:none;border-radius:4px}</style>
</head><body>
<h1>🦉 Eule MCP — Authentication</h1>
<p>After logging in, Microsoft will redirect you to a blank page or an error page. This is expected.</p>
<p><strong>Copy the full URL from your browser's address bar</strong> and paste it below:</p>
<form method="POST" action="/submit">
<input type="text" name="url" placeholder="https://login.microsoftonline.com/common/oauth2/nativeclient?code=..." autofocus>
<br><button type="submit">Submit</button>
</form>
<p><small>The URL should start with <code>https://login.microsoftonline.com/common/oauth2/nativeclient?code=</code></small></p>
</body></html>`);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      console.log(`\nOpening browser for authentication...`);
      console.log(`After login, paste the redirect URL at: http://localhost:${String(port)}\n`);
      console.log(`If the browser doesn't open, visit:\n${authUrl}\n`);
      void open(authUrl);

      // Also open the capture page.
      setTimeout(() => {
        void open(`http://localhost:${String(port)}`);
      }, 1000);
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Authentication timed out (5 minutes)"));
    }, 5 * 60 * 1000);
  });
}

/** Extract email (upn) from a JWT access token without verification. */
function extractEmail(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
    return (decoded["upn"] ?? decoded["preferred_username"] ?? decoded["email"] ?? null) as
      | string
      | null;
  } catch {
    return null;
  }
}
