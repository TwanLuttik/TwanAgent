//! Skills and MCP for every model provider.
//!
//! A turn installs one session for its conversation. `load_skill` reads an enabled
//! SKILL.md. Each tool from a connected MCP server is a normal function tool named
//! `mcp__server__tool`. xAI, Claude, and MiniMax all receive that same list.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const MAX_SERVERS: usize = 16;
const MAX_TOOLS: usize = 64;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const CALL_TIMEOUT: Duration = Duration::from_secs(45);
const TEXT_CAP: usize = 24_000;
const TEXT_HEAD: usize = 20_000;
const TEXT_TAIL: usize = 2_000;
const VENDOR_SKILLS: &[&str] = &["shell", "canvas", "statusline"];

struct Skill {
    name: String,
    description: String,
    path: PathBuf,
}

struct McpTool {
    exposed: String,
    remote: String,
    session: usize,
    description: String,
    schema: Value,
}

enum Session {
    Stdio(StdioSession),
    Http(HttpSession),
}

struct StdioSession {
    child: Child,
    stdin: std::process::ChildStdin,
    incoming: std::sync::mpsc::Receiver<Value>,
    next_id: i64,
}

struct HttpSession {
    client: reqwest::blocking::Client,
    url: String,
    headers: Vec<(String, String)>,
    session_id: Option<String>,
    next_id: i64,
}

#[derive(Clone)]
struct ServerSpec {
    name: String,
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    url: String,
    headers: Vec<(String, String)>,
    enabled: bool,
}

pub struct Capabilities {
    skills: Vec<Skill>,
    tools: Vec<McpTool>,
    sessions: Vec<Session>,
    connected: Vec<String>,
    failed: Vec<(String, String)>,
    disabled_mcp: Vec<String>,
    disabled_skills: usize,
    omitted_tools: usize,
}

pub struct Guard {
    id: String,
    slot: Arc<Mutex<Capabilities>>,
}

fn slots() -> &'static Mutex<HashMap<String, Arc<Mutex<Capabilities>>>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, Arc<Mutex<Capabilities>>>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

