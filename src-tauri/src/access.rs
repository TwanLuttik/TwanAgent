//! macOS remembers a folder only when the app keeps a security-scoped bookmark.
//! A saved path is not enough: the next read of Desktop, Documents, or Downloads
//! asks again. The bookmark is created while the user still has the folder open
//! from the picker, then resolved on the next launch so the prompt does not return.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;

const BOOKMARK_FILE: &str = "folder-bookmarks.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredBookmark {
    path: String,
    /// Base64 bookmark data. Empty on platforms that do not use security scope.
    data: String,
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use apple_scoped_bookmarks::Bookmark;

    use super::StoredBookmark;
    use crate::error::{Error, Result};

    /// Resolved bookmarks must stay alive. Dropping them stops the grant.
    static GRANTS: Mutex<Vec<Grant>> = Mutex::new(Vec::new());

    struct Grant {
        path: PathBuf,
        _access: apple_scoped_bookmarks::ScopedAccess,
    }

    pub fn save(data_dir: &Path, root: &Path, rows: &[StoredBookmark]) -> Result<()> {
        let path = root.to_string_lossy().into_owned();
        if rows.iter().any(|row| same_path(&row.path, &path) && !row.data.is_empty()) {
            return Ok(());
        }
        let bookmark = Bookmark::create(root).map_err(|err| {
            Error::Other(format!("could not keep access to {}: {err}", root.display()))
        })?;
        let mut next: Vec<StoredBookmark> = rows
            .iter()
            .filter(|row| !same_path(&row.path, &path))
            .cloned()
            .collect();
        next.push(StoredBookmark {
            path: crate::paths::native_source(&path),
            data: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bookmark.as_bytes()),
        });
        next.sort_by(|a, b| a.path.cmp(&b.path));
        super::write_rows(data_dir, &next)
    }

    pub fn restore(data_dir: &Path, rows: &[StoredBookmark]) {
        let mut kept = Vec::new();
        let mut changed = false;
        for row in rows {
            if row.data.is_empty() {
                changed = true;
                continue;
            }
            let bytes = match base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                row.data.trim(),
            ) {
                Ok(bytes) => bytes,
                Err(_) => {
                    changed = true;
                    continue;
                }
            };
            let bookmark = Bookmark::from_bytes(bytes);
            match bookmark.resolve() {
                Ok(access) => {
                    let resolved = access.path().to_path_buf();
                    let stored = if access.is_stale() {
                        match Bookmark::create(&resolved) {
                            Ok(fresh) => base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                fresh.as_bytes(),
                            ),
                            Err(err) => {
                                eprintln!("could not refresh folder access for {}: {err}", resolved.display());
                                row.data.clone()
                            }
                        }
                    } else {
                        row.data.clone()
                    };
                    if stored != row.data
                        || crate::paths::native_source(&resolved.to_string_lossy()) != row.path
                    {
                        changed = true;
                    }
                    kept.push(StoredBookmark {
                        path: crate::paths::native_source(&resolved.to_string_lossy()),
                        data: stored,
                    });
                    hold(resolved, access);
                }
                Err(err) => {
                    changed = true;
                    eprintln!("could not restore folder access for {}: {err}", row.path);
                }
            }
        }
        if changed {
            let _ = super::write_rows(data_dir, &kept);
        }
    }

    pub fn release(root: &Path) {
        let Ok(mut grants) = GRANTS.lock() else {
            return;
        };
        grants.retain(|grant| !same_dir(&grant.path, root));
    }

    fn hold(path: PathBuf, access: apple_scoped_bookmarks::ScopedAccess) {
        let Ok(mut grants) = GRANTS.lock() else {
            return;
        };
        grants.retain(|grant| !same_dir(&grant.path, &path));
        grants.push(Grant {
            path,
            _access: access,
        });
    }

    fn same_dir(left: &Path, right: &Path) -> bool {
        same_path(
            &left.to_string_lossy(),
            &right.to_string_lossy(),
        )
    }

    fn same_path(left: &str, right: &str) -> bool {
        crate::paths::native_source(left).eq_ignore_ascii_case(&crate::paths::native_source(right))
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use std::path::Path;

    use super::StoredBookmark;
    use crate::error::Result;

    pub fn save(_data_dir: &Path, _root: &Path, _rows: &[StoredBookmark]) -> Result<()> {
        Ok(())
    }

    pub fn restore(_data_dir: &Path, _rows: &[StoredBookmark]) {}

    pub fn release(_root: &Path) {}
}

/// Create a bookmark for a folder the user just approved, and start using it.
/// A second call for the same folder does nothing.
pub fn remember(data_dir: &Path, root: &Path) -> Result<()> {
    let rows = read_rows(data_dir);
    platform::save(data_dir, root, &rows)
}

/// Resolve every saved bookmark before any file command runs.
pub fn restore_all(data_dir: &Path) {
    platform::restore(data_dir, &read_rows(data_dir));
}

/// Drop the grant when the user removes the folder.
pub fn forget(data_dir: &Path, root: &Path) -> Result<()> {
    platform::release(root);
    let path = root.to_string_lossy();
    let rows: Vec<StoredBookmark> = read_rows(data_dir)
        .into_iter()
        .filter(|row| !same_stored(&row.path, &path))
        .collect();
    write_rows(data_dir, &rows)
}

fn same_stored(left: &str, right: &str) -> bool {
    crate::paths::native_source(left).eq_ignore_ascii_case(&crate::paths::native_source(right))
}

fn read_rows(data_dir: &Path) -> Vec<StoredBookmark> {
    let Ok(raw) = fs::read_to_string(data_dir.join(BOOKMARK_FILE)) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_rows(data_dir: &Path, rows: &[StoredBookmark]) -> Result<()> {
    fs::create_dir_all(data_dir)?;
    let tmp = data_dir.join("folder-bookmarks.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(rows)?)?;
    #[cfg(windows)]
    {
        let dest = data_dir.join(BOOKMARK_FILE);
        if dest.exists() {
            fs::remove_file(&dest)?;
        }
    }
    fs::rename(tmp, data_dir.join(BOOKMARK_FILE))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forget_removes_only_the_named_folder() {
        let data = tempfile::tempdir().unwrap();
        write_rows(
            data.path(),
            &[
                StoredBookmark {
                    path: "/Users/me/Documents/keep".into(),
                    data: "aaa".into(),
                },
                StoredBookmark {
                    path: "/Users/me/Desktop/gone".into(),
                    data: "bbb".into(),
                },
            ],
        )
        .unwrap();
        forget(data.path(), Path::new("/Users/me/Desktop/gone")).unwrap();
        let rows = read_rows(data.path());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "/Users/me/Documents/keep");
    }
}
