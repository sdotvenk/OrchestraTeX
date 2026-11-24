mod commands;

use commands::agent::AgentManagerState;
use commands::fs::{ProjectState, WatcherState};
use commands::latex::LaTeXCompilationState;
use commands::terminal::PtyState;
use std::sync::Mutex;
use tauri::webview::WebviewWindowBuilder;
use tauri::{Manager, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

fn is_external_url(url: &url::Url, dev_port: u16) -> bool {
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return false;
    }

    let host = url.host_str().unwrap_or("");
    let port = url.port();

    if host == "localhost" || host == "127.0.0.1" {
        if let Some(p) = port {
            return p != dev_port;
        }
        return false;
    }

    host != "tauri.localhost"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(PtyState::default())
        .manage(AgentManagerState::default())
        .manage(LaTeXCompilationState::default())
        .manage(Mutex::new(WatcherState::default()))
        .manage(Mutex::new(ProjectState::default()))
        .invoke_handler(tauri::generate_handler![
            commands::fs::set_project_path,
            commands::fs::read_file,
            commands::fs::read_file_bytes,
            commands::fs::copy_file_to_path,
            commands::fs::import_external_file,
            commands::fs::write_file,
            commands::fs::get_file_tree,
            commands::fs::watch_directory,
            commands::fs::stop_watch,
            commands::fs::create_file,
            commands::fs::create_latex_project,
            commands::fs::create_directory,
            commands::fs::rename_path,
            commands::fs::delete_path,
            commands::git::git_status,
            commands::git::git_branch_pull_request,
            commands::git::git_open_branch_pull_request,
            commands::git::git_merge_thread_worktree,
            commands::git::git_log,
            commands::git::git_graph,
            commands::git::git_diff,
            commands::git::git_discard_all,
            commands::git::git_discard_file,
            commands::git::git_unstage,
            commands::git::git_add,
            commands::git::git_commit,
            commands::git::git_fetch,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_init,
            commands::git::git_clone,
            commands::git::git_add_remote,
            commands::git::gh_check,
            commands::git::gh_auth_login,
            commands::git::gh_create_repo,
            commands::checkpoints::checkpoint_create,
            commands::checkpoints::checkpoint_list,
            commands::checkpoints::checkpoint_diff,
            commands::checkpoints::checkpoint_restore,
            commands::checkpoints::checkpoint_create_label,
            commands::checkpoints::checkpoint_list_labels,
            commands::checkpoints::checkpoint_delete_label,
            commands::checkpoints::checkpoint_reverse_hunk,
            commands::terminal::spawn_pty,
            commands::terminal::write_pty,
            commands::terminal::resize_pty,
            commands::terminal::kill_pty,
            commands::agent::agent_list_providers,
            commands::agent::agent_refresh_rate_limits,
            commands::agent::agent_list_threads,
            commands::agent::agent_list_all_threads,
            commands::agent::agent_load_thread,
            commands::agent::agent_create_thread,
            commands::agent::agent_create_worktree,
            commands::agent::agent_update_thread,
            commands::agent::agent_delete_thread,
            commands::agent::agent_fork_thread,
            commands::agent::agent_send_message,
            commands::agent::agent_steer_turn,
            commands::agent::agent_interrupt_turn,
            commands::agent::agent_compact_thread,
            commands::agent::agent_respond_interaction,
            commands::agent::agent_one_shot_prompt,
            commands::agent::agent_query_usage_log,
            commands::agent::agent_delegate_thread,
            commands::agent::agent_set_thread_schedule,
            commands::agent::agent_run_due_schedules,
            commands::agent::agent_shutdown_all,
            commands::latex::latex_detect_compilers,
            commands::latex::latex_detect_main_file,
            commands::latex::latex_compile,
            commands::latex::latex_stop_compilation,
            commands::latex::latex_clean_aux_files,
            commands::latex::latex_synctex_edit,
            commands::latex::latex_synctex_view,
            commands::latex::latex_install_synctex,
            commands::latex::latex_get_distributions,
            commands::latex::latex_install,
            commands::latex::latex_open_download_page,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            let webview_url = if cfg!(debug_assertions) {
                WebviewUrl::External("http://localhost:3000".parse().unwrap())
            } else {
                WebviewUrl::App("index.html".into())
            };

            let mut builder = WebviewWindowBuilder::new(app, "main", webview_url)
                .title("OrchestraTeX")
                .inner_size(1400.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .resizable(true)
                .center();

            let opener_handle = app_handle.clone();
            builder = builder.on_navigation(move |url| {
                if is_external_url(url, 3000) {
                    let url_str = url.to_string();
                    let handle = opener_handle.clone();
                    std::thread::spawn(move || {
                        let _ = handle.opener().open_url(&url_str, None::<&str>);
                    });
                    return false;
                }
                true
            });

            let _window = builder.build()?;

            #[cfg(debug_assertions)]
            _window.open_devtools();

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<AgentManagerState>();
            tauri::async_runtime::block_on(state.shutdown_all());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_url(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn external_https_url_is_external() {
        assert!(is_external_url(&parse_url("https://example.com"), 3000));
    }

    #[test]
    fn localhost_same_port_is_not_external() {
        assert!(!is_external_url(&parse_url("http://localhost:3000"), 3000));
    }

    #[test]
    fn localhost_different_port_is_external() {
        assert!(is_external_url(&parse_url("http://localhost:4000"), 3000));
    }

    #[test]
    fn tauri_localhost_is_not_external() {
        assert!(!is_external_url(
            &parse_url("https://tauri.localhost"),
            3000
        ));
    }

    #[test]
    fn non_http_scheme_is_not_external() {
        assert!(!is_external_url(&parse_url("ftp://example.com"), 3000));
        assert!(!is_external_url(&parse_url("tauri://localhost"), 3000));
    }

    #[test]
    fn ip_127_same_port_is_not_external() {
        assert!(!is_external_url(&parse_url("http://127.0.0.1:3000"), 3000));
    }

    #[test]
    fn ip_127_different_port_is_external() {
        assert!(is_external_url(&parse_url("http://127.0.0.1:4000"), 3000));
    }
}
