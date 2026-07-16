//! `oauth-capture` — interactive OAuth in an embedded webview.
//!
//! Loads the Microsoft authorize URL in a real webview, intercepts the
//! non-navigable broker redirect (urn:ietf:wg:oauth:2.0:oob or a custom scheme)
//! in the navigation handler, exchanges the code for tokens on the v1/v2 token
//! endpoint, and merges the result into ~/.eule/tokens.json. Prints only a
//! non-secret status line; the tokens never touch stdout.

use crate::util;
use clap::Args as ClapArgs;
use std::path::PathBuf;
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

/// Event-loop message: the injected page script found the OTP field and wants a
/// fresh TOTP code filled in (kept off the injected JS so the secret stays in
/// this process).
#[derive(Debug, Clone, Copy)]
enum UserEvent {
    FillTotp,
}

#[derive(ClapArgs)]
pub struct Args {
    /// OAuth public-client application (client) id.
    #[arg(long)]
    client_id: String,
    /// API tier this token is for (mail/calendar/contacts all ride EWS).
    #[arg(long, default_value = "ews")]
    tier: String,
    /// Azure AD endpoint generation.
    #[arg(long, default_value = "v1", value_parser = ["v1", "v2"])]
    api_version: String,
    /// v1 resource (e.g. https://outlook.office.com). Required for v1.
    #[arg(long)]
    resource: Option<String>,
    /// v2 space-separated scopes. Required for v2.
    #[arg(long)]
    scope: Option<String>,
    /// Tenant (default: common).
    #[arg(long, default_value = "common")]
    tenant: String,
    /// Pre-fill this account on the login page.
    #[arg(long)]
    login_hint: Option<String>,
    /// Redirect URI to intercept (the app's broker-bound one).
    #[arg(long, default_value = "urn:ietf:wg:oauth:2.0:oob")]
    redirect_uri: String,
    /// tokens.json path (default: ~/.eule/tokens.json).
    #[arg(long)]
    tokens_path: Option<PathBuf>,
    /// Abort after N seconds if the user never finishes.
    #[arg(long, default_value_t = 300)]
    timeout: u64,
}

fn base(tenant: &str, v1: bool, leaf: &str) -> String {
    let seg = if v1 { "oauth2" } else { "oauth2/v2.0" };
    format!("https://login.microsoftonline.com/{tenant}/{seg}/{leaf}")
}

