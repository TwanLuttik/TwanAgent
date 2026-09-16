use std::path::Path;

/// Slash-separated path without a Windows `\\?\` prefix or trailing slash.
pub fn slash_path(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        s = if let Some(unc) = rest.strip_prefix("UNC/") {
            format!("//{unc}")
        } else {
            rest.to_string()
        };
    }
    while s.len() > 1 && s.ends_with('/') {
        if s.len() == 3 && s.as_bytes()[1] == b':' {
            break;
        }
        s.pop();
    }
    s
}

/// Relative path from `root` to `path`, using `/`, or `None` if `path` is not under `root`.
/// An exact match returns `Some("")`.
pub fn relative_to(root: &Path, path: &Path) -> Option<String> {
    let root_s = slash_path(root);
    let path_s = slash_path(path);
    let root_cmp = root_s.to_ascii_lowercase();
    let path_cmp = path_s.to_ascii_lowercase();
    if path_cmp == root_cmp {
        return Some(String::new());
    }
    let prefix = format!("{root_cmp}/");
    if !path_cmp.starts_with(&prefix) {
        return None;
    }
    let start = root_s.len() + 1;
    if start <= path_s.len() {
        Some(path_s[start..].to_string())
    } else {
        Some(path_cmp[prefix.len()..].to_string())
    }
}

pub fn is_under(path: &Path, root: &Path) -> bool {
    relative_to(root, path).is_some()
}

pub fn same_dir(a: &Path, b: &Path) -> bool {
    matches!(relative_to(a, b), Some(rel) if rel.is_empty())
}

/// Persist a location source with native separators and no trailing slash.
pub fn native_source(source: &str) -> String {
    let s = slash_path(Path::new(source.trim()));
    if cfg!(windows) {
        s.replace('/', "\\")
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn slash_path_strips_extended_prefix_and_backslashes() {
        assert_eq!(
            slash_path(Path::new(r"\\?\C:\Users\me\Docs")),
            "C:/Users/me/Docs"
        );
        assert_eq!(
            slash_path(Path::new(r"C:\Users\me\Docs\")),
            "C:/Users/me/Docs"
        );
        assert_eq!(
            slash_path(Path::new(r"\\?\UNC\server\share\file")),
            "//server/share/file"
        );
    }

    #[test]
    fn relative_to_handles_mixed_windows_forms() {
        let root = Path::new(r"C:\Users\me\Docs");
        assert_eq!(relative_to(root, root).as_deref(), Some(""));
        assert_eq!(
            relative_to(root, Path::new(r"C:\Users\me\Docs\photos\a.jpg")).as_deref(),
            Some("photos/a.jpg")
        );
        assert_eq!(
            relative_to(root, Path::new(r"\\?\C:\Users\me\Docs\notes.txt")).as_deref(),
            Some("notes.txt")
        );
        assert_eq!(
            relative_to(root, Path::new(r"c:\users\me\docs\A.TXT")).as_deref(),
            Some("A.TXT")
        );
        assert_eq!(
            relative_to(root, Path::new(r"C:\Users\me\Other\a.txt")),
            None
        );
    }

    #[test]
    fn native_source_drops_trailing_slash() {
        assert_eq!(native_source("/Users/me/Docs/"), "/Users/me/Docs");
        assert_eq!(
            native_source(r"C:\Users\me\Docs\"),
            native_source(r"C:\Users\me\Docs")
        );
    }
}
