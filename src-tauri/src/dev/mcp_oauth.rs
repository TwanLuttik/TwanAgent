//! Browser sign-in for remote MCP servers that speak OAuth (Linear, Notion, …).
//!
//! Discovery follows the MCP authorization spec: probe the server, read protected-resource
//! metadata, then authorization-server metadata. A public client is registered dynamically,
//! the user approves in the browser, and the loopback callback exchanges the code.
//! Tokens land in `~/.grok/mcp_credentials.json` in the same shape the Grok CLI already reads.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Instant;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::process::WindowlessCommand;

use super::mcp::{mcp_name_ok, read_user_mcp, USER_MCP_FILES};

const CALLBACK_PATH: &str = "/callback";
const AUTH_WAIT: Duration = Duration::from_secs(180);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug)]
struct RemoteMcp {
    name: String,
    url: String,
}

#[derive(Clone, Debug)]
struct AuthServer {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    scopes: Vec<String>,
    resource: String,
}

#[derive(Clone, Debug)]
struct ClientCreds {
    client_id: String,
    client_secret: Option<String>,
}

pub fn mcp_sign_in(name: &str) -> Result<()> {
    if !mcp_name_ok(name) {
        return Err(Error::Other("invalid MCP server name".into()));
    }
    let server = find_remote_server(name)?;
    let meta = discover(&server.url)?;
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .map_err(|err| Error::Other(format!("could not open a local sign-in port: {err}")))?;
    let port = listener
        .local_addr()
        .map_err(|err| Error::Other(err.to_string()))?
        .port();
    let redirect = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let creds = register_client(&meta, &redirect)?;
    let (verifier, challenge) = pkce();
    let state = random_token(24);
    let auth_url = authorize_url(&meta, &creds, &redirect, &challenge, &state);
    open_browser(&auth_url)?;
    let code = wait_for_code(&listener, &state)?;
    let token = exchange_code(&meta, &creds, &redirect, &verifier, &code)?;
    save_credential(&server, &meta, &creds, &token)
}

fn find_remote_server(name: &str) -> Result<RemoteMcp> {
    let mut found: Option<RemoteMcp> = None;
    for path in USER_MCP_FILES {
        let Ok(contents) = read_user_mcp(path) else {
            continue;
        };
        if let Some(url) = remote_url_in(path, &contents, name) {
            found = Some(RemoteMcp {
                name: name.to_string(),
                url,
            });
        }
    }
    found.ok_or_else(|| {
        Error::Other(format!(
            "{name} has no remote URL. Add url = \"https://…\" under its MCP config, then try again."
        ))
    })
}

fn remote_url_in(path: &str, contents: &str, name: &str) -> Option<String> {
    if path.ends_with(".toml") {
        return toml_server_url(contents, name);
    }
    json_server_url(contents, name)
}

fn json_server_url(contents: &str, name: &str) -> Option<String> {
    let raw: Value = serde_json::from_str(contents).ok()?;
    let map = raw
        .get("mcpServers")
        .or_else(|| raw.get("servers"))
        .or_else(|| raw.get("mcp").and_then(|mcp| mcp.get("servers")))?
        .as_object()?;
    let entry = map.get(name)?;
    http_url(entry.get("url").and_then(|value| value.as_str()))
}

