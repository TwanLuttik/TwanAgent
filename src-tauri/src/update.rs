//! Check GitHub releases for a newer macOS build, download it, and replace this app.
//!
//! Releases are published as prereleases (`v1.0.0-beta.1`), so `/releases/latest` is the wrong
//! endpoint: it skips every prerelease. The asset is `TwanAgent_<version>_universal.app.tar.gz`.
//! Installing swaps the `.app` this process was launched from, then opens the new copy.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use tar::Archive;

use crate::error::{Error, Result};
use crate::state::AppState;

const RELEASES_URL: &str = "https://api.github.com/repos/TwanLuttik/TwanAgent/releases?per_page=20";
/// A universal macOS build is about 20 MB. Anything past this is not the asset we expect.
const MAX_ARCHIVE_BYTES: u64 = 250 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 800 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppUpdate {
    pub version: String,
    pub tag: String,
    pub name: String,
    pub notes: String,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
struct UpdateProgress {
    received: u64,
    total: u64,
    phase: String,
}

#[derive(Clone, Default)]
pub struct UpdateGate {
    busy: std::sync::Arc<Mutex<bool>>,
}

impl UpdateGate {
    fn enter(&self) -> Result<BusyGuard> {
        let mut busy = self.busy.lock().unwrap_or_else(|err| err.into_inner());
        if *busy {
            return Err(Error::Other("An update is already downloading.".into()));
        }
        *busy = true;
        Ok(BusyGuard { busy: self.busy.clone() })
    }
}

struct BusyGuard {
    busy: std::sync::Arc<Mutex<bool>>,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        if let Ok(mut busy) = self.busy.lock() {
            *busy = false;
        }
    }
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let host = attempt.url().host_str().unwrap_or_default().to_string();
                if download_host_ok(&host) && attempt.previous().len() < 5 {
                    attempt.follow()
                } else {
                    attempt.error(format!("refusing redirect to {host}"))
                }
            }))
            .user_agent(format!("TwanAgent/{}", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(60 * 20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn download_host_ok(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    host == "github.com"
        || host == "objects.githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
        || host == "release-assets.githubusercontent.com"
}

/// `v1.0.0-beta.2+abc` and `1.0.0-beta.2` compare as the same release.
pub fn version_core(raw: &str) -> &str {
    let trimmed = raw.trim().trim_start_matches('v').trim_start_matches('V');
    trimmed.split_once('+').map(|(core, _)| core).unwrap_or(trimmed)
}

/// Numeric compare with prerelease rules: `1.0.0` is newer than `1.0.0-beta.2`.
pub fn version_is_newer(candidate: &str, current: &str) -> bool {
    cmp_versions(version_core(candidate), version_core(current)) == std::cmp::Ordering::Greater
}

fn cmp_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let (left_num, left_pre) = split_prerelease(left);
    let (right_num, right_pre) = split_prerelease(right);
    let len = left_num.len().max(right_num.len());
    for i in 0..len {
        let a = left_num.get(i).copied().unwrap_or(0);
        let b = right_num.get(i).copied().unwrap_or(0);
        match a.cmp(&b) {
            std::cmp::Ordering::Equal => {}
            other => return other,
        }
    }
    match (left_pre, right_pre) {
        (None, None) => std::cmp::Ordering::Equal,
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(a), Some(b)) => cmp_prerelease(a, b),
    }
}

fn split_prerelease(raw: &str) -> (Vec<u64>, Option<&str>) {
    let (num, pre) = raw.split_once('-').map(|(n, p)| (n, Some(p))).unwrap_or((raw, None));
    let parts = num
        .split('.')
        .map(|part| part.chars().take_while(|c| c.is_ascii_digit()).collect::<String>())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect();
    (parts, pre.filter(|part| !part.is_empty()))
}

fn cmp_prerelease(left: &str, right: &str) -> std::cmp::Ordering {
    let left: Vec<&str> = left.split('.').collect();
    let right: Vec<&str> = right.split('.').collect();
    let len = left.len().max(right.len());
    for i in 0..len {
        match (left.get(i).copied(), right.get(i).copied()) {
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (None, None) => return std::cmp::Ordering::Equal,
            (Some(a), Some(b)) => {
                let an = a.parse::<u64>().ok();
                let bn = b.parse::<u64>().ok();
                let order = match (an, bn) {
                    (Some(x), Some(y)) => x.cmp(&y),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => a.cmp(b),
                };
                if order != std::cmp::Ordering::Equal {
                    return order;
                }
            }
        }
    }
    std::cmp::Ordering::Equal
}

#[derive(Debug, Clone)]
struct ReleaseAsset {
    name: String,
    url: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone)]
