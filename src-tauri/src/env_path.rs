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
    for part in prefixes.iter().map(String::as_str).chain(current.split(':')) {
        if part.is_empty() || !seen.insert(part.to_string()) {
            continue;
        }
        out.push(part.to_string());
    }
    out.join(":")
}

fn installed_path_prefixes() -> Vec<String> {
    let mut prefixes = Vec::new();
    if let Some(home) = home_dir() {
        for rel in [".local/share/pnpm", "Library/pnpm", ".local/bin"] {
            push_dir(&mut prefixes, home.join(rel));
        }
    }
    for extra in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
        push_dir(&mut prefixes, PathBuf::from(extra));
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
    fn merge_command_path_puts_developer_bins_first_without_duplicates() {
        let merged = merge_command_path(
            "/usr/bin:/bin:/opt/homebrew/bin",
            &["/opt/homebrew/bin".into(), "/Users/me/Library/pnpm".into()],
        );
        assert_eq!(
            merged,
            "/opt/homebrew/bin:/Users/me/Library/pnpm:/usr/bin:/bin"
        );
    }
}
