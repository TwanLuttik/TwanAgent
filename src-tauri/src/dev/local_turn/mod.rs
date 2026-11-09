//! A local chat turn runs in this process, not in the webview.
//! Reloading the window, or a React crash that remounts it, leaves the turn running.
//! The new page asks which turns are still going and keeps painting their events.

mod context;
mod drive;
mod subagent;
mod tools;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use super::types::{DevChatEvent, DevToolCall};
use crate::error::{Error, Result};
use crate::state::AppState;

use drive::Round;

const EVENT: &str = "dev-local-turn";
pub(super) const FAILURE_PREFIX: &str = "Couldn't continue: ";
const EMPTY_REPLY: &str = "Grok returned an empty reply.";
const CONTEXT_LIMIT_MESSAGE: &str =
    "This conversation is over the context size you chose. Start a new chat, or pick a larger context size.";

#[derive(Debug, Clone, Deserialize)]
pub struct LocalTurnStart {
    pub workspace: String,
    pub conversation_id: String,
    #[serde(default)]
    pub messages: Vec<Value>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub permission: String,
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub journey_id: Option<String>,
    #[serde(default)]
    pub allow_spawn: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LocalTurnInfo {
    pub conversation_id: String,
    pub workspace: String,
    /// Epoch ms when this turn started. A reloaded page keeps this instead of stamping now.
    pub started_at: u64,
}

struct ShellWait {
    command: String,
    tx: std::sync::mpsc::Sender<bool>,
}

struct PlanWait {
    tx: std::sync::mpsc::Sender<PlanAnswer>,
}

struct PlanAnswer {
    decision: String,
    note: String,
}

struct LiveTurn {
    workspace: PathBuf,
    started_at: u64,
    cancel: Arc<AtomicBool>,
    shell: Mutex<Vec<ShellWait>>,
    plan: Mutex<Vec<PlanWait>>,
    /// Subagents still running for this chat. Stopping the parent stops them too.
    children: Mutex<Vec<Arc<AtomicBool>>>,
    /// Model streams opened by those children. Stop cancels these as well as the parent.
    child_streams: Mutex<Vec<String>>,
    /// Shell processes this chat started. Stop kills them instead of waiting out the command.
    commands: Mutex<Vec<String>>,
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn turns() -> &'static Mutex<HashMap<String, Arc<LiveTurn>>> {
    static TURNS: OnceLock<Mutex<HashMap<String, Arc<LiveTurn>>>> = OnceLock::new();
    TURNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn emit(
    app: &AppHandle,
    conversation_id: &str,
    kind: &str,
    text: Option<String>,
    tool: Option<DevToolCall>,
    saved: Option<Value>,
) {
    let _ = app.emit(
        EVENT,
        DevChatEvent {
            stream_id: conversation_id.to_string(),
            kind: kind.to_string(),
            text,
            tool_calls: tool.map(|call| vec![call]),
            usage: None,
            thinking: None,
            conversation: saved,
        },
    );
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_local_turns() -> Vec<LocalTurnInfo> {
    let Ok(map) = turns().lock() else {
        return Vec::new();
    };
    map.iter()
        .filter(|(_, turn)| !turn.cancel.load(Ordering::Relaxed))
        .map(|(id, turn)| LocalTurnInfo {
            conversation_id: id.clone(),
            workspace: turn.workspace.to_string_lossy().into_owned(),
            started_at: turn.started_at,
        })
        .collect()
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_local_turn_stop(conversation_id: String) {
    let Some(turn) = turns()
        .lock()
        .ok()
        .and_then(|map| map.get(&conversation_id).cloned())
    else {
        return;
    };
    turn.cancel.store(true, Ordering::Relaxed);
    if let Ok(mut waits) = turn.shell.lock() {
        for wait in waits.drain(..) {
            let _ = wait.tx.send(false);
        }
    }
    if let Ok(mut waits) = turn.plan.lock() {
        for wait in waits.drain(..) {
            let _ = wait.tx.send(PlanAnswer {
                decision: "decline".into(),
                note: String::new(),
            });
        }
    };
    if let Ok(children) = turn.children.lock() {
        for child in children.iter() {
            child.store(true, Ordering::Relaxed);
        }
    };
    if let Ok(mut streams) = turn.child_streams.lock() {
        for stream_id in streams.drain(..) {
            super::chat::dev_chat_cancel(stream_id);
        }
    };
    // The parent round uses the chat id. A compaction round uses compact:<chat id>.
    // Child rounds use their own ids, cancelled above. One click has to reach all of them.
    super::chat::dev_chat_cancel(conversation_id.clone());
    super::chat::dev_chat_cancel(format!("compact:{conversation_id}"));
    if let Ok(mut commands) = turn.commands.lock() {
        for command_id in commands.drain(..) {
            let _ = super::cmd::stop_command(&command_id);
        }
    };
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_local_turn_shell(conversation_id: String, command: String, allow: bool) -> Result<()> {
    let turn = live(&conversation_id)
        .ok_or_else(|| Error::Other("that chat is not waiting on a command".into()))?;
    let mut waits = turn
        .shell
        .lock()
        .map_err(|_| Error::Other("shell wait is busy".into()))?;
    if waits.is_empty() {
        return Err(Error::Other("that chat is not waiting on a command".into()));
    }
    let index = waits
        .iter()
        .position(|wait| wait.command == command)
        .unwrap_or(0);
    let at = index.min(waits.len() - 1);
    let wait = waits.remove(at);
    let _ = wait.tx.send(allow);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_local_turn_plan(
    conversation_id: String,
    decision: String,
    note: Option<String>,
) -> Result<()> {
    let turn = live(&conversation_id)
        .ok_or_else(|| Error::Other("that chat is not waiting on a plan".into()))?;
    let mut waits = turn
        .plan
        .lock()
        .map_err(|_| Error::Other("plan wait is busy".into()))?;
    let Some(wait) = waits.pop() else {
        return Err(Error::Other("that chat is not waiting on a plan".into()));
    };
    let _ = wait.tx.send(PlanAnswer {
        decision,
        note: note.unwrap_or_default(),
    });
    Ok(())
}

fn live(id: &str) -> Option<Arc<LiveTurn>> {
    turns().lock().ok().and_then(|map| map.get(id).cloned())
}

/// Start the turn and return. Events arrive on `dev-local-turn` until `idle`.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_local_turn_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: LocalTurnStart,
) -> Result<()> {
    let id = request.conversation_id.trim().to_string();
    if id.is_empty() {
        return Err(Error::Other("conversation id is empty".into()));
    }
    let workspace = state.require_workspace(&request.workspace)?;
    if let Some(old) = live(&id) {
        old.cancel.store(true, Ordering::Relaxed);
    }
    let data_dir = state.data_dir.clone();
    spawn_local_turn(&app, &data_dir, &workspace, request);
    Ok(())
}

/// Register the turn, then run it off this thread. Safe to call from a turn that is already running.
fn spawn_local_turn(app: &AppHandle, data_dir: &Path, workspace: &Path, request: LocalTurnStart) {
    let id = request.conversation_id.trim().to_string();
    if id.is_empty() {
        return;
    }
    if let Some(old) = live(&id) {
        old.cancel.store(true, Ordering::Relaxed);
    }
    let live_turn = Arc::new(LiveTurn {
        workspace: workspace.to_path_buf(),
        started_at: epoch_ms(),
        cancel: Arc::new(AtomicBool::new(false)),
        shell: Mutex::new(Vec::new()),
        plan: Mutex::new(Vec::new()),
        children: Mutex::new(Vec::new()),
        child_streams: Mutex::new(Vec::new()),
        commands: Mutex::new(Vec::new()),
    });
    if let Ok(mut map) = turns().lock() {
        map.insert(id.clone(), live_turn.clone());
    }
    let app_for_turn = app.clone();
    let data_dir = data_dir.to_path_buf();
    let workspace = workspace.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drive::drive(&app_for_turn, &data_dir, &workspace, &request, &live_turn)
        }));
        if let Err(panic) = outcome {
            let text = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_string()))
                .unwrap_or_else(|| "the turn stopped unexpectedly".into());
            emit(&app_for_turn, &id, "error", Some(text), None, None);
        }
        emit(&app_for_turn, &id, "idle", None, None, None);
        if let Ok(mut map) = turns().lock() {
            if map
                .get(&id)
                .is_some_and(|slot| Arc::ptr_eq(slot, &live_turn))
            {
                map.remove(&id);
            }
        }
    });
}

