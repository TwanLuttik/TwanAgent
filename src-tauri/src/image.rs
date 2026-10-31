use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{Error, Result};
use crate::state::AppState;

pub const MAX_EDGE: u32 = 2048;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreparedImage {
    pub id: String,
    pub path: String,
    pub name: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub resized: bool,
    /// `"file"` for anything that is not a picture. Empty on images.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// Byte size of a stored file. Zero on images.
    #[serde(default, skip_serializing_if = "u64_is_zero")]
    pub bytes: u64,
}

fn u64_is_zero(value: &u64) -> bool {
    *value == 0
}

pub fn attachments_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("attachments")
}

pub const SPACE_CORNER_DIR: &str = "space-corner";
pub const SPACE_CORNER_FILE: &str = "image";

pub fn space_corner_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SPACE_CORNER_DIR)
}

/// Extensions the composer and the corner picker accept.
/// Keep this in sync with `IMAGE_EXT` in `src/lib/image.ts`.
fn is_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".bmp")
        || lower.ends_with(".jfif")
        || crate::heic::is_heic_name(&lower)
}

const MAX_SOURCE_BYTES: u64 = 50 * 1024 * 1024;
/// The corner is drawn at 360px. Cap a converted HEIC well above that so a
/// retina sidebar stays sharp without decoding a 48 megapixel photo.
const CORNER_HEIC_EDGE: u32 = 4096;

/// Copy a user-picked picture into the app data folder so the corner keeps working
/// after the original file is moved or deleted.
pub fn copy_space_corner_image(data_dir: &Path, source: &str) -> Result<PreparedImage> {
    let path = PathBuf::from(source.trim());
    let name = display_name(source);
    if !is_image_name(&name) {
        return Err(Error::Other("This file isn’t a supported image.".into()));
    }
    let meta = fs::metadata(&path).map_err(|_| Error::Other("image file not found".into()))?;
    if !meta.is_file() {
        return Err(Error::Other("image file not found".into()));
    }
    if meta.len() > MAX_SOURCE_BYTES {
        return Err(Error::Other("image is too large".into()));
    }
    let bytes = fs::read(&path)?;
    if bytes.is_empty() {
        return Err(Error::Other("image is empty".into()));
    }
    let raster = open_raster(&bytes, &name, CORNER_HEIC_EDGE)?;
    let (width, height) = raster.image.dimensions();
    if width == 0 || height == 0 {
        return Err(Error::Other("image has no pixels".into()));
    }
    // HEIC has no passthrough. Store JPEG or PNG so the sidebar can paint it.
    let (ext, mime, encoded) = if let Some((ext, mime)) = passthrough_format(raster.format) {
        (ext.to_string(), mime.to_string(), bytes)
    } else {
        encode_resized(&raster.image)?
    };
    let dir = space_corner_dir(data_dir);
    fs::create_dir_all(&dir)?;
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
    let stored = dir.join(format!("{SPACE_CORNER_FILE}.{ext}"));
    fs::write(&stored, &encoded)?;
    Ok(PreparedImage {
        id: SPACE_CORNER_FILE.into(),
        path: stored.to_string_lossy().replace('\\', "/"),
        name,
        mime: mime.into(),
        width,
        height,
        resized: false,
        kind: String::new(),
        bytes: 0,
    })
}

/// The copied corner picture, if one is still in the data folder.
pub fn space_corner_image(data_dir: &Path) -> Result<Option<PreparedImage>> {
    let dir = space_corner_dir(data_dir);
    if !dir.is_dir() {
        return Ok(None);
    }
    let mut found: Option<PathBuf> = None;
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            continue;
        }
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !name.starts_with(SPACE_CORNER_FILE) || !is_image_name(&name) {
            continue;
        }
        found = Some(path);
        break;
    }
    let Some(path) = found else {
        return Ok(None);
    };
    let bytes = fs::read(&path)?;
    let reader = ImageReader::new(Cursor::new(bytes.as_slice()))
        .with_guessed_format()
        .map_err(|e| Error::Other(format!("Couldn’t read image: {e}")))?;
    let format = reader.format();
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| Error::Other("This image format isn’t supported.".into()))?;
    let mime = passthrough_format(format)
        .map(|(_, mime)| mime)
        .unwrap_or_else(|| mime_from_path(&path));
    Ok(Some(PreparedImage {
        id: SPACE_CORNER_FILE.into(),
        path: path.to_string_lossy().replace('\\', "/"),
        name: display_name(&path.to_string_lossy()),
        mime: mime.into(),
        width,
        height,
        resized: false,
        kind: String::new(),
        bytes: 0,
    }))
}

