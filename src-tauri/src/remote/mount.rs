use std::path::{Path, PathBuf};
use std::process::Command;

use super::config::{validate_remote_path, Machine};
use super::ssh::shell_single_quote;
use crate::error::{Error, Result};

pub fn sshfs_available() -> bool {
    Command::new("sshfs")
        .arg("-V")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

pub fn mount_spec(machine: &Machine, remote_path: &str) -> Result<String> {
    let remote = validate_remote_path(remote_path)?;
    let user = super::config::validate_user(&machine.user)?;
    let host = super::config::validate_host(&machine.host)?;
    Ok(format!("{user}@{host}:{remote}"))
}

pub fn sshfs_args(machine: &Machine, remote_path: &str, mount_point: &Path) -> Result<Vec<String>> {
    if !cfg!(target_os = "macos") {
        return Err(Error::Other(
            "folder mounts are available on macOS in this version".into(),
        ));
    }
    let spec = mount_spec(machine, remote_path)?;
    let point = mount_point.to_string_lossy().to_string();
    if point.is_empty() {
        return Err(Error::Other("mount path is empty".into()));
    }
    Ok(vec![
        spec,
        point,
        "-o".into(),
        format!("port={}", machine.port),
        "-o".into(),
        "reconnect".into(),
        "-o".into(),
        "follow_symlinks".into(),
        "-o".into(),
        "volname=TwanAgent".into(),
    ])
}

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

pub fn mount_sshfs(machine: &Machine, remote_path: &str, mount_point: &Path) -> Result<()> {
    if !sshfs_available() {
        return Err(Error::Other(
            "sshfs is not installed. Install macFUSE and sshfs, then try again.".into(),
        ));
    }
    ensure_mount_point(mount_point)?;
    let args = sshfs_args(machine, remote_path, mount_point)?;
    let out = Command::new("sshfs").args(&args).output().map_err(|e| {
        Error::Other(format!("could not start sshfs: {e}"))
    })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err.trim();
        return Err(Error::Other(if msg.is_empty() {
            "sshfs failed".into()
        } else {
            msg.chars().take(400).collect()
        }));
    }
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
    use crate::remote::config::{AuthMethod, Machine};

    fn machine() -> Machine {
        Machine {
            id: "m".into(),
            name: "Box".into(),
            user: "dev".into(),
            host: "example.com".into(),
            port: 2222,
            auth: AuthMethod::Agent,
            key_path: None,
            secret_account: None,
            created_at: "now".into(),
        }
    }

    #[test]
    fn mount_args_point_at_the_remote_project() {
        let args = sshfs_args(&machine(), "/srv/apps/billing/", Path::new("/tmp/mounts/p")).unwrap();
        assert_eq!(args[0], "dev@example.com:/srv/apps/billing");
        assert_eq!(args[1], "/tmp/mounts/p");
        assert!(args.iter().any(|arg| arg == "port=2222"));
        assert!(mkdir_remote_command("/srv/apps/billing").unwrap().contains("'/srv/apps/billing'"));
        assert!(sshfs_args(&machine(), "relative", Path::new("/tmp/m")).is_err());
    }
}