std::thread_local! {
    static CURRENT: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    static HIDE_TOOLS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Hide dynamic MCP tools for one model call, such as a compaction summary.
pub struct HideTools {
    previous: bool,
}

impl HideTools {
    pub fn new() -> Self {
        let previous = HIDE_TOOLS.with(|flag| {
            let previous = flag.get();
            flag.set(true);
            previous
        });
        Self { previous }
    }
}

impl Drop for HideTools {
    fn drop(&mut self) {
        HIDE_TOOLS.with(|flag| flag.set(self.previous));
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        CURRENT.with(|current| {
            if current.borrow().as_deref() == Some(self.id.as_str()) {
                *current.borrow_mut() = None;
            }
        });
        if let Ok(mut map) = slots().lock() {
            if map.get(&self.id).is_some_and(|slot| Arc::ptr_eq(slot, &self.slot)) {
                map.remove(&self.id);
            }
        }
    }
}

impl Drop for StdioSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Read configs, connect enabled MCP servers, and keep the sessions for this conversation.
pub fn install(id: &str, workspace: &Path, home: &Path) -> Guard {
    let id = id.trim();
    let slot = Arc::new(Mutex::new(prepare(workspace, home)));
    if let Ok(mut map) = slots().lock() {
        map.insert(id.to_string(), slot.clone());
    }
    CURRENT.with(|current| *current.borrow_mut() = Some(id.to_string()));
    Guard { id: id.to_string(), slot }
}

pub fn prompt_block(conversation_id: &str) -> String {
    with_caps(conversation_id, |caps| caps.prompt_block())
}

pub fn tool_defs(conversation_id: &str) -> Vec<Value> {
    with_caps(conversation_id, |caps| caps.mcp_tool_defs())
}

/// Tools for the model call on this thread. Empty during compaction.
pub fn current_extra_tools() -> Vec<Value> {
    if HIDE_TOOLS.with(|flag| flag.get()) {
        return Vec::new();
    }
    let Some(id) = CURRENT.with(|current| current.borrow().clone()) else {
        return Vec::new();
    };
    tool_defs(&id)
}

/// `Some` when this name is a skill or MCP tool, including a failed call.
pub fn call(conversation_id: &str, name: &str, arguments: &str) -> Option<String> {
    if name != "load_skill" && !name.starts_with("mcp__") {
        return None;
    }
    let slot = slots().lock().ok().and_then(|map| map.get(conversation_id).cloned());
    let Some(slot) = slot else {
        return Some("Error: this turn has no skill or MCP session.".into());
    };
    let mut caps = slot.lock().unwrap_or_else(|err| err.into_inner());
    Some(caps.invoke(name, arguments))
}

pub fn load_skill_at(workspace: &Path, home: &Path, name: &str) -> String {
    let caps = discover(workspace, home);
    caps.invoke_skill(name)
}

fn with_caps<T>(conversation_id: &str, f: impl FnOnce(&Capabilities) -> T) -> T
where
    T: Default,
{
    let Some(slot) = slots().lock().ok().and_then(|map| map.get(conversation_id).cloned()) else {
        return T::default();
    };
    let caps = slot.lock().unwrap_or_else(|err| err.into_inner());
    f(&caps)
}

fn discover(workspace: &Path, home: &Path) -> Capabilities {
    let grok = home.join(".grok");
    let disabled_skills = disabled_names(&grok.join("config.toml"), "skills", "disabled");
    let mut disabled_mcp = disabled_names(&grok.join("config.toml"), "", "disabled_mcp_servers");
    disabled_mcp.extend(disabled_names(&workspace.join(".grok/config.toml"), "", "disabled_mcp_servers"));
    let disabled_mcp_set: HashSet<String> = disabled_mcp.iter().cloned().collect();
    let mut skills = Vec::new();
    let mut seen = HashSet::new();
    for (path, _) in skill_files(workspace, home, &grok) {
        let Some(skill) = read_skill(&path) else {
            continue;
        };
        if !seen.insert(skill.name.clone()) {
            continue;
        }
        if disabled_skills.iter().any(|name| name == &skill.name) {
            continue;
        }
        skills.push(skill);
    }
    let disabled_skill_count = disabled_skills.len();
    let mut servers = read_servers(workspace, home);
    for server in &mut servers {
        if disabled_mcp_set.contains(&server.name) {
            server.enabled = false;
        }
    }
    let mut disabled_names = Vec::new();
    let mut seen_servers = HashSet::new();
    for server in servers {
        if !seen_servers.insert(server.name.clone()) {
            continue;
        }
        if !server.enabled {
            disabled_names.push(server.name);
        }
    }
    Capabilities {
        skills,
        tools: Vec::new(),
        sessions: Vec::new(),
        connected: Vec::new(),
        failed: Vec::new(),
        disabled_mcp: disabled_names,
        disabled_skills: disabled_skill_count,
        omitted_tools: 0,
    }
}

fn prepare_full(workspace: &Path, home: &Path) -> Capabilities {
    let grok = home.join(".grok");
    let disabled_skill_names = disabled_names(&grok.join("config.toml"), "skills", "disabled");
    let mut disabled_mcp = disabled_names(&grok.join("config.toml"), "", "disabled_mcp_servers");
    disabled_mcp.extend(disabled_names(
        &workspace.join(".grok/config.toml"),
        "",
        "disabled_mcp_servers",
    ));
    let workspace_skills = disabled_names(&workspace.join(".grok/config.toml"), "skills", "disabled");
    let mut disabled_skill_names = disabled_skill_names;
    for name in workspace_skills {
        if !disabled_skill_names.iter().any(|row| row == &name) {
            disabled_skill_names.push(name);
        }
    }
    let disabled_set: HashSet<String> = disabled_mcp.iter().cloned().collect();
    let mut skills = Vec::new();
    let mut seen = HashSet::new();
    let mut disabled_skills = 0usize;
    for (path, _) in skill_files(workspace, home, &grok) {
        let Some(skill) = read_skill(&path) else {
            continue;
        };
        if !seen.insert(skill.name.clone()) {
            continue;
        }
        if disabled_skill_names.iter().any(|name| name == &skill.name) {
            disabled_skills += 1;
            continue;
        }
        skills.push(skill);
    }
    let mut servers = Vec::new();
    let mut disabled_mcp_names = Vec::new();
    let mut seen_servers = HashSet::new();
    for server in read_servers(workspace, home) {
        if !seen_servers.insert(server.name.clone()) {
            continue;
        }
        if !server.enabled || disabled_set.contains(&server.name) {
            disabled_mcp_names.push(server.name);
            continue;
        }
        servers.push(server);
    }
    let mut caps = Capabilities {
        skills,
        tools: Vec::new(),
        sessions: Vec::new(),
        connected: Vec::new(),
        failed: Vec::new(),
        disabled_mcp: disabled_mcp_names,
        disabled_skills,
        omitted_tools: 0,
    };
    let credentials = read_credentials(&grok.join("mcp_credentials.json"));
    let waiting = servers.len().saturating_sub(MAX_SERVERS);
    let workspace = workspace.to_path_buf();
    let mut joins = Vec::new();
    for server in servers.into_iter().take(MAX_SERVERS) {
        let workspace = workspace.clone();
        let credentials = credentials.clone();
        joins.push(std::thread::spawn(move || {
            let name = server.name.clone();
            let result = connect_server(&workspace, &server, &credentials);
            (name, result)
        }));
    }
    let mut used_names = HashSet::new();
    for join in joins {
        let Ok((name, result)) = join.join() else {
            caps.failed.push(("mcp".into(), "connect thread stopped".into()));
            continue;
        };
        match result {
            Ok((session, listed)) => {
                let index = caps.sessions.len();
                caps.sessions.push(session);
                caps.connected.push(name.clone());
                for tool in listed {
                    if caps.tools.len() >= MAX_TOOLS {
                        caps.omitted_tools += 1;
                        continue;
                    }
                    let remote = tool.get("name").and_then(Value::as_str).unwrap_or("").trim();
                    if remote.is_empty() {
                        continue;
                    }
                    let exposed = expose_name(&name, remote, &mut used_names);
                    let description = tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .chars()
                        .take(400)
                        .collect::<String>();
                    let schema = tool
                        .get("inputSchema")
                        .or_else(|| tool.get("parameters"))
                        .filter(|value| value.is_object())
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
                    caps.tools.push(McpTool {
                        exposed,
                        remote: remote.to_string(),
                        session: index,
                        description,
                        schema,
                    });
                }
            }
            Err(err) => caps.failed.push((name, clip(&err, 160))),
        }
    }
    if waiting > 0 {
        caps.failed.push((
            format!("{waiting} more"),
            "not connected this turn".into(),
        ));
    }
    caps
}

fn prepare(workspace: &Path, home: &Path) -> Capabilities {
    prepare_full(workspace, home)
}

impl Capabilities {
    fn prompt_block(&self) -> String {
        let mut lines = Vec::new();
        if !self.skills.is_empty() || self.disabled_skills > 0 {
            let list = self
                .skills
                .iter()
                .map(|skill| {
                    if skill.description.is_empty() {
                        skill.name.clone()
                    } else {
                        format!("{} ({})", skill.name, one_line(&skill.description))
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            let disabled = if self.disabled_skills > 0 {
                format!(" {} disabled.", self.disabled_skills)
            } else {
                String::new()
            };
            let names = if list.is_empty() { "none".to_string() } else { list };
            lines.push(format!(
                "Call load_skill with a skill name to read its instructions before following it. Enabled: {names}.{disabled}"
            ));
        }
        if !self.connected.is_empty() || !self.failed.is_empty() || !self.disabled_mcp.is_empty() {
            let mut parts = Vec::new();
            if !self.connected.is_empty() {
                parts.push(format!("connected {}", self.connected.join(", ")));
            }
            if !self.failed.is_empty() {
                let failed = self
                    .failed
                    .iter()
                    .map(|(name, err)| format!("{name} ({err})"))
                    .collect::<Vec<_>>()
                    .join(", ");
                parts.push(format!("failed {failed}"));
            }
            if !self.disabled_mcp.is_empty() {
                parts.push(format!("disabled {}", self.disabled_mcp.join(", ")));
            }
            if self.omitted_tools > 0 {
                parts.push(format!("{} tools left out", self.omitted_tools));
            }
            lines.push(format!(
                "MCP tools are named mcp__server__tool. This turn: {}.",
                parts.join(". ")
            ));
        }
        lines.join("\n")
    }

    fn mcp_tool_defs(&self) -> Vec<Value> {
        self.tools
            .iter()
            .map(|tool| {
                let description = if tool.description.is_empty() {
                    format!("MCP tool {} from {}.", tool.remote, server_of(&tool.exposed))
                } else {
                    format!("{}: {}", server_of(&tool.exposed), tool.description)
                };
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.exposed,
                        "description": description,
                        "parameters": tool.schema,
                    }
                })
            })
            .collect()
    }

    fn invoke(&mut self, name: &str, arguments: &str) -> String {
        if name == "load_skill" {
            let args: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
            let skill = args.get("name").and_then(Value::as_str).unwrap_or("");
            return self.invoke_skill(skill);
        }
        let Some(index) = self.tools.iter().position(|tool| tool.exposed == name) else {
            return format!("Error: unknown MCP tool {name}.");
        };
        let remote = self.tools[index].remote.clone();
        let session = self.tools[index].session;
        let args: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));
        let Some(session) = self.sessions.get_mut(session) else {
            return "Error: MCP session is gone.".into();
        };
        match session.request("tools/call", json!({ "name": remote, "arguments": args }), CALL_TIMEOUT) {
            Ok(result) => tool_result_text(&result),
            Err(err) => format!("Error: {err}"),
        }
    }

    fn invoke_skill(&self, name: &str) -> String {
        let wanted = normalize_skill_name(name);
        if wanted.is_empty() {
            return "Error: load_skill requires a name.".into();
        }
        let Some(skill) = self.skills.iter().find(|skill| skill.name == wanted) else {
            let enabled = if self.skills.is_empty() {
                "none".to_string()
            } else {
                self.skills.iter().map(|skill| skill.name.as_str()).collect::<Vec<_>>().join(", ")
            };
            return format!("Error: no enabled skill named {wanted}. Enabled: {enabled}.");
        };
        match fs::read_to_string(&skill.path) {
            Ok(text) => cap_text(&text),
            Err(err) => format!("Error: could not read {}: {err}", skill.name),
        }
    }
}