pub fn clear_space_corner_image(data_dir: &Path) -> Result<()> {
    let dir = space_corner_dir(data_dir);
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

pub fn needs_resize(width: u32, height: u32) -> bool {
    width.max(height) > MAX_EDGE
}

fn folder_name(conversation_id: Option<&str>) -> String {
    let raw = conversation_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("inbox");
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if cleaned.is_empty() {
        "inbox".into()
    } else {
        cleaned
    }
}

fn display_name(name: &str) -> String {
    display_name_or(name, "image")
}

fn display_name_or(name: &str, fallback: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn safe_extension(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let cleaned: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(16)
        .collect();
    if cleaned.is_empty() {
        "bin".into()
    } else {
        cleaned.to_ascii_lowercase()
    }
}

fn file_mime(name: &str) -> &'static str {
    match safe_extension(name).as_str() {
        "pdf" => "application/pdf",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "heic" | "heif" => {
            "application/octet-stream"
        }
        "txt" | "md" | "csv" | "log" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go"
        | "toml" | "yaml" | "yml" | "html" | "css" | "xml" | "sh" | "sql" | "c" | "h" | "cpp"
        | "hpp" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Copy a dropped file that is not a picture. Bytes are stored as-is.
pub fn prepare_file(
    data_dir: &Path,
    bytes: &[u8],
    name: &str,
    conversation_id: Option<&str>,
) -> Result<PreparedImage> {
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(Error::Other("file is too large".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = attachments_dir(data_dir).join(folder_name(conversation_id));
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{id}.{}", safe_extension(name)));
    fs::write(&path, bytes)?;
    let shown = display_name_or(name, "file");
    Ok(PreparedImage {
        id,
        path: path.to_string_lossy().replace('\\', "/"),
        name: shown,
        mime: file_mime(name).into(),
        width: 0,
        height: 0,
        resized: false,
        kind: "file".into(),
        bytes: bytes.len() as u64,
    })
}

pub fn prepare_file_from_path(
    data_dir: &Path,
    source: &str,
    conversation_id: Option<&str>,
) -> Result<PreparedImage> {
    let path = PathBuf::from(source.trim());
    let name = display_name_or(source, "file");
    let meta = fs::metadata(&path).map_err(|_| Error::Other("file not found".into()))?;
    if meta.is_dir() {
        return Err(Error::Other("Drop a file, not a folder.".into()));
    }
    if !meta.is_file() {
        return Err(Error::Other("file not found".into()));
    }
    if meta.len() > MAX_SOURCE_BYTES {
        return Err(Error::Other("file is too large".into()));
    }
    let bytes = fs::read(&path)?;
    prepare_file(data_dir, &bytes, &name, conversation_id)
}

/// Copy a drop into attachments without decoding it, so the chip can paint
/// before a large screenshot is resized.
pub fn stage_dropped_path(
    data_dir: &Path,
    source: &str,
    conversation_id: Option<&str>,
) -> Result<PreparedImage> {
    let path = PathBuf::from(source.trim());
    let name = display_name_or(source, "file");
    let meta = fs::metadata(&path).map_err(|_| Error::Other("file not found".into()))?;
    if meta.is_dir() {
        return Err(Error::Other("Drop a file, not a folder.".into()));
    }
    if !meta.is_file() {
        return Err(Error::Other("file not found".into()));
    }
    if meta.len() > MAX_SOURCE_BYTES {
        return Err(Error::Other("file is too large".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = attachments_dir(data_dir).join(folder_name(conversation_id));
    fs::create_dir_all(&dir)?;
    let stored = dir.join(format!("{id}.{}", safe_extension(&name)));
    fs::copy(&path, &stored)?;
    let image = is_image_name(&name);
    Ok(PreparedImage {
        id,
        path: stored.to_string_lossy().replace('\\', "/"),
        mime: if image {
            image_mime_from_name(&name).to_string()
        } else {
            file_mime(&name).to_string()
        },
        name,
        width: 0,
        height: 0,
        resized: false,
        kind: if image { String::new() } else { "file".into() },
        bytes: if image { 0 } else { meta.len() },
    })
}

/// Finish a staged picture. A file that already fits keeps its path. A large
/// one is resized and the staged original is removed.
pub fn finalize_staged_image(data_dir: &Path, path: &str) -> Result<PreparedImage> {
    let file = resolve_attachment(data_dir, path)?;
    let bytes = fs::read(&file)?;
    // Keep the caller's path. Canonicalizing adds a `/private` prefix on macOS
    // and would reload the thumbnail for the same file.
    let staged = path.trim().replace('\\', "/");
    if let Some((width, height, format)) = header_size(&bytes) {
        if !needs_resize(width, height) {
            if let Some((_, mime)) = passthrough_format(Some(format)) {
                return Ok(PreparedImage {
                    id: file
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("image")
                        .to_string(),
                    path: staged.clone(),
                    name: display_name(&staged),
                    mime: mime.to_string(),
                    width,
                    height,
                    resized: false,
                    kind: String::new(),
                    bytes: 0,
                });
            }
        }
    }
    let conv = file
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|s| s.to_str());
    let prepared = prepare_image(data_dir, &bytes, &display_name(&staged), conv)?;
    if prepared.path != staged {
        let _ = fs::remove_file(&file);
    }
    Ok(prepared)
}

fn image_mime_from_name(name: &str) -> &'static str {
    match safe_extension(name).as_str() {
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "heic" | "heif" => "image/heic",
        _ => "image/png",
    }
}

fn mime_from_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

fn has_useful_alpha(img: &DynamicImage) -> bool {
    if !img.color().has_alpha() {
        return false;
    }
    img.to_rgba8().pixels().any(|p| p.0[3] < 255)
}

fn encode_resized(img: &DynamicImage) -> Result<(String, String, Vec<u8>)> {
    if has_useful_alpha(img) {
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png)
            .map_err(|e| Error::Other(e.to_string()))?;
        Ok(("png".into(), "image/png".into(), buf.into_inner()))
    } else {
        let rgb = img.to_rgb8();
        let mut buf = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut buf, 85);
        encoder
            .encode_image(&rgb)
            .map_err(|e| Error::Other(e.to_string()))?;
        Ok(("jpg".into(), "image/jpeg".into(), buf))
    }
}

fn passthrough_format(format: Option<ImageFormat>) -> Option<(&'static str, &'static str)> {
    match format {
        Some(ImageFormat::Png) => Some(("png", "image/png")),
        Some(ImageFormat::Jpeg) => Some(("jpg", "image/jpeg")),
        Some(ImageFormat::Gif) => Some(("gif", "image/gif")),
        Some(ImageFormat::WebP) => Some(("webp", "image/webp")),
        Some(ImageFormat::Bmp) => Some(("bmp", "image/bmp")),
        _ => None,
    }
}

struct Raster {
    image: DynamicImage,
    format: Option<ImageFormat>,
    source_width: u32,
    source_height: u32,
}

/// Decode a prompt or corner image.
///
/// HEIC is not a format this crate or the model API can carry, so those bytes
/// are decoded with the system and come back with `format: None`. Callers then
/// store JPEG or PNG instead of the original file.
fn open_raster(bytes: &[u8], name: &str, heic_max_edge: u32) -> Result<Raster> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| Error::Other(format!("Couldn’t read image: {e}")))?;
    let format = reader.format();
    match reader.decode() {
        Ok(image) => {
            let (source_width, source_height) = image.dimensions();
            Ok(Raster {
                image,
                format,
                source_width,
                source_height,
            })
        }
        Err(_) if crate::heic::should_decode_heic(name, bytes) => {
            let decoded = crate::heic::decode_heic(bytes, heic_max_edge)?;
            Ok(Raster {
                image: decoded.image,
                format: None,
                source_width: decoded.stored_width,
                source_height: decoded.stored_height,
            })
        }
        Err(_) => Err(Error::Other("This image format isn’t supported.".into())),
    }
}

pub fn prepare_image(
    data_dir: &Path,
    bytes: &[u8],
    name: &str,
    conversation_id: Option<&str>,
) -> Result<PreparedImage> {
    if bytes.is_empty() {
        return Err(Error::Other("image is empty".into()));
    }
    // A picture that already fits is stored as-is. Reading the header avoids
    // decoding every pixel, which is what made a drop feel late.
    if let Some((width, height, format)) = header_size(bytes) {
        if !needs_resize(width, height) {
            if let Some((ext, mime)) = passthrough_format(Some(format)) {
                return store_prepared(
                    data_dir,
                    conversation_id,
                    name,
                    ext,
                    mime,
                    bytes,
                    width,
                    height,
                    false,
                );
            }
        }
    }
    let raster = open_raster(bytes, name, MAX_EDGE)?;
    if raster.source_width == 0 || raster.source_height == 0 {
        return Err(Error::Other("image has no pixels".into()));
    }
    let resized = needs_resize(raster.source_width, raster.source_height);
    let (cur_w, cur_h) = raster.image.dimensions();
    let out = if needs_resize(cur_w, cur_h) {
        raster
            .image
            .resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Triangle)
    } else {
        raster.image
    };
    let (width, height) = out.dimensions();
    // A downscaled HEIC is already within the cap, but it still has to be
    // re-encoded. Only an original PNG, JPEG, GIF, WebP, or BMP is stored as-is.
    let (ext, mime, encoded) =
        if let Some((ext, mime)) = passthrough_format(raster.format).filter(|_| !resized) {
            (ext.to_string(), mime.to_string(), bytes.to_vec())
        } else {
            encode_resized(&out)?
        };

    store_prepared(
        data_dir,
        conversation_id,
        name,
        &ext,
        &mime,
        &encoded,
        width,
        height,
        resized,
    )
}

fn header_size(bytes: &[u8]) -> Option<(u32, u32, ImageFormat)> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let format = reader.format()?;
    let (width, height) = reader.into_dimensions().ok()?;
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height, format))
}

