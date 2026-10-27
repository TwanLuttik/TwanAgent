//! One file backend for a workspace command.
//!
//! A local project uses the disk. A server project runs the same operation over SSH.
//! Callers ask for a workspace once instead of branching on every command.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::Digest;

use super::files;
use super::types::{DevEntry, FilePreview, TreeSnapshot};
use crate::error::{Error, Result};
use crate::remote::config::{Machine, RemoteProject};
use crate::remote::ssh::Pool;
use crate::state::AppState;

pub(crate) enum WorkspaceFiles {
    Local { root: PathBuf },
    Remote(RemoteFiles),
}

pub(crate) struct RemoteFiles {
    machine: Machine,
    project: RemoteProject,
    pool: Arc<Pool>,
    secret: Option<String>,
}

impl WorkspaceFiles {
    pub(crate) fn open(state: &AppState, workspace: &str) -> Result<Self> {
        let root = state.require_workspace(workspace)?;
        Self::for_root(state, root)
    }

    pub(crate) fn for_root(state: &AppState, root: PathBuf) -> Result<Self> {
        if let Some(remote) = remote_files(state, &root)? {
            return Ok(Self::Remote(remote));
        }
        Ok(Self::Local { root })
    }

    pub(crate) fn list(&self, rel: &str) -> Result<Vec<DevEntry>> {
        match self {
            Self::Local { root } => files::list_dir(root, rel),
            Self::Remote(remote) => remote.list(rel),
        }
    }

    pub(crate) fn grep(&self, pattern: &str, rel: &str, glob: &str) -> Result<String> {
        match self {
            Self::Local { root } => files::grep(root, pattern, rel, glob),
            Self::Remote(remote) => remote.grep(pattern, rel, glob),
        }
    }

    pub(crate) fn glob(&self, pattern: &str, rel: &str) -> Result<String> {
        match self {
            Self::Local { root } => files::glob(root, pattern, rel),
            Self::Remote(remote) => remote.glob(pattern, rel),
        }
    }

    pub(crate) fn read(&self, rel: &str) -> Result<String> {
        match self {
            Self::Local { root } => files::read_file(root, rel),
            Self::Remote(remote) => remote.read(rel),
        }
    }

    pub(crate) fn read_pdf(&self, rel: &str) -> Result<String> {
        match self {
            Self::Local { root } => files::read_pdf_base64(root, rel),
            Self::Remote(_) => Err(Error::Other("Open this PDF from a local project.".into())),
        }
    }

    pub(crate) fn tree(&self) -> Result<TreeSnapshot> {
        match self {
            Self::Local { root } => files::tree_snapshot(root),
            Self::Remote(remote) => remote.tree_snapshot(),
        }
    }

    pub(crate) fn preview(&self, rel: &str) -> Result<FilePreview> {
        match self {
            Self::Local { root } => files::file_preview(root, rel),
            Self::Remote(_) => Err(Error::Other("this project lives on a server".into())),
        }
    }

    pub(crate) fn existing(&self, paths: &[String]) -> Result<Vec<String>> {
        match self {
            Self::Local { root } => Ok(files::existing_files(root, paths)),
            Self::Remote(_) => Ok(Vec::new()),
        }
    }

    pub(crate) fn resolve(&self, rel: &str) -> Result<String> {
        match self {
            Self::Local { root } => files::resolve_file(root, rel),
            Self::Remote(_) => Err(Error::Other("this project lives on a server".into())),
        }
    }

    pub(crate) fn rename(&self, rel: &str, name: &str) -> Result<String> {
        match self {
            Self::Local { root } => files::rename_path(root, rel, name),
            Self::Remote(remote) => remote.rename(rel, name),
        }
    }

    pub(crate) fn move_paths(&self, paths: &[String], dest: &str) -> Result<Vec<String>> {
        let mut moved = Vec::new();
        for path in paths {
            let name = std::path::Path::new(path.trim_matches('/'))
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .ok_or_else(|| Error::Other("invalid path".into()))?;
            let to = if dest.trim_matches('/').is_empty() {
                name
            } else {
                format!("{}/{}", dest.trim_matches('/'), name)
            };
            moved.push(match self {
                Self::Local { root } => files::move_path(root, path, &to)?,
                Self::Remote(remote) => remote.move_path(path, &to)?,
            });
        }
        Ok(moved)
    }

    pub(crate) fn delete(&self, paths: &[String]) -> Result<()> {
        match self {
            Self::Local { root } => files::delete_paths(root, paths),
            Self::Remote(remote) => remote.delete(paths),
        }
    }

    pub(crate) fn create_dir(&self, parent: &str, name: &str) -> Result<String> {
        match self {
            Self::Local { root } => files::create_dir(root, parent, name),
            Self::Remote(remote) => remote.create_dir(parent, name),
        }
    }

    pub(crate) fn write(&self, rel: &str, contents: &str) -> Result<()> {
        match self {
            Self::Local { root } => files::write_file(root, rel, contents),
            Self::Remote(remote) => remote.write(rel, contents),
        }
    }

    pub(crate) fn edit(&self, rel: &str, old: &str, new: &str) -> Result<()> {
        match self {
            Self::Local { root } => files::edit_file(root, rel, old, new),
            Self::Remote(remote) => remote.edit(rel, old, new),
        }
    }
}

