//! `oauth-safari` — Microsoft sign-in in the user's own Safari.
//!
//! The embedded webview cannot reach security keys or passkeys on macOS: WebKit
//! grants that only to browsers Apple entitles and to apps associated with the
//! site. Safari can, and it keeps the user's Microsoft session, so a sign-in
//! often needs no interaction at all.
//!
//! The helper opens the authorize URL in a window of its own, first without
//! bringing Safari forward and without forcing an account picker. While Safari
//! signs in from its session, nothing is shown. If no code arrives within
//! `--silent-wait` seconds, Safari comes forward with a notification for the
//! user to finish, e.g. with a YubiKey. Microsoft then lands on the registered
//! `nativeclient` page with the code in the address; the helper reads that
//! address over AppleScript, checks `state`, closes its window, returns focus,
//! and redeems the code with PKCE like `oauth-capture`. macOS asks once whether
//! Safari may be controlled.

use crate::oauth::{self, OAuthArgs};
use crate::util;
use clap::Args as ClapArgs;
use std::time::Duration;

pub const NATIVE_CLIENT_REDIRECT: &str =
    "https://login.microsoftonline.com/common/oauth2/nativeclient";

/// Where Microsoft's nativeclient page moves a browser three seconds after
/// showing the code; arriving there means the code was missed.
const WRONG_PLACE: &str = "https://login.microsoftonline.com/common/wrongplace";

const NEEDS_YOU: &str = "Sign in to Microsoft in Safari to continue.";

#[derive(ClapArgs)]
pub struct Args {
    #[command(flatten)]
    oauth: OAuthArgs,
    /// Redirect URI registered for the client; Safari lands there with the code.
    #[arg(long, default_value = NATIVE_CLIENT_REDIRECT)]
    redirect_uri: String,
    /// Seconds to wait for a sign-in from Safari's session before Safari comes forward.
    #[arg(long, default_value_t = 4)]
    silent_wait: u64,
    /// Abort after N seconds if the sign-in is not finished.
    #[arg(long, default_value_t = 300)]
    timeout: u64,
}

/// The few things the sign-in needs from a browser.
pub trait Browser {
    type Window: Copy;
    /// Open `url` in a new window without bringing the browser forward.
    fn open(&mut self, url: &str) -> Result<Self::Window, String>;
    /// Address shown in the window, or `None` once the window is gone.
    fn url(&mut self, window: Self::Window) -> Result<Option<String>, String>;
    fn bring_to_front(&mut self, window: Self::Window) -> Result<(), String>;
    fn notify(&mut self, message: &str);
    fn close(&mut self, window: Self::Window);
    /// Give focus back to the app that had it before `bring_to_front`.
    fn restore_focus(&mut self);
}

#[derive(Debug, PartialEq, Eq)]
pub enum SignInError {
    /// The user closed the sign-in window.
    Closed,
    TimedOut,
    /// A redirect with another `state` reached the window.
    StateMismatch,
    /// Microsoft redirected with an error instead of a code.
    Denied(String),
    /// The window moved on to Microsoft's "wrong place" page before the code
    /// was read.
    CodeMissed,
    Browser(String),
}

pub struct Timing {
    pub poll: Duration,
    pub silent_wait: Duration,
    pub timeout: Duration,
}