struct Release {
    tag: String,
    #[allow(dead_code)]
    name: String,
    notes: String,
    draft: bool,
    asset: Option<ReleaseAsset>,
}

/// The newest published release that is ahead of `current` and ships a macOS app archive.
pub fn pick_update(body: &str, current: &str) -> Result<Option<AppUpdate>> {
    let rows = parse_releases(body)?;
    let mut best: Option<Release> = None;
    for row in rows {
        if row.draft || row.asset.is_none() {
            continue;
        }
        if !version_is_newer(&row.tag, current) {
            continue;
        }
        let replace = match &best {
            None => true,
            Some(prev) => version_is_newer(&row.tag, &prev.tag),
        };
        if replace {
            best = Some(row);
        }
    }
    Ok(best.map(|row| {
        let asset = row.asset.expect("filtered");
        AppUpdate {
            version: version_core(&row.tag).to_string(),
            tag: row.tag,
            name: asset.name,
            notes: notes_preview(&row.notes),
            url: asset.url,
            bytes: asset.bytes,
            sha256: asset.sha256,
        }
    }))
}

fn notes_preview(notes: &str) -> String {
    let trimmed = notes.trim();
    trimmed.chars().take(600).collect()
}

fn parse_releases(body: &str) -> Result<Vec<Release>> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| Error::Other("Could not read the release list.".into()))?;
    let Some(rows) = value.as_array() else {
        return Err(Error::Other("Could not read the release list.".into()));
    };
    Ok(rows.iter().filter_map(parse_release).collect())
}

fn parse_release(value: &serde_json::Value) -> Option<Release> {
    let tag = value.get("tag_name")?.as_str()?.trim().to_string();
    if version_core(&tag).is_empty() {
        return None;
    }
    let name = value
        .get("name")
        .and_then(|name| name.as_str())
        .unwrap_or(&tag)
        .trim()
        .to_string();
    let notes = value
        .get("body")
        .and_then(|body| body.as_str())
        .unwrap_or("")
        .to_string();
    let draft = value.get("draft").and_then(|draft| draft.as_bool()).unwrap_or(false);
    let asset = value
        .get("assets")
        .and_then(|assets| assets.as_array())
        .and_then(|assets| assets.iter().find_map(parse_asset));
    Some(Release {
        tag,
        name,
        notes,
        draft,
        asset,
    })
}

fn parse_asset(value: &serde_json::Value) -> Option<ReleaseAsset> {
    let name = value.get("name")?.as_str()?.trim().to_string();
    if !asset_name_ok(&name) {
        return None;
    }
    let url = value.get("browser_download_url")?.as_str()?.trim().to_string();
    if !download_url_ok(&url) {
        return None;
    }
    let bytes = value.get("size")?.as_u64()?;
    if bytes == 0 || bytes > MAX_ARCHIVE_BYTES {
        return None;
    }
    let sha256 = value
        .get("digest")
        .and_then(|digest| digest.as_str())
        .and_then(parse_sha256)
        .unwrap_or_default();
    Some(ReleaseAsset {
        name,
        url,
        bytes,
        sha256,
    })
}

/// `TwanAgent_1.0.0-beta.1_universal.app.tar.gz`, including the build-id form `…+abc_….app.tar.gz`.
pub fn asset_name_ok(name: &str) -> bool {
    let name = name.trim();
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    let Some(rest) = name.strip_prefix("TwanAgent_") else {
        return false;
    };
    rest.ends_with(".app.tar.gz") && rest.len() > ".app.tar.gz".len()
}

pub fn download_url_ok(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw.trim()) else {
        return false;
    };
    if url.scheme() != "https" {
        return false;
    }
    url.host_str().is_some_and(download_host_ok)
}

fn parse_sha256(raw: &str) -> Option<String> {
    let hex = raw.trim().strip_prefix("sha256:").unwrap_or(raw).trim();
    if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

pub async fn fetch_update(current: &str) -> Result<Option<AppUpdate>> {
    let resp = http_client()
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|_| Error::Other("Could not reach GitHub releases.".into()))?;
    if !resp.status().is_success() {
        return Err(Error::Other(format!(
            "Could not read GitHub releases ({}).",
            resp.status()
        )));
    }
    let body = resp
        .text()
        .await
        .map_err(|_| Error::Other("Could not read GitHub releases.".into()))?;
    pick_update(&body, current)
}