fn toml_server_url(contents: &str, name: &str) -> Option<String> {
    let mut current: Option<String> = None;
    let mut url: Option<String> = None;
    for raw in contents.lines() {
        let line = raw.trim();
        if let Some(header) = toml_header(line) {
            if current.as_deref() == Some(name) {
                if let Some(found) = url.clone() {
                    return Some(found);
                }
            }
            current = Some(header);
            url = None;
            continue;
        }
        if current.as_deref() != Some(name) {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == "url" {
            url = http_url(Some(unquote(value.trim())));
        }
    }
    if current.as_deref() == Some(name) {
        url
    } else {
        None
    }
}

fn toml_header(line: &str) -> Option<String> {
    let quoted = line
        .strip_prefix("[mcp_servers.\"")
        .and_then(|rest| rest.split('"').next())
        .map(str::trim)
        .filter(|name| !name.is_empty());
    if quoted.is_some() {
        return quoted.map(str::to_string);
    }
    let rest = line.strip_prefix("[mcp_servers.")?;
    let name = rest.split(['.', ']']).next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn unquote(value: &str) -> &str {
    value
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .trim()
}

fn http_url(value: Option<&str>) -> Option<String> {
    let url = value?.trim();
    (url.starts_with("https://") || url.starts_with("http://")).then(|| url.to_string())
}

fn discover(resource_url: &str) -> Result<AuthServer> {
    let client = http_client()?;
    let probe = client
        .get(resource_url)
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-06-18")
        .send()
        .map_err(|err| Error::Other(format!("could not reach {resource_url}: {err}")))?;
    let mut metadata_urls = resource_metadata_urls(&probe);
    let mut scopes = scopes_from_header(probe.headers().get("www-authenticate").and_then(|v| v.to_str().ok()));
    let origin = origin_of(resource_url)?;
    metadata_urls.push(format!(
        "{origin}/.well-known/oauth-protected-resource{}",
        path_of(resource_url)
    ));
    metadata_urls.push(format!("{origin}/.well-known/oauth-protected-resource"));
    metadata_urls.sort();
    metadata_urls.dedup();

    let mut resource = resource_url.to_string();
    let mut issuers: Vec<String> = Vec::new();
    for url in &metadata_urls {
        let Ok(res) = client.get(url).header("Accept", "application/json").send() else {
            continue;
        };
        if !res.status().is_success() {
            continue;
        }
        let Ok(body) = res.json::<Value>() else {
            continue;
        };
        if let Some(value) = body.get("resource").and_then(|v| v.as_str()) {
            if value.starts_with("https://") || value.starts_with("http://") {
                resource = value.to_string();
            }
        }
        if let Some(list) = body.get("scopes_supported").and_then(|v| v.as_array()) {
            let parsed = string_list(list);
            if !parsed.is_empty() {
                scopes = parsed;
            }
        }
        if let Some(list) = body.get("authorization_servers").and_then(|v| v.as_array()) {
            issuers = string_list(list);
            if !issuers.is_empty() {
                break;
            }
        }
    }
    if issuers.is_empty() {
        issuers.push(origin);
    }
    if scopes.is_empty() {
        scopes = vec!["read".into(), "write".into()];
    }

    for issuer in issuers {
        if let Some(mut server) = fetch_auth_server(&client, &issuer, scopes.clone())? {
            server.resource = resource.clone();
            return Ok(server);
        }
    }
    Err(Error::Other(
        "this MCP server did not publish OAuth metadata TwanAgent can use".into(),
    ))
}

fn fetch_auth_server(
    client: &reqwest::blocking::Client,
    issuer: &str,
    scopes: Vec<String>,
) -> Result<Option<AuthServer>> {
    let origin = origin_of(issuer).unwrap_or_else(|_| issuer.trim_end_matches('/').to_string());
    let path = path_of(issuer);
    let candidates = [
        format!("{origin}/.well-known/oauth-authorization-server{path}"),
        format!("{origin}/.well-known/openid-configuration{path}"),
        format!("{origin}/.well-known/oauth-authorization-server"),
        format!("{origin}/.well-known/openid-configuration"),
    ];
    for url in candidates {
        let Ok(res) = client.get(&url).header("Accept", "application/json").send() else {
            continue;
        };
        if !res.status().is_success() {
            continue;
        }
        let Ok(body) = res.json::<Value>() else {
            continue;
        };
        let Some(authorization_endpoint) = body
            .get("authorization_endpoint")
            .and_then(|v| v.as_str())
            .map(str::to_string)
        else {
            continue;
        };
        let Some(token_endpoint) = body.get("token_endpoint").and_then(|v| v.as_str()).map(str::to_string) else {
            continue;
        };
        let advertised = body
            .get("scopes_supported")
            .and_then(|v| v.as_array())
            .map(|list| string_list(list))
            .unwrap_or_default();
        let scopes = if advertised.is_empty() {
            scopes.clone()
        } else {
            let wanted: Vec<String> = scopes
                .iter()
                .filter(|scope| advertised.iter().any(|row| row == *scope))
                .cloned()
                .collect();
            if wanted.is_empty() { advertised } else { wanted }
        };
        return Ok(Some(AuthServer {
            issuer: body
                .get("issuer")
                .and_then(|v| v.as_str())
                .unwrap_or(issuer)
                .trim_end_matches('/')
                .to_string(),
            authorization_endpoint,
            token_endpoint,
            registration_endpoint: body
                .get("registration_endpoint")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            scopes,
            resource: String::new(),
        }));
    }
    Ok(None)
}

fn register_client(meta: &AuthServer, redirect: &str) -> Result<ClientCreds> {
    let Some(endpoint) = meta.registration_endpoint.as_deref() else {
        return Err(Error::Other(
            "this MCP server does not support sign-in from TwanAgent (no client registration)".into(),
        ));
    };
    let body = json!({
        "client_name": "TwanAgent",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": meta.scopes.join(" "),
        "application_type": "native",
    });
    let res = http_client()?
        .post(endpoint)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .map_err(|err| Error::Other(format!("could not register with the MCP server: {err}")))?;
    let status = res.status();
    let payload: Value = res.json().unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(Error::Other(oauth_error(
            &payload,
            "the MCP server rejected sign-in registration",
        )));
    }
    let client_id = payload
        .get("client_id")
        .and_then(|v| v.as_str())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| Error::Other("the MCP server did not return a client id".into()))?
        .to_string();
    let client_secret = payload
        .get("client_secret")
        .and_then(|v| v.as_str())
        .filter(|secret| !secret.is_empty())
        .map(str::to_string);
    Ok(ClientCreds {
        client_id,
        client_secret,
    })
}

