import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import open from "open";
import type { ApiTier, TokenStore, AccountToken } from "../types/index.js";

const TOKENS_PATH = join(homedir(), ".eule", "tokens.json");

// Thunderbird's registered app ID — consented in most M365 tenants.
const CLIENT_ID = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";
const TENANT = "common";
const AUTH_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

/** Scope sets per API tier. */
export const TIER_SCOPES: Record<ApiTier, string> = {
  graph: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Contacts.Read offline_access",
  ews: "https://outlook.office.com/EWS.AccessAsUser.All offline_access",
  imap: "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access",
};

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
export async function refreshAccessToken(account: string): Promise<AccountToken | null> {
  const store = loadTokens();
  const token = store.accounts[account];
  if (!token?.refreshToken) return null;

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    scope: TIER_SCOPES[token.tier],
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) return null;

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
export async function getAccessToken(account: string): Promise<string | null> {
  const store = loadTokens();
  const token = store.accounts[account];
  if (!token) return null;

  // Refresh if expiring within 5 minutes.
  if (token.expiresAt - Date.now() < 5 * 60 * 1000) {
    const refreshed = await refreshAccessToken(account);
    return refreshed?.accessToken ?? null;
  }

  return token.accessToken;
}

/**
 * Run the interactive browser-based OAuth2 authorization code flow with PKCE.
 * Starts a local HTTP server, opens the browser, waits for the redirect.
 */
export async function authenticateAccount(
  tier: ApiTier,
  accountHint?: string,
): Promise<AccountToken> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const scope = TIER_SCOPES[tier];

  return new Promise<AccountToken>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDesc = url.searchParams.get("error_description");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<h1>Authentication failed</h1><p>${errorDesc ?? error}</p><p>You can close this window.</p>`);
        server.close();
        reject(new Error(`OAuth error: ${errorDesc ?? error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Invalid callback</h1><p>Missing code or state mismatch.</p>");
        server.close();
        reject(new Error("Invalid OAuth callback"));
        return;
      }

      // Exchange code for tokens.
      const tokenBody = new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: `http://localhost:${String(port)}/callback`,
        code_verifier: verifier,
        scope,
      });

      void (async () => {
        try {
          const tokenRes = await fetch(TOKEN_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenBody.toString(),
          });

          if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<h1>Token exchange failed</h1><pre>${errText}</pre><p>You can close this window.</p>`);
            server.close();
            reject(new Error(`Token exchange failed: ${errText}`));
            return;
          }

          const data = (await tokenRes.json()) as {
            access_token: string;
            refresh_token: string;
            expires_in: number;
            id_token?: string;
          };

          // Extract account email from the access token (JWT payload).
          const account = extractEmail(data.access_token) ?? accountHint ?? "unknown";

          const tokenData: AccountToken = {
            account,
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: Date.now() + data.expires_in * 1000,
            tier,
          };

          // Persist.
          const store = loadTokens();
          store.accounts[account] = tokenData;
          saveTokens(store);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<h1>✅ Authenticated!</h1><p>Account: ${account}</p><p>Tier: ${tier}</p><p>You can close this window.</p>`);
          server.close();
          resolve(tokenData);
        } catch (err) {
          server.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });

    // Listen on random port.
    let port = 0;
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        port = addr.port;
      }

      const redirectUri = `http://localhost:${String(port)}/callback`;
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri,
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

      const authUrl = `${AUTH_ENDPOINT}?${params.toString()}`;
      console.log(`\nOpening browser for authentication...`);
      console.log(`If the browser doesn't open, visit:\n${authUrl}\n`);
      void open(authUrl);
    });

    // Timeout after 5 minutes.
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
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    return (decoded["upn"] ?? decoded["preferred_username"] ?? decoded["email"] ?? null) as string | null;
  } catch {
    return null;
  }
}