fn updates_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("updates")
}

pub async fn download_archive(
    data_dir: &Path,
    update: &AppUpdate,
    on_progress: impl Fn(u64, u64),
) -> Result<PathBuf> {
    if !download_url_ok(&update.url) || !asset_name_ok(&update.name) {
        return Err(Error::Other("That update cannot be downloaded.".into()));
    }
    if update.bytes == 0 || update.bytes > MAX_ARCHIVE_BYTES {
        return Err(Error::Other("That update is larger than expected.".into()));
    }
    let dir = updates_dir(data_dir);
    fs::create_dir_all(&dir)?;
    clear_partials(&dir)?;
    let dest = dir.join(&update.name);
    if dest.parent() != Some(dir.as_path()) {
        return Err(Error::Other("That update cannot be downloaded.".into()));
    }
    let partial = dest.with_extension("partial");
    let mut resp = http_client()
        .get(&update.url)
        .send()
        .await
        .map_err(|_| Error::Other("Could not download the update.".into()))?;
    if !resp.status().is_success() {
        let _ = fs::remove_file(&partial);
        return Err(Error::Other(format!(
            "Could not download the update ({}).",
            resp.status()
        )));
    }
    let mut file = File::create(&partial)?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| Error::Other("Could not download the update.".into()))?
    {
        file.write_all(&chunk)?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        if received > MAX_ARCHIVE_BYTES {
            let _ = fs::remove_file(&partial);
            return Err(Error::Other("The update download was larger than expected.".into()));
        }
        on_progress(received, update.bytes.max(received));
    }
    file.flush()?;
    drop(file);
    let digest = hex::encode(hasher.finalize());
    if !update.sha256.is_empty() && !digest.eq_ignore_ascii_case(&update.sha256) {
        let _ = fs::remove_file(&partial);
        return Err(Error::Other("The update download did not match GitHub.".into()));
    }
    if update.bytes > 0 && received != update.bytes {
        let _ = fs::remove_file(&partial);
        return Err(Error::Other("The update download was incomplete.".into()));
    }
    let _ = fs::remove_file(&dest);
    fs::rename(&partial, &dest)?;
    Ok(dest)
}

fn clear_partials(dir: &Path) -> Result<()> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".partial") || name.ends_with(".app.tar.gz") {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Unpack `TwanAgent.app` out of the gzipped tar. Anything else in the archive is refused.
pub fn unpack_app(archive: &Path, dest_dir: &Path) -> Result<PathBuf> {
    let file = File::open(archive)?;
    let decoder = GzDecoder::new(file);
    let mut tar = Archive::new(decoder);
    fs::create_dir_all(dest_dir)?;
    let app_root = dest_dir.join("TwanAgent.app");
    if app_root.exists() {
        fs::remove_dir_all(&app_root)?;
    }
    let mut unpacked = 0u64;
    let entries = tar
        .entries()
        .map_err(|_| Error::Other("Could not read the update archive.".into()))?;
    for entry in entries {
        let mut entry = entry.map_err(|_| Error::Other("Could not read the update archive.".into()))?;
        let rel = entry
            .path()
            .map_err(|_| Error::Other("Could not read the update archive.".into()))?
            .into_owned();
        if !tar_path_ok(&rel) {
            let _ = fs::remove_dir_all(&app_root);
            return Err(Error::Other("The update archive has an unexpected file.".into()));
        }
        let size = entry.size();
        unpacked = unpacked.saturating_add(size);
        if unpacked > MAX_UNPACKED_BYTES {
            let _ = fs::remove_dir_all(&app_root);
            return Err(Error::Other("The update archive is larger than expected.".into()));
        }
        let dest = dest_dir.join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        if entry.header().entry_type().is_dir() {
            fs::create_dir_all(&dest)?;
            continue;
        }
        if !entry.header().entry_type().is_file() {
            let _ = fs::remove_dir_all(&app_root);
            return Err(Error::Other("The update archive has an unexpected file.".into()));
        }
        let mut out = File::create(&dest)?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|_| Error::Other("Could not unpack the update.".into()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(mode) = entry.header().mode() {
                let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(mode));
            }
        }
    }
    let binary = app_root.join("Contents").join("MacOS").join("twanagent");
    if !binary.is_file() {
        let _ = fs::remove_dir_all(&app_root);
        return Err(Error::Other("The update archive did not contain TwanAgent.".into()));
    }
    Ok(app_root)
}

