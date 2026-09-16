mod dev;
mod error;
mod grok_cli;
mod paths;
mod pty;
mod secrets;
mod state;
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
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            state::app_version,
            dev::dev_key_status,
            dev::dev_runtime,
            dev::dev_set_key,
            dev::dev_clear_key,
            dev::dev_projects_root,
            dev::dev_list_projects,
            dev::dev_open_folder,
            dev::dev_suggest_folders,
            dev::dev_create_project,
            dev::dev_clone_repo,
            dev::dev_list_dir,
            dev::dev_read_file,
            dev::dev_resolve_file,
            dev::dev_write_file,
            dev::dev_edit_file,
            dev::dev_git_status,
            dev::dev_git_diff,
            dev::dev_git_branches,
            dev::dev_git_switch,
            dev::dev_run_command,
            dev::dev_list_conversations,
            dev::dev_get_conversation,
            dev::dev_save_conversation,
            dev::dev_reorder_conversations,
            dev::dev_delete_conversation,
            dev::dev_chat_start,
            dev::dev_chat_cancel,
            pty::dev_pty_open,
            pty::dev_pty_open_grok,
            pty::dev_pty_write,
            pty::dev_pty_write_bytes,
            pty::dev_pty_resize,
            pty::dev_pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TwanAgent");
}