impl Session {
    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        match self {
            Session::Stdio(session) => session.request(method, params, timeout),
            Session::Http(session) => session.request(method, params, timeout),
        }
    }
}

fn connect_server(
    workspace: &Path,
    server: &ServerSpec,
    credentials: &HashMap<String, String>,
) -> Result<(Session, Vec<Value>), String> {
    if !server.url.is_empty() {
        let mut headers = server.headers.clone();
        let has_auth = headers.iter().any(|(key, _)| key.eq_ignore_ascii_case("authorization"));
        if !has_auth {
            if let Some(token) = token_for(credentials, &server.name, &server.url) {
                headers.push(("Authorization".into(), format!("Bearer {token}")));
            }
        }
        let mut session = Session::Http(HttpSession::open(&server.url, headers)?);
        let tools = handshake(&mut session)?;
        return Ok((session, tools));
    }
    if server.command.is_empty() {
        return Err("no command or url".into());
    }
    let mut session = Session::Stdio(StdioSession::open(workspace, &server.command, &server.args, &server.env)?);
    let tools = handshake(&mut session)?;
    Ok((session, tools))
}

fn handshake(session: &mut Session) -> Result<Vec<Value>, String> {
    let result = session.request(
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "TwanAgent", "version": "1.0" }
        }),
        CONNECT_TIMEOUT,
    )?;
    let _ = result;
    if let Session::Stdio(stdio) = session {
        stdio.notify("notifications/initialized");
    } else if let Session::Http(http) = session {
        http.notify("notifications/initialized");
    }
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..5 {
        let params = if let Some(cursor) = cursor.clone() {
            json!({ "cursor": cursor })
        } else {
            json!({})
        };
        let page = session.request("tools/list", params, CONNECT_TIMEOUT)?;
        if let Some(rows) = page.get("tools").and_then(Value::as_array) {
            tools.extend(rows.iter().cloned());
        }
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|value| !value.is_empty());
        if cursor.is_none() {
            break;
        }
    }
    Ok(tools)
}