/// Watch `window` until Microsoft redirects there. Returns the code and whether
/// the browser had to be brought forward. `sleep` is injected for tests.
pub fn wait_for_code<B: Browser>(
    browser: &mut B,
    window: B::Window,
    redirect: &str,
    state: &str,
    timing: &Timing,
    sleep: &mut dyn FnMut(Duration),
) -> Result<(String, bool), SignInError> {
    let mut elapsed = Duration::ZERO;
    let mut in_front = false;
    loop {
        match browser.url(window).map_err(SignInError::Browser)? {
            None => return Err(SignInError::Closed),
            Some(url) if oauth::matches_redirect(&url, redirect) => {
                if oauth::query_parameter(&url, "state").as_deref() != Some(state) {
                    return Err(SignInError::StateMismatch);
                }
                if let Some(code) = oauth::code_from(&url) {
                    return Ok((code, in_front));
                }
                let reason = oauth::query_parameter(&url, "error_description")
                    .or_else(|| oauth::query_parameter(&url, "error"))
                    .unwrap_or_else(|| "redirect without a code".into());
                return Err(SignInError::Denied(reason));
            }
            Some(url) if oauth::matches_redirect(&url, WRONG_PLACE) => {
                return Err(SignInError::CodeMissed);
            }
            Some(_) => {}
        }
        if elapsed >= timing.timeout {
            return Err(SignInError::TimedOut);
        }
        if !in_front && elapsed >= timing.silent_wait {
            browser.bring_to_front(window).map_err(SignInError::Browser)?;
            browser.notify(NEEDS_YOU);
            in_front = true;
        }
        sleep(timing.poll);
        elapsed += timing.poll;
    }
}

pub fn run(args: Args) -> Result<(), String> {
    let mut browser = native_browser()?;
    let verifier = util::random_b64url(32);
    let challenge = util::pkce_challenge(&verifier);
    let state = util::random_b64url(16);
    // No prompt: Microsoft may complete the sign-in from Safari's session.
    let url = oauth::authorize_url(&args.oauth, &args.redirect_uri, &challenge, &state, None)?;

    let window = browser.open(&url)?;
    let timing = Timing {
        // Microsoft shows the code page for three seconds, with a phishing
        // warning; a short interval keeps it on screen only briefly.
        poll: Duration::from_millis(250),
        silent_wait: Duration::from_secs(args.silent_wait),
        timeout: Duration::from_secs(args.timeout),
    };
    let outcome =
        wait_for_code(&mut browser, window, &args.redirect_uri, &state, &timing, &mut |pause| {
            std::thread::sleep(pause)
        });
    if outcome != Err(SignInError::Closed) {
        browser.close(window);
    }
    if matches!(outcome, Ok((_, true))) {
        browser.restore_focus();
    }
    match outcome {
        Ok((code, _)) => {
            let account =
                oauth::redeem_and_store(&args.oauth, &args.redirect_uri, &verifier, &code)?;
            println!("ok account={account}");
            Ok(())
        }
        Err(SignInError::Closed) => {
            eprintln!("error: the Safari sign-in window was closed");
            std::process::exit(3);
        }
        Err(SignInError::TimedOut) => {
            eprintln!("error: timed out after {}s", args.timeout);
            std::process::exit(2);
        }
        Err(SignInError::StateMismatch) => Err("OAuth redirect state mismatch".into()),
        Err(SignInError::Denied(reason)) => Err(format!("sign-in refused: {reason}")),
        Err(SignInError::CodeMissed) => {
            Err("Safari left Microsoft's code page before the code was read".into())
        }
        Err(SignInError::Browser(message)) => Err(message),
    }
}

#[cfg(target_os = "macos")]
fn native_browser() -> Result<applescript::Safari, String> {
    Ok(applescript::Safari::default())
}

#[cfg(not(target_os = "macos"))]
fn native_browser() -> Result<NoBrowser, String> {
    Err("the Safari sign-in is only available on macOS".into())
}

/// Stand-in so `run` compiles where there is no Safari; never constructed.
#[cfg(not(target_os = "macos"))]
enum NoBrowser {}

#[cfg(not(target_os = "macos"))]
impl Browser for NoBrowser {
    type Window = u8;
    fn open(&mut self, _: &str) -> Result<u8, String> {
        match *self {}
    }
    fn url(&mut self, _: u8) -> Result<Option<String>, String> {
        match *self {}
    }
    fn bring_to_front(&mut self, _: u8) -> Result<(), String> {
        match *self {}
    }
    fn notify(&mut self, _: &str) {
        match *self {}
    }
    fn close(&mut self, _: u8) {
        match *self {}
    }
    fn restore_focus(&mut self) {
        match *self {}
    }
}

#[cfg(target_os = "macos")]
mod applescript {
    use super::Browser;
    use std::process::Command;

    /// Marker the window script returns when the window no longer exists.
    const CLOSED: &str = "<closed>";

