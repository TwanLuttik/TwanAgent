use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::config::{AuthMethod, Machine};
use crate::error::{Error, Result};

pub const KNOWN_HOSTS_FILE: &str = "known_hosts.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyDecision {
    Trusted,
    Unknown(KnownHost),
    Changed { stored: KnownHost, presented: KnownHost },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostPrompt {
    pub machine_id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub changed: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct KnownHosts {
    pub rows: Vec<KnownHost>,
}

impl KnownHosts {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join(KNOWN_HOSTS_FILE);
        let Ok(raw) = fs::read_to_string(path) else {
            return Self::default();
        };
        if let Ok(rows) = serde_json::from_str::<Vec<KnownHost>>(&raw) {
            return Self { rows };
        }
        serde_json::from_str(&raw).unwrap_or_default()
    }

    pub fn save(&self, data_dir: &Path) -> Result<()> {
        fs::create_dir_all(data_dir)?;
        let path = data_dir.join(KNOWN_HOSTS_FILE);
        let tmp = data_dir.join("known_hosts.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        #[cfg(windows)]
        if path.exists() {
            fs::remove_file(&path)?;
        }
        fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn decide(&self, presented: &KnownHost) -> HostKeyDecision {
        match self.find(presented.host.as_str(), presented.port) {
            None => HostKeyDecision::Unknown(presented.clone()),
            Some(stored) if stored.fingerprint == presented.fingerprint && stored.key_type == presented.key_type => {
                HostKeyDecision::Trusted
            }
            Some(stored) => HostKeyDecision::Changed {
                stored: stored.clone(),
                presented: presented.clone(),
            },
        }
    }

    pub fn accept(&mut self, presented: KnownHost) {
        if let Some(row) = self
            .rows
            .iter_mut()
            .find(|row| row.host == presented.host && row.port == presented.port)
        {
            *row = presented;
        } else {
            self.rows.push(presented);
        }
    }

    fn find(&self, host: &str, port: u16) -> Option<&KnownHost> {
        self.rows.iter().find(|row| row.host == host && row.port == port)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecRequest {
    pub cwd: String,
    pub command: String,
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    /// Stdout before it was turned into text. A hosted frame is binary, so the string form drops bytes.
    pub stdout_bytes: Vec<u8>,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// One live connection. Channels are opened per call and are not reused.
pub trait SshSession: Send + Sync {
    fn exec_channel(&self, request: &ExecRequest) -> Result<ExecResult>;
    fn alive(&self) -> bool;
    /// Run a command whose stdout arrives as it is written. Stderr is kept until the end.
    fn exec_stream(&self, request: &ExecRequest, on_stdout: &mut dyn FnMut(&[u8])) -> Result<ExecResult> {
        let result = self.exec_channel(request)?;
        if !result.stdout.is_empty() {
            on_stdout(result.stdout.as_bytes());
        }
        Ok(result)
    }

    /// Run a command and feed its stdin. The default sends nothing, which is what a normal exec does.
    fn exec_with_stdin(
        &self,
        request: &ExecRequest,
        stdin: &[u8],
        on_sent: &mut dyn FnMut(u64),
    ) -> Result<ExecResult> {
        let _ = (stdin, on_sent);
        self.exec_channel(request)
    }
}

pub trait SshConnector: Send + Sync {
    fn connect(&self, machine: &Machine, secret: Option<&str>) -> Result<(Box<dyn SshSession>, KnownHost)>;
}

#[derive(Clone)]
struct Pooled {
    generation: u64,
    session: Arc<dyn SshSession>,
}

pub struct Pool {
    connector: Arc<dyn SshConnector>,
    sessions: Mutex<HashMap<String, Pooled>>,
}

impl Pool {
    pub fn new(connector: Arc<dyn SshConnector>) -> Self {
        Self {
            connector,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn exec(
        &self,
        machine: &Machine,
        secret: Option<&str>,
        request: &ExecRequest,
    ) -> Result<ExecResult> {
        let session = self.session(machine, secret)?;
        session.exec_channel(request)
    }

    /// Connect and return the presented host key without storing the session.
    pub fn probe(&self, machine: &Machine, secret: Option<&str>) -> Result<(Arc<dyn SshSession>, KnownHost)> {
        let (session, host) = self.connector.connect(machine, secret)?;
        Ok((Arc::from(session), host))
    }

    /// A connection that is not the shared one. A long copy must not sit on the channel that loads chats.
    pub fn fresh(&self, machine: &Machine, secret: Option<&str>) -> Result<Arc<dyn SshSession>> {
        let (session, _host) = self.connector.connect(machine, secret)?;
        Ok(Arc::from(session))
    }

    pub fn is_alive(&self, machine_id: &str) -> bool {
        let map = self.sessions.lock().unwrap_or_else(|err| err.into_inner());
        map.get(machine_id).is_some_and(|pooled| pooled.session.alive())
    }

    pub fn session(&self, machine: &Machine, secret: Option<&str>) -> Result<Arc<dyn SshSession>> {
        {
            let map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(pooled) = map.get(&machine.id) {
                if pooled.session.alive() {
                    return Ok(pooled.session.clone());
                }
            }
        }
        let (session, _host) = self.connector.connect(machine, secret)?;
        let session: Arc<dyn SshSession> = Arc::from(session);
        let mut map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let generation = map.get(&machine.id).map(|row| row.generation).unwrap_or(0) + 1;
        map.insert(
            machine.id.clone(),
            Pooled {
                generation,
                session: session.clone(),
            },
        );
        Ok(session)
    }

    pub fn generations(&self) -> HashMap<String, u64> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(id, row)| (id.clone(), row.generation))
            .collect()
    }

    pub fn drop_machine(&self, id: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }
}

/// Build a remote shell command that cds into the project and does not use the local mount.
pub fn remote_shell_command(cwd: &str, command: &str) -> Result<String> {
    if cwd == "/" {
        let command = command.trim();
        if command.is_empty() || command.contains('\0') {
            return Err(Error::Other("command is empty".into()));
        }
        return Ok(command.to_string());
    }
    let cwd = super::config::validate_remote_path(cwd)?;
    let command = command.trim();
    if command.is_empty() {
        return Err(Error::Other("command is empty".into()));
    }
    if command.contains('\0') {
        return Err(Error::Other("command is invalid".into()));
    }
    Ok(format!(
        "cd {} && {}",
        shell_single_quote(&cwd),
        command
    ))
}

pub fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn auth_material<'a>(machine: &'a Machine, secret: Option<&'a str>) -> Result<AuthUse<'a>> {
    match machine.auth {
        AuthMethod::Agent => Ok(AuthUse::Agent),
        AuthMethod::PrivateKey => {
            let path = machine
                .key_path
                .as_deref()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| Error::Other("private key path is required".into()))?;
            Ok(AuthUse::PrivateKey {
                path: PathBuf::from(path),
                passphrase: secret.filter(|s| !s.is_empty()),
            })
        }
        AuthMethod::Password => {
            let password = secret.filter(|s| !s.is_empty());
            if let Some(password) = password {
                return Ok(AuthUse::Password(password));
            }
            // Older rows were saved as password auth with no password. Use the key instead.
            if let Some(path) = machine.key_path.as_deref().filter(|path| !path.is_empty()) {
                return Ok(AuthUse::PrivateKey {
                    path: PathBuf::from(path),
                    passphrase: None,
                });
            }
            Ok(AuthUse::Agent)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthUse<'a> {
    Agent,
    PrivateKey {
        path: PathBuf,
        passphrase: Option<&'a str>,
    },
    Password(&'a str),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeSession {
        id: usize,
        alive: bool,
        calls: Arc<AtomicUsize>,
    }

    impl SshSession for FakeSession {
        fn exec_channel(&self, request: &ExecRequest) -> Result<ExecResult> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(ExecResult {
                stdout: format!("{}:{}", self.id, request.command),
                stderr: String::new(),
                stdout_bytes: Vec::new(),
                exit_code: Some(0),
                timed_out: false,
            })
        }
        fn alive(&self) -> bool {
            self.alive
        }
    }

    struct FakeConnector {
        connects: Arc<AtomicUsize>,
        die_after: Option<usize>,
    }

    impl SshConnector for FakeConnector {
        fn connect(&self, machine: &Machine, _secret: Option<&str>) -> Result<(Box<dyn SshSession>, KnownHost)> {
            let n = self.connects.fetch_add(1, Ordering::SeqCst) + 1;
            let alive = self.die_after != Some(n);
            Ok((
                Box::new(FakeSession {
                    id: n,
                    alive,
                    calls: Arc::new(AtomicUsize::new(0)),
                }),
                KnownHost {
                    host: machine.host.clone(),
                    port: machine.port,
                    key_type: "ssh-ed25519".into(),
                    fingerprint: "SHA256:test".into(),
                },
            ))
        }
    }

    fn machine() -> Machine {
        Machine {
            id: "m1".into(),
            name: "Box".into(),
            user: "dev".into(),
            host: "example.com".into(),
            port: 22,
            auth: AuthMethod::Agent,
            key_path: None,
            secret_account: None,
            created_at: "now".into(),
        }
    }

    #[test]
    fn password_auth_without_a_secret_uses_the_key() {
        let mut row = machine();
        row.auth = AuthMethod::Password;
        row.key_path = Some("/Users/me/.ssh/id_ed25519".into());
        assert_eq!(
            auth_material(&row, None).unwrap(),
            AuthUse::PrivateKey {
                path: PathBuf::from("/Users/me/.ssh/id_ed25519"),
                passphrase: None,
            }
        );
        row.key_path = None;
        assert_eq!(auth_material(&row, None).unwrap(), AuthUse::Agent);
        assert_eq!(
            auth_material(&row, Some("secret")).unwrap(),
            AuthUse::Password("secret")
        );
    }

    #[test]
    fn a_live_session_is_alive_until_it_is_dropped() {
        let pool = Pool::new(Arc::new(FakeConnector {
            connects: Arc::new(AtomicUsize::new(0)),
            die_after: None,
        }));
        let machine = machine();
        assert!(!pool.is_alive(&machine.id));
        pool.session(&machine, None).unwrap();
        assert!(pool.is_alive(&machine.id));
        pool.drop_machine(&machine.id);
        assert!(!pool.is_alive(&machine.id));
    }

    #[test]
    fn two_execs_share_one_connection() {
        let connects = Arc::new(AtomicUsize::new(0));
        let pool = Pool::new(Arc::new(FakeConnector {
            connects: connects.clone(),
            die_after: None,
        }));
        let req = ExecRequest {
            cwd: "/srv/app".into(),
            command: "echo hi".into(),
            timeout_secs: 10,
        };
        let a = pool.exec(&machine(), None, &req).unwrap();
        let b = pool.exec(&machine(), None, &req).unwrap();
        assert_eq!(connects.load(Ordering::SeqCst), 1);
        assert!(a.stdout.starts_with("1:"));
        assert!(b.stdout.starts_with("1:"));
        assert_eq!(pool.generations().get("m1"), Some(&1));
    }

    #[test]
    fn a_dead_connection_reconnects_once() {
        let connects = Arc::new(AtomicUsize::new(0));
        let pool = Pool::new(Arc::new(FakeConnector {
            connects: connects.clone(),
            die_after: Some(1),
        }));
        let machine = machine();
        let _ = pool.session(&machine, None).unwrap();
        let again = pool.session(&machine, None).unwrap();
        assert!(again.alive());
        assert_eq!(connects.load(Ordering::SeqCst), 2);
        assert_eq!(pool.generations().get("m1"), Some(&2));
    }

    #[test]
    fn changed_fingerprint_is_rejected() {
        let mut hosts = KnownHosts::default();
        let first = KnownHost {
            host: "example.com".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:one".into(),
        };
        assert!(matches!(hosts.decide(&first), HostKeyDecision::Unknown(_)));
        hosts.accept(first.clone());
        assert_eq!(hosts.decide(&first), HostKeyDecision::Trusted);
        let changed = KnownHost {
            fingerprint: "SHA256:two".into(),
            ..first
        };
        assert!(matches!(hosts.decide(&changed), HostKeyDecision::Changed { .. }));
    }

    #[test]
    fn remote_command_quotes_the_directory_and_rejects_escapes() {
        assert_eq!(
            remote_shell_command("/srv/apps/billing", "npm test").unwrap(),
            "cd '/srv/apps/billing' && npm test"
        );
        assert_eq!(
            remote_shell_command("/srv/o'brien", "pwd").unwrap(),
            "cd '/srv/o'\\''brien' && pwd"
        );
        assert!(remote_shell_command("/srv/../etc", "pwd").is_err());
        assert!(remote_shell_command("relative", "pwd").is_err());
        assert!(remote_shell_command("/srv/app", "   ").is_err());
    }

    #[test]
    fn known_hosts_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut hosts = KnownHosts::default();
        hosts.accept(KnownHost {
            host: "example.com".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint: "SHA256:abc".into(),
        });
        hosts.save(dir.path()).unwrap();
        let loaded = KnownHosts::load(dir.path());
        assert_eq!(loaded.rows.len(), 1);
        assert_eq!(loaded.rows[0].fingerprint, "SHA256:abc");
    }
}