fn remote_files(state: &AppState, root: &Path) -> Result<Option<RemoteFiles>> {
    let Some(project) = crate::remote::project_for_workspace(state, root)? else {
        return Ok(None);
    };
    let conn = crate::appdb::open(&state.data_dir)?;
    let machine = crate::remote::config::machine_by_id(&conn, &project.machine_id)?
        .ok_or_else(|| Error::NotFound("machine not found".into()))?;
    let secret = machine
        .secret_account
        .as_deref()
        .and_then(crate::secrets::get_ssh_secret);
    Ok(Some(RemoteFiles {
        machine,
        project,
        pool: state.ssh_pool.clone(),
        secret,
    }))
}

impl RemoteFiles {
    fn exec(&self, command: &str) -> Result<String> {
        self.exec_at(&self.project.remote_path, command)
    }

    fn exec_at(&self, cwd: &str, command: &str) -> Result<String> {
        let out = self.pool.exec(
            &self.machine,
            self.secret.as_deref(),
            &crate::remote::ssh::ExecRequest {
                cwd: cwd.to_string(),
                command: command.to_string(),
                timeout_secs: 60,
            },
        )?;
        if out.exit_code.is_some_and(|code| code != 0) {
            let err = if out.stderr.is_empty() { out.stdout } else { out.stderr };
            return Err(Error::Other(err.trim().chars().take(300).collect()));
        }
        Ok(out.stdout)
    }

    fn grep(&self, pattern: &str, rel: &str, glob: &str) -> Result<String> {
        let command = crate::remote::files::remote_grep_command(&self.project.remote_path, pattern, rel, glob)?;
        self.exec_at("/", &command)
    }

    fn glob(&self, pattern: &str, rel: &str) -> Result<String> {
        let command = crate::remote::files::remote_glob_command(&self.project.remote_path, pattern, rel)?;
        self.exec_at("/", &command)
    }

    fn read(&self, rel: &str) -> Result<String> {
        let command = crate::remote::files::remote_read_command(&self.project.remote_path, rel)?;
        self.exec(&command)
    }

    fn write(&self, rel: &str, contents: &str) -> Result<()> {
        if contents.len() > 2_000_000 {
            return Err(Error::Other("write is larger than 2000000 bytes".into()));
        }
        let script = crate::remote::files::remote_write_script(&self.project.remote_path, rel)?;
        // File bytes stay base64 inside single quotes. They are not interpolated into the shell.
        self.exec(&crate::remote::files::remote_write_shell(contents, &script))?;
        Ok(())
    }

    fn edit(&self, rel: &str, old: &str, new: &str) -> Result<()> {
        if old.is_empty() {
            return Err(Error::Other("old_string is empty".into()));
        }
        let current = self.read(rel)?;
        let matches = current.matches(old).count();
        if matches == 0 {
            return Err(Error::Other("old_string was not found".into()));
        }
        if matches > 1 {
            return Err(Error::Other(format!(
                "old_string matched {matches} times — make it unique"
            )));
        }
        self.write(rel, &current.replacen(old, new, 1))
    }

    fn tree_snapshot(&self) -> Result<TreeSnapshot> {
        let command = crate::remote::files::remote_tree_command(&self.project.remote_path)?;
        let text = self.exec_at("/", &command)?;
        let rows = crate::remote::files::parse_remote_tree(&text);
        let mut hasher = sha2::Sha256::new();
        let mut dirs = Vec::new();
        for (path, dir) in &rows {
            hasher.update(if *dir { b"d\t" } else { b"f\t" });
            hasher.update(path.as_bytes());
            hasher.update(b"\n");
            if *dir {
                dirs.push(path.clone());
            }
        }
        Ok(TreeSnapshot {
            signature: hex::encode(hasher.finalize()),
            dirs,
            files: rows
                .iter()
                .filter(|(_, dir)| !dir)
                .map(|(path, _)| path.clone())
                .collect(),
        })
    }

    fn rename(&self, rel: &str, name: &str) -> Result<String> {
        let (command, dest) =
            crate::remote::files::remote_rename_command(&self.project.remote_path, rel, name)?;
        if !command.is_empty() {
            self.exec(&command)?;
        }
        Ok(dest)
    }

    fn move_path(&self, from: &str, to: &str) -> Result<String> {
        let (command, dest) =
            crate::remote::files::remote_move_command(&self.project.remote_path, from, to)?;
        if !command.is_empty() {
            self.exec(&command)?;
        }
        Ok(dest)
    }

    fn delete(&self, rels: &[String]) -> Result<()> {
        let command = crate::remote::files::remote_delete_command(&self.project.remote_path, rels)?;
        self.exec(&command)?;
        Ok(())
    }

    fn create_dir(&self, parent: &str, name: &str) -> Result<String> {
        let (command, rel) =
            crate::remote::files::remote_mkdir_command(&self.project.remote_path, parent, name)?;
        self.exec(&command)?;
        Ok(rel)
    }

    fn list(&self, rel: &str) -> Result<Vec<DevEntry>> {
        let command = crate::remote::files::remote_list_command(&self.project.remote_path, rel)?;
        // The command already names the remote folder. Don't cd into it first: a missing folder would fail the cd.
        let text = self.exec_at("/", &command)?;
        Ok(crate::remote::files::parse_remote_list(&text, rel)
            .into_iter()
            .map(|(path, dir)| {
                let name = std::path::Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone());
                DevEntry {
                    name,
                    path,
                    kind: if dir { "dir" } else { "file" }.into(),
                    size: None,
                }
            })
            .collect())
    }
}

