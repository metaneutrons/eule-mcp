//! `secret-prompt` — a local password window.
//!
//! Renders a tiny HTML password form in an embedded webview; the entered value
//! is delivered over the webview IPC channel and written to a 0600 file. The
//! secret never appears in argv, stdout, logs, or the MCP tool call — the Node
//! side reads the --out file, folds it into config.yaml, and unlinks it.

use crate::util;
use clap::Args as ClapArgs;
use std::path::PathBuf;
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

const CANCEL: &str = "__EULE_CANCEL__";

#[derive(ClapArgs)]
pub struct Args {
    /// Label shown above the input (e.g. "iCloud app-specific password").
    #[arg(long, default_value = "Secret")]
    label: String,
    /// File to write the entered secret to (created 0600). Required.
    #[arg(long)]
    out: PathBuf,
    /// Abort after N seconds if nothing is entered.
    #[arg(long, default_value_t = 180)]
    timeout: u64,
}

fn page(label: &str) -> String {
    // label is our own arg (not remote content), but escape anyway.
    let safe = label
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>
body{{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px;background:#1e1e1e;color:#eee}}
label{{display:block;font-size:13px;margin-bottom:8px;color:#bbb}}
input{{width:100%;box-sizing:border-box;padding:10px;font-size:15px;border:1px solid #555;border-radius:6px;background:#2a2a2a;color:#fff}}
.row{{margin-top:16px;display:flex;gap:8px;justify-content:flex-end}}
button{{padding:8px 18px;font-size:14px;border:0;border-radius:6px;cursor:pointer}}
.ok{{background:#0a84ff;color:#fff}} .cancel{{background:#3a3a3a;color:#ddd}}
</style></head><body>
<label>{safe}</label>
<input id="s" type="password" autofocus autocomplete="off" spellcheck="false"
  onkeydown="if(event.key==='Enter')submitVal()">
<div class="row">
  <button class="cancel" onclick="window.ipc.postMessage('{CANCEL}')">Cancel</button>
  <button class="ok" onclick="submitVal()">Save</button>
</div>
<script>function submitVal(){{window.ipc.postMessage(document.getElementById('s').value)}}</script>
</body></html>"#
    )
}

pub fn run(args: Args) -> Result<(), String> {
    let timeout = args.timeout;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(timeout));
        eprintln!("error: timed out after {timeout}s");
        std::process::exit(2);
    });

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("eule — enter secret")
        .with_inner_size(tao::dpi::LogicalSize::new(420.0, 180.0))
        .build(&event_loop)
        .map_err(|e| format!("window: {e}"))?;

    let out = args.out.clone();
    let _webview = WebViewBuilder::new()
        .with_html(page(&args.label))
        .with_ipc_handler(move |req| {
            let value = req.into_body();
            if value == CANCEL {
                eprintln!("error: cancelled");
                std::process::exit(3);
            }
            match util::write_secure(&out, &value) {
                Ok(()) => {
                    println!("ok");
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("error: writing secret: {e}");
                    std::process::exit(1);
                }
            }
        })
        .build(&window)
        .map_err(|e| format!("webview: {e}"))?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            eprintln!("error: window closed");
            std::process::exit(3);
        }
    });
}