impl StdioSession {
    fn open(workspace: &Path, command: &str, args: &[String], env: &[(String, String)]) -> Result<Self, String> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (key, value) in env {
            cmd.env(key, value);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().map_err(|err| format!("could not start {command}: {err}"))?;
        let stdin = child.stdin.take().ok_or("MCP server stdin is closed")?;
        let stdout = child.stdout.take().ok_or("MCP server stdout is closed")?;
        let (tx, incoming) = std::sync::mpsc::channel();
        std::thread::spawn(move || read_stdio(stdout, tx));
        Ok(Self { child, stdin, incoming, next_id: 0 })
    }

    fn notify(&mut self, method: &str) {
        let msg = json!({ "jsonrpc": "2.0", "method": method });
        let _ = writeln!(self.stdin, "{msg}");
        let _ = self.stdin.flush();
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.stdin, "{msg}").map_err(|err| err.to_string())?;
        self.stdin.flush().map_err(|err| err.to_string())?;
        wait_id(&self.incoming, id, timeout)
    }
}

impl HttpSession {
    fn open(url: &str, headers: Vec<(String, String)>) -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(CALL_TIMEOUT)
            .build()
            .map_err(|err| err.to_string())?;
        Ok(Self {
            client,
            url: url.to_string(),
            headers,
            session_id: None,
            next_id: 0,
        })
    }

    fn notify(&mut self, method: &str) {
        let msg = json!({ "jsonrpc": "2.0", "method": method });
        let _ = self.post(&msg, CONNECT_TIMEOUT);
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let (status, ctype, text, session) = self.post(&msg, timeout)?;
        if let Some(session) = session {
            self.session_id = Some(session);
        }
        if !(200..300).contains(&status) {
            return Err(format!("HTTP {status}"));
        }
        let parsed = if ctype.contains("text/event-stream") {
            sse_message(&text, id)?
        } else {
            serde_json::from_str::<Value>(&text).map_err(|err| err.to_string())?
        };
        rpc_result(&parsed)
    }

    fn post(&mut self, body: &Value, timeout: Duration) -> Result<(u16, String, String, Option<String>), String> {
        let mut req = self
            .client
            .post(&self.url)
            .timeout(timeout)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2024-11-05")
            .json(body);
        for (key, value) in &self.headers {
            req = req.header(key.as_str(), value.as_str());
        }
        if let Some(session) = &self.session_id {
            req = req.header("mcp-session-id", session);
        }
        let response = req.send().map_err(|err| err.to_string())?;
        let status = response.status().as_u16();
        let session = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let ctype = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = response.text().unwrap_or_default();
        Ok((status, ctype, text, session))
    }
}

