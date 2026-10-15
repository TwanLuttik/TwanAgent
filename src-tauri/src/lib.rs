mod model_providers;
mod appdb;
mod remote;
mod dev;
mod env_path;
mod error;

pub use model_providers::anthropic;
pub use model_providers::grok_cli;
pub use model_providers::minimax;
mod image;
mod paths;
mod perf;
mod pty;
mod secrets;
mod speech;
mod state;
mod store;
mod update;
mod usage;
mod web_search;
mod workspace;

use std::path::PathBuf;

use tauri::Manager;

use state::AppState;

const WINDOW_SIZE_KEY: &str = "window.size";
const WINDOW_MAXIMIZED_KEY: &str = "window.maximized";
const WINDOW_MIN_WIDTH: f64 = 880.0;
const WINDOW_MIN_HEIGHT: f64 = 560.0;

/// `"1100x740"` from the settings table. Empty when it was never saved or cannot be read.
fn saved_window_size(data_dir: &std::path::Path) -> Option<(f64, f64)> {
    let conn = appdb::open(data_dir).ok()?;
    let raw = appdb::get_setting(&conn, WINDOW_SIZE_KEY).ok()??;
    parse_window_size(&raw)
}

fn parse_window_size(raw: &str) -> Option<(f64, f64)> {
    let (width, height) = raw.trim().split_once('x')?;
    let width: f64 = width.trim().parse().ok()?;
    let height: f64 = height.trim().parse().ok()?;
    if !width.is_finite() || !height.is_finite() {
        return None;
    }
    if width < WINDOW_MIN_WIDTH || height < WINDOW_MIN_HEIGHT {
        return None;
    }
    Some((width, height))
}

fn save_window_size(data_dir: &std::path::Path, width: f64, height: f64) {
    let Some((width, height)) = parse_window_size(&format!("{width}x{height}")) else {
        return;
    };
    let Ok(conn) = appdb::open(data_dir) else {
        return;
    };
    let _ = appdb::set_setting(&conn, WINDOW_SIZE_KEY, &format!("{width}x{height}"));
}

fn saved_window_maximized(data_dir: &std::path::Path) -> bool {
    let Ok(conn) = appdb::open(data_dir) else {
        return false;
    };
    appdb::get_setting(&conn, WINDOW_MAXIMIZED_KEY)
        .ok()
        .flatten()
        .as_deref()
        == Some("1")
}

fn save_window_maximized(data_dir: &std::path::Path, maximized: bool) {
    let Ok(conn) = appdb::open(data_dir) else {
        return;
    };
    let _ = appdb::set_setting(&conn, WINDOW_MAXIMIZED_KEY, if maximized { "1" } else { "0" });
}

/// The last session's size, applied before the window is shown so it does not open and then jump.
fn restore_window_size(app: &tauri::App, data_dir: &std::path::Path) {
    let Some((width, height)) = saved_window_size(data_dir) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
    nudge_window_on_screen(&window);
    if saved_window_maximized(data_dir) {
        let _ = window.maximize();
    }
}

/// Moves the window back only when the restored size leaves it outside the monitor.
fn nudge_window_on_screen(window: &tauri::WebviewWindow) {
    let Ok(monitor) = window.current_monitor() else {
        return;
    };
    let Some(monitor) = monitor else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let area = monitor.position();
    let screen = monitor.size();
    let margin = 40;
    let max_x = area.x + screen.width as i32 - margin;
    let max_y = area.y + screen.height as i32 - margin;
    let fits = position.x < max_x
        && position.y < max_y
        && position.x + size.width as i32 > area.x
        && position.y + size.height as i32 > area.y;
    if !fits {
        let _ = window.center();
    }
}

