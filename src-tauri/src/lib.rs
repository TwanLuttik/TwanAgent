mod anthropic;
mod appdb;
mod remote;
mod dev;
mod error;
mod grok_cli;
mod image;
mod paths;
mod perf;
mod pty;
mod secrets;
mod speech;
mod state;
mod store;
mod usage;
mod workspace;

use std::path::PathBuf;

use tauri::Manager;

use state::AppState;

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
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            state::app_version,
            perf::app_perf_snapshot,
            dev::keys::dev_key_status,
            dev::keys::dev_runtime,
            dev::keys::dev_cli_info,
            dev::keys::dev_set_key,
            dev::keys::dev_clear_key,
            dev::keys::dev_anthropic_key_status,
            dev::keys::dev_set_anthropic_key,
            dev::keys::dev_clear_anthropic_key,
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
            dev::commands::dev_read_file,
            dev::commands::dev_read_user_mcp,
            dev::commands::dev_write_user_mcp,
            dev::commands::dev_open_user_mcp,
            dev::commands::dev_mcp_auth_names,
            dev::commands::dev_mcp_clear_auth,
            dev::commands::dev_mcp_sign_in,
            dev::commands::dev_list_skill_files,
            dev::commands::dev_read_user_skill,
            dev::commands::dev_open_user_skill,
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
            dev::commands::dev_git_switch,
            dev::commands::dev_run_command,
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
            grok_cli::dev_grok_plan,
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
            remote::commands::dev_workspace_remote,
            appdb::dev_app_list_projects,
            appdb::dev_app_add_project,
            appdb::dev_app_remove_project,
            appdb::dev_app_get_setting,
            appdb::dev_app_set_setting,
            usage::dev_usage_record,
            usage::dev_usage_list,
            usage::dev_usage_db_info,
            usage::dev_usage_db_reset,
            usage::dev_usage_db_open,
            image::dev_prepare_image,
            image::dev_prepare_image_path,
            image::dev_image_data_url,
            speech::dev_microphone_info,
            speech::dev_microphone_ready,
            speech::dev_speech_models,
            speech::dev_speech_download,
            speech::dev_transcribe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TwanAgent");
}