fn store_prepared(
    data_dir: &Path,
    conversation_id: Option<&str>,
    name: &str,
    ext: &str,
    mime: &str,
    bytes: &[u8],
    width: u32,
    height: u32,
    resized: bool,
) -> Result<PreparedImage> {
    let id = uuid::Uuid::new_v4().to_string();
    let dir = attachments_dir(data_dir).join(folder_name(conversation_id));
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{id}.{ext}"));
    fs::write(&path, bytes)?;
    Ok(PreparedImage {
        id,
        path: path.to_string_lossy().replace('\\', "/"),
        name: display_name(name),
        mime: mime.to_string(),
        width,
        height,
        resized,
        kind: String::new(),
        bytes: 0,
    })
}

pub fn prepare_image_from_path(
    data_dir: &Path,
    source: &str,
    conversation_id: Option<&str>,
) -> Result<PreparedImage> {
    let path = PathBuf::from(source.trim());
    let name = display_name(source);
    if !is_image_name(&name) {
        return Err(Error::Other("This file isn’t a supported image.".into()));
    }
    let meta = fs::metadata(&path).map_err(|_| Error::Other("image file not found".into()))?;
    if !meta.is_file() {
        return Err(Error::Other("image file not found".into()));
    }
    if meta.len() > MAX_SOURCE_BYTES {
        return Err(Error::Other("image is too large".into()));
    }
    let bytes = fs::read(&path)?;
    prepare_image(data_dir, &bytes, &name, conversation_id)
}