fn wait_id(incoming: &std::sync::mpsc::Receiver<Value>, id: i64, timeout: Duration) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("timed out".into());
        }
        match incoming.recv_timeout(left) {
            Ok(msg) => {
                if msg.get("id").and_then(Value::as_i64) == Some(id) {
                    return rpc_result(&msg);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Err("timed out".into()),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err("MCP server closed".into()),
        }
    }
}

fn rpc_result(msg: &Value) -> Result<Value, String> {
    if let Some(err) = msg.get("error") {
        let text = err.get("message").and_then(Value::as_str).unwrap_or("MCP request failed");
        return Err(text.to_string());
    }
    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

fn read_stdio(stdout: std::process::ChildStdout, tx: std::sync::mpsc::Sender<Value>) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line);
        if !matches!(read, Ok(n) if n > 0) {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('{') {
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                if tx.send(value).is_err() {
                    break;
                }
            }
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            let Ok(len) = rest.trim().parse::<usize>() else {
                continue;
            };
            let mut discard = String::new();
            loop {
                discard.clear();
                if reader.read_line(&mut discard).ok().filter(|n| *n > 0).is_none() {
                    return;
                }
                if discard.trim().is_empty() {
                    break;
                }
            }
            let mut body = vec![0u8; len];
            if std::io::Read::read_exact(&mut reader, &mut body).is_err() {
                break;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(&body) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    }
}

fn sse_message(body: &str, id: i64) -> Result<Value, String> {
    let mut last = None;
    for line in body.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            if value.get("id").and_then(Value::as_i64) == Some(id) || value.get("id").is_none() {
                last = Some(value);
            }
        }
    }
    last.ok_or_else(|| "empty MCP stream".into())
}

fn tool_result_text(result: &Value) -> String {
    let error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
    let mut text = String::new();
    if let Some(rows) = result.get("content").and_then(Value::as_array) {
        for row in rows {
            if let Some(piece) = row.get("text").and_then(Value::as_str) {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(piece);
            }
        }
    }
    if text.is_empty() {
        text = result.to_string();
    }
    let text = cap_text(&text);
    if error {
        format!("Error: {text}")
    } else {
        text
    }
}

fn expose_name(server: &str, tool: &str, used: &mut HashSet<String>) -> String {
    let raw = format!("mcp__{server}__{tool}");
    let mut name: String = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if !name.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic()) {
        name = format!("m{name}");
    }
    name = clip(&name, 64);
    let base = name.clone();
    let mut n = 2u32;
    while used.contains(&name) {
        let suffix = format!("_{n}");
        let room = 64 - suffix.len();
        name = format!("{}{suffix}", clip(&base, room));
        n += 1;
    }
    used.insert(name.clone());
    name
}

fn server_of(exposed: &str) -> &str {
    exposed
        .strip_prefix("mcp__")
        .and_then(|rest| rest.split("__").next())
        .unwrap_or(exposed)
}

fn skill_files(workspace: &Path, home: &Path, grok: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut out = Vec::new();
    push_skill_dir(&mut out, &workspace.join(".grok/skills"), "project");
    push_command_dir(&mut out, &workspace.join(".grok/commands"), "project");
    push_skill_dir(&mut out, &workspace.join(".agents/skills"), "project");
    push_command_dir(&mut out, &workspace.join(".agents/commands"), "project");
    push_skill_dir(&mut out, &workspace.join(".claude/skills"), "claude");
    push_command_dir(&mut out, &workspace.join(".claude/commands"), "claude");
    push_skill_dir(&mut out, &workspace.join(".cursor/skills"), "cursor");
    push_skill_dir(&mut out, &grok.join("skills"), "user");
    push_command_dir(&mut out, &grok.join("commands"), "user");
    push_skill_dir(&mut out, &home.join(".agents/skills"), "user");
    push_skill_dir(&mut out, &home.join(".claude/skills"), "claude");
    push_command_dir(&mut out, &home.join(".claude/commands"), "claude");
    push_skill_dir(&mut out, &home.join(".cursor/skills"), "cursor");
    if let Ok(plugins) = fs::read_dir(grok.join("installed-plugins")) {
        let mut plugins: Vec<_> = plugins.flatten().collect();
        plugins.sort_by_key(|entry| entry.file_name());
        for plugin in plugins {
            push_skill_dir(&mut out, &plugin.path().join("skills"), "plugin");
        }
    }
    push_skill_dir(&mut out, &grok.join("bundled/skills"), "bundled");
    out
}