fn tar_path_ok(path: &Path) -> bool {
    let mut parts = path.components();
    match parts.next() {
        Some(Component::Normal(name)) if name == "TwanAgent.app" => {}
        _ => return false,
    }
    parts.all(|part| matches!(part, Component::Normal(name) if name != ".."))
}

/// The `.app` that contains the running binary. None for `tauri dev` and for a loose binary.
pub fn installed_bundle(exe: &Path) -> Option<PathBuf> {
    let mut cursor = exe;
    while let Some(parent) = cursor.parent() {
        if parent.file_name().is_some_and(|name| name == "Contents") {
            let bundle = parent.parent()?;
            if bundle.extension().is_some_and(|ext| ext == "app") {
                return Some(bundle.to_path_buf());
            }
            return None;
        }
        cursor = parent;
    }
    None
}

pub fn install_bundle(downloaded: &Path, installed: &Path) -> Result<()> {
    if downloaded.file_name().is_none_or(|name| name != "TwanAgent.app") {
        return Err(Error::Other("The update is not a TwanAgent app.".into()));
    }
    if !downloaded.join("Contents/MacOS/twanagent").is_file() {
        return Err(Error::Other("The update is not a TwanAgent app.".into()));
    }
    if installed.extension().is_none_or(|ext| ext != "app") {
        return Err(Error::Other("TwanAgent is not installed as an app.".into()));
    }
    let parent = installed
        .parent()
        .ok_or_else(|| Error::Other("Could not find the installed app.".into()))?;
    let staging = parent.join(".TwanAgent.update.app");
    let backup = parent.join(".TwanAgent.previous.app");
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&backup);
    copy_dir(downloaded, &staging)?;
    if let Err(err) = fs::rename(installed, &backup) {
        let _ = fs::remove_dir_all(&staging);
        return Err(Error::Other(format!("Could not replace TwanAgent: {err}")));
    }
    if let Err(err) = fs::rename(&staging, installed) {
        let _ = fs::rename(&backup, installed);
        let _ = fs::remove_dir_all(&staging);
        return Err(Error::Other(format!("Could not replace TwanAgent: {err}")));
    }
    let _ = fs::remove_dir_all(&backup);
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else if kind.is_symlink() {
            let target = fs::read_link(entry.path())?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &dest)?;
            #[cfg(not(unix))]
            {
                let _ = target;
                return Err(Error::Other("Could not copy the update.".into()));
            }
        } else {
            fs::copy(entry.path(), &dest)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(mode) = entry.metadata().map(|meta| meta.permissions().mode()) {
                    let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(mode));
                }
            }
        }
    }
    Ok(())
}

/// Open the installed app and quit this process. The new copy does not wait on this one.
pub fn relaunch(installed: &Path) -> Result<()> {
    let mut child = Command::new("open");
    child.arg("-n").arg(installed);
    child
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    child
        .spawn()
        .map_err(|err| Error::Other(format!("Could not reopen TwanAgent: {err}")))?;
    std::process::exit(0);
}

fn emit_progress(app: &AppHandle, received: u64, total: u64, phase: &str) {
    let _ = app.emit(
        "app-update",
        UpdateProgress {
            received,
            total,
            phase: phase.into(),
        },
    );
}