fn fail(app: &AppHandle, id: &str, transcript: &mut Vec<Value>, error: &str) {
    emit(app, id, "error", Some(error.to_string()), None, None);
    transcript.push(json!({
        "role": "assistant",
        "content": format!("{FAILURE_PREFIX}{error}"),
        "error": true,
    }));
}

fn keep_partial(transcript: &mut Vec<Value>, round: &Round) {
    if round.text.trim().is_empty() && round.reasoning.trim().is_empty() {
        return;
    }
    transcript.push(assistant_value(
        &round.text,
        &round.reasoning,
        &[],
        &round.thinking,
    ));
}

fn assistant_value(
    text: &str,
    reasoning: &str,
    tools: &[DevToolCall],
    thinking: &[crate::model_providers::ThinkingBlock],
) -> Value {
    let mut message = json!({ "role": "assistant", "content": text });
    if !reasoning.trim().is_empty() {
        message["reasoning"] = Value::String(reasoning.trim().to_string());
    }
    if !tools.is_empty() {
        message["tool_calls"] = serde_json::to_value(tools).unwrap_or(Value::Null);
    }
    if !thinking.is_empty() {
        if let Ok(value) = serde_json::to_value(thinking) {
            message["thinking"] = value;
        }
    }
    message
}

fn close_dangling(transcript: &mut Vec<Value>) {
    let mut answered = HashSet::new();
    for message in transcript.iter() {
        if message.get("role").and_then(Value::as_str) == Some("tool") {
            if let Some(id) = message.get("tool_call_id").and_then(Value::as_str) {
                answered.insert(id.to_string());
            }
        }
    }
    let mut missing = Vec::new();
    for message in transcript.iter() {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(calls) = message.get("tool_calls").and_then(Value::as_array) else {
            continue;
        };
        for call in calls {
            let Some(id) = call.get("id").and_then(Value::as_str) else {
                continue;
            };
            if id.is_empty() || !answered.insert(id.to_string()) {
                continue;
            }
            missing.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": "Error: the command did not finish.",
            }));
        }
    }
    transcript.extend(missing);
}