    #[derive(Default)]
    pub struct Safari {
        /// Path of the app that was frontmost before Safari came forward.
        previous_app: Option<String>,
    }

    /// Run an AppleScript; values travel as arguments, never inside the script.
    fn osascript(lines: &[&str], args: &[&str]) -> Result<String, String> {
        let mut command = Command::new("osascript");
        for line in lines {
            command.arg("-e").arg(line);
        }
        let output = command.args(args).output().map_err(|e| format!("running osascript: {e}"))?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("-1743") || stderr.contains("Not authorized to send Apple events") {
            return Err("macOS does not allow Eule to control Safari; allow it in System \
                        Settings → Privacy & Security → Automation"
                .into());
        }
        Err(format!("AppleScript failed: {}", stderr.trim()))
    }

    impl Browser for Safari {
        type Window = i64;

        fn open(&mut self, url: &str) -> Result<i64, String> {
            // "front window" is not the new one while Safari is in the
            // background, so take the window that was not there before.
            let id = osascript(
                &[
                    "on run argv",
                    "tell application \"Safari\"",
                    "set knownIds to id of every window",
                    "make new document with properties {URL:(item 1 of argv)}",
                    "repeat with w in windows",
                    "if (id of w) is not in knownIds then return id of w",
                    "end repeat",
                    "end tell",
                    "error \"Safari did not open a new window\"",
                    "end run",
                ],
                &[url],
            )?;
            id.parse().map_err(|_| format!("unexpected Safari window id {id:?}"))
        }

        fn url(&mut self, window: i64) -> Result<Option<String>, String> {
            let id = window.to_string();
            let url = osascript(
                &[
                    "on run argv",
                    "set wid to (item 1 of argv) as integer",
                    "tell application \"Safari\"",
                    &format!("if not (exists window id wid) then return \"{CLOSED}\""),
                    "set u to URL of current tab of window id wid",
                    "if u is missing value then return \"\"",
                    "return u",
                    "end tell",
                    "end run",
                ],
                &[&id],
            )?;
            Ok((url != CLOSED).then_some(url))
        }

        fn bring_to_front(&mut self, window: i64) -> Result<(), String> {
            self.previous_app =
                osascript(&["POSIX path of (path to frontmost application)"], &[]).ok();
            let id = window.to_string();
            osascript(
                &[
                    "on run argv",
                    "set wid to (item 1 of argv) as integer",
                    "tell application \"Safari\"",
                    "set index of window id wid to 1",
                    "activate",
                    "end tell",
                    "end run",
                ],
                &[&id],
            )
            .map(|_| ())
        }

        fn notify(&mut self, message: &str) {
            let _ = osascript(
                &[
                    "on run argv",
                    "display notification (item 1 of argv) with title \"Eule\"",
                    "end run",
                ],
                &[message],
            );
        }

        fn close(&mut self, window: i64) {
            let id = window.to_string();
            let _ = osascript(
                &[
                    "on run argv",
                    "set wid to (item 1 of argv) as integer",
                    "tell application \"Safari\"",
                    "if exists window id wid then close window id wid",
                    "end tell",
                    "end run",
                ],
                &[&id],
            );
        }

