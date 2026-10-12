use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, AuthResult, Handler};
use russh::keys::{decode_secret_key, key::PrivateKeyWithHashAlg, load_secret_key};
use russh::ChannelMsg;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use super::config::Machine;
use super::ssh::{self, AuthUse, ExecRequest, ExecResult, KnownHost, SshConnector, SshSession};
use crate::error::{Error, Result};

struct AcceptHandler {
    presented: Arc<Mutex<Option<KnownHost>>>,
}

impl Handler for AcceptHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> impl std::future::Future<Output = std::result::Result<bool, Self::Error>> + Send {
        let slot = self.presented.clone();
        let host = host_from_key(server_public_key);
        async move {
            *slot.lock().await = Some(host);
            Ok(true)
        }
    }
}

pub struct LiveSession {
    handle: Arc<Mutex<client::Handle<AcceptHandler>>>,
    /// russh allows one channel at a time on this handle. A write and a tree scan must not overlap.
    channel: Arc<std::sync::Mutex<()>>,
}

impl SshSession for LiveSession {
    fn exec_channel(&self, request: &ExecRequest) -> Result<ExecResult> {
        self.exec_stream(request, &mut |_| {})
    }

    fn alive(&self) -> bool {
        true
    }

    fn exec_stream(&self, request: &ExecRequest, on_stdout: &mut dyn FnMut(&[u8])) -> Result<ExecResult> {
        let command = ssh::remote_shell_command(&request.cwd, &request.command)?;
        let timeout = Duration::from_secs(request.timeout_secs.max(1));
        let handle = self.handle.clone();
        let _turn = self.channel.lock().unwrap_or_else(|err| err.into_inner());
        let (tx, rx) = std::sync::mpsc::channel();
        ssh_runtime().spawn(async move {
            let handle = handle.lock().await;
            run_exec_stream(&handle, &command, timeout, tx).await;
        });
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;
        let mut timed_out = false;
        while let Ok(piece) = rx.recv() {
            match piece {
                StreamPiece::Out(chunk) => {
                    on_stdout(&chunk);
                    stdout.extend_from_slice(&chunk);
                }
                StreamPiece::Err(chunk) => stderr.extend_from_slice(&chunk),
                StreamPiece::Exit(code) => exit_code = Some(code),
                StreamPiece::TimedOut => timed_out = true,
                StreamPiece::Failed(message) => return Err(Error::Other(message)),
            }
        }
        Ok(ExecResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            stdout_bytes: stdout,
            exit_code,
            timed_out,
        })
    }
}

enum StreamPiece {
    Out(Vec<u8>),
    Err(Vec<u8>),
    Exit(i32),
    TimedOut,
    Failed(String),
}

async fn run_exec_stream(
    handle: &client::Handle<AcceptHandler>,
    command: &str,
    timeout: Duration,
    tx: std::sync::mpsc::Sender<StreamPiece>,
) {
    let mut channel = match handle.channel_open_session().await {
        Ok(channel) => channel,
        Err(err) => {
            let _ = tx.send(StreamPiece::Failed(format!("could not open SSH channel: {err}")));
            return;
        }
    };
    if let Err(err) = channel.exec(true, command).await {
        let _ = tx.send(StreamPiece::Failed(format!("could not run command: {err}")));
        return;
    }
    let mut exit_code = None;
    let mut stdout_done = false;
    let started = std::time::Instant::now();
    loop {
        if started.elapsed() > timeout {
            let _ = tx.send(StreamPiece::TimedOut);
            let _ = channel.close().await;
            break;
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        let msg = tokio::time::timeout(remaining.min(Duration::from_secs(1)), channel.wait()).await;
        match msg {
            Ok(Some(ChannelMsg::Data { data })) => {
                let _ = tx.send(StreamPiece::Out(data.to_vec()));
            }
            Ok(Some(ChannelMsg::ExtendedData { data, ext: _ })) => {
                let _ = tx.send(StreamPiece::Err(data.to_vec()));
            }
            Ok(Some(ChannelMsg::ExitStatus { exit_status })) => {
                exit_code = Some(exit_status as i32);
                if stdout_done {
                    break;
                }
            }
            Ok(Some(ChannelMsg::Eof) | Some(ChannelMsg::Close)) => {
                stdout_done = true;
                if exit_code.is_some() {
                    break;
                }
            }
            Ok(None) => break,
            Ok(Some(_)) => {}
            Err(_) => continue,
        }
    }
    if let Some(code) = exit_code {
        let _ = tx.send(StreamPiece::Exit(code));
    }
}

pub struct LiveConnector;

impl SshConnector for LiveConnector {
    fn connect(&self, machine: &Machine, secret: Option<&str>) -> Result<(Box<dyn SshSession>, KnownHost)> {
        let machine = machine.clone();
        let secret = secret.map(str::to_string);
        block_on(async move {
            let auth = ssh::auth_material(&machine, secret.as_deref())?;
            connect_live(&machine, auth).await
        })
    }
}

async fn connect_live(
    machine: &Machine,
    auth: AuthUse<'_>,
) -> Result<(Box<dyn SshSession>, KnownHost)> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        keepalive_interval: Some(Duration::from_secs(30)),
        ..client::Config::default()
    });
    let presented_slot = Arc::new(Mutex::new(None));
    let handler = AcceptHandler {
        presented: presented_slot.clone(),
    };
    // System ssh applies ~/.ssh/config, keys, and ProxyJump. A raw TCP connect does not.
    let (ssh_user, ssh_host) = super::config::ssh_login(&machine.user, &machine.host);
    let mut handle = connect_with_system_ssh(config, &ssh_user, &ssh_host, machine.port, handler).await?;
    authenticate(&mut handle, machine, &auth).await?;
    let presented = presented_slot
        .lock()
        .await
        .clone()
        .ok_or_else(|| Error::Other("server did not present a host key".into()))?;
    let host = KnownHost {
        host: machine.host.clone(),
        port: machine.port,
        key_type: presented.key_type,
        fingerprint: presented.fingerprint,
    };
    Ok((
        Box::new(LiveSession {
            handle: Arc::new(Mutex::new(handle)),
            channel: Arc::new(std::sync::Mutex::new(())),
        }),
        host,
    ))
}

