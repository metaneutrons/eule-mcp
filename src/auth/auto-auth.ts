import { TOTP } from "otpauth";
import type { ApiTier, AutoAuthConfig, OAuthConfig, AccountToken } from "../types/index.js";
import { TIER_SCOPES, loadTokens, saveTokens } from "./oauth.js";
import { randomBytes, createHash } from "node:crypto";

const REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";

function authEndpoint(oauth: OAuthConfig): string {
  return `https://login.microsoftonline.com/${oauth.tenant}/oauth2/v2.0/authorize`;
}

function tokenEndpoint(oauth: OAuthConfig): string {
  return `https://login.microsoftonline.com/${oauth.tenant}/oauth2/v2.0/token`;
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function generateTotp(secret: string): string {
  const totp = new TOTP({ secret, digits: 6, period: 30 });
  return totp.generate();
}

/** Extract email from JWT without verification. */
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

/**
 * Automated headless OAuth flow using Playwright + TOTP.
 * Falls back to manual flow on any failure.
 *
 * @returns AccountToken on success, null if automation failed (caller should fall back).
 */
export async function autoAuthenticate(
  tier: ApiTier,
  credentials: AutoAuthConfig,
  oauth: OAuthConfig,
): Promise<AccountToken | null> {
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
    login_hint: credentials.account,
  });

  const authUrl = `${authEndpoint(oauth)}?${params.toString()}`;

  let chromium;
  try {
    // Dynamic import — playwright is a dev/optional dependency.
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    console.log("Playwright not available, falling back to manual auth.");
    return null;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to auth URL.
    await page.goto(authUrl, { waitUntil: "networkidle" });

    // Wait for and fill email (may be pre-filled via login_hint).
    try {
      const emailInput = page.locator('input[type="email"], input[name="loginfmt"]');
      if (await emailInput.isVisible({ timeout: 3000 })) {
        await emailInput.fill(credentials.account);
        await page.locator('input[type="submit"], button[type="submit"]').first().click();
        await page.waitForLoadState("networkidle");
      }
    } catch {
      // Email may have been pre-filled, continue.
    }

    // Fill password.
    try {
      const passwordInput = page.locator('input[type="password"], input[name="passwd"]');
      await passwordInput.waitFor({ state: "visible", timeout: 10000 });
      await passwordInput.fill(credentials.password);
      await page.locator('input[type="submit"], button[type="submit"]').first().click();
      await page.waitForLoadState("networkidle");
    } catch {
      console.log("Auto-auth: password field not found, falling back.");
      return null;
    }

    // Handle TOTP MFA prompt.
    try {
      // Microsoft shows various MFA prompts. Look for TOTP input.
      const totpInput = page.locator('input[name="otc"], input[id="idTxtBx_SAOTCC_OTC"], input[aria-label*="code"], input[placeholder*="code"]');
      if (await totpInput.isVisible({ timeout: 10000 })) {
        const code = generateTotp(credentials.totpSecret);
        await totpInput.fill(code);
        // Click verify/submit.
        await page.locator('input[type="submit"], button[type="submit"], button:has-text("Verify"), button:has-text("Überprüfen")').first().click();
        await page.waitForLoadState("networkidle");
      }
    } catch {
      // MFA might not be TOTP, or different prompt. Fall back.
      console.log("Auto-auth: TOTP input not found or MFA type not supported, falling back.");
      return null;
    }

    // Handle "Stay signed in?" prompt.
    try {
      const staySignedIn = page.locator('input[type="submit"][value="Yes"], button:has-text("Yes"), input[type="submit"][value="Ja"], button:has-text("Ja")');
      if (await staySignedIn.isVisible({ timeout: 3000 })) {
        await staySignedIn.click();
        await page.waitForLoadState("networkidle");
      }
    } catch {
      // No "stay signed in" prompt, continue.
    }

    // Wait for redirect to nativeclient with code.
    await page.waitForURL("**/nativeclient**", { timeout: 15000 });
    const finalUrl = page.url();
    const parsed = new URL(finalUrl);
    const code = parsed.searchParams.get("code");
    const returnedState = parsed.searchParams.get("state");

    if (!code || returnedState !== state) {
      console.log("Auto-auth: no code in redirect URL, falling back.");
      return null;
    }

    // Exchange code for tokens.
    const tokenBody = new URLSearchParams({
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
      body: tokenBody.toString(),
    });

    if (!res.ok) {
      console.log(`Auto-auth: token exchange failed (${String(res.status)}), falling back.`);
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const account = extractEmail(data.access_token) ?? credentials.account;
    const tokenData: AccountToken = {
      account,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      tier,
    };

    const store = loadTokens();
    store.accounts[account] = tokenData;
    saveTokens(store);

    return tokenData;
  } catch (err) {
    console.log(`Auto-auth failed: ${err instanceof Error ? err.message : String(err)}`);
    console.log("Falling back to manual browser auth.");
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