/// Debug runs keep their own app data so `tauri dev` cannot read or rewrite a release install.
pub(crate) fn isolate_data_dir(dir: PathBuf) -> PathBuf {
    if !cfg!(debug_assertions) {
        return dir;
    }
    let name = dir
        .file_name()
        .map(|name| format!("{}-dev", name.to_string_lossy()))
        .unwrap_or_else(|| "app.twanagent.desktop-dev".into());
    dir.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_size_rejects_a_missing_or_too_small_value() {
        assert_eq!(parse_window_size("1280x800"), Some((1280.0, 800.0)));
        assert_eq!(parse_window_size(" 1440 x 900 "), Some((1440.0, 900.0)));
        assert_eq!(parse_window_size(""), None);
        assert_eq!(parse_window_size("1100"), None);
        assert_eq!(parse_window_size("400x300"), None);
        assert_eq!(parse_window_size("nanx800"), None);
    }

    #[test]
    fn debug_data_dir_is_a_sibling_of_the_release_dir() {
        let release = PathBuf::from("/Users/me/Library/Application Support/app.twanagent.desktop");
        let got = isolate_data_dir(release.clone());
        if cfg!(debug_assertions) {
            assert_eq!(
                got,
                PathBuf::from("/Users/me/Library/Application Support/app.twanagent.desktop-dev")
            );
            assert_ne!(got, release);
        } else {
            assert_eq!(got, release);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = isolate_data_dir(app.path().app_data_dir()?);
            std::fs::create_dir_all(&data_dir)?;
            let state = AppState::load(data_dir);
            state.allow_persisted_assets(app);
            let attachments = state.data_dir.join("attachments");
            std::fs::create_dir_all(&attachments)?;
            let _ = app
                .asset_protocol_scope()
                .allow_directory(&attachments, true);
            let space_corner = state.data_dir.join(image::SPACE_CORNER_DIR);
            std::fs::create_dir_all(&space_corner)?;
            let _ = app
                .asset_protocol_scope()
                .allow_directory(&space_corner, true);
            restore_window_size(app, &state.data_dir);
            let data_dir = state.data_dir.clone();
            app.manage(state);
            if let Some(window) = app.get_webview_window("main") {
                let data_dir = data_dir.clone();
                let window = window.clone();
                window.clone().on_window_event(move |event| {
                    if let tauri::WindowEvent::Resized(size) = event {
                        // A minimized window reports 0×0. Saving that would reopen the app tiny.
                        if size.width == 0 || size.height == 0 {
                            return;
                        }
                        let maximized = window.is_maximized().unwrap_or(false);
                        save_window_maximized(&data_dir, maximized);
                        // The maximized frame fills the screen. The restored size is what we want back.
                        if maximized {
                            return;
                        }
                        // The event is in physical pixels. The config size is in points, so a
                        // Retina display has to be scaled back or the window grows every launch.
                        let scale = window.scale_factor().unwrap_or(1.0);
                        if scale <= 0.0 {
                            return;
                        }
                        save_window_size(&data_dir, f64::from(size.width) / scale, f64::from(size.height) / scale);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            state::app_version,
            state::app_dev_build,
            update::app_update_check,
            update::app_update_install,
            update::app_update_relaunch,
            perf::app_perf_snapshot,
            dev::keys::dev_key_status,
            dev::keys::dev_runtime,
            dev::keys::dev_runtime_cached,
            dev::keys::dev_cli_info,
            dev::keys::dev_claude_cli_info,
            dev::keys::dev_minimax_cli_info,
            dev::keys::dev_set_key,
            dev::keys::dev_clear_key,
            dev::keys::dev_anthropic_key_status,
            dev::keys::dev_set_anthropic_key,
            dev::keys::dev_clear_anthropic_key,
            dev::keys::dev_minimax_key_status,
            dev::keys::dev_set_minimax_key,
            dev::keys::dev_clear_minimax_key,
            dev::commands::dev_projects_root,
            dev::commands::dev_projects_location,
            dev::commands::dev_list_projects,
            dev::commands::dev_opened_workspaces,
            dev::commands::dev_forget_workspace,
            dev::commands::dev_open_folder,
            dev::commands::dev_suggest_folders,
            dev::commands::dev_create_project,
            dev::commands::dev_delete_project,
            dev::commands::dev_clone_repo,
            dev::commands::dev_tree_signature,
            dev::commands::dev_list_dir,
            dev::commands::dev_grep,
            dev::commands::dev_glob,
            dev::commands::dev_read_file,
            dev::commands::dev_read_pdf,
            dev::commands::dev_read_user_mcp,
            dev::commands::dev_write_user_mcp,
            dev::commands::dev_open_user_mcp,
            dev::commands::dev_mcp_auth_names,
            dev::commands::dev_mcp_clear_auth,
            dev::commands::dev_mcp_sign_in,
            dev::commands::dev_list_skill_files,
            dev::commands::dev_read_user_skill,
            dev::commands::dev_write_user_skill,
            dev::commands::dev_resolve_file,
            dev::commands::dev_existing_files,
            dev::commands::dev_file_preview,
            dev::commands::dev_rename_path,
            dev::commands::dev_move_paths,
            dev::commands::dev_delete_paths,
            dev::commands::dev_create_dir,
            dev::commands::dev_write_file,
            dev::commands::dev_edit_file,
            dev::commands::dev_git_status,
            dev::commands::dev_git_diff,
            dev::commands::dev_git_branches,
            dev::commands::dev_git_summary,
            dev::commands::dev_git_project_summary,
            dev::commands::dev_git_switch,
            dev::commands::dev_git_create_branch,
            dev::commands::dev_git_stage,
            dev::commands::dev_git_unstage,
            dev::commands::dev_git_discard,
            dev::commands::dev_git_commit,
            dev::commands::dev_git_identity,
            dev::commands::dev_git_set_identity,
            dev::commands::dev_git_sync,
            dev::commands::dev_git_stash,
            dev::commands::dev_git_log,
            dev::commands::dev_git_show,
            dev::commands::dev_git_file_at,
            dev::commands::dev_run_command,
            dev::commands::dev_stop_command,
            dev::commands::dev_open_url,
            dev::commands::dev_reveal_folder,
            dev::conv::dev_list_conversations,
            dev::conv::dev_get_conversation,
            dev::conv::dev_save_conversation,
            dev::conv::dev_reorder_conversations,
            dev::conv::dev_delete_conversation,
            dev::conv::dev_archive_conversation,
            dev::conv::dev_list_journeys,
            dev::conv::dev_create_journey,
            dev::conv::dev_rename_journey,
            dev::conv::dev_delete_journey,
            dev::conv::dev_set_journey_collapsed,
            dev::conv::dev_set_journey_color,
            dev::conv::dev_move_conversation,
            dev::conv::dev_reorder_sidebar,
            dev::conv::dev_get_journey_knowledge,
            dev::conv::dev_save_journey_knowledge,
            dev::conv::dev_update_journey_knowledge,
            dev::chat::dev_chat_start,
            dev::chat::dev_chat_cancel,
            dev::chat::dev_web_search,
            grok_cli::dev_grok_plan,
            grok_cli::dev_grok_plan_edit,
            grok_cli::dev_grok_plan_set,
            grok_cli::dev_grok_plan_write,
            pty::dev_pty_open,
            pty::dev_pty_open_grok,
            pty::dev_pty_write,
            pty::dev_pty_write_bytes,
            pty::dev_pty_resize,
            pty::dev_pty_kill,
            remote::commands::dev_discover_ssh,
            remote::commands::dev_ssh_defaults,
            remote::commands::dev_remote_home,
            remote::commands::dev_list_machines,
            remote::commands::dev_save_machine,
            remote::commands::dev_delete_machine,
            remote::commands::dev_list_remote_projects,
            remote::commands::dev_test_machine,
            remote::commands::dev_accept_host,
            remote::commands::dev_create_remote_project,
            remote::commands::dev_clone_remote_repo,
            remote::commands::dev_workspace_remote,
            remote::commands::dev_warm_workspace_link,
            remote::commands::dev_list_agent_servers,
            remote::commands::dev_probe_agent_server,
            remote::commands::dev_agent_server_status,
            remote::commands::dev_install_agent_binary,
            remote::commands::dev_install_agent_server,
            remote::commands::dev_pair_agent_server,
            remote::commands::dev_remove_agent_server,
            remote::commands::dev_server_storage,
            remote::commands::dev_server_provider_keys,
            remote::commands::dev_copy_server_provider_keys,
            remote::commands::dev_workspace_server_id,
            remote::commands::dev_workspace_capabilities,
            remote::commands::dev_server_capabilities,
            remote::commands::dev_server_projects,
            remote::commands::dev_server_git,
            remote::commands::dev_install_server_git,
            remote::commands::dev_sync_server_capabilities,
            remote::hosted::dev_hosted_turn,
            remote::hosted::dev_hosted_cancel,
            remote::hosted::dev_hosted_shell_answer,
            remote::hosted::dev_hosted_follow,
            remote::hosted::dev_hosted_unfollow,
            remote::hosted::dev_hosted_call,
            remote::hosted::dev_hosted_sidebar_cached,
            remote::hosted::dev_hosted_conversation_cached,
            appdb::dev_app_list_projects,
            appdb::dev_app_add_project,
            appdb::dev_app_reorder_projects,
            appdb::dev_app_remove_project,
            appdb::dev_app_get_setting,
            appdb::dev_app_set_setting,
            anthropic::dev_account_usage,
            anthropic::dev_account_usage_cached,
            minimax::dev_minimax_account_usage,
            minimax::dev_minimax_account_usage_cached,
            usage::dev_usage_record,
            usage::dev_usage_list,
            usage::dev_usage_db_info,
            usage::dev_usage_db_reset,
            usage::dev_usage_db_open,
            image::dev_prepare_image,
            image::dev_prepare_image_path,
            image::dev_image_data_url,
            image::dev_set_space_corner_image,
            image::dev_space_corner_image,
            image::dev_clear_space_corner_image,
            speech::dev_microphone_info,
            speech::dev_microphone_ready,
            speech::dev_speech_models,
            speech::dev_speech_download,
            speech::dev_transcribe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TwanAgent");
}