/// Use the system `ssh` as the transport so `~/.ssh/config`, keys, and the agent apply.
async fn connect_with_system_ssh(
    config: Arc<client::Config>,
    user: &str,
    host: &str,
    port: u16,
    handler: AcceptHandler,
) -> Result<client::Handle<AcceptHandler>> {
    let mut command = tokio::process::Command::new("ssh");
    command
        .arg("-W")
        .arg(format!("{host}:{port}"))
        .arg("-p")
        .arg(port.to_string())
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=8")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg(format!("{user}@{host}"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| Error::Other(format!("could not start ssh: {e}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| Error::Other("ssh did not provide a connection".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Other("ssh did not provide a connection".into()))?;
    let stderr = child.stderr.take();
    let stream = SshProcess {
        _child: child,
        read: stdout,
        write: stdin,
    };
    match client::connect_stream(config, stream, handler).await {
        Ok(handle) => Ok(handle),
        Err(err) => {
            let note = ssh_failure_note(stderr).await;
            let detail = match note {
                Some(line) => format!("{err}: {line}"),
                None => err.to_string(),
            };
            Err(Error::Other(friendly_ssh_error(host, &detail)))
        }
    }
}

async fn ssh_failure_note(stderr: Option<tokio::process::ChildStderr>) -> Option<String> {
    let mut stderr = stderr?;
    let mut buf = Vec::new();
    let _ = tokio::io::AsyncReadExt::read_to_end(&mut stderr, &mut buf).await;
    let text = String::from_utf8_lossy(&buf);
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

struct SshProcess {
    _child: tokio::process::Child,
    read: tokio::process::ChildStdout,
    write: tokio::process::ChildStdin,
}

impl tokio::io::AsyncRead for SshProcess {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.read).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for SshProcess {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.write).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.write).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.write).poll_shutdown(cx)
    }
}

fn friendly_ssh_error(host: &str, raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("no route")
        || lower.contains("os error 65")
        || lower.contains("disconnected")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("network is unreachable")
    {
        format!("{host} did not answer. It may be offline or on another network.")
    } else if lower.contains("permission denied") || lower.contains("auth") {
        format!("SSH rejected the login for {host}. Your existing key was tried.")
    } else {
        format!("could not connect to {host}: {raw}")
    }
}

async fn authenticate(
    handle: &mut client::Handle<AcceptHandler>,
    machine: &Machine,
    auth: &AuthUse<'_>,
) -> Result<()> {
    let result = match auth {
        AuthUse::Password(password) => handle
            .authenticate_password(&machine.user, *password)
            .await
            .map_err(|e| Error::Other(format!("SSH login failed: {e}")))?,
        AuthUse::PrivateKey { path, passphrase } => {
            let key = if let Some(pass) = passphrase {
                decode_secret_key(&std::fs::read_to_string(path)?, Some(pass))
                    .map_err(|e| Error::Other(format!("could not read private key: {e}")))?
            } else {
                load_secret_key(path, None)
                    .map_err(|e| Error::Other(format!("could not read private key: {e}")))?
            };
            handle
                .authenticate_publickey(&machine.user, PrivateKeyWithHashAlg::new(Arc::new(key), None))
                .await
                .map_err(|e| Error::Other(format!("SSH login failed: {e}")))?
        }
        AuthUse::Agent => {
            let key = default_private_key()?;
            handle
                .authenticate_publickey(
                    &machine.user,
                    PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await
                .map_err(|e| Error::Other(format!("SSH login failed: {e}")))?
        }
    };
    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(Error::Other("SSH login was rejected".into())),
    }
}

fn default_private_key() -> Result<russh::keys::PrivateKey> {
    let home = crate::dev::paths::home_dir()
        .ok_or_else(|| Error::Other("home folder is unknown".into()))?;
    for name in ["id_ed25519", "id_rsa", "id_ecdsa"] {
        let path = home.join(".ssh").join(name);
        if path.is_file() {
            return load_secret_key(&path, None)
                .map_err(|e| Error::Other(format!("could not read {}: {e}", path.display())));
        }
    }
    Err(Error::Other(
        "No SSH key was found in ~/.ssh. Add one or type a password.".into(),
    ))
}

fn host_from_key(key: &russh::keys::PublicKey) -> KnownHost {
    let bytes = key.to_bytes().unwrap_or_default();
    let digest = Sha256::digest(&bytes);
    let fingerprint = format!("SHA256:{}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD_NO_PAD, digest));
    KnownHost {
        host: String::new(),
        port: 0,
        key_type: key.algorithm().to_string(),
        fingerprint,
    }
}

fn ssh_runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("twanagent-ssh")
            .build()
            .expect("ssh runtime")
    })
}

/// SSH sessions are background tasks. They have to live on a runtime that outlasts this call.
fn block_on<T: Send + 'static>(work: impl std::future::Future<Output = T> + Send + 'static) -> T {
    ssh_runtime().block_on(work)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_sha256_of_the_key_bytes() {
        let key = russh::keys::PrivateKey::random(&mut rand::rngs::OsRng, russh::keys::Algorithm::Ed25519).unwrap();
        let host = host_from_key(&key.public_key());
        assert!(host.fingerprint.starts_with("SHA256:"));
        assert!(!host.key_type.is_empty());
    }
}