/// Extract the `code` query parameter from an intercepted redirect URL. `url`
/// crate won't reliably parse `urn:` schemes, so split the query by hand.
fn code_from(url: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix("code=") {
            return Some(percent_decode(v));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let h = |c: u8| (c as char).to_digit(16);
                if let (Some(hi), Some(lo)) = (h(bytes[i + 1]), h(bytes[i + 2])) {
                    out.push((hi * 16 + lo) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Redeem the authorization code and write the token. Called on the UI thread
/// from the navigation handler; blocking is fine (the window is closing).
fn redeem_and_store(args: &Args, verifier: &str, code: &str) -> Result<String, String> {
    let v1 = args.api_version == "v1";
    let token_url = base(&args.tenant, v1, "token");
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", &args.client_id),
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", &args.redirect_uri),
        ("code_verifier", verifier),
    ];
    if v1 {
        form.push(("resource", args.resource.as_deref().unwrap_or("")));
    } else {
        form.push(("scope", args.scope.as_deref().unwrap_or("")));
    }

    let mut resp = ureq::post(&token_url)
        .send_form(form)
        .map_err(|e| format!("token exchange failed: {e}"))?;
    let text = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("reading token response: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("bad token JSON: {e}"))?;

    let access = json["access_token"].as_str().ok_or("no access_token")?;
    let refresh = json["refresh_token"].as_str().unwrap_or("");
    let expires_in = json["expires_in"].as_i64().unwrap_or(3600);
    let account = util::jwt_email(access).unwrap_or_else(|| "unknown".into());
    let expires_at = now_ms() + expires_in * 1000;

    let tokens_path = args
        .tokens_path
        .clone()
        .unwrap_or_else(|| util::eule_path("tokens.json"));
    util::merge_token(
        &tokens_path,
        &account,
        access,
        refresh,
        expires_at,
        &args.tier,
        &args.client_id,
        &args.api_version,
    )
    .map_err(|e| format!("writing tokens.json: {e}"))?;
    Ok(account)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 6-digit TOTP (RFC 6238, SHA-1, 30 s window) from a base32 secret at a given
/// unix time. Returns None if the secret isn't valid base32.
fn totp_at(secret_b32: &str, unix_secs: u64) -> Option<String> {
    let norm = secret_b32.trim().replace([' ', '-'], "").to_uppercase();
    let key = base32::decode(base32::Alphabet::Rfc4648 { padding: false }, &norm)?;
    if key.is_empty() {
        return None;
    }
    Some(totp_lite::totp_custom::<totp_lite::Sha1>(
        30, 6, &key, unix_secs,
    ))
}

/// Current TOTP code (see [`totp_at`]).
fn gen_totp(secret_b32: &str) -> Option<String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    totp_at(secret_b32, now)
}

/// Injected at document start ONLY when auto-TOTP is enabled. Pure JS, carries
/// no secret: it walks the Microsoft login UI to the verification-code step and,
/// once the OTP field is present, asks the Rust side for a code over IPC. Mirrors
/// the selectors/labels the Playwright auto-auth path uses.
const AUTO_TOTP_INIT_JS: &str = r#"
(function () {
  var requested = false;
  function vis(e) { return e && e.offsetParent !== null; }
  function byText(re) {
    return [].slice.call(document.querySelectorAll('a,button,div[role=button],span'))
      .find(function (e) { return vis(e) && re.test(e.textContent || ''); });
  }
  function otp() {
    return document.querySelector(
      'input[name="otc"],input[autocomplete="one-time-code"],input[id="idTxtBx_SAOTCC_OTC"],input[aria-label*="ode"],input[placeholder*="ode"]');
  }
  function tick() {
    try {
      if (location.href.indexOf('/fido/') > -1) { var a = byText(/andere Weise|another way/i); if (a) { a.click(); return; } }
      if (!otp()) { var vc = byText(/verification code|Pr(ü|u)fcode/i); if (vc) { vc.click(); return; } }
      if (otp() && !requested) { requested = true; window.ipc.postMessage('eule:need-totp'); setTimeout(function () { requested = false; }, 35000); return; }
      var k = document.querySelector('#idSIButton9');
      if (k && /angemeldet bleiben|stay signed in/i.test(document.body.innerText || '')) { k.click(); }
    } catch (e) {}
  }
  setInterval(tick, 1200);
})();
"#;

/// JS (run via evaluate_script) that types `code` into the OTP field and submits.
fn fill_totp_js(code: &str) -> String {
    format!(
        r#"(function () {{
  var el = document.querySelector('input[name="otc"],input[autocomplete="one-time-code"],input[id="idTxtBx_SAOTCC_OTC"],input[aria-label*="ode"],input[placeholder*="ode"]');
  if (!el) return;
  var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(el, '{code}');
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  var b = document.querySelector('#idSubmit_SAOTCC_Continue,input[type=submit],button[type=submit],#idSIButton9');
  if (b) b.click();
}})();"#
    )
}

pub fn run(args: Args) -> Result<(), String> {
    let v1 = args.api_version == "v1";
    if v1 && args.resource.is_none() {
        return Err("--resource is required for --api-version v1".into());
    }
    if !v1 && args.scope.is_none() {
        return Err("--scope is required for --api-version v2".into());
    }

    let verifier = util::random_b64url(32);
    let challenge = util::pkce_challenge(&verifier);
    let state = util::random_b64url(16);

    let mut q: Vec<(&str, &str)> = vec![
        ("client_id", &args.client_id),
        ("response_type", "code"),
        ("redirect_uri", &args.redirect_uri),
        ("response_mode", "query"),
        ("state", &state),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("prompt", "select_account"),
    ];
    if v1 {
        q.push(("resource", args.resource.as_deref().unwrap()));
    } else {
        q.push(("scope", args.scope.as_deref().unwrap()));
    }
    if let Some(h) = &args.login_hint {
        q.push(("login_hint", h));
    }
    let query: String = q
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let auth_url = format!("{}?{}", base(&args.tenant, v1, "authorize"), query);

    // Hard timeout so a walked-away login can't hang forever.
    let timeout = args.timeout;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(timeout));
        eprintln!("error: timed out after {timeout}s");
        std::process::exit(2);
    });

    // Opt-in TOTP autofill: active only when a secret is supplied (via env, so
    // it never lands in argv/ps). The password stays manual — only the second
    // factor is automated.
    let totp_secret = std::env::var("EULE_TOTP_SECRET")
        .ok()
        .filter(|s| !s.is_empty());

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("eule — sign in")
        .build(&event_loop)
        .map_err(|e| format!("window: {e}"))?;

    let redirect = args.redirect_uri.clone();
    let mut builder = WebViewBuilder::new()
        .with_url(&auth_url)
        .with_navigation_handler(move |uri: String| {
            if uri.starts_with(&redirect) {
                match code_from(&uri) {
                    Some(code) => match redeem_and_store(&args, &verifier, &code) {
                        Ok(account) => {
                            println!("ok account={account}");
                            std::process::exit(0);
                        }
                        Err(e) => {
                            eprintln!("error: {e}");
                            std::process::exit(1);
                        }
                    },
                    None => {
                        eprintln!("error: intercepted redirect without a code: {uri}");
                        std::process::exit(1);
                    }
                }
            }
            true
        });

    if totp_secret.is_some() {
        // The init script drives the MFA UI and pings us; we answer with a fresh
        // code via a user event so evaluate_script runs on the event-loop thread.
        let proxy = event_loop.create_proxy();
        builder = builder
            .with_initialization_script(AUTO_TOTP_INIT_JS)
            .with_ipc_handler(move |req| {
                if req.into_body() == "eule:need-totp" {
                    let _ = proxy.send_event(UserEvent::FillTotp);
                }
            });
    }

    let webview = builder
        .build(&window)
        .map_err(|e| format!("webview: {e}"))?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::FillTotp) => {
                if let Some(secret) = totp_secret.as_deref() {
                    match gen_totp(secret) {
                        Some(code) => {
                            let _ = webview.evaluate_script(&fill_totp_js(&code));
                        }
                        None => eprintln!(
                            "warning: EULE_TOTP_SECRET is not valid base32 — TOTP autofill skipped"
                        ),
                    }
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                eprintln!("error: window closed before sign-in completed");
                std::process::exit(3);
            }
            _ => {}
        }
    });
}

/// Minimal application/x-www-form-urlencoded encoder for query values.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::totp_at;

    // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890" (base32 below),
    // truncated to 6 digits (the reference table lists the 8-digit values).
    const SEED_B32: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn rfc6238_vectors() {
        assert_eq!(totp_at(SEED_B32, 59).as_deref(), Some("287082"));
        assert_eq!(totp_at(SEED_B32, 1111111109).as_deref(), Some("081804"));
        assert_eq!(totp_at(SEED_B32, 1234567890).as_deref(), Some("005924"));
        assert_eq!(totp_at(SEED_B32, 2000000000).as_deref(), Some("279037"));
    }

    #[test]
    fn tolerates_spacing_and_case() {
        // Same secret, lower-case with spaces/dashes — normalization must match.
        let spaced = "gezd gnbv-gy3t qojq gezd gnbv-gy3t qojq";
        assert_eq!(totp_at(spaced, 59), totp_at(SEED_B32, 59));
    }

    #[test]
    fn rejects_non_base32() {
        assert_eq!(totp_at("not!base32!", 59), None);
        assert_eq!(totp_at("", 59), None);
    }
}