fn authorize_url(
    meta: &AuthServer,
    creds: &ClientCreds,
    redirect: &str,
    challenge: &str,
    state: &str,
) -> String {
    let mut url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&code_challenge={}&code_challenge_method=S256&state={}&resource={}",
        meta.authorization_endpoint,
        enc(&creds.client_id),
        enc(redirect),
        enc(challenge),
        enc(state),
        enc(&meta.resource),
    );
    if !meta.scopes.is_empty() {
        url.push_str("&scope=");
        url.push_str(&enc(&meta.scopes.join(" ")));
    }
    url
}

fn exchange_code(
    meta: &AuthServer,
    creds: &ClientCreds,
    redirect: &str,
    verifier: &str,
    code: &str,
) -> Result<Value> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect.to_string()),
        ("client_id", creds.client_id.clone()),
        ("code_verifier", verifier.to_string()),
        ("resource", meta.resource.clone()),
    ];
    if let Some(secret) = &creds.client_secret {
        form.push(("client_secret", secret.clone()));
    }
    let res = http_client()?
        .post(&meta.token_endpoint)
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .map_err(|err| Error::Other(format!("could not finish sign-in: {err}")))?;
    let status = res.status();
    let payload: Value = res.json().unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(Error::Other(oauth_error(&payload, "sign-in was rejected")));
    }
    if payload.get("access_token").and_then(|v| v.as_str()).is_none() {
        return Err(Error::Other("sign-in finished without an access token".into()));
    }
    Ok(payload)
}

