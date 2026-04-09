import { TOTP } from "otpauth";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";
import type { ApiTier, AutoAuthConfig, OAuthConfig, AccountToken } from "../types/index.js";
import { TIER_SCOPES, loadTokens, saveTokens } from "./oauth.js";
import { randomBytes, createHash } from "node:crypto";

const REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";
const DEBUG_DIR = join(homedir(), ".eule");

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

async function saveDebug(page: { url: () => string; content: () => Promise<string>; screenshot: (opts: { path: string }) => Promise<unknown> }, label: string): Promise<void> {
  try {
    writeFileSync(join(DEBUG_DIR, `auto-auth-debug-${label}.html`), await page.content(), "utf-8");
    await page.screenshot({ path: join(DEBUG_DIR, `auto-auth-debug-${label}.png`) });
    console.log(`  Debug saved: ~/.eule/auto-auth-debug-${label}.{html,png}`);
  } catch {
    // Ignore debug save errors.
  }
}

/**
 * Automated headless OAuth flow using Playwright + TOTP.
 *
 * Flow: email → password → FIDO bypass → MFA picker → TOTP → redirect
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
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    console.log("  Playwright not available, falling back to manual auth.");
    return null;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Step 1: Navigate to auth URL.
    await page.goto(authUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    console.log(`  Step 1 (email): ${page.url()}`);

    // Step 2: Fill email if visible.
    try {
      const emailInput = page.locator('input[type="email"], input[name="loginfmt"], input[name="UserName"], input[id="userNameInput"], input[id="i0116"]').first();
      if (await emailInput.isVisible({ timeout: 3000 })) {
        await emailInput.fill(credentials.account);
        await page.locator('input[type="submit"], button[type="submit"], button[id="idSIButton9"]').first().click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
      }
    } catch {
      // Email pre-filled via login_hint.
    }
    console.log(`  Step 2 (after email): ${page.url()}`);

    // Step 3: Fill password.
    try {
      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.waitFor({ state: "visible", timeout: 10000 });
      await passwordInput.fill(credentials.password);
      await page.locator('input[type="submit"], button[type="submit"], button[id="idSIButton9"]').first().click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(3000);
    } catch (err) {
      console.log(`  Password step failed: ${err instanceof Error ? err.message : String(err)}`);
      await saveDebug(page, "password");
      return null;
    }
    console.log(`  Step 3 (after password): ${page.url()}`);

    // Step 4: Handle FIDO/passkey MFA prompt — click "Auf andere Weise anmelden" / "Sign in another way".
    if (page.url().includes("/fido/")) {
      console.log("  FIDO MFA detected, clicking 'Sign in another way'...");
      try {
        const link = page.locator('a:has-text("andere Weise"), a:has-text("another way")').first();
        await link.waitFor({ state: "visible", timeout: 5000 });
        await link.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
        console.log(`  Step 4 (after FIDO bypass): ${page.url()}`);
      } catch (err) {
        console.log(`  FIDO bypass failed: ${err instanceof Error ? err.message : String(err)}`);
        await saveDebug(page, "fido");
        return null;
      }
    }

    // Step 5: MFA method picker — select "Use a verification code" / "Verwenden eines Prüfcodes".
    try {
      const codeOption = page.getByText("Use a verification code");
      const codeOptionDe = page.getByText("Verwenden eines Prüfcodes");
      if (await codeOption.isVisible({ timeout: 5000 })) {
        console.log("  Selecting 'Use a verification code'...");
        await codeOption.click();
      } else if (await codeOptionDe.isVisible({ timeout: 2000 })) {
        console.log("  Selecting 'Verwenden eines Prüfcodes'...");
        await codeOptionDe.click();
      } else {
        console.log("  No TOTP option found in MFA picker.");
        await saveDebug(page, "picker");
        return null;
      }
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2000);
    } catch (err) {
      console.log(`  MFA picker failed: ${err instanceof Error ? err.message : String(err)}`);
      await saveDebug(page, "picker");
      return null;
    }
    console.log(`  Step 5 (after MFA picker): ${page.url()}`);

    // Step 6: Enter TOTP code.
    try {
      const totpInput = page.locator('input[name="otc"], input[id="idTxtBx_SAOTCC_OTC"], input[aria-label*="code"], input[placeholder*="Code"], input[placeholder*="code"]').first();
      await totpInput.waitFor({ state: "visible", timeout: 10000 });
      const code = generateTotp(credentials.totpSecret);
      console.log("  Entering TOTP code...");
      await totpInput.fill(code);
      await page.locator('input[type="submit"], button[type="submit"], button:has-text("Verify"), button:has-text("Überprüfen")').first().click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2000);
    } catch (err) {
      console.log(`  TOTP step failed: ${err instanceof Error ? err.message : String(err)}`);
      await saveDebug(page, "totp");
      return null;
    }
    console.log(`  Step 6 (after TOTP): ${page.url()}`);

    // Step 7: Handle "Stay signed in?" / "Angemeldet bleiben?" prompt.
    try {
      const btn = page.locator('input[type="submit"], button[id="idSIButton9"], button[id="idBtn_Back"]').first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
      }
    } catch {
      // No prompt.
    }

    // Step 8: Wait for redirect to nativeclient.
    try {
      await page.waitForURL("**/nativeclient**", { timeout: 15000 });
    } catch {
      console.log(`  Timeout waiting for redirect. URL: ${page.url()}`);
      await saveDebug(page, "final");
      return null;
    }

    // Step 9: Extract code and exchange for tokens.
    const finalUrl = page.url();
    const parsed = new URL(finalUrl);
    const code = parsed.searchParams.get("code");
    const returnedState = parsed.searchParams.get("state");

    if (!code || returnedState !== state) {
      console.log("  No code in redirect URL.");
      return null;
    }

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
      console.log(`  Token exchange failed: ${String(res.status)}`);
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
    console.log(`  Auto-auth failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
