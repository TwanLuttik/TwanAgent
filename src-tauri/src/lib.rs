mod model_providers;
mod access;
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
mod process;
mod pty;
mod secrets;
mod speech;
mod state;
mod store;
mod update;
mod usage;
mod web_search;
mod command_surface;
mod window;
mod workspace;

use tauri::Manager;

use state::AppState;
use window::isolate_data_dir;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = isolate_data_dir(app.path().app_data_dir()?);
            std::fs::create_dir_all(&data_dir)?;
            let state = AppState::load(data_dir);
            // Resolve saved folder grants before any file command can trip a new prompt.
            access::restore_all(&state.data_dir);
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
            window::restore_window_size(app, &state.data_dir);
            let data_dir = state.data_dir.clone();
            app.manage(state);
            if let Some(window) = app.get_webview_window("main") {
                let data_dir = data_dir.clone();
                window.clone().on_window_event(move |event| {
                    if let tauri::WindowEvent::Resized(size) = event {
                        window::note_window_resize(&window, &data_dir, *size);
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
            dev::keys::dev_cli_update,
            dev::keys::dev_set_key,
            dev::keys::dev_clear_key,
            dev::keys::dev_anthropic_key_status,
            dev::keys::dev_set_anthropic_key,
            dev::keys::dev_clear_anthropic_key,
            dev::keys::dev_minimax_key_status,
            dev::keys::dev_set_minimax_key,
            dev::keys::dev_clear_minimax_key,
            dev::commands::project_cmds::dev_projects_root,
            dev::commands::project_cmds::dev_projects_location,
            dev::commands::project_cmds::dev_list_projects,
            dev::commands::project_cmds::dev_opened_workspaces,
            dev::commands::project_cmds::dev_forget_workspace,
            dev::commands::project_cmds::dev_open_folder,
            dev::commands::project_cmds::dev_suggest_folders,
            dev::commands::project_cmds::dev_create_project,
            dev::commands::project_cmds::dev_delete_project,
            dev::commands::project_cmds::dev_project_removal,
            dev::commands::project_cmds::dev_delete_project_worktrees,
            dev::commands::project_cmds::dev_clone_repo,
            dev::commands::file_cmds::dev_tree_signature,
            dev::commands::file_cmds::dev_list_dir,
            dev::commands::file_cmds::dev_grep,
            dev::commands::file_cmds::dev_glob,
            dev::commands::file_cmds::dev_read_file,
            dev::commands::file_cmds::dev_read_pdf,
            dev::commands::file_cmds::dev_read_user_mcp,
            dev::commands::file_cmds::dev_write_user_mcp,
            dev::commands::file_cmds::dev_open_user_mcp,
            dev::commands::file_cmds::dev_mcp_auth_names,
            dev::commands::file_cmds::dev_mcp_clear_auth,
            dev::commands::file_cmds::dev_mcp_sign_in,
            dev::commands::file_cmds::dev_list_skill_files,
            dev::commands::file_cmds::dev_read_user_skill,
            dev::commands::file_cmds::dev_write_user_skill,
            dev::commands::file_cmds::dev_resolve_file,
            dev::commands::file_cmds::dev_existing_files,
            dev::commands::file_cmds::dev_file_preview,
            dev::commands::file_cmds::dev_rename_path,
            dev::commands::file_cmds::dev_move_paths,
            dev::commands::file_cmds::dev_delete_paths,
            dev::commands::file_cmds::dev_create_dir,
            dev::commands::file_cmds::dev_write_file,
            dev::commands::file_cmds::dev_edit_file,
            dev::commands::git_cmds::dev_git_status,
            dev::commands::git_cmds::dev_git_diff,
            dev::commands::git_cmds::dev_git_branches,
            dev::commands::git_cmds::dev_git_summary,
            dev::commands::git_cmds::dev_git_project_summary,
            dev::commands::git_cmds::dev_git_switch,
            dev::commands::git_cmds::dev_git_create_branch,
            dev::commands::git_cmds::dev_git_stage,
            dev::commands::git_cmds::dev_git_unstage,
            dev::commands::git_cmds::dev_git_discard,
            dev::commands::git_cmds::dev_git_commit,
            dev::commands::git_cmds::dev_git_identity,
            dev::commands::git_cmds::dev_git_set_identity,
            dev::commands::git_cmds::dev_git_sync,
            dev::commands::git_cmds::dev_git_stash,
            dev::commands::git_cmds::dev_git_log,
            dev::commands::git_cmds::dev_git_show,
            dev::commands::git_cmds::dev_git_file_at,
            dev::commands::git_cmds::dev_git_worktrees,
            dev::commands::git_cmds::dev_git_pull_requests,
            dev::commands::git_cmds::dev_git_pull_requests_cached,
            dev::commands::git_cmds::dev_git_pull_request_checkout,
            dev::commands::git_cmds::dev_git_worktree_add,
            dev::commands::git_cmds::dev_git_worktree_rename,
            dev::commands::git_cmds::dev_git_worktree_remove,
            dev::commands::shell_cmds::dev_run_command,
            dev::commands::shell_cmds::dev_stop_command,
            dev::commands::shell_cmds::dev_open_url,
            dev::commands::shell_cmds::dev_reveal_folder,
            dev::conv::dev_sidebar_snapshot,
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
            dev::local_turn::dev_local_turn_start,
            dev::local_turn::dev_local_turn_stop,
            dev::local_turn::dev_local_turns,
            dev::local_turn::dev_local_turn_shell,
            dev::local_turn::dev_local_turn_plan,
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
            remote::hosted::dev_usage_sync,
            remote::hosted::dev_hosted_sidebar_cached,
            remote::hosted::dev_hosted_conversation_cached,
            appdb::commands::dev_app_list_projects,
            appdb::commands::dev_app_add_project,
            appdb::commands::dev_app_reorder_projects,
            appdb::commands::dev_app_remove_project,
            appdb::commands::dev_app_get_setting,
            appdb::commands::dev_app_set_setting,
            anthropic::dev_account_usage,
            anthropic::dev_account_usage_cached,
            minimax::dev_minimax_account_usage,
            minimax::dev_minimax_account_usage_cached,
            grok_cli::dev_xai_account_usage,
            grok_cli::dev_xai_account_usage_cached,
            usage::dev_usage_record,
            usage::dev_usage_list,
            usage::dev_usage_cloud,
            usage::dev_usage_for_conversation,
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