fn save_credential(server: &RemoteMcp, meta: &AuthServer, creds: &ClientCreds, token: &Value) -> Result<()> {
    let key = format!("{}:{}", server.name, server.url);
    let mut stored = super::mcp::read_credentials_map()?;
    let mut entry = Map::new();
    entry.insert("client_id".into(), Value::String(creds.client_id.clone()));
    if let Some(secret) = &creds.client_secret {
        entry.insert("client_secret".into(), Value::String(secret.clone()));
    }
    let granted = token
        .get("scope")
        .and_then(|v| v.as_str())
        .map(|scope| {
            scope
                .split_whitespace()
                .filter(|part| !part.is_empty())
                .map(|part| Value::String(part.to_string()))
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| meta.scopes.iter().cloned().map(Value::String).collect());
    entry.insert("granted_scopes".into(), Value::Array(granted));
    entry.insert("issuer".into(), Value::String(meta.issuer.clone()));
    entry.insert(
        "token_received_at".into(),
        Value::Number(now_secs().into()),
    );
    let mut response = token.as_object().cloned().unwrap_or_default();
    response.insert("resource".into(), Value::String(server.url.clone()));
    entry.insert("token_response".into(), Value::Object(response));
    stored.insert(key, Value::Object(entry));
    super::mcp::write_credentials_map(&stored)
}

fn wait_for_code(listener: &TcpListener, expected_state: &str) -> Result<String> {
    listener
        .set_nonblocking(true)
        .map_err(|err| Error::Other(err.to_string()))?;
    let started = Instant::now();
    loop {
        if started.elapsed() >= AUTH_WAIT {
            return Err(Error::Other(
                "sign-in timed out before the browser came back".into(),
            ));
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                match read_callback(&mut stream, expected_state) {
                    Callback::Code(code) => {
                        write_page(
                            &mut stream,
                            "Signed in",
                            "Linear is connected. You can close this tab and return to TwanAgent.",
                        );
                        return Ok(code);
                    }
                    Callback::Error(message) => {
                        write_page(&mut stream, "Sign-in failed", &message);
                        return Err(Error::Other(message));
                    }
                    Callback::Ignore => {}
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(err) => return Err(Error::Other(format!("sign-in listener failed: {err}"))),
        }
    }
}

enum Callback {
    Code(String),
    Error(String),
    Ignore,
}

fn read_callback(stream: &mut TcpStream, expected_state: &str) -> Callback {
    let mut buf = [0_u8; 8192];
    let Ok(n) = stream.read(&mut buf) else {
        return Callback::Ignore;
    };
    let text = String::from_utf8_lossy(&buf[..n]);
    let Some(first) = text.lines().next() else {
        return Callback::Ignore;
    };
    let Some(target) = first.split_whitespace().nth(1) else {
        return Callback::Ignore;
    };
    if !target.starts_with(CALLBACK_PATH) {
        write_page(stream, "Waiting", "Finish sign-in in the other tab.");
        return Callback::Ignore;
    }
    let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let params = query_map(query);
    if params.get("state").map(String::as_str) != Some(expected_state) {
        return Callback::Error("sign-in response did not match this attempt".into());
    }
    if let Some(code) = params.get("code").filter(|code| !code.is_empty()) {
        return Callback::Code(code.clone());
    }
    let detail = params
        .get("error_description")
        .cloned()
        .or_else(|| params.get("error").cloned())
        .unwrap_or_else(|| "the server did not return a code".into());
    Callback::Error(detail)
}

fn write_page(stream: &mut TcpStream, title: &str, body: &str) {
    let page = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title><body style=\"font:16px -apple-system,sans-serif;padding:48px\"><h1>{title}</h1><p>{body}</p></body>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        page.len(),
        page
    );
    let _ = stream.write_all(response.as_bytes());
}

fn open_browser(url: &str) -> Result<()> {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .hide_console_window()
            .args(["/C", "start", "", url])
            .status()
    } else {
        std::process::Command::new("xdg-open").arg(url).status()
    };
    match status {
        Ok(code) if code.success() => Ok(()),
        Ok(_) => Err(Error::Other(format!("could not open the browser. Sign in at {url}"))),
        Err(err) => Err(Error::Other(format!("could not open the browser: {err}"))),
    }
}

fn resource_metadata_urls(response: &reqwest::blocking::Response) -> Vec<String> {
    let Some(raw) = response
        .headers()
        .get("www-authenticate")
        .and_then(|value| value.to_str().ok())
    else {
        return Vec::new();
    };
    let mut urls = Vec::new();
    for (key, value) in auth_params(raw) {
        if key.eq_ignore_ascii_case("resource_metadata") && (value.starts_with("https://") || value.starts_with("http://"))
        {
            urls.push(value);
        }
    }
    urls
}

