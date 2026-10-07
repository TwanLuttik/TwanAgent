mod dev;
mod error;
mod grok_cli;
mod image;
mod paths;
mod perf;
mod pty;
mod secrets;
mod state;
mod store;
mod usage;
mod workspace;

use tauri::Manager;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
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
            usage::dev_usage_record,
            usage::dev_usage_list,
            usage::dev_usage_db_info,
            usage::dev_usage_db_reset,
            image::dev_prepare_image,
            image::dev_prepare_image_path,
            image::dev_image_data_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TwanAgent");
}