fn push_skill_dir(out: &mut Vec<(PathBuf, &'static str)>, dir: &Path, origin: &'static str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut rows: Vec<_> = entries.flatten().collect();
    rows.sort_by_key(|entry| entry.file_name());
    for entry in rows {
        let skill = entry.path().join("SKILL.md");
        if skill.is_file() {
            out.push((skill, origin));
        }
    }
}

fn push_command_dir(out: &mut Vec<(PathBuf, &'static str)>, dir: &Path, origin: &'static str) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut rows: Vec<_> = entries.flatten().collect();
    rows.sort_by_key(|entry| entry.file_name());
    for entry in rows {
        let path = entry.path();
        let name = path.file_name().and_then(|value| value.to_str()).unwrap_or("");
        if path.is_file() && name.to_ascii_lowercase().ends_with(".md") && !name.eq_ignore_ascii_case("readme.md") {
            out.push((path, origin));
        }
    }
}

fn read_skill(path: &Path) -> Option<Skill> {
    let text = fs::read_to_string(path).ok()?;
    if text.trim().is_empty() {
        return None;
    }
    let matter = frontmatter(&text);
    let fallback = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|name| !name.eq_ignore_ascii_case("skill"))
        .map(str::to_string)
        .or_else(|| {
            path.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    let name = normalize_skill_name(matter.get("name").map(String::as_str).unwrap_or(fallback.as_str()));
    if name.is_empty() || VENDOR_SKILLS.contains(&name.as_str()) {
        return None;
    }
    let description = matter
        .get("description")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| first_paragraph(&strip_frontmatter(&text)));
    Some(Skill {
        name,
        description: one_line(&description),
        path: path.to_path_buf(),
    })
}

fn normalize_skill_name(raw: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in raw.trim().chars() {
        let ch = ch.to_ascii_lowercase();
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            dash = false;
        } else if (ch == '-' || ch == ' ' || ch == '_') && !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
        if out.len() >= 64 {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

fn frontmatter(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return map;
    };
    let end = rest.find("\n---").unwrap_or(rest.len());
    let body = &rest[..end];
    let mut key = String::new();
    let mut folded = String::new();
    for line in body.lines() {
        if let Some(name) = line.strip_suffix(": |").or_else(|| line.strip_suffix(": >")) {
            if !key.is_empty() {
                map.insert(std::mem::take(&mut key), folded.trim().to_string());
                folded.clear();
            }
            key = name.trim().to_string();
            continue;
        }
        if !key.is_empty() && line.starts_with(' ') {
            if !folded.is_empty() {
                folded.push(' ');
            }
            folded.push_str(line.trim());
            continue;
        }
        if !key.is_empty() {
            map.insert(std::mem::take(&mut key), folded.trim().to_string());
            folded.clear();
        }
        if let Some((name, value)) = line.split_once(':') {
            map.insert(name.trim().to_string(), strip_quotes(value.trim()));
        }
    }
    if !key.is_empty() {
        map.insert(key, folded.trim().to_string());
    }
    map
}

fn strip_frontmatter(text: &str) -> String {
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return text.to_string();
    };
    let Some(end) = rest.find("\n---") else {
        return text.to_string();
    };
    let after = end + 4;
    rest[after..].trim_start_matches(['\r', '\n']).to_string()
}

fn first_paragraph(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .unwrap_or("")
        .to_string()
}

fn strip_quotes(value: &str) -> String {
    let value = value.trim().trim_end_matches(',');
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'"' && bytes[value.len() - 1] == b'"') || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn read_servers(workspace: &Path, home: &Path) -> Vec<ServerSpec> {
    let mut out = Vec::new();
    for path in [
        home.join(".grok/config.toml"),
        home.join(".cursor/mcp.json"),
        home.join(".claude.json"),
        workspace.join(".mcp.json"),
        workspace.join("mcp.json"),
        workspace.join(".cursor/mcp.json"),
        workspace.join(".vscode/mcp.json"),
        workspace.join(".grok/config.toml"),
    ] {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if path.extension().and_then(|ext| ext.to_str()) == Some("toml") {
            out.extend(servers_from_toml(&text));
        } else {
            out.extend(servers_from_json(&text));
        }
    }
    out
}

fn servers_from_json(text: &str) -> Vec<ServerSpec> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let map = value
        .get("mcpServers")
        .or_else(|| value.get("servers"))
        .or_else(|| value.get("mcp").and_then(|mcp| mcp.get("servers")))
        .and_then(Value::as_object);
    let Some(map) = map else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, entry) in map {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        out.push(server_from_entry(name, entry));
    }
    out
}

