use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::paths::is_under;

const OPENED_FILE: &str = "opened-workspaces.json";
const OPENED_CAP: usize = 40;

#[derive(Debug, Default, Clone)]
pub struct OpenedRoots {
    roots: HashSet<PathBuf>,
    projects_dir: Option<PathBuf>,
}

impl OpenedRoots {
    pub fn new(projects_dir: Option<PathBuf>) -> Self {
        Self {
            roots: HashSet::new(),
            projects_dir,
        }
    }

    pub fn load(data_dir: &Path, projects_dir: PathBuf) -> Self {
        let mut opened = Self::new(Some(projects_dir));
        let path = data_dir.join(OPENED_FILE);
        let Ok(raw) = fs::read_to_string(&path) else {
            return opened;
        };
        let Ok(rows) = serde_json::from_str::<Vec<String>>(&raw) else {
            return opened;
        };
        for row in rows {
            if let Ok(canon) = fs::canonicalize(&row) {
                if canon.is_dir() {
                    opened.roots.insert(canon);
                }
            }
        }
        opened
    }

    pub fn persist(&self, data_dir: &Path) -> Result<()> {
        fs::create_dir_all(data_dir)?;
        let mut rows: Vec<String> = self
            .roots
            .iter()
            .map(|p| crate::paths::native_source(&p.to_string_lossy()))
            .collect();
        rows.sort();
        if rows.len() > OPENED_CAP {
            rows.truncate(OPENED_CAP);
        }
        let tmp = data_dir.join("opened-workspaces.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&rows)?)?;
        #[cfg(windows)]
        {
            let dest = data_dir.join(OPENED_FILE);
            if dest.exists() {
                fs::remove_file(&dest)?;
            }
        }
        fs::rename(tmp, data_dir.join(OPENED_FILE))?;
        Ok(())
    }

    pub fn register(&mut self, root: &Path) -> Result<PathBuf> {
        let canon = fs::canonicalize(root)
            .map_err(|_| Error::Other("workspace folder is missing".into()))?;
        if !canon.is_dir() {
            return Err(Error::Other("workspace is not a folder".into()));
        }
        self.roots.insert(canon.clone());
        Ok(canon)
    }

    pub fn is_allowed(&self, root: &Path) -> bool {
        let Ok(canon) = fs::canonicalize(root) else {
            return false;
        };
        if self.roots.iter().any(|r| r == &canon) {
            return true;
        }
        let Some(projects) = self.projects_dir.as_ref() else {
            return false;
        };
        let Ok(projects) = fs::canonicalize(projects) else {
            return false;
        };
        if !projects.is_dir() {
            return false;
        }
        is_under(&canon, &projects) && canon != projects
    }

    pub fn require(&self, workspace: &str) -> Result<PathBuf> {
        let trimmed = workspace.trim();
        if trimmed.is_empty() {
            return Err(Error::Other("workspace folder is missing".into()));
        }
        let canon = fs::canonicalize(trimmed)
            .map_err(|_| Error::Other("workspace folder is missing".into()))?;
        if !canon.is_dir() {
            return Err(Error::Other("workspace is not a folder".into()));
        }
        if !self.is_allowed(&canon) {
            return Err(Error::Other("folder is not an opened workspace".into()));
        }
        Ok(canon)
    }

    pub fn iter(&self) -> impl Iterator<Item = &PathBuf> {
        self.roots.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unopened_folder() {
        let opened = OpenedRoots::new(None);
        let dir = tempfile::tempdir().unwrap();
        assert!(!opened.is_allowed(dir.path()));
        let err = opened.require(dir.path().to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("not an opened workspace"));
    }

    #[test]
    fn allows_registered_folder() {
        let mut opened = OpenedRoots::new(None);
        let dir = tempfile::tempdir().unwrap();
        let got = opened.register(dir.path()).unwrap();
        assert!(opened.is_allowed(&got));
        assert_eq!(
            opened.require(dir.path().to_str().unwrap()).unwrap(),
            got
        );
    }

    #[test]
    fn allows_projects_dir_children_only() {
        let projects = tempfile::tempdir().unwrap();
        let child = projects.path().join("app");
        fs::create_dir(&child).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let opened = OpenedRoots::new(Some(projects.path().to_path_buf()));
        assert!(opened.is_allowed(&child));
        assert!(!opened.is_allowed(projects.path()));
        assert!(!opened.is_allowed(outside.path()));
    }

    #[test]
    fn persist_roundtrip_skips_missing_folders() {
        let data = tempfile::tempdir().unwrap();
        let projects = tempfile::tempdir().unwrap();
        let keep = tempfile::tempdir().unwrap();
        let gone = tempfile::tempdir().unwrap();
        let gone_path = gone.path().to_path_buf();
        let mut opened = OpenedRoots::new(Some(projects.path().to_path_buf()));
        opened.register(keep.path()).unwrap();
        opened.register(&gone_path).unwrap();
        opened.persist(data.path()).unwrap();
        drop(gone);
        let loaded = OpenedRoots::load(data.path(), projects.path().to_path_buf());
        assert!(loaded.is_allowed(keep.path()));
        assert!(!loaded.is_allowed(&gone_path));
    }
}
