// apple-oauth-capture.swift
//
// Captures an OAuth2 authorization code for a public-client app whose only
// registered redirect URIs are non-navigable (custom URL schemes like
// com.apple.mobilemail://, or the IETF out-of-band urn:ietf:wg:oauth:2.0:oob).
// Browsers refuse to navigate to these ("address invalid"), but a WKWebView
// we host ourselves can intercept the *attempt* in decidePolicyFor before
// WebKit rejects it — the same mechanism any native OAuth client uses. No
// interception of Microsoft's real traffic, no spoofed domains/certs; we
// just never let the browser try the bad navigation.
//
// Background: some M365 tenants only consent well-known first-party public
// clients (e.g. Thunderbird `9e5f94bc-...`, Apple Internet Accounts
// `f8d98a96-...`) for specific resources/tiers. Apple's app is EWS/EAS-only
// (no Graph) and its redirect URIs are all broker-bound — this tool is the
// way to drive it from outside the real macOS broker.
//
// Usage:
//   swiftc -O apple-oauth-capture.swift -o apple-oauth-capture
//   ./apple-oauth-capture <client_id> <resource> <login_hint> <out_dir>
//   # a window opens; log in; on success it writes <out_dir>/oauth-result.txt
//   # (raw query string: code=...&state=...) and <out_dir>/oauth-verifier.txt
//   # (PKCE code_verifier — needed for the token exchange).
//
// Token exchange (v1 endpoint, since these apps are legacy-registered):
//   POST https://login.microsoftonline.com/common/oauth2/token
//     client_id=<client_id>&grant_type=authorization_code&code=<code>
//     &redirect_uri=urn:ietf:wg:oauth:2.0:oob&code_verifier=<verifier>
//     &resource=<resource>
//
// A code is single-use — re-run this tool for each attempt.

import Cocoa
import WebKit
import CryptoKit
import Security

let args = CommandLine.arguments
guard args.count == 5 else {
    print("Usage: apple-oauth-capture <client_id> <resource> <login_hint> <out_dir>")
    exit(1)
}
let clientId = args[1]
let resource = args[2]
let loginHint = args[3]
let outDir = args[4]
let redirectUri = "urn:ietf:wg:oauth:2.0:oob"

func base64url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func randomBase64url(_ bytes: Int) -> String {
    var buf = [UInt8](repeating: 0, count: bytes)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &buf)
    return base64url(Data(buf))
}

let verifier = randomBase64url(32)
let challenge = base64url(Data(SHA256.hash(data: verifier.data(using: .utf8)!)))
let state = randomBase64url(16)

// The verifier + captured code together are the full token-exchange credential,
// so write them owner-only (0600), not with the default umask (~0644). The
// caller that redeems the code MUST unlink both files afterwards.
func writeSecure(_ text: String, to path: String) {
    FileManager.default.createFile(
        atPath: path,
        contents: text.data(using: .utf8),
        attributes: [.posixPermissions: 0o600],
    )
}

writeSecure(verifier, to: "\(outDir)/oauth-verifier.txt")

var comps = URLComponents(string: "https://login.microsoftonline.com/common/oauth2/authorize")!
comps.queryItems = [
    URLQueryItem(name: "client_id", value: clientId),
    URLQueryItem(name: "response_type", value: "code"),
    URLQueryItem(name: "redirect_uri", value: redirectUri),
    URLQueryItem(name: "resource", value: resource),
    URLQueryItem(name: "state", value: state),
    URLQueryItem(name: "code_challenge", value: challenge),
    URLQueryItem(name: "code_challenge_method", value: "S256"),
    URLQueryItem(name: "prompt", value: "select_account"),
    URLQueryItem(name: "login_hint", value: loginHint),
]
let authURL = comps.url!

final class Delegate: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let urlString = navigationAction.request.url?.absoluteString ?? ""
        if urlString.hasPrefix("urn:ietf:wg:oauth:2.0:oob") {
            decisionHandler(.cancel)
            let result: String
            if let qIndex = urlString.firstIndex(of: "?") {
                result = String(urlString[urlString.index(after: qIndex)...])
            } else {
                result = "NO_QUERY"
            }
            writeSecure(result, to: "\(outDir)/oauth-result.txt")
            print("CAPTURED: \(result)")
            NSApp.terminate(nil)
            return
        }
        decisionHandler(.allow)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 900, height: 800),
                       styleMask: [.titled, .closable, .resizable],
                       backing: .buffered, defer: false)
window.title = "OAuth Login — \(loginHint)"
let webView = WKWebView(frame: window.contentView!.bounds)
webView.autoresizingMask = [.width, .height]
let delegate = Delegate()
webView.navigationDelegate = delegate
window.contentView?.addSubview(webView)
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

print("Loading: \(authURL.absoluteString)")
webView.load(URLRequest(url: authURL))

app.run()