fn server_from_entry(name: &str, entry: &Value) -> ServerSpec {
    let command = entry.get("command").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let args = entry
        .get("args")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    let env = entry
        .get("env")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let url = entry.get("url").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let headers = entry
        .get("headers")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let enabled = entry.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    ServerSpec {
        name: name.to_string(),
        command,
        args,
        env,
        url,
        headers,
        enabled,
    }
}

fn servers_from_toml(text: &str) -> Vec<ServerSpec> {
    let mut found: Vec<ServerSpec> = Vec::new();
    let mut index: Option<usize> = None;
    let mut env_for: Option<usize> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(header) = toml_header(line) {
            env_for = None;
            if header.ends_with(".env") {
                let name = header.trim_end_matches(".env");
                env_for = found.iter().position(|server| server.name == name);
                index = None;
                continue;
            }
            if found.iter().any(|server| server.name == header) {
                index = found.iter().position(|server| server.name == header);
                continue;
            }
            found.push(ServerSpec {
                name: header,
                command: String::new(),
                args: Vec::new(),
                env: Vec::new(),
                url: String::new(),
                headers: Vec::new(),
                enabled: true,
            });
            index = Some(found.len() - 1);
            continue;
        }
        if let Some(slot) = env_for {
            if let Some((key, value)) = toml_assign(line) {
                found[slot].env.push((key, value));
            }
            continue;
        }
        let Some(slot) = index else {
            continue;
        };
        let Some(key) = line.split('=').next().map(str::trim) else {
            continue;
        };
        match key {
            "url" => {
                if let Some((_, value)) = toml_assign(line) {
                    found[slot].url = value;
                }
            }
            "command" => {
                if let Some((_, value)) = toml_assign(line) {
                    found[slot].command = value;
                }
            }
            "enabled" => {
                if let Some(value) = toml_bool(line) {
                    found[slot].enabled = value;
                }
            }
            "args" => found[slot].args = toml_string_array(text, line),
            _ => {}
        }
    }
    found
}

fn toml_header(line: &str) -> Option<String> {
    let rest = line.strip_prefix("[mcp_servers.")?.strip_suffix(']')?;
    let name = rest.trim().trim_matches('"');
    let name = name.split('.').next()?.trim();
    if name.is_empty() {
        None
    } else if rest.trim().ends_with(".env") || rest.contains(".env") {
        Some(format!("{name}.env"))
    } else {
        Some(name.to_string())
    }
}

fn toml_assign(line: &str) -> Option<(String, String)> {
    let (key, value) = line.split_once('=')?;
    let value = strip_quotes(value.trim());
    if value.is_empty() {
        return None;
    }
    Some((key.trim().to_string(), value))
}

fn toml_bool(line: &str) -> Option<bool> {
    let value = line.split('=').nth(1)?.trim();
    match value {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn toml_string_array(full: &str, first: &str) -> Vec<String> {
    let mut chunk = String::new();
    if let Some(start) = full.find(first) {
        let rest = &full[start..];
        if let Some(end) = rest.find(']') {
            chunk = rest[..=end].to_string();
        }
    }
    if chunk.is_empty() {
        chunk = first.to_string();
    }
    let mut names = Vec::new();
    for item in chunk.split(|ch| ch == ',' || ch == '[' || ch == ']') {
        let name = strip_quotes(item.trim());
        if !name.is_empty() && name != "args" && !name.contains('=') {
            names.push(name);
        }
    }
    names
}

fn disabled_names(path: &Path, table: &str, key: &str) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let section = if table.is_empty() {
        text.as_str()
    } else if let Some(start) = text.find(&format!("[{table}]")) {
        let rest = &text[start..];
        let end = rest[1..].find("\n[").map(|index| index + 1).unwrap_or(rest.len());
        &rest[..end]
    } else {
        return Vec::new();
    };
    let Some(pos) = section.find(key) else {
        return Vec::new();
    };
    let rest = &section[pos + key.len()..];
    let Some(start) = rest.find('[') else {
        return Vec::new();
    };
    let Some(end) = rest[start..].find(']') else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for item in rest[start + 1..start + end].split(',') {
        let name = strip_quotes(item.trim());
        if !name.is_empty() {
            names.push(name);
        }
    }
    names
}

fn read_credentials(path: &Path) -> HashMap<String, String> {
    let Ok(text) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return HashMap::new();
    };
    let Some(map) = value.as_object() else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for (key, entry) in map {
        let Some(token) = entry.pointer("/token_response/access_token").and_then(Value::as_str) else {
            continue;
        };
        if !token.is_empty() {
            out.insert(key.clone(), token.to_string());
        }
    }
    out
}