#[tauri::command(rename_all = "snake_case")]
pub async fn app_update_check() -> Result<Option<AppUpdate>> {
    if !cfg!(target_os = "macos") {
        return Ok(None);
    }
    fetch_update(env!("CARGO_PKG_VERSION")).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn app_update_install(
    app: AppHandle,
    state: State<'_, AppState>,
    update: AppUpdate,
) -> Result<()> {
    if !cfg!(target_os = "macos") {
        return Err(Error::Other("Updates install on macOS.".into()));
    }
    let _busy = state.updates.enter()?;
    let current = env!("CARGO_PKG_VERSION");
    if !version_is_newer(&update.version, current) {
        return Err(Error::Other("That version is already installed.".into()));
    }
    let exe = std::env::current_exe().map_err(|_| Error::Other("Could not find this app.".into()))?;
    let Some(bundle) = installed_bundle(&exe) else {
        return Err(Error::Other(
            "Install TwanAgent from the app before updating it.".into(),
        ));
    };
    let data_dir = state.data_dir.clone();
    let app_for_progress = app.clone();
    emit_progress(&app, 0, update.bytes, "download");
    let archive = download_archive(&data_dir, &update, |received, total| {
        emit_progress(&app_for_progress, received, total, "download");
    })
    .await?;
    emit_progress(&app, update.bytes, update.bytes, "install");
    let unpacked_dir = updates_dir(&data_dir).join("unpacked");
    let _ = fs::remove_dir_all(&unpacked_dir);
    let downloaded = unpack_app(&archive, &unpacked_dir)?;
    install_bundle(&downloaded, &bundle)?;
    let _ = fs::remove_dir_all(&unpacked_dir);
    let _ = fs::remove_file(&archive);
    emit_progress(&app, update.bytes, update.bytes, "ready");
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn app_update_relaunch() -> Result<()> {
    let exe = std::env::current_exe().map_err(|_| Error::Other("Could not find this app.".into()))?;
    let Some(bundle) = installed_bundle(&exe) else {
        return Err(Error::Other("Install TwanAgent from the app before updating it.".into()));
    };
    relaunch(&bundle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prerelease_is_older_than_the_same_release() {
        assert!(version_is_newer("1.0.0", "1.0.0-beta.2"));
        assert!(version_is_newer("v1.0.0-beta.2", "1.0.0-beta.1"));
        assert!(version_is_newer("1.0.0-beta.10", "1.0.0-beta.2"));
        assert!(!version_is_newer("1.0.0-beta.2", "1.0.0-beta.2"));
        assert!(!version_is_newer("1.0.0-beta.1", "v1.0.0-beta.2+2672518"));
        assert!(!version_is_newer("1.0.0-beta.2+aaaaaaa", "1.0.0-beta.2+bbbbbbb"));
        assert!(version_is_newer("1.1.0", "1.0.9"));
        assert!(!version_is_newer("0.9.0", "1.0.0-beta.1"));
    }

    #[test]
    fn only_the_macos_app_archive_is_an_update() {
        assert!(asset_name_ok("TwanAgent_1.0.0-beta.1_universal.app.tar.gz"));
        assert!(asset_name_ok("TwanAgent_1.0.0-beta.2+2672518_universal.app.tar.gz"));
        assert!(!asset_name_ok("TwanAgent_1.0.0-beta.1_aarch64.dmg"));
        assert!(!asset_name_ok("../TwanAgent_1.0.0.app.tar.gz"));
        assert!(!asset_name_ok("notes.txt"));
    }

    #[test]
    fn downloads_stay_on_github() {
        assert!(download_url_ok(
            "https://github.com/TwanLuttik/TwanAgent/releases/download/v1.0.0-beta.1/TwanAgent_1.0.0-beta.1_universal.app.tar.gz"
        ));
        assert!(download_url_ok(
            "https://release-assets.githubusercontent.com/github-production-release-asset/1"
        ));
        assert!(!download_url_ok("http://github.com/TwanLuttik/TwanAgent/x"));
        assert!(!download_url_ok("https://evil.example/TwanAgent.app.tar.gz"));
        assert!(!download_url_ok("https://github.com.evil.test/x"));
    }

    #[test]
    fn the_newest_published_app_wins() {
        let body = r#"[
          {"tag_name":"v1.0.0-beta.1","name":"old","draft":false,"body":"first","assets":[
            {"name":"TwanAgent_1.0.0-beta.1_universal.app.tar.gz","size":20,"browser_download_url":"https://github.com/TwanLuttik/TwanAgent/releases/download/v1.0.0-beta.1/TwanAgent_1.0.0-beta.1_universal.app.tar.gz","digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
          ]},
          {"tag_name":"v1.0.0-beta.3","name":"new","draft":false,"body":"third","assets":[
            {"name":"TwanAgent_1.0.0-beta.3_universal.app.tar.gz","size":22,"browser_download_url":"https://github.com/TwanLuttik/TwanAgent/releases/download/v1.0.0-beta.3/TwanAgent_1.0.0-beta.3_universal.app.tar.gz","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
          ]},
          {"tag_name":"v9.0.0","name":"draft","draft":true,"body":"hidden","assets":[
            {"name":"TwanAgent_9.0.0_universal.app.tar.gz","size":22,"browser_download_url":"https://github.com/TwanLuttik/TwanAgent/releases/download/v9.0.0/TwanAgent_9.0.0_universal.app.tar.gz"}
          ]}
        ]"#;
        let found = pick_update(body, "1.0.0-beta.2").unwrap().unwrap();
        assert_eq!(found.version, "1.0.0-beta.3");
        assert_eq!(found.bytes, 22);
        assert!(found.sha256.starts_with("bbbb"));
        assert!(pick_update(body, "1.0.0-beta.3").unwrap().is_none());
        assert!(pick_update(body, "2.0.0").unwrap().is_none());
    }

    #[test]
    fn a_dmg_only_release_is_not_installable() {
        let body = r#"[{"tag_name":"v1.2.0","draft":false,"assets":[
          {"name":"TwanAgent_1.2.0_aarch64.dmg","size":20,"browser_download_url":"https://github.com/TwanLuttik/TwanAgent/releases/download/v1.2.0/TwanAgent_1.2.0_aarch64.dmg"}
        ]}]"#;
        assert!(pick_update(body, "1.0.0").unwrap().is_none());
    }

    #[test]
    fn unpack_keeps_only_the_app_tree() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("TwanAgent_1.0.0_universal.app.tar.gz");
        write_app_archive(&archive);
        let app = unpack_app(&archive, &dir.path().join("out")).unwrap();
        assert!(app.join("Contents/MacOS/twanagent").is_file());
        assert!(app.join("Contents/Info.plist").is_file());
    }

    #[test]
    fn unpack_refuses_a_link_outside_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("bad.tar.gz");
        let tar_path = archive.with_extension("tar");
        {
            let file = File::create(&tar_path).unwrap();
            let mut builder = tar::Builder::new(file);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_cksum();
            builder
                .append_link(&mut header, "TwanAgent.app/Contents/MacOS/escape", "../../escape")
                .unwrap();
            builder.finish().unwrap();
        }
        let raw = fs::read(&tar_path).unwrap();
        let mut encoder =
            flate2::write::GzEncoder::new(File::create(&archive).unwrap(), flate2::Compression::fast());
        encoder.write_all(&raw).unwrap();
        encoder.finish().unwrap();
        let out = dir.path().join("out");
        assert!(unpack_app(&archive, &out).is_err());
        assert!(!out.join("TwanAgent.app").exists());
    }

    #[test]
    fn the_bundle_is_the_app_around_the_binary() {
        let exe = Path::new("/Applications/TwanAgent.app/Contents/MacOS/twanagent");
        assert_eq!(
            installed_bundle(exe).unwrap(),
            PathBuf::from("/Applications/TwanAgent.app")
        );
        assert!(installed_bundle(Path::new("/usr/local/bin/twanagent")).is_none());
    }

    #[test]
    fn install_replaces_the_app_and_can_roll_back() {
        let dir = tempfile::tempdir().unwrap();
        let installed = dir.path().join("TwanAgent.app");
        write_fake_app(&installed, "old");
        let downloaded = dir.path().join("downloaded").join("TwanAgent.app");
        write_fake_app(&downloaded, "new");
        install_bundle(&downloaded, &installed).unwrap();
        let binary = installed.join("Contents/MacOS/twanagent");
        assert_eq!(fs::read_to_string(&binary).unwrap(), "new");
        assert!(!dir.path().join(".TwanAgent.previous.app").exists());
        assert!(!dir.path().join(".TwanAgent.update.app").exists());
    }

    fn write_fake_app(root: &Path, marker: &str) {
        let macos = root.join("Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        fs::write(macos.join("twanagent"), marker).unwrap();
        fs::write(root.join("Contents/Info.plist"), "<plist/>").unwrap();
    }

    fn write_app_archive(path: &Path) {
        write_tar_gz(
            path,
            &[
                ("TwanAgent.app/Contents/Info.plist", b"<plist/>"),
                ("TwanAgent.app/Contents/MacOS/twanagent", b"#!/bin/sh\n"),
            ],
        );
    }

    fn write_tar_gz(path: &Path, files: &[(&str, &[u8])]) {
        let tar_path = path.with_extension("tar");
        {
            let file = File::create(&tar_path).unwrap();
            let mut builder = tar::Builder::new(file);
            for (name, bytes) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, name, *bytes).unwrap();
            }
            builder.finish().unwrap();
        }
        let raw = fs::read(&tar_path).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(File::create(path).unwrap(), flate2::Compression::fast());
        encoder.write_all(&raw).unwrap();
        encoder.finish().unwrap();
        let _ = fs::remove_file(tar_path);
    }
}
