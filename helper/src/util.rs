//! Shared helpers: PKCE, base64url, secure file writes, token-store merge.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use std::io;
use std::path::Path;

/// Random bytes → base64url (no padding), for PKCE verifier / state.
pub fn random_b64url(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS RNG");
    URL_SAFE_NO_PAD.encode(&buf)
}

/// PKCE S256 challenge for a given verifier.
pub fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(h.finalize())
}

/// Decode the `upn`/`preferred_username`/`email` claim from a JWT without
/// verifying the signature (we only need the account label; the token itself is
/// what's authoritative and is validated by the resource server on use).
pub fn jwt_email(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    for k in ["upn", "preferred_username", "email"] {
        if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

/// Write a file owner-only (0600 on Unix). On Windows the default ACL already
/// restricts to the user profile.
pub fn write_secure(path: &Path, contents: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Merge a single M365 account into ~/.eule/tokens.json, preserving every other
/// account (mirrors the Node loadTokens/saveTokens read-modify-write). Returns
/// the resolved tokens.json path.
#[allow(clippy::too_many_arguments)]
pub fn merge_token(
    tokens_path: &Path,
    account: &str,
    access_token: &str,
    refresh_token: &str,
    expires_at_ms: i64,
    tier: &str,
    client_id: &str,
    api_version: &str,
) -> io::Result<()> {
    let mut store: serde_json::Value = if tokens_path.exists() {
        serde_json::from_slice(&std::fs::read(tokens_path)?)
            .unwrap_or_else(|_| serde_json::json!({ "accounts": {} }))
    } else {
        serde_json::json!({ "accounts": {} })
    };
    if !store
        .get("accounts")
        .map(|a| a.is_object())
        .unwrap_or(false)
    {
        store["accounts"] = serde_json::json!({});
    }
    store["accounts"][account] = serde_json::json!({
        "account": account,
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": expires_at_ms,
        "tier": tier,
        "clientId": client_id,
        "apiVersion": api_version,
    });
    write_secure(tokens_path, &serde_json::to_string_pretty(&store)?)
}

/// Default ~/.eule/<name> path.
pub fn eule_path(name: &str) -> std::path::PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    home.join(".eule").join(name)
}
