//! eule-helper — cross-platform GUI helper for eule-mcp.
//!
//! Interactive, desktop-only steps that the Node MCP server shells out to.
//! Everything here runs LOCALLY on the user's machine; secrets/codes never pass
//! back through the LLM or MCP — the helper writes tokens locally and stores
//! connector secrets in the operating-system credential store.
//!
//!   eule-helper oauth-capture  — WKWebView/WebView2/WebKitGTK login window that
//!     intercepts a broker-bound redirect (urn:ietf:wg:oauth:2.0:oob or a custom
//!     scheme) no browser can navigate to, exchanges the code, writes tokens.json.
//!   eule-helper secret-prompt  — a local password window; writes the entered
//!     value to a 0600 file or directly to the OS credential store.
//!
//! Same mechanism on all three OSes via `wry` (one webview abstraction).

use clap::{Parser, Subcommand};

mod capture;
mod credential;
mod prompt;
mod util;

#[derive(Parser)]
#[command(
    name = "eule-helper",
    version,
    about = "Cross-platform auth/secret helper for eule-mcp"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Interactive OAuth login in an embedded webview; writes the token to tokens.json.
    OauthCapture(capture::Args),
    /// Prompt for a secret in a local window; writes the raw value to --out (0600).
    SecretPrompt(prompt::Args),
    /// Read or delete an Eule secret in the operating-system credential store.
    Credential(credential::Args),
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::OauthCapture(args) => capture::run(args),
        Command::SecretPrompt(args) => prompt::run(args),
        Command::Credential(args) => credential::run(args),
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
