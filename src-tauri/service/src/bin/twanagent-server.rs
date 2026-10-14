//! Headless TwanAgent. No window. The GUI starts this over SSH and sends prompts.
//!
//! Usage: twanagent-server --serve --data <dir>
//!        twanagent-server --call --project <dir> --data <dir> [--frame <base64>]
//!        twanagent-server --version
//! Frames are length-prefixed JSON on stdin and stdout. See docs/twanagent-server.md.
//! `--serve` stays up, owns the live socket, and runs turns. `--call` answers one store frame.

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use twanagent_service::{key_file, open_server, serve_once, serve_stdio};

fn expand_home(raw: String) -> PathBuf {
    let Some(rest) = raw.strip_prefix("$HOME") else {
        return PathBuf::from(raw);
    };
    match env::var_os("HOME") {
        Some(home) if !home.is_empty() => PathBuf::from(home).join(rest.trim_start_matches('/')),
        Some(_) | None => PathBuf::from(raw),
    }
}

fn main() -> ExitCode {
    let mut project = None;
    let mut data = None;
    let mut once = false;
    let mut serve = false;
    let mut frame = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--project" => project = args.next().map(PathBuf::from),
            "--data" => data = args.next().map(expand_home),
            "--call" => once = true,
            "--serve" => serve = true,
            "--frame" => frame = args.next(),
            "--live" => {
                let data = data.get_or_insert_with(|| expand_home("$HOME/.twanagent".into()));
                match twanagent_service::ensure_started(data) {
                    Ok((addr, true)) => eprintln!("twanagent-server live on {addr}"),
                    Ok((addr, false)) => {
                        eprintln!("twanagent-server live on {addr}");
                        return ExitCode::SUCCESS;
                    }
                    Err(err) => {
                        eprintln!("{err}");
                        return ExitCode::from(1);
                    }
                }
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(3600));
                }
            }
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
    let Some(data) = data else {
        eprintln!("usage: twanagent-server --serve --data <dir>");
        return ExitCode::from(2);
    };
    // One process owns the socket and runs the turns. A second start leaves that process alone.
    if serve && project.is_none() {
        match twanagent_service::ensure_started(&data) {
            Ok((addr, true)) => {
                eprintln!("twanagent-server live on {addr}");
                let keys = key_file(&data);
                // SSH closes a command's stdin as the command starts. The desktop writes frames
                // to a fifo instead, and this process reads that fifo for as long as it runs.
                let fifo = data.join("serve.stdin");
                if let Err(err) = twanagent_service::serve_resident_fifo(&data, &keys, &fifo) {
                    eprintln!("{err}");
                    return ExitCode::from(1);
                }
                return ExitCode::SUCCESS;
            }
            Ok((addr, false)) => {
                eprintln!("twanagent-server live on {addr}");
                return ExitCode::SUCCESS;
            }
            Err(err) => {
                eprintln!("{err}");
                return ExitCode::from(1);
            }
        }
    }
    let Some(project) = project else {
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
    // `--call` does not bind the socket and does not run a live turn. A second hub would
    // publish frames no client is connected to.
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