/// One model round, including a tool round. The usage screen reads this database.
/// A reload can drop the page, so the turn records it here instead of waiting for the webview.
fn record_round_usage(
    data_dir: &Path,
    workspace: &str,
    conversation_id: &str,
    model: &str,
    usage: Option<&super::types::DevChatUsage>,
) {
    let Some(usage) = usage else {
        return;
    };
    if usage.prompt_tokens == 0 && usage.completion_tokens == 0 {
        return;
    }
    let title =
        crate::store::with_conn(&super::conv::conv_store_dir(data_dir, workspace), |conn| {
            crate::store::get_conversation(conn, conversation_id).map(|row| row.title)
        })
        .ok()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "Chat".into());
    let _ = crate::usage::record(
        data_dir,
        crate::usage::UsageRecord {
            workspace_path: workspace.to_string(),
            workspace_name: workspace_name(workspace),
            conversation_id: conversation_id.to_string(),
            conversation_title: title,
            model: model.to_string(),
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            duration_ms: None,
        },
    );
}

fn workspace_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Folder")
        .to_string()
}

fn save(
    data_dir: &Path,
    workspace: &str,
    id: &str,
    messages: &[Value],
    from_index: usize,
    usage: Option<&super::types::DevChatUsage>,
) {
    let dir = super::conv::conv_store_dir(data_dir, workspace);
    let updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let _ = crate::store::with_conn(&dir, |conn| {
        crate::store::save_conversation_suffix_with_usage(
            conn,
            id,
            &updated_at,
            messages,
            from_index,
            usage,
        )
    });
}