fn scopes_from_header(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    auth_params(raw)
        .into_iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("scope"))
        .map(|(_, value)| value.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
}

fn auth_params(raw: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = raw;
    while let Some(eq) = rest.find('=') {
        let key = rest[..eq].split([',', ' ']).last().unwrap_or("").trim();
        rest = &rest[eq + 1..];
        if rest.starts_with('"') {
            if let Some(end) = rest[1..].find('"') {
                out.push((key.to_string(), rest[1..1 + end].to_string()));
                rest = &rest[1 + end + 1..];
                continue;
            }
        }
        let end = rest.find([',', ' ']).unwrap_or(rest.len());
        out.push((key.to_string(), rest[..end].trim().to_string()));
        rest = &rest[end..];
    }
    out
}

fn query_map(query: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(decode(key), decode(value));
    }
    map
}

fn decode(value: &str) -> String {
    let with_spaces = value.replace('+', " ");
    percent_decode(&with_spaces)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn enc(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn pkce() -> (String, String) {
    let verifier = random_token(48);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0_u8; bytes];
    getrandom::getrandom(&mut buf).expect("system random");
    URL_SAFE_NO_PAD.encode(buf)
}

fn origin_of(url: &str) -> Result<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| Error::Other(format!("not an http URL: {url}")))?;
    let scheme = if url.starts_with("https://") { "https" } else { "http" };
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if host.is_empty() {
        return Err(Error::Other(format!("not an http URL: {url}")));
    }
    Ok(format!("{scheme}://{host}"))
}

fn path_of(url: &str) -> String {
    let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    else {
        return String::new();
    };
    let Some(slash) = rest.find('/') else {
        return String::new();
    };
    let path = &rest[slash..];
    let path = path.split(['?', '#']).next().unwrap_or(path);
    path.trim_end_matches('/').to_string()
}

fn string_list(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn oauth_error(payload: &Value, fallback: &str) -> String {
    payload
        .get("error_description")
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("error").and_then(|v| v.as_str()))
        .or_else(|| payload.get("message").and_then(|v| v.as_str()))
        .filter(|text| !text.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn http_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|err| Error::Other(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_linear_url_from_grok_toml_and_cursor_json() {
        let toml = r#"
[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
enabled = true

[mcp_servers.notion]
url = "https://mcp.notion.com/mcp"
"#;
        assert_eq!(
            toml_server_url(toml, "linear").as_deref(),
            Some("https://mcp.linear.app/mcp")
        );
        let json = r#"{"mcpServers":{"linear":{"url":"https://mcp.linear.app/sse"}}}"#;
        assert_eq!(
            json_server_url(json, "linear").as_deref(),
            Some("https://mcp.linear.app/sse")
        );
        assert!(json_server_url(json, "missing").is_none());
    }

    #[test]
    fn parses_www_authenticate_metadata_and_scope() {
        let header = r#"Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope="read write""#;
        let urls = {
            let params = auth_params(header);
            params
                .into_iter()
                .filter(|(key, _)| key == "resource_metadata")
                .map(|(_, value)| value)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            urls,
            vec!["https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"]
        );
        assert_eq!(scopes_from_header(Some(header)), vec!["read", "write"]);
    }

    #[test]
    fn pkce_challenge_matches_the_verifier() {
        let (verifier, challenge) = pkce();
        assert!(verifier.len() >= 43);
        let mut hasher = Sha256::new();
        hasher.update(verifier.as_bytes());
        assert_eq!(challenge, URL_SAFE_NO_PAD.encode(hasher.finalize()));
    }

    #[test]
    fn origin_and_path_split_the_mcp_url() {
        assert_eq!(origin_of("https://mcp.linear.app/mcp").unwrap(), "https://mcp.linear.app");
        assert_eq!(path_of("https://mcp.linear.app/mcp"), "/mcp");
        assert_eq!(path_of("https://mcp.linear.app"), "");
    }
}
