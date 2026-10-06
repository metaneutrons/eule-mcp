//! Microsoft OAuth pieces shared by the sign-in commands: the client
//! parameters, the authorize URL with PKCE, reading the redirect, and redeeming
//! the code into ~/.eule/tokens.json.

use crate::util;
use clap::Args as ClapArgs;
use std::path::PathBuf;

/// Client and token parameters common to every M365 sign-in command.
#[derive(ClapArgs)]
pub struct OAuthArgs {
    /// OAuth public-client application (client) id.
    #[arg(long)]
    pub client_id: String,
    /// API tier this token is for (mail/calendar/contacts all ride EWS).
    #[arg(long, default_value = "ews")]
    pub tier: String,
    /// Azure AD endpoint generation.
    #[arg(long, default_value = "v1", value_parser = ["v1", "v2"])]
    pub api_version: String,
    /// v1 resource (e.g. https://outlook.office.com). Required for v1.
    #[arg(long)]
    pub resource: Option<String>,
    /// v2 space-separated scopes. Required for v2.
    #[arg(long)]
    pub scope: Option<String>,
    /// Tenant (default: common).
    #[arg(long, default_value = "common")]
    pub tenant: String,
    /// Pre-fill this account on the login page.
    #[arg(long)]
    pub login_hint: Option<String>,
    /// tokens.json path (default: ~/.eule/tokens.json).
    #[arg(long)]
    pub tokens_path: Option<PathBuf>,
}

impl OAuthArgs {
    fn v1(&self) -> bool {
        self.api_version == "v1"
    }
}

fn base(tenant: &str, v1: bool, leaf: &str) -> String {
    let seg = if v1 { "oauth2" } else { "oauth2/v2.0" };
    format!("https://login.microsoftonline.com/{tenant}/{seg}/{leaf}")
}

/// Authorize URL for the authorization-code flow with PKCE. `prompt` is passed
/// through as given; without it Microsoft may reuse an existing browser session.
pub fn authorize_url(
    oauth: &OAuthArgs,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
    prompt: Option<&str>,
) -> Result<String, String> {
    let v1 = oauth.v1();
    let mut q: Vec<(&str, &str)> = vec![
        ("client_id", &oauth.client_id),
        ("response_type", "code"),
        ("redirect_uri", redirect_uri),
        ("response_mode", "query"),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
    ];
    if let Some(prompt) = prompt {
        q.push(("prompt", prompt));
    }
    match (v1, oauth.resource.as_deref(), oauth.scope.as_deref()) {
        (true, Some(resource), _) => q.push(("resource", resource)),
        (true, None, _) => return Err("--resource is required for --api-version v1".into()),
        (false, _, Some(scope)) => q.push(("scope", scope)),
        (false, _, None) => return Err("--scope is required for --api-version v2".into()),
    }
    if let Some(hint) = &oauth.login_hint {
        q.push(("login_hint", hint));
    }
    let query: String =
        q.iter().map(|(k, v)| format!("{k}={}", urlencode(v))).collect::<Vec<_>>().join("&");
    Ok(format!("{}?{}", base(&oauth.tenant, v1, "authorize"), query))
}

/// Extract the `code` query parameter from a redirect URL. The `url` crate
/// won't reliably parse `urn:` schemes, so the query is split by hand.
pub fn code_from(url: &str) -> Option<String> {
    query_parameter(url, "code")
}

pub fn query_parameter(url: &str, name: &str) -> Option<String> {
    let q = url.split_once('?')?.1.split('#').next()?;
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix(&format!("{name}=")) {
            return Some(percent_decode(v));
        }
    }
    None
}

pub fn matches_redirect(candidate: &str, expected: &str) -> bool {
    candidate.split(['?', '#']).next() == expected.split(['?', '#']).next()
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

/// Redeem the authorization code and write the token. Returns the account the
/// token belongs to.
pub fn redeem_and_store(
    oauth: &OAuthArgs,
    redirect_uri: &str,
    verifier: &str,
    code: &str,
) -> Result<String, String> {
    let v1 = oauth.v1();
    let token_url = base(&oauth.tenant, v1, "token");
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", &oauth.client_id),
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];
    if v1 {
        form.push(("resource", oauth.resource.as_deref().unwrap_or("")));
    } else {
        form.push(("scope", oauth.scope.as_deref().unwrap_or("")));
    }

    let mut resp = ureq::post(&token_url)
        .send_form(form)
        .map_err(|e| format!("token exchange failed: {e}"))?;
    let text =
        resp.body_mut().read_to_string().map_err(|e| format!("reading token response: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("bad token JSON: {e}"))?;

    let access = json["access_token"].as_str().ok_or("no access_token")?;
    let refresh = json["refresh_token"].as_str().unwrap_or("");
    let expires_in = json["expires_in"].as_i64().unwrap_or(3600);
    let account = util::jwt_email(access).unwrap_or_else(|| "unknown".into());
    let expires_at = now_ms() + expires_in * 1000;

    let tokens_path = oauth.tokens_path.clone().unwrap_or_else(|| util::eule_path("tokens.json"));
    util::merge_token(
        &tokens_path,
        &account,
        access,
        refresh,
        expires_at,
        &oauth.tier,
        &oauth.client_id,
        &oauth.api_version,
    )
    .map_err(|e| format!("writing tokens.json: {e}"))?;
    Ok(account)
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
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
    use super::{OAuthArgs, authorize_url};

    fn oauth(api_version: &str) -> OAuthArgs {
        OAuthArgs {
            client_id: "client".into(),
            tier: "ews".into(),
            api_version: api_version.into(),
            resource: Some("https://outlook.office.com".into()),
            scope: None,
            tenant: "common".into(),
            login_hint: Some("user@example.com".into()),
            tokens_path: None,
        }
    }

    #[test]
    fn builds_the_authorize_url_with_and_without_a_prompt() {
        let with =
            authorize_url(&oauth("v1"), "https://r/x", "ch", "st", Some("select_account")).unwrap();
        assert!(with.starts_with("https://login.microsoftonline.com/common/oauth2/authorize?"));
        assert!(with.contains("prompt=select_account"));
        assert!(with.contains("resource=https%3A%2F%2Foutlook.office.com"));
        assert!(with.contains("login_hint=user%40example.com"));
        assert!(with.contains("state=st") && with.contains("code_challenge=ch"));

        let without = authorize_url(&oauth("v1"), "https://r/x", "ch", "st", None).unwrap();
        assert!(!without.contains("prompt="));
    }

    #[test]
    fn requires_the_parameter_of_the_endpoint_generation() {
        assert!(authorize_url(&oauth("v2"), "https://r/x", "ch", "st", None).is_err());
        let mut v1 = oauth("v1");
        v1.resource = None;
        assert!(authorize_url(&v1, "https://r/x", "ch", "st", None).is_err());
    }
}