fn emit_saved(
    app: &AppHandle,
    id: &str,
    messages: &[Value],
    usage: Option<&super::types::DevChatUsage>,
    compaction: Option<&super::types::DevCompaction>,
) {
    let mut conversation = json!({ "id": id, "messages": messages });
    if let Some(usage) = usage {
        conversation["context_usage"] = serde_json::to_value(usage).unwrap_or(Value::Null);
    }
    if let Some(compaction) = compaction {
        conversation["compaction"] = serde_json::to_value(compaction).unwrap_or(Value::Null);
    }
    emit(app, id, "saved", None, None, Some(conversation));
}

fn stopped(live: &LiveTurn) -> bool {
    stopped_flag(&live.cancel)
}

fn stopped_flag(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

enum ProviderHold {
    Retry,
    Stopped,
    Pass,
}

/// A Grok outage ("service temporarily unavailable", "the model did not respond")
/// and the same class of provider failure. The turn keeps asking until it answers.
fn provider_outage(error: &str) -> bool {
    retryable_model_error(error) && twanagent_service::transient_provider_error(error)
}

fn wait_for_provider(cancel: &AtomicBool, attempt: u32) -> bool {
    let slice = std::time::Duration::from_millis(200);
    let mut left = twanagent_service::provider_retry_pause(attempt);
    while !left.is_zero() {
        if stopped_flag(cancel) {
            return false;
        }
        let step = if left < slice { left } else { slice };
        std::thread::sleep(step);
        left = left.saturating_sub(step);
    }
    !stopped_flag(cancel)
}

/// Pause and ask again. `Pass` means this error is not an outage.
fn hold_provider_outage(
    app: &AppHandle,
    id: &str,
    cancel: &AtomicBool,
    tries: &mut u32,
    error: &str,
) -> ProviderHold {
    if !provider_outage(error) {
        return ProviderHold::Pass;
    }
    emit(
        app,
        id,
        "status",
        Some(twanagent_service::provider_retry_status(tries.saturating_add(1))),
        None,
        None,
    );
    let attempt = *tries;
    *tries = tries.saturating_add(1);
    if !wait_for_provider(cancel, attempt) {
        return ProviderHold::Stopped;
    }
    emit(app, id, "status", None, None, None);
    ProviderHold::Retry
}

fn normalize_permission(raw: &str) -> String {
    match raw.trim() {
        "approve-all" => "approve-all".into(),
        "read-only" => "read-only".into(),
        _ => "ask".into(),
    }
}

fn parse_args(raw: &str) -> serde_json::Map<String, Value> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn str_arg<'a>(args: &'a serde_json::Map<String, Value>, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}

fn int_arg(args: &serde_json::Map<String, Value>, key: &str) -> Option<u32> {
    args.get(key).and_then(twanagent_service::parse_line_int)
}

fn round_is_empty(round: &Round) -> bool {
    round.error.is_none()
        && round.tool_calls.is_empty()
        && round.text.trim().is_empty()
        && round.reasoning.trim().is_empty()
}