pub fn resolve_attachment(data_dir: &Path, path: &str) -> Result<PathBuf> {
    let root = attachments_dir(data_dir);
    fs::create_dir_all(&root)?;
    let root = root
        .canonicalize()
        .map_err(|_| Error::Other("attachments folder is missing".into()))?;
    let given = PathBuf::from(path.trim());
    if given.as_os_str().is_empty() {
        return Err(Error::NotFound("image not found".into()));
    }
    let abs = if given.is_absolute() {
        given
    } else {
        root.join(given)
    };
    let canon = abs
        .canonicalize()
        .map_err(|_| Error::NotFound("image not found".into()))?;
    if !canon.starts_with(&root) {
        return Err(Error::Other("image is outside attachments".into()));
    }
    Ok(canon)
}

pub fn image_data_url(data_dir: &Path, path: &str) -> Result<String> {
    let file = resolve_attachment(data_dir, path)?;
    let bytes = fs::read(&file)?;
    Ok(format!(
        "data:{};base64,{}",
        mime_from_path(&file),
        BASE64.encode(bytes)
    ))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_prepare_image(
    state: State<'_, AppState>,
    bytes_base64: String,
    name: String,
    conversation_id: Option<String>,
) -> Result<PreparedImage> {
    let data_dir = state.data_dir.clone();
    crate::state::run_blocking(move || {
        let bytes = BASE64
            .decode(bytes_base64.trim())
            .map_err(|_| Error::Other("Couldn’t read image data.".into()))?;
        prepare_image(&data_dir, &bytes, &name, conversation_id.as_deref())
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_prepare_image_path(
    state: State<'_, AppState>,
    path: String,
    conversation_id: Option<String>,
) -> Result<PreparedImage> {
    let data_dir = state.data_dir.clone();
    crate::state::run_blocking(move || {
        prepare_image_from_path(&data_dir, &path, conversation_id.as_deref())
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_prepare_file(
    state: State<'_, AppState>,
    bytes_base64: String,
    name: String,
    conversation_id: Option<String>,
) -> Result<PreparedImage> {
    let data_dir = state.data_dir.clone();
    crate::state::run_blocking(move || {
        let bytes = BASE64
            .decode(bytes_base64.trim())
            .map_err(|_| Error::Other("Couldn’t read file data.".into()))?;
        prepare_file(&data_dir, &bytes, &name, conversation_id.as_deref())
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_prepare_file_path(
    state: State<'_, AppState>,
    path: String,
    conversation_id: Option<String>,
) -> Result<PreparedImage> {
    let data_dir = state.data_dir.clone();
    crate::state::run_blocking(move || {
        prepare_file_from_path(&data_dir, &path, conversation_id.as_deref())
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_stage_drop_path(
    state: State<'_, AppState>,
    path: String,
    conversation_id: Option<String>,
) -> Result<PreparedImage> {
    let data_dir = state.data_dir.clone();
    crate::state::run_blocking(move || {
        stage_dropped_path(&data_dir, &path, conversation_id.as_deref())
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_finalize_image(state: State<'_, AppState>, path: String) -> Result<PreparedImage> {
    let data_dir = state.data_dir.clone();
    crate::state::run_blocking(move || finalize_staged_image(&data_dir, &path)).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_image_data_url(state: State<'_, AppState>, path: String) -> Result<String> {
    image_data_url(&state.data_dir, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_set_space_corner_image(
    state: State<'_, AppState>,
    path: String,
) -> Result<PreparedImage> {
    let data_dir = state.data_dir.clone();
    crate::state::run_blocking(move || copy_space_corner_image(&data_dir, &path)).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_space_corner_image(state: State<'_, AppState>) -> Result<Option<PreparedImage>> {
    space_corner_image(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_clear_space_corner_image(state: State<'_, AppState>) -> Result<()> {
    clear_space_corner_image(&state.data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};
    use tempfile::tempdir;

    fn png_bytes(w: u32, h: u32, alpha: u8) -> Vec<u8> {
        let img = RgbaImage::from_pixel(w, h, Rgba([10, 20, 30, alpha]));
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    #[test]
    fn keeps_small_png_dimensions() {
        let dir = tempdir().unwrap();
        let out = prepare_image(dir.path(), &png_bytes(80, 40, 255), "shot.png", None).unwrap();
        assert_eq!(out.width, 80);
        assert_eq!(out.height, 40);
        assert!(!out.resized);
        assert_eq!(out.mime, "image/png");
        assert!(Path::new(&out.path).exists());
        assert!(out.path.contains("/inbox/"));
    }

    #[test]
    fn downscales_a_wide_image() {
        let dir = tempdir().unwrap();
        let out = prepare_image(
            dir.path(),
            &png_bytes(4096, 2048, 255),
            "wide.png",
            Some("chat-1"),
        )
        .unwrap();
        assert_eq!(out.width, 2048);
        assert_eq!(out.height, 1024);
        assert!(out.resized);
        assert_eq!(out.mime, "image/jpeg");
        assert!(out.path.contains("/chat-1/"));
        let url = image_data_url(dir.path(), &out.path).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn keeps_png_when_resized_image_has_alpha() {
        let dir = tempdir().unwrap();
        let out = prepare_image(dir.path(), &png_bytes(3000, 1000, 120), "a.png", None).unwrap();
        assert!(out.resized);
        assert_eq!(out.mime, "image/png");
        assert_eq!(out.width, 2048);
        assert_eq!(out.height, 683);
    }

    #[test]
    fn prepares_from_a_dropped_file_path() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("drop.png");
        fs::write(&src, png_bytes(16, 12, 255)).unwrap();
        let out = prepare_image_from_path(dir.path(), src.to_str().unwrap(), Some("c1")).unwrap();
        assert_eq!(out.name, "drop.png");
        assert_eq!(out.width, 16);
        assert_eq!(out.height, 12);
        assert!(out.path.contains("/c1/"));
    }

    #[test]
    fn rejects_empty_bytes() {
        let dir = tempdir().unwrap();
        assert!(prepare_image(dir.path(), &[], "a.png", None).is_err());
    }

    #[test]
    fn copies_the_corner_image_into_app_data() {
        let dir = tempdir().unwrap();
        let src_dir = tempdir().unwrap();
        let src = src_dir.path().join("corner.png");
        fs::write(&src, png_bytes(24, 18, 255)).unwrap();
        let out = copy_space_corner_image(dir.path(), src.to_str().unwrap()).unwrap();
        assert_eq!(out.name, "corner.png");
        assert_eq!(out.width, 24);
        assert_eq!(out.height, 18);
        assert!(out.path.contains("/space-corner/image.png"));
        assert!(Path::new(&out.path).exists());
        fs::remove_file(&src).unwrap();
        let kept = space_corner_image(dir.path()).unwrap().unwrap();
        assert_eq!(kept.path, out.path);
        assert!(Path::new(&kept.path).exists());
    }

    #[test]
    fn replacing_the_corner_image_drops_the_old_copy() {
        let dir = tempdir().unwrap();
        let src_dir = tempdir().unwrap();
        let png = src_dir.path().join("a.png");
        fs::write(&png, png_bytes(8, 8, 255)).unwrap();
        copy_space_corner_image(dir.path(), png.to_str().unwrap()).unwrap();
        let jpg_bytes = {
            let img = image::RgbImage::from_pixel(6, 4, image::Rgb([1, 2, 3]));
            let mut buf = Cursor::new(Vec::new());
            DynamicImage::ImageRgb8(img)
                .write_to(&mut buf, ImageFormat::Jpeg)
                .unwrap();
            buf.into_inner()
        };
        let jpg = src_dir.path().join("b.jpg");
        fs::write(&jpg, jpg_bytes).unwrap();
        let next = copy_space_corner_image(dir.path(), jpg.to_str().unwrap()).unwrap();
        assert!(next.path.ends_with("/space-corner/image.jpg"));
        assert!(!dir.path().join("space-corner/image.png").exists());
        clear_space_corner_image(dir.path()).unwrap();
        assert!(space_corner_image(dir.path()).unwrap().is_none());
    }

    #[test]
    fn stages_a_picture_before_it_is_decoded() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("shot.png");
        let bytes = png_bytes(80, 40, 255);
        fs::write(&src, &bytes).unwrap();
        let staged = stage_dropped_path(dir.path(), src.to_str().unwrap(), Some("c")).unwrap();
        assert!(staged.kind.is_empty());
        assert_eq!(staged.width, 0);
        assert_eq!(fs::read(&staged.path).unwrap(), bytes);
        let done = finalize_staged_image(dir.path(), &staged.path).unwrap();
        assert_eq!(done.path, staged.path);
        assert_eq!(done.width, 80);
        assert_eq!(done.height, 40);
        assert!(!done.resized);
    }

    #[test]
    fn a_wide_staged_picture_is_resized_and_the_staged_copy_is_removed() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("wide.png");
        fs::write(&src, png_bytes(3000, 1000, 255)).unwrap();
        let staged = stage_dropped_path(dir.path(), src.to_str().unwrap(), None).unwrap();
        let done = finalize_staged_image(dir.path(), &staged.path).unwrap();
        assert_ne!(done.path, staged.path);
        assert_eq!(done.width, 2048);
        assert_eq!(done.height, 683);
        assert!(done.resized);
        assert!(!Path::new(&staged.path).exists());
    }

    #[test]
    fn copies_a_text_file_without_decoding_it_as_an_image() {
        let dir = tempdir().unwrap();
        let out = prepare_file(dir.path(), b"hello\n", "notes.md", Some("chat")).unwrap();
        assert_eq!(out.kind, "file");
        assert_eq!(out.name, "notes.md");
        assert_eq!(out.mime, "text/plain");
        assert_eq!(out.bytes, 6);
        assert_eq!(out.width, 0);
        assert!(out.path.ends_with(".md"), "{}", out.path);
        assert_eq!(fs::read(out.path).unwrap(), b"hello\n");
    }

    #[test]
    fn copies_a_dropped_file_and_refuses_a_folder() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("plan.pdf");
        fs::write(&src, b"%PDF-1.1\n").unwrap();
        let out = prepare_file_from_path(dir.path(), src.to_str().unwrap(), None).unwrap();
        assert_eq!(out.name, "plan.pdf");
        assert_eq!(out.mime, "application/pdf");
        assert_eq!(out.kind, "file");
        let folder = dir.path().join("folder");
        fs::create_dir(&folder).unwrap();
        let err = prepare_file_from_path(dir.path(), folder.to_str().unwrap(), None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("folder"), "{err}");
    }

    #[test]
    fn refuses_paths_outside_attachments() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(attachments_dir(dir.path())).unwrap();
        let outside = dir.path().join("secret.png");
        fs::write(&outside, b"nope").unwrap();
        assert!(image_data_url(dir.path(), outside.to_str().unwrap()).is_err());
    }

    #[test]
    fn rejects_bytes_that_only_pretend_to_be_heic() {
        let dir = tempdir().unwrap();
        let mut bytes = vec![0u8; 24];
        bytes[4..8].copy_from_slice(b"ftyp");
        bytes[8..12].copy_from_slice(b"heic");
        let err = prepare_image(dir.path(), &bytes, "a.heic", None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("HEIC"), "{err}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn converts_heic_into_a_jpeg_the_model_can_read() {
        let dir = tempdir().unwrap();
        let heic = crate::heic::heic_via_sips(&png_bytes(64, 48, 255));
        let out = prepare_image(dir.path(), &heic, "IMG_1.HEIC", Some("chat")).unwrap();
        assert_eq!(out.name, "IMG_1.HEIC");
        assert_eq!(out.width, 64);
        assert_eq!(out.height, 48);
        assert!(!out.resized);
        assert_eq!(out.mime, "image/jpeg");
        assert!(out.path.ends_with(".jpg"), "{}", out.path);
        assert!(out.path.contains("/chat/"));
        let url = image_data_url(dir.path(), &out.path).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn downscales_a_wide_heic() {
        let dir = tempdir().unwrap();
        let heic = crate::heic::heic_via_sips(&png_bytes(3000, 1000, 255));
        let out = prepare_image(dir.path(), &heic, "wide.heic", None).unwrap();
        assert_eq!(out.width, 2048);
        assert!((682..=683).contains(&out.height), "height {}", out.height);
        assert!(out.resized);
        assert_eq!(out.mime, "image/jpeg");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn prepares_heic_from_a_dropped_path() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("drop.heif");
        fs::write(&src, crate::heic::heic_via_sips(&png_bytes(16, 12, 255))).unwrap();
        let out = prepare_image_from_path(dir.path(), src.to_str().unwrap(), None).unwrap();
        assert_eq!(out.name, "drop.heif");
        assert_eq!(out.width, 16);
        assert_eq!(out.height, 12);
        assert_eq!(out.mime, "image/jpeg");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn copies_a_heic_corner_as_a_bitmap_the_sidebar_can_show() {
        let dir = tempdir().unwrap();
        let src_dir = tempdir().unwrap();
        let src = src_dir.path().join("corner.heic");
        fs::write(&src, crate::heic::heic_via_sips(&png_bytes(24, 18, 255))).unwrap();
        let out = copy_space_corner_image(dir.path(), src.to_str().unwrap()).unwrap();
        assert_eq!(out.name, "corner.heic");
        assert_eq!(out.width, 24);
        assert_eq!(out.height, 18);
        assert!(
            out.path.ends_with("/space-corner/image.jpg"),
            "{}",
            out.path
        );
        fs::remove_file(&src).unwrap();
        let kept = space_corner_image(dir.path()).unwrap().unwrap();
        assert_eq!(kept.width, 24);
        assert_eq!(kept.height, 18);
        assert_eq!(kept.mime, "image/jpeg");
    }
}
