use std::path::{Path, PathBuf};
use std::process::Command;

use super::config::validate_remote_path;
use super::ssh::shell_single_quote;
use crate::error::{Error, Result};

pub fn mkdir_remote_command(remote_path: &str) -> Result<String> {
    let remote = validate_remote_path(remote_path)?;
    Ok(format!("mkdir -p {}", shell_single_quote(&remote)))
}

pub fn mount_dir(data_dir: &Path, project_id: &str) -> PathBuf {
    super::config::mount_point(data_dir, project_id)
}

pub fn ensure_mount_point(path: &Path) -> Result<()> {
    if path.exists() && !path.is_dir() {
        return Err(Error::Other("mount path is not a folder".into()));
    }
    std::fs::create_dir_all(path)?;
    Ok(())
}

pub fn unmount(mount_point: &Path) -> Result<()> {
    if !mount_point.exists() {
        return Ok(());
    }
    let out = if cfg!(target_os = "macos") {
        Command::new("diskutil")
            .args(["unmount", "force"])
            .arg(mount_point)
            .output()
    } else {
        Command::new("umount").arg(mount_point).output()
    };
    match out {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            if err.to_ascii_lowercase().contains("not currently mounted")
                || err.to_ascii_lowercase().contains("not a mount point")
            {
                return Ok(());
            }
            Err(Error::Other(err.trim().chars().take(300).collect()))
        }
        Err(e) => Err(Error::Other(format!("could not unmount: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_mkdir_quotes_the_project_path() {
        assert!(mkdir_remote_command("/srv/apps/billing").unwrap().contains("'/srv/apps/billing'"));
        assert!(mkdir_remote_command("relative").is_err());
    }
}
