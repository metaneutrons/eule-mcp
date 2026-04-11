import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import open from "open";
import type { GoogleOAuthConfig, AccountToken } from "../../types/index.js";
import { loadTokens, saveTokens } from "../m365/auth/oauth.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_PORT = 8739;
const REDIRECT_URI = `http://localhost:${String(REDIRECT_PORT)}`;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/drive",
  "openid",
  "email",
].join(" ");

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function authenticateGoogle(
  cfg: GoogleOAuthConfig,
  accountHint?: string,
): Promise<AccountToken> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });
  if (accountHint) params.set("login_hint", accountHint);

  const authUrl = `${AUTH_URL}?${params.toString()}`;

  return new Promise<AccountToken>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      if (!code || returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>❌ Auth failed</h1>");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>✅ Authenticated! You can close this tab.</h1>");
      server.close();

      exchangeCode(code, verifier, cfg)
        .then((token) => {
          const store = loadTokens();
          store.accounts[token.account] = token;
          saveTokens(store);
          resolve(token);
        })
        .catch(reject);
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`\nOpen this URL to authenticate:\n${authUrl}\n`);
      void open(authUrl);
    });
  });
}

async function exchangeCode(
  code: string,
  verifier: string,
  cfg: GoogleOAuthConfig,
): Promise<AccountToken> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  });

  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    id_token?: string;
  };

  const email = extractEmail(data.id_token) ?? "unknown@gmail.com";
  return {
    account: email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    tier: "google",
    provider: "google",
  };
}

function extractEmail(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString(),
    ) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

export async function refreshGoogleToken(
  account: string,
  cfg: GoogleOAuthConfig,
): Promise<AccountToken | null> {
  const store = loadTokens();
  const token = store.accounts[account];
  if (!token?.refreshToken) return null;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
    }).toString(),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
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

export async function getGoogleAccessToken(
  account: string,
  cfg: GoogleOAuthConfig,
): Promise<string | null> {
  const store = loadTokens();
  const token = store.accounts[account];
  if (!token) return null;
  if (token.expiresAt - Date.now() < 5 * 60 * 1000) {
    const refreshed = await refreshGoogleToken(account, cfg);
    return refreshed?.accessToken ?? null;
  }
  return token.accessToken;
}
