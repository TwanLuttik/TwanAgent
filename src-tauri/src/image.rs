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
}

pub fn attachments_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("attachments")
}

pub const SPACE_CORNER_DIR: &str = "space-corner";
pub const SPACE_CORNER_FILE: &str = "image";

pub fn space_corner_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SPACE_CORNER_DIR)
}

fn is_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".webp")
        || lower.ends_with(".bmp")
        || lower.ends_with(".jfif")
}

const MAX_SOURCE_BYTES: u64 = 50 * 1024 * 1024;

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
    let reader = ImageReader::new(Cursor::new(bytes.as_slice()))
        .with_guessed_format()
        .map_err(|e| Error::Other(format!("Couldn’t read image: {e}")))?;
    let format = reader.format();
    let img = reader
        .decode()
        .map_err(|_| Error::Other("This image format isn’t supported.".into()))?;
    let (width, height) = img.dimensions();
    if width == 0 || height == 0 {
        return Err(Error::Other("image has no pixels".into()));
    }
    let (ext, mime) = passthrough_format(format).unwrap_or(("png", "image/png"));
    let dir = space_corner_dir(data_dir);
    fs::create_dir_all(&dir)?;
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            let _ = fs::remove_file(entry.path());
        }
    }
    let stored = dir.join(format!("{SPACE_CORNER_FILE}.{ext}"));
    fs::write(&stored, &bytes)?;
    Ok(PreparedImage {
        id: SPACE_CORNER_FILE.into(),
        path: stored.to_string_lossy().replace('\\', "/"),
        name,
        mime: mime.into(),
        width,
        height,
        resized: false,
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
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
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
    }))
}

pub fn clear_space_corner_image(data_dir: &Path) -> Result<()> {
    let dir = space_corner_dir(data_dir);
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        if entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
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
    Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("image")
        .to_string()
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

pub fn prepare_image(
    data_dir: &Path,
    bytes: &[u8],
    name: &str,
    conversation_id: Option<&str>,
) -> Result<PreparedImage> {
    if bytes.is_empty() {
        return Err(Error::Other("image is empty".into()));
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| Error::Other(format!("Couldn’t read image: {e}")))?;
    let format = reader.format();
    let img = reader
        .decode()
        .map_err(|_| Error::Other("This image format isn’t supported.".into()))?;
    let (orig_w, orig_h) = img.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return Err(Error::Other("image has no pixels".into()));
    }
    let resized = needs_resize(orig_w, orig_h);
    let out = if resized {
        img.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let (width, height) = out.dimensions();
    let (ext, mime, encoded) = if resized {
        encode_resized(&out)?
    } else if let Some((ext, mime)) = passthrough_format(format) {
        (ext.to_string(), mime.to_string(), bytes.to_vec())
    } else {
        encode_resized(&out)?
    };

    let id = uuid::Uuid::new_v4().to_string();
    let dir = attachments_dir(data_dir).join(folder_name(conversation_id));
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{id}.{ext}"));
    fs::write(&path, encoded)?;
    Ok(PreparedImage {
        id,
        path: path.to_string_lossy().replace('\\', "/"),
        name: display_name(name),
        mime,
        width,
        height,
        resized,
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
    fn refuses_paths_outside_attachments() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(attachments_dir(dir.path())).unwrap();
        let outside = dir.path().join("secret.png");
        fs::write(&outside, b"nope").unwrap();
        assert!(image_data_url(dir.path(), outside.to_str().unwrap()).is_err());
    }
}