/// Transport and provider failures.
/// An outage keeps the turn alive until the provider answers. Anything else here is tried once.
/// Context-length errors are not included: those fold the transcript instead.
fn retryable_model_error(error: &str) -> bool {
    if super::compact::is_context_length_error(error) {
        return false;
    }
    let text = error.to_lowercase();
    if text.is_empty()
        || text.contains("stopped")
        || text.contains("signed in")
        || text.contains("401")
        || text.contains("api key")
        || text.contains("login expired")
    {
        return false;
    }
    text.contains("xai request failed")
        || twanagent_service::bare_status_error(error, "403")
        || text.contains("429")
        || text.contains("500")
        || text.contains("502")
        || text.contains("503")
        || text.contains("504")
        || text.contains("timed out")
        || text.contains("timeout")
        || text.contains("decoding response body")
        || text.contains("connection reset")
        || text.contains("broken pipe")
        || text.contains("model stream closed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_tool_result_is_closed() {
        let mut messages = vec![json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [{ "id": "call-1", "name": "read_file", "arguments": "{}" }]
        })];
        close_dangling(&mut messages);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["tool_call_id"], "call-1");
    }

    #[test]
    fn a_minimax_round_is_written_to_the_usage_database() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("billing");
        std::fs::create_dir_all(&workspace).unwrap();
        record_round_usage(
            dir.path(),
            workspace.to_str().unwrap(),
            "9d5099c0-f864-48d7-9754-e1a5aecd0ed0",
            "MiniMax-M3",
            Some(&crate::dev::types::DevChatUsage {
                prompt_tokens: 1200,
                completion_tokens: 80,
                total_tokens: 1280,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            }),
        );
        let rows = crate::usage::list_since(dir.path(), None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].model, "MiniMax-M3");
        assert_eq!(rows[0].prompt_tokens, 1200);
        assert_eq!(rows[0].completion_tokens, 80);
        assert_eq!(rows[0].workspace_name, "billing");
        record_round_usage(
            dir.path(),
            workspace.to_str().unwrap(),
            "c1",
            "MiniMax-M3",
            None,
        );
        assert_eq!(crate::usage::list_since(dir.path(), None).unwrap().len(), 1);
    }

    #[test]
    fn permission_defaults_to_ask() {
        assert_eq!(normalize_permission(""), "ask");
        assert_eq!(normalize_permission("approve-all"), "approve-all");
        assert_eq!(normalize_permission("nope"), "ask");
    }

    #[test]
    fn a_blank_round_is_empty_and_a_real_reply_is_not() {
        let mut round = Round {
            text: "  ".into(),
            reasoning: String::new(),
            tool_calls: Vec::new(),
            thinking: Vec::new(),
            usage: None,
            error: None,
            streamed_text: false,
            streamed_reasoning: false,
        };
        assert!(round_is_empty(&round));
        round.text = "done".into();
        assert!(!round_is_empty(&round));
        round.text.clear();
        round.reasoning = "looked".into();
        assert!(!round_is_empty(&round));
        round.reasoning.clear();
        round.tool_calls.push(DevToolCall {
            id: "1".into(),
            name: "read_file".into(),
            arguments: "{}".into(),
        });
        assert!(!round_is_empty(&round));
        round.tool_calls.clear();
        round.error = Some("xAI request failed: overloaded".into());
        assert!(!round_is_empty(&round));
    }

    #[test]
    fn empty_and_transport_failures_are_retried_once_but_auth_and_context_are_not() {
        assert!(retryable_model_error("xAI request failed: overloaded"));
        assert!(retryable_model_error("error decoding response body"));
        assert!(retryable_model_error("the model stream closed"));
        assert!(!retryable_model_error("Stopped."));
        assert!(!retryable_model_error(
            "Grok CLI login expired. Run grok login."
        ));
        assert!(!retryable_model_error("xAI rejected the API key."));
        assert!(!retryable_model_error(
            "This model's maximum context length was exceeded"
        ));
    }

    #[test]
    fn a_grok_outage_holds_the_turn_and_a_decode_error_does_not() {
        let grok = "xAI request failed: Service temporarily unavailable. The model did not respond to this request.";
        assert!(provider_outage(grok));
        assert!(provider_outage("xAI error 503: unavailable"));
        assert!(provider_outage("xAI error 403: "));
        assert!(provider_outage("xAI error 403:"));
        assert!(!provider_outage("xAI error 403: permission denied"));
        assert!(provider_outage("xAI request failed: error sending request"));
        assert!(!provider_outage("error decoding response body"));
        assert!(!provider_outage("Stopped."));
        assert!(!provider_outage("Grok CLI login expired. Run grok login."));
        assert!(!provider_outage("xAI rejected the API key."));
        assert_eq!(twanagent_service::provider_retry_pause(0).as_secs(), 2);
        assert_eq!(twanagent_service::provider_retry_pause(3).as_secs(), 16);
        assert_eq!(twanagent_service::provider_retry_pause(9).as_secs(), 30);
    }

    #[test]
    fn int_arg_reads_string_and_number_line_counts() {
        let args = parse_args(r#"{"offset":"10","limit":51}"#);
        assert_eq!(int_arg(&args, "offset"), Some(10));
        assert_eq!(int_arg(&args, "limit"), Some(51));
        assert_eq!(int_arg(&args, "missing"), None);
    }
}
