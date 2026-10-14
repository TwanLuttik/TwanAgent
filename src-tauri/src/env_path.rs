use std::path::PathBuf;

/// GUI apps start with a short PATH, so developer tools are missing even when a shell can see them.
pub(crate) fn command_path() -> String {
    merge_command_path(
        &std::env::var("PATH").unwrap_or_default(),
        &installed_path_prefixes(),
    )
}

pub(crate) fn merge_command_path(current: &str, prefixes: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for part in prefixes
        .iter()
        .map(PathBuf::from)
        .chain(std::env::split_paths(current))
    {
        let spelling = part.to_string_lossy().into_owned();
        let key = if cfg!(windows) {
            spelling.to_lowercase()
        } else {
            spelling.clone()
        };
        // Empty entries search the working directory. Invalid additions cannot form a PATH entry.
        if spelling.is_empty() || std::env::join_paths([&part]).is_err() || !seen.insert(key) {
            continue;
        }
        out.push(part);
    }
    std::env::join_paths(out)
        .expect("validated PATH entries")
        .to_string_lossy()
        .into_owned()
}

fn installed_path_prefixes() -> Vec<String> {
    let mut prefixes = Vec::new();
    #[cfg(windows)]
    {
        // pnpm, npm global installs, and native CLI/Rust installers use these user directories.
        if let Some(path) = std::env::var_os("PNPM_HOME") {
            push_dir(&mut prefixes, PathBuf::from(path));
        }
        for (variable, rel) in [("LOCALAPPDATA", "pnpm"), ("APPDATA", "npm")] {
            if let Some(base) = std::env::var_os(variable) {
                push_dir(&mut prefixes, PathBuf::from(base).join(rel));
            }
        }
        if let Some(home) = home_dir() {
            for rel in [".local/bin", ".cargo/bin"] {
                push_dir(&mut prefixes, home.join(rel));
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = home_dir() {
            for rel in [".local/share/pnpm", "Library/pnpm", ".local/bin"] {
                push_dir(&mut prefixes, home.join(rel));
            }
        }
        for extra in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
            push_dir(&mut prefixes, PathBuf::from(extra));
        }
    }
    prefixes
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn push_dir(prefixes: &mut Vec<String>, path: PathBuf) {
    if path.is_dir() {
        prefixes.push(path.to_string_lossy().into_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(windows))]
    fn merge_command_path_puts_developer_bins_first_without_duplicates() {
        let merged = merge_command_path(
            "/usr/bin:/bin:/opt/homebrew/bin",
            &[
                "/opt/homebrew/bin".into(),
                "/home/<user>/Library/pnpm".into(),
            ],
        );
        assert_eq!(
            merged,
            "/opt/homebrew/bin:/home/<user>/Library/pnpm:/usr/bin:/bin"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_preserves_drives_and_first_spelling() {
        let merged = merge_command_path(
            r#"C:\Windows\System32;;d:\TOOLS;"C:\Program Files\nodejs";D:\Tools;"#,
            &[r"D:\Tools".into(), r"C:\Bins".into()],
        );
        assert_eq!(
            merged,
            r"D:\Tools;C:\Bins;C:\Windows\System32;C:\Program Files\nodejs"
        );
        assert_eq!(std::env::split_paths(&merged).count(), 4);
    }

    #[test]
    fn empty_path_and_prefixes_do_not_search_the_current_directory() {
        assert_eq!(merge_command_path("", &["".into()]), "");
        let dir = tempfile::tempdir().unwrap();
        let prefix = dir.path().to_string_lossy().into_owned();
        assert_eq!(
            merge_command_path("", &[prefix.clone(), prefix.clone()]),
            prefix
        );
    }
}
