use std::fs;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::paths::is_under;

pub fn resolve_in_workspace(root: &Path, rel: &str) -> Result<PathBuf> {
    let root =
        fs::canonicalize(root).map_err(|_| Error::Other("workspace folder is missing".into()))?;
    if !root.is_dir() {
        return Err(Error::Other("workspace is not a folder".into()));
    }
    let rel = normalize_rel(rel)?;
    if rel.as_os_str().is_empty() {
        return Ok(root);
    }
    let joined = root.join(&rel);
    if let Ok(canon) = fs::canonicalize(&joined) {
        ensure_inside(&root, &canon)?;
        return Ok(canon);
    }
    let mut ancestor = joined.parent().unwrap_or(root.as_path()).to_path_buf();
    let mut missing = vec![joined
        .file_name()
        .ok_or_else(|| Error::Other("invalid path".into()))?
        .to_os_string()];
    while !ancestor.exists() {
        if let Some(name) = ancestor.file_name() {
            missing.push(name.to_os_string());
        }
        match ancestor.parent() {
            Some(parent) => ancestor = parent.to_path_buf(),
            None => break,
        }
    }
    let ancestor = fs::canonicalize(&ancestor).unwrap_or_else(|_| root.clone());
    ensure_inside(&root, &ancestor)?;
    missing.reverse();
    let mut out = ancestor;
    for part in missing {
        out.push(part);
    }
    ensure_inside(&root, &out)?;
    Ok(out)
}

fn normalize_rel(rel: &str) -> Result<PathBuf> {
    if rel.contains('\0') {
        return Err(Error::Other("invalid path".into()));
    }
    let trimmed = rel.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(PathBuf::new());
    }
    if trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || Path::new(trimmed).is_absolute()
        || (trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':')
    {
        return Err(Error::Other(
            "path must be relative to the workspace".into(),
        ));
    }
    let path = Path::new(trimmed);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                if !out.pop() {
                    return Err(Error::Other("path is outside the workspace".into()));
                }
            }
            _ => {
                return Err(Error::Other(
                    "path must be relative to the workspace".into(),
                ))
            }
        }
    }
    Ok(out)
}

fn ensure_inside(root: &Path, path: &Path) -> Result<()> {
    if path == root || is_under(path, root) {
        Ok(())
    } else {
        Err(Error::Other("path is outside the workspace".into()))
    }
}

pub(crate) fn workspace_id(root: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(root.as_bytes());
    hex::encode(&hasher.finalize()[..8])
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub(crate) fn path_string(path: &Path) -> String {
    crate::paths::native_source(&path.to_string_lossy())
}

pub(crate) fn resolve_typed_path(raw: &str) -> Result<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Error::Other("folder path is empty".into()));
    }
    if trimmed.contains('\0') {
        return Err(Error::Other("invalid path".into()));
    }
    let mut path = if trimmed == "~" {
        home_dir().ok_or_else(|| Error::Other("home folder is unknown".into()))?
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        home_dir()
            .ok_or_else(|| Error::Other("home folder is unknown".into()))?
            .join(rest)
    } else if let Some(rest) = trimmed.strip_prefix("~\\") {
        home_dir()
            .ok_or_else(|| Error::Other("home folder is unknown".into()))?
            .join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    if !path.is_absolute() {
        if let Some(home) = home_dir() {
            let under_home = home.join(&path);
            if under_home.is_dir() {
                path = under_home;
            }
        }
    }
    Ok(path)
}

pub fn expand_folder_path(raw: &str) -> Result<PathBuf> {
    let path = resolve_typed_path(raw)?;
    let canon = fs::canonicalize(&path)
        .map_err(|_| Error::Other(format!("folder not found: {}", path.display())))?;
    if !canon.is_dir() {
        return Err(Error::Other("not a folder".into()));
    }
    Ok(canon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_ws() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn rejects_parent_escape() {
        let dir = temp_ws();
        let err = resolve_in_workspace(dir.path(), "../secret").unwrap_err();
        assert!(err.to_string().contains("outside"));
    }

    #[test]
    fn rejects_absolute_path() {
        let dir = temp_ws();
        let err = resolve_in_workspace(dir.path(), "/etc/passwd").unwrap_err();
        assert!(err.to_string().contains("relative"));
    }

    #[test]
    fn allows_nested_and_dot_segments() {
        let dir = temp_ws();
        fs::create_dir_all(dir.path().join("src/lib")).unwrap();
        fs::write(dir.path().join("src/lib/mod.rs"), "ok").unwrap();
        let path = resolve_in_workspace(dir.path(), "src/./lib/mod.rs").unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "ok");
    }

    #[test]
    fn expand_folder_path_requires_an_existing_dir() {
        let dir = temp_ws();
        let path = expand_folder_path(dir.path().to_str().unwrap()).unwrap();
        assert!(path.is_dir());
        let missing = dir.path().join("nope");
        assert!(expand_folder_path(missing.to_str().unwrap()).is_err());
        let file = dir.path().join("file.txt");
        fs::write(&file, "x").unwrap();
        assert!(expand_folder_path(file.to_str().unwrap()).is_err());
    }

    #[test]
    fn expand_tilde_uses_home() {
        let dir = temp_ws();
        let prev = std::env::var_os("HOME");
        unsafe { std::env::set_var("HOME", dir.path()) };
        fs::create_dir_all(dir.path().join("code")).unwrap();
        let got = expand_folder_path("~/code").unwrap();
        assert_eq!(got, fs::canonicalize(dir.path().join("code")).unwrap());
        match prev {
            Some(v) => unsafe { std::env::set_var("HOME", v) },
            None => unsafe { std::env::remove_var("HOME") },
        }
    }

    #[test]
    fn symlink_escape_is_rejected() {
        let dir = temp_ws();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "nope").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = dir.path().join("out");
            symlink(outside.path(), &link).unwrap();
            let err = resolve_in_workspace(dir.path(), "out/secret.txt").unwrap_err();
            assert!(err.to_string().contains("outside"));
        }
        #[cfg(not(unix))]
        {
            let _ = secret;
        }
    }
}