fn token_for(credentials: &HashMap<String, String>, name: &str, url: &str) -> Option<String> {
    credentials
        .get(&format!("{name}:{url}"))
        .or_else(|| credentials.iter().find(|(key, _)| key.split(':').next() == Some(name)).map(|(_, token)| token))
        .cloned()
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

fn cap_text(text: &str) -> String {
    let len = text.chars().count();
    if len <= TEXT_CAP {
        return text.to_string();
    }
    let head: String = text.chars().take(TEXT_HEAD).collect();
    let tail: String = text.chars().skip(len - TEXT_TAIL).collect();
    let omitted = len - TEXT_HEAD - TEXT_TAIL;
    format!("{head}\n… omitted {omitted} characters …\n{tail}")
}

pub fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_names_and_prompt_come_from_skill_md() {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".grok/skills/commit")).unwrap();
        fs::write(
            root.path().join(".grok/skills/commit/SKILL.md"),
            "---\nname: commit\ndescription: Create conventional commits.\n---\n\n# Commit\n",
        )
        .unwrap();
        fs::create_dir_all(home.path().join(".grok/skills/shell")).unwrap();
        fs::write(home.path().join(".grok/skills/shell/SKILL.md"), "---\nname: shell\n---\n").unwrap();
        fs::write(
            home.path().join(".grok/config.toml"),
            "[skills]\ndisabled = [\"hidden\"]\n\n[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\n\n[mcp_servers.old]\ncommand = \"nope\"\nenabled = false\n",
        )
        .unwrap();
        fs::create_dir_all(root.path().join(".grok/skills/hidden")).unwrap();
        fs::write(root.path().join(".grok/skills/hidden/SKILL.md"), "---\nname: hidden\n---\n").unwrap();
        let caps = discover(root.path(), home.path());
        assert_eq!(caps.skills.len(), 1);
        assert_eq!(caps.skills[0].name, "commit");
        assert_eq!(caps.skills[0].description, "Create conventional commits.");
        assert_eq!(caps.disabled_skills, 1);
        let loaded = caps.invoke_skill("Commit");
        assert!(loaded.contains("conventional commits"));
        assert!(caps.invoke_skill("missing").starts_with("Error:"));
        let block = caps.prompt_block();
        assert!(block.contains("load_skill"));
        assert!(block.contains("commit (Create conventional commits.)"));
        assert!(block.contains("1 disabled"));
    }

    #[test]
    fn mcp_names_are_safe_and_configs_merge() {
        let mut used = HashSet::new();
        let name = expose_name("linear", "list issues", &mut used);
        assert_eq!(name, "mcp__linear__list_issues");
        assert!(name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'));
        let again = expose_name("linear", "list issues", &mut used);
        assert_ne!(again, name);
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join(".mcp.json"),
            r#"{"mcpServers":{"railway":{"command":"npx","args":["-y","srv"],"env":{"A":"b"}}}}"#,
        )
        .unwrap();
        fs::create_dir_all(home.path().join(".grok")).unwrap();
        fs::write(
            home.path().join(".grok/config.toml"),
            "disabled_mcp_servers = [\"railway\"]\n\n[mcp_servers.notion]\nurl = \"https://mcp.notion.com/mcp\"\n",
        )
        .unwrap();
        let servers = read_servers(root.path(), home.path());
        assert!(servers.iter().any(|server| server.name == "railway" && server.args == ["-y", "srv"] && server.env == [("A".into(), "b".into())]));
        assert!(servers.iter().any(|server| server.name == "notion" && server.url.contains("notion")));
        let caps = discover(root.path(), home.path());
        assert!(caps.disabled_mcp.iter().any(|name| name == "railway"));
        assert!(caps.prompt_block().contains("disabled railway") || caps.disabled_mcp.iter().any(|name| name == "railway"));
    }

    #[test]
    fn stdio_server_lists_and_calls_a_tool() {
        let python = ["python3", "python"]
            .into_iter()
            .find(|bin| Command::new(bin).arg("--version").output().is_ok());
        let Some(python) = python else {
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("fake_mcp.py");
        fs::write(
            &script,
            r#"
import json, sys
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{}}})
    elif method == "tools/list":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"tools":[{"name":"ping","description":"Ping","inputSchema":{"type":"object","properties":{"text":{"type":"string"}}}}]}})
    elif method == "tools/call":
        send({"jsonrpc":"2.0","id":msg["id"],"result":{"content":[{"type":"text","text":"pong"}]}})
"#,
        )
        .unwrap();
        let server = ServerSpec {
            name: "fake".into(),
            command: python.into(),
            args: vec![script.to_string_lossy().into_owned()],
            env: Vec::new(),
            url: String::new(),
            headers: Vec::new(),
            enabled: true,
        };
        let (mut session, tools) = connect_server(root.path(), &server, &HashMap::new()).unwrap();
        assert_eq!(tools[0]["name"], "ping");
        let result = session
            .request("tools/call", json!({ "name": "ping", "arguments": {} }), CALL_TIMEOUT)
            .unwrap();
        assert_eq!(tool_result_text(&result), "pong");
    }
}