        fn restore_focus(&mut self) {
            if let Some(app) = self.previous_app.take() {
                let _ = Command::new("open").arg("-a").arg(app).status();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Browser, SignInError, Timing, wait_for_code};
    use std::collections::VecDeque;
    use std::time::Duration;

    const REDIRECT: &str = "https://login.microsoftonline.com/common/oauth2/nativeclient";

    /// A browser whose window shows a scripted sequence of addresses.
    #[derive(Default)]
    struct Script {
        addresses: VecDeque<Option<String>>,
        events: Vec<&'static str>,
    }

    impl Script {
        fn showing(addresses: &[Option<&str>]) -> Self {
            Self {
                addresses: addresses.iter().map(|a| a.map(str::to_string)).collect(),
                events: Vec::new(),
            }
        }
    }

    impl Browser for Script {
        type Window = u8;
        fn open(&mut self, _: &str) -> Result<u8, String> {
            Ok(1)
        }
        fn url(&mut self, _: u8) -> Result<Option<String>, String> {
            let next = self.addresses.pop_front();
            // Keep showing the last address once the script runs out.
            if self.addresses.is_empty()
                && let Some(last) = &next
            {
                self.addresses.push_back(last.clone());
            }
            Ok(next.flatten())
        }
        fn bring_to_front(&mut self, _: u8) -> Result<(), String> {
            self.events.push("front");
            Ok(())
        }
        fn notify(&mut self, _: &str) {
            self.events.push("notify");
        }
        fn close(&mut self, _: u8) {
            self.events.push("close");
        }
        fn restore_focus(&mut self) {
            self.events.push("restore");
        }
    }

    fn timing(silent_polls: u64, timeout_polls: u64) -> Timing {
        Timing {
            poll: Duration::from_secs(1),
            silent_wait: Duration::from_secs(silent_polls),
            timeout: Duration::from_secs(timeout_polls),
        }
    }

    fn wait(browser: &mut Script, timing: &Timing) -> Result<(String, bool), SignInError> {
        wait_for_code(browser, 1, REDIRECT, "st8", timing, &mut |_| ())
    }

    const LOGIN: Option<&str> = Some("https://login.microsoftonline.com/common/oauth2/authorize?x");
    const DONE: Option<&str> = Some(
        "https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc%2Fdef&state=st8",
    );

    #[test]
    fn signs_in_from_the_session_without_bringing_safari_forward() {
        let mut safari = Script::showing(&[LOGIN, LOGIN, DONE]);
        assert_eq!(wait(&mut safari, &timing(4, 60)), Ok(("abc/def".into(), false)));
        assert!(safari.events.is_empty());
    }

    #[test]
    fn brings_safari_forward_once_when_the_session_does_not_suffice() {
        let mut addresses = vec![LOGIN; 8];
        addresses.push(DONE);
        let mut safari = Script::showing(&addresses);
        assert_eq!(wait(&mut safari, &timing(4, 60)), Ok(("abc/def".into(), true)));
        assert_eq!(safari.events, ["front", "notify"]);
    }

    #[test]
    fn reports_a_closed_window_and_a_timeout() {
        let mut safari = Script::showing(&[LOGIN, None]);
        assert_eq!(wait(&mut safari, &timing(4, 60)), Err(SignInError::Closed));

        let mut safari = Script::showing(&[LOGIN]);
        assert_eq!(wait(&mut safari, &timing(2, 5)), Err(SignInError::TimedOut));
        assert_eq!(safari.events, ["front", "notify"]);
    }

    #[test]
    fn refuses_a_foreign_state_and_reports_microsoft_errors() {
        let foreign = Some(
            "https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc&state=other",
        );
        let mut safari = Script::showing(&[foreign]);
        assert_eq!(wait(&mut safari, &timing(4, 60)), Err(SignInError::StateMismatch));

        let denied = Some(
            "https://login.microsoftonline.com/common/oauth2/nativeclient?error=access_denied&error_description=AADSTS53003%3A+Blocked&state=st8",
        );
        let mut safari = Script::showing(&[denied]);
        assert_eq!(
            wait(&mut safari, &timing(4, 60)),
            Err(SignInError::Denied("AADSTS53003: Blocked".into()))
        );
    }

    #[test]
    fn stops_when_the_code_page_has_moved_on() {
        let wrong = Some("https://login.microsoftonline.com/common/wrongplace");
        let mut safari = Script::showing(&[LOGIN, wrong]);
        assert_eq!(wait(&mut safari, &timing(4, 60)), Err(SignInError::CodeMissed));
    }

    #[test]
    fn ignores_other_pages_with_a_similar_address() {
        let elsewhere = Some("https://login.microsoftonline.com/common/oauth2/authorize?state=st8");
        let mut safari = Script::showing(&[elsewhere, DONE]);
        assert_eq!(wait(&mut safari, &timing(4, 60)), Ok(("abc/def".into(), false)));
    }
}
