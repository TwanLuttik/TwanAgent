//! Main window size. Restored before the window is shown, saved on resize.
//! Debug builds use a sibling data directory so `tauri dev` cannot rewrite a release install.

use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::appdb;

const WINDOW_SIZE_KEY: &str = "window.size";
const WINDOW_MAXIMIZED_KEY: &str = "window.maximized";
const WINDOW_MIN_WIDTH: f64 = 880.0;
const WINDOW_MIN_HEIGHT: f64 = 560.0;

/// `"1100x740"` from the settings table. Empty when it was never saved or cannot be read.
fn saved_window_size(data_dir: &Path) -> Option<(f64, f64)> {
    let conn = appdb::open(data_dir).ok()?;
    let raw = appdb::get_setting(&conn, WINDOW_SIZE_KEY).ok()??;
    parse_window_size(&raw)
}

pub(crate) fn parse_window_size(raw: &str) -> Option<(f64, f64)> {
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

fn save_window_size(data_dir: &Path, width: f64, height: f64) {
    let Some((width, height)) = parse_window_size(&format!("{width}x{height}")) else {
        return;
    };
    let Ok(conn) = appdb::open(data_dir) else {
        return;
    };
    let _ = appdb::set_setting(&conn, WINDOW_SIZE_KEY, &format!("{width}x{height}"));
}

fn saved_window_maximized(data_dir: &Path) -> bool {
    let Ok(conn) = appdb::open(data_dir) else {
        return false;
    };
    appdb::get_setting(&conn, WINDOW_MAXIMIZED_KEY)
        .ok()
        .flatten()
        .as_deref()
        == Some("1")
}

fn save_window_maximized(data_dir: &Path, maximized: bool) {
    let Ok(conn) = appdb::open(data_dir) else {
        return;
    };
    let _ = appdb::set_setting(&conn, WINDOW_MAXIMIZED_KEY, if maximized { "1" } else { "0" });
}

/// The last session's size, applied before the window is shown so it does not open and then jump.
pub(crate) fn restore_window_size(app: &tauri::App, data_dir: &Path) {
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

/// Remember the size after a resize. A minimized window reports 0×0 and is ignored.
/// A maximized frame is not saved: the restored size is what should come back.
pub(crate) fn note_window_resize(window: &tauri::WebviewWindow, data_dir: &Path, size: tauri::PhysicalSize<u32>) {
    if size.width == 0 || size.height == 0 {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    save_window_maximized(data_dir, maximized);
    if maximized {
        return;
    }
    // The event is in physical pixels. The config size is in points, so a
    // Retina display has to be scaled back or the window grows every launch.
    let scale = window.scale_factor().unwrap_or(1.0);
    if scale <= 0.0 {
        return;
    }
    save_window_size(data_dir, f64::from(size.width) / scale, f64::from(size.height) / scale);
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

