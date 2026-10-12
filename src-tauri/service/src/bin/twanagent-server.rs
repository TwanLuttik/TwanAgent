//! Headless TwanAgent. No window. The GUI starts this over SSH and sends prompts.
//!
//! Usage: twanagent-server --project <dir> --data <dir>
//!        twanagent-server --call --project <dir> --data <dir>
//!        twanagent-server --version
//! Frames are length-prefixed JSON on stdin and stdout. See docs/twanagent-server.md.
//! `--call` reads one frame and exits. The desktop app uses that over SSH.

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use base64::Engine;
use twanagent_service::{key_file, open_server, serve_once, serve_stdio};

fn expand_home(raw: String) -> PathBuf {
    let Some(rest) = raw.strip_prefix("$HOME") else {
        return PathBuf::from(raw);
    };
    match env::var_os("HOME") {
        Some(home) if !home.is_empty() => PathBuf::from(home).join(rest.trim_start_matches('/')),
        None => PathBuf::from(raw),
    }
}

fn main() -> ExitCode {
    let mut project = None;
    let mut data = None;
    let mut once = false;
    let mut frame = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--project" => project = args.next().map(PathBuf::from),
            "--data" => data = args.next().map(expand_home),
            "--call" => once = true,
            "--frame" => frame = args.next(),
            "--version" => {
                println!("twanagent-server {}", env!("CARGO_PKG_VERSION"));
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("unknown argument: {other}");
                return ExitCode::from(2);
            }
        }
    }
    let (Some(project), Some(data)) = (project, data) else {
        eprintln!("usage: twanagent-server --project <dir> --data <dir>");
        return ExitCode::from(2);
    };
    let service = match open_server(&project, &data) {
        Ok(service) => service,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(1);
        }
    };
    let keys = key_file(&data);
    let ran = if once {
        // The SSH session runs this through a shell, so a pipe never reaches this program.
        // The frame arrives as base64 on --frame instead.
        if let Some(encoded) = frame {
            let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded.trim())
                .unwrap_or_default();
            twanagent_service::serve_frame(&service, &keys, &bytes)
        } else {
            serve_once(&service, &keys)
        }
    } else {
        serve_stdio(&service, &keys)
    };
    if let Err(err) = ran {
        eprintln!("{err}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
