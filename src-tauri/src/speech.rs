use std::fs::{self, File};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::appdb;
use crate::error::{Error, Result};
use crate::state::AppState;

const SETTING_KEY: &str = "speech.model";
const DEFAULT_ID: &str = "tiny.en";
const MAX_CLIP_SECONDS: f32 = 60.0;
const SAMPLE_RATE: u32 = 16_000;
const TRANSCRIPT_CAP: usize = 8_000;

const HF_HOSTS: &[&str] = &["huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.huggingface.co"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeechModel {
    pub id: &'static str,
    pub label: &'static str,
    pub file: &'static str,
    pub bytes: u64,
    pub english: bool,
}

pub const SPEECH_MODELS: &[SpeechModel] = &[
    SpeechModel {
        id: "tiny.en",
        label: "Tiny English",
        file: "ggml-tiny.en.bin",
        bytes: 77_704_715,
        english: true,
    },
    SpeechModel {
        id: "base.en",
        label: "Base English",
        file: "ggml-base.en.bin",
        bytes: 147_964_211,
        english: true,
    },
    SpeechModel {
        id: "small.en",
        label: "Small English",
        file: "ggml-small.en.bin",
        bytes: 487_614_201,
        english: true,
    },
    SpeechModel {
        id: "tiny",
        label: "Tiny multilingual",
        file: "ggml-tiny.bin",
        bytes: 77_691_713,
        english: false,
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelStatus {
    Missing,
    Partial,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeechModelInfo {
    pub id: String,
    pub label: String,
    pub file: String,
    pub bytes: u64,
    pub english: bool,
    pub status: ModelStatus,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadEvent {
    id: String,
    received: u64,
    total: u64,
    done: bool,
}

#[derive(Clone)]
pub struct SpeechEngine {
    loaded: std::sync::Arc<Mutex<Option<LoadedModel>>>,
    downloads: std::sync::Arc<Mutex<std::collections::HashSet<String>>>,
}

struct LoadedModel {
    id: String,
    ctx: whisper_rs::WhisperContext,
}

impl SpeechEngine {
    pub fn new() -> Self {
        Self {
            loaded: std::sync::Arc::new(Mutex::new(None)),
            downloads: std::sync::Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }
}

pub fn catalog_model(id: &str) -> Option<&'static SpeechModel> {
    let id = id.trim();
    SPEECH_MODELS.iter().find(|model| model.id == id)
}

pub fn normalize_model_id(id: &str) -> &'static str {
    catalog_model(id).map(|model| model.id).unwrap_or(DEFAULT_ID)
}

pub fn speech_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("speech")
}

pub fn model_path(data_dir: &Path, id: &str) -> Result<PathBuf> {
    let model = catalog_model(id).ok_or_else(|| Error::Other("Unknown voice model.".into()))?;
    let name = model.file;
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(Error::Other("Unknown voice model.".into()));
    }
    let dir = speech_dir(data_dir);
    let path = dir.join(name);
    if path.parent() != Some(dir.as_path()) {
        return Err(Error::Other("Unknown voice model.".into()));
    }
    Ok(path)
}

pub fn model_status(data_dir: &Path, id: &str) -> Result<ModelStatus> {
    let path = model_path(data_dir, id)?;
    let model = catalog_model(id).ok_or_else(|| Error::Other("Unknown voice model.".into()))?;
    status_for(&path, model.bytes)
}

fn status_for(path: &Path, expected: u64) -> Result<ModelStatus> {
    let partial = partial_path(path);
    if path.is_file() {
        let len = fs::metadata(path)?.len();
        if len == expected {
            return Ok(ModelStatus::Ready);
        }
        return Ok(ModelStatus::Partial);
    }
    if partial.is_file() {
        return Ok(ModelStatus::Partial);
    }
    Ok(ModelStatus::Missing)
}

fn partial_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| format!("{}.partial", name.to_string_lossy()))
        .unwrap_or_else(|| "model.partial".into());
    path.with_file_name(name)
}

pub fn list_models(data_dir: &Path) -> Result<Vec<SpeechModelInfo>> {
    SPEECH_MODELS
        .iter()
        .map(|model| {
            Ok(SpeechModelInfo {
                id: model.id.into(),
                label: model.label.into(),
                file: model.file.into(),
                bytes: model.bytes,
                english: model.english,
                status: model_status(data_dir, model.id)?,
            })
        })
        .collect()
}

pub fn download_url(model: &SpeechModel) -> String {
    format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}?download=true",
        model.file
    )
}

pub fn host_allowed(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if HF_HOSTS.iter().any(|allowed| host == *allowed) {
        return true;
    }
    // Current Hub resolve URLs redirect to the Xet CDN, for example us.aws.cdn.hf.co.
    host.ends_with(".hf.co") || host == "hf.co"
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let host = attempt.url().host_str().unwrap_or_default().to_string();
                if host_allowed(&host) {
                    attempt.follow()
                } else {
                    attempt.error(format!("refusing redirect to {host}"))
                }
            }))
            .timeout(Duration::from_secs(60 * 30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

pub async fn download_model(data_dir: &Path, id: &str, on_progress: impl Fn(u64, u64)) -> Result<PathBuf> {
    let model = catalog_model(id).ok_or_else(|| Error::Other("Unknown voice model.".into()))?;
    let path = model_path(data_dir, model.id)?;
    if model_status(data_dir, model.id)? == ModelStatus::Ready {
        on_progress(model.bytes, model.bytes);
        return Ok(path);
    }
    fs::create_dir_all(speech_dir(data_dir))?;
    let partial = partial_path(&path);
    let mut resp = http_client()
        .get(download_url(model))
        .send()
        .await
        .map_err(|err| Error::Other(format!("Could not download the voice model: {err}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let _ = fs::remove_file(&partial);
        return Err(Error::Other(format!(
            "Could not download the voice model ({status})."
        )));
    }
    let mut file = File::create(&partial)?;
    let mut received = 0u64;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|err| Error::Other(format!("Could not download the voice model: {err}")))?
    {
        file.write_all(&chunk)?;
        received += chunk.len() as u64;
        if received > model.bytes {
            let _ = fs::remove_file(&partial);
            return Err(Error::Other("The voice model download was larger than expected.".into()));
        }
        on_progress(received, model.bytes);
    }
    file.flush()?;
    drop(file);
    let len = fs::metadata(&partial)?.len();
    if len != model.bytes {
        let _ = fs::remove_file(&partial);
        return Err(Error::Other(
            "The voice model download did not match the expected size.".into(),
        ));
    }
    fs::rename(&partial, &path)?;
    Ok(path)
}

pub fn clean_transcript(text: &str) -> String {
    let mut stripped = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('[') {
        stripped.push_str(&rest[..start]);
        let after = &rest[start..];
        if let Some(end) = after.find(']') {
            let token = &after[..=end];
            if is_timestamp_token(token) || is_blank_token(token) {
                stripped.push(' ');
                rest = &after[end + 1..];
                continue;
            }
        }
        stripped.push('[');
        rest = &rest[start + 1..];
    }
    stripped.push_str(rest);
    let trimmed = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() || is_blank_phrase(&trimmed) {
        return String::new();
    }
    trimmed.chars().take(TRANSCRIPT_CAP).collect()
}

fn is_timestamp_token(token: &str) -> bool {
    token.starts_with('[') && token.ends_with(']') && token.contains("-->")
}

fn is_blank_token(token: &str) -> bool {
    token.eq_ignore_ascii_case("[BLANK_AUDIO]")
}

fn is_blank_phrase(text: &str) -> bool {
    text.eq_ignore_ascii_case("[BLANK_AUDIO]") || text.eq_ignore_ascii_case("(blank audio)")
}

pub fn decode_to_pcm(bytes: &[u8], filename: &str) -> Result<Vec<f32>> {
    if bytes.is_empty() {
        return Err(Error::Other("The recording was empty.".into()));
    }
    if !audio_extension_ok(filename) {
        return Err(Error::Other("This recording format cannot be read.".into()));
    }
    let samples = decode_samples(bytes)?;
    if samples.is_empty() {
        return Err(Error::Other("The recording was empty.".into()));
    }
    let seconds = samples.len() as f32 / SAMPLE_RATE as f32;
    if seconds > MAX_CLIP_SECONDS {
        return Err(Error::Other("Keep a dictation under 60 seconds.".into()));
    }
    Ok(samples)
}

fn audio_extension_ok(filename: &str) -> bool {
    let lower = filename.trim().to_ascii_lowercase();
    lower.ends_with(".wav")
        || lower.ends_with(".mp3")
        || lower.ends_with(".ogg")
        || lower.ends_with(".m4a")
        || lower.ends_with(".aac")
        || lower.ends_with(".mp4")
}

fn decode_samples(bytes: &[u8]) -> Result<Vec<f32>> {
    use symphonia::core::codecs::audio::AudioDecoderOptions;
    use symphonia::core::formats::{probe::Hint, FormatOptions, TrackType};
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;

    let cursor = Cursor::new(bytes.to_vec());
    let source = MediaSourceStream::new(Box::new(cursor), Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(
            &Hint::new(),
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|_| Error::Other("Could not read the recording.".into()))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| Error::Other("Could not read the recording.".into()))?;
    let track_id = track.id;
    let audio = match &track.codec_params {
        Some(symphonia::core::codecs::CodecParameters::Audio(params)) => params.clone(),
        _ => return Err(Error::Other("Could not read the recording.".into())),
    };
    let rate = audio
        .sample_rate
        .ok_or_else(|| Error::Other("Could not read the recording.".into()))?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&audio, &AudioDecoderOptions::default())
        .map_err(|_| Error::Other("Could not read the recording.".into()))?;
    let mut pcm = Vec::<f32>::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(symphonia::core::errors::Error::IoError(err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(_) => break,
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(_) => continue,
        };
        append_mono(&mut pcm, &decoded);
    }
    Ok(resample_linear(&pcm, rate, SAMPLE_RATE))
}

fn append_mono(pcm: &mut Vec<f32>, decoded: &symphonia::core::audio::GenericAudioBufferRef<'_>) {
    use symphonia::core::audio::GenericAudioBufferRef;
    match decoded {
        GenericAudioBufferRef::U8(buf) => mix_planes(pcm, buf),
        GenericAudioBufferRef::S8(buf) => mix_planes(pcm, buf),
        GenericAudioBufferRef::U16(buf) => mix_planes(pcm, buf),
        GenericAudioBufferRef::S16(buf) => mix_planes(pcm, buf),
        GenericAudioBufferRef::U24(buf) => mix_planes(pcm, buf),
        GenericAudioBufferRef::S24(buf) => mix_planes(pcm, buf),
        GenericAudioBufferRef::U32(buf) => mix_planes(pcm, buf),
        GenericAudioBufferRef::S32(buf) => mix_planes(pcm, buf),
        GenericAudioBufferRef::F32(buf) => mix_planes(pcm, buf),
        GenericAudioBufferRef::F64(buf) => mix_planes(pcm, buf),
    }
}

fn mix_planes<S>(pcm: &mut Vec<f32>, buf: &symphonia::core::audio::AudioBuffer<S>)
where
    S: symphonia::core::audio::sample::Sample,
    f32: symphonia::core::audio::conv::FromSample<S>,
{
    use symphonia::core::audio::conv::FromSample;
    use symphonia::core::audio::Audio;
    let frames = Audio::frames(buf);
    let planes = Audio::num_planes(buf);
    if frames == 0 || planes == 0 {
        return;
    }
    for frame in 0..frames {
        let mut sum = 0f32;
        for plane in 0..planes {
            let Some(samples) = Audio::plane(buf, plane) else {
                continue;
            };
            sum += f32::from_sample(samples[frame]);
        }
        pcm.push(sum / planes as f32);
    }
}

fn resample_linear(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if input.is_empty() || from == 0 || to == 0 {
        return Vec::new();
    }
    if from == to {
        return input.to_vec();
    }
    let out_len = ((input.len() as u64) * to as u64 / from as u64) as usize;
    if out_len == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(out_len);
    let scale = from as f64 / to as f64;
    let last = input.len() - 1;
    for i in 0..out_len {
        let pos = i as f64 * scale;
        let idx = pos.floor() as usize;
        let frac = (pos - idx as f64) as f32;
        let a = input[idx.min(last)];
        let b = input[(idx + 1).min(last)];
        out.push(a + (b - a) * frac);
    }
    out
}

pub fn selected_model_id(data_dir: &Path) -> String {
    let Ok(conn) = appdb::open(data_dir) else {
        return DEFAULT_ID.into();
    };
    match appdb::get_setting(&conn, SETTING_KEY) {
        Ok(Some(value)) => normalize_model_id(&value).into(),
        _ => DEFAULT_ID.into(),
    }
}

fn transcribe_pcm(engine: &SpeechEngine, data_dir: &Path, pcm: &[f32]) -> Result<String> {
    if pcm.is_empty() {
        return Err(Error::Other("The recording was empty.".into()));
    }
    let id = selected_model_id(data_dir);
    let model = catalog_model(&id).ok_or_else(|| Error::Other("Unknown voice model.".into()))?;
    if model_status(data_dir, model.id)? != ModelStatus::Ready {
        return Err(Error::Other("Download a voice model in Settings.".into()));
    }
    let path = model_path(data_dir, model.id)?;
    let mut slot = engine.loaded.lock().unwrap_or_else(|err| err.into_inner());
    let reload = slot.as_ref().map(|loaded| loaded.id != model.id).unwrap_or(true);
    if reload {
        let ctx = whisper_rs::WhisperContext::new_with_params(
            path.to_string_lossy().as_ref(),
            whisper_rs::WhisperContextParameters::new(),
        )
        .map_err(|err| Error::Other(format!("Could not load the voice model: {err}")))?;
        *slot = Some(LoadedModel {
            id: model.id.into(),
            ctx,
        });
    }
    let loaded = slot.as_ref().ok_or_else(|| Error::Other("Could not load the voice model.".into()))?;
    let mut state = loaded
        .ctx
        .create_state()
        .map_err(|err| Error::Other(format!("Could not transcribe: {err}")))?;
    let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    params.set_translate(false);
    params.set_single_segment(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    if model.english {
        params.set_language(Some("en"));
    } else {
        params.set_language(None);
        params.set_detect_language(true);
    }
    state
        .full(params, pcm)
        .map_err(|err| Error::Other(format!("Could not transcribe: {err}")))?;
    let count = state.full_n_segments();
    let mut text = String::new();
    for index in 0..count {
        let Some(segment) = state.get_segment(index) else {
            continue;
        };
        let piece = segment
            .to_str_lossy()
            .map_err(|err| Error::Other(format!("Could not transcribe: {err}")))?;
        if !text.is_empty() && !piece.is_empty() {
            text.push(' ');
        }
        text.push_str(piece.trim());
    }
    Ok(clean_transcript(&text))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MicrophoneInfo {
    pub ready: bool,
    pub exe: String,
    pub reason: String,
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_microphone_info() -> MicrophoneInfo {
    let exe = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let ready = microphone_usage_declared();
    let reason = if ready {
        "NSMicrophoneUsageDescription is present.".into()
    } else {
        "NSMicrophoneUsageDescription is missing. macOS aborts microphone access.".into()
    };
    let info = MicrophoneInfo { ready, exe, reason };
    log_microphone(&info);
    info
}

fn log_microphone(info: &MicrophoneInfo) {
    let Ok(dir) = std::env::current_exe() else {
        return;
    };
    let _ = dir;
    if let Some(dir) = app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let line = format!(
            "{} ready={} exe={} {}\n",
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            info.ready,
            info.exe,
            info.reason
        );
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("crash.log"))
            .and_then(|mut file| {
                use std::io::Write;
                file.write_all(line.as_bytes())
            });
    }
}

fn app_log_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let base = std::path::PathBuf::from(home).join("Library/Logs/TwanAgent");
    Some(base)
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_microphone_ready() -> bool {
    dev_microphone_info().ready
}

fn microphone_usage_declared() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    if let Some(info) = bundle_info_plist(&exe) {
        if let Ok(text) = std::fs::read_to_string(info) {
            return text.contains("NSMicrophoneUsageDescription");
        }
    }
    embedded_plist_has_microphone(&exe)
}

fn bundle_info_plist(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut info = exe.to_path_buf();
    if !info.components().any(|part| part.as_os_str() == "Contents") {
        return None;
    }
    while info.file_name().is_some_and(|name| name != "Contents") {
        if !info.pop() {
            return None;
        }
    }
    info.push("Info.plist");
    Some(info)
}

fn embedded_plist_has_microphone(path: &std::path::Path) -> bool {
    let Ok(data) = std::fs::read(path) else {
        return false;
    };
    if data.len() < 32 || u32::from_le_bytes(data[0..4].try_into().unwrap_or([0; 4])) != 0xFEEDFACF {
        return false;
    }
    let ncmds = u32::from_le_bytes(data[16..20].try_into().unwrap_or([0; 4])) as usize;
    let mut offset = 32usize;
    for _ in 0..ncmds {
        if offset + 8 > data.len() {
            return false;
        }
        let cmd = u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap());
        let cmdsize = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap()) as usize;
        if cmd == 0x19 && data.get(offset + 8..offset + 14) == Some(b"__TEXT") {
            let nsects = u32::from_le_bytes(data[offset + 64..offset + 68].try_into().unwrap_or([0; 4])) as usize;
            let mut sect = offset + 72;
            for _ in 0..nsects {
                let name = data.get(sect..sect + 16).unwrap_or_default();
                if name.starts_with(b"__info_plist") {
                    let size = u64::from_le_bytes(data[sect + 40..sect + 48].try_into().unwrap_or([0; 8])) as usize;
                    let fileoff = u32::from_le_bytes(data[sect + 48..sect + 52].try_into().unwrap_or([0; 4])) as usize;
                    let blob = data.get(fileoff..fileoff + size).unwrap_or_default();
                    return blob.windows(b"NSMicrophoneUsageDescription".len()).any(|w| w == b"NSMicrophoneUsageDescription");
                }
                sect += 80;
            }
        }
        offset += cmdsize;
    }
    false
}

#[tauri::command(rename_all = "snake_case")]
pub fn dev_speech_models(state: State<'_, AppState>) -> Result<Vec<SpeechModelInfo>> {
    list_models(&state.data_dir)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_speech_download(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<SpeechModelInfo> {
    let model = catalog_model(&id).ok_or_else(|| Error::Other("Unknown voice model.".into()))?;
    {
        let mut active = state.speech.downloads.lock().unwrap_or_else(|err| err.into_inner());
        if !active.insert(model.id.into()) {
            return Err(Error::Other("That voice model is already downloading.".into()));
        }
    }
    let data_dir = state.data_dir.clone();
    let app_for_progress = app.clone();
    let model_id = model.id.to_string();
    let result = download_model(&data_dir, model.id, |received, total| {
        let _ = app_for_progress.emit(
            "speech-download",
            DownloadEvent {
                id: model_id.clone(),
                received,
                total,
                done: received >= total && total > 0,
            },
        );
    })
    .await;
    state
        .speech
        .downloads
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(model.id);
    result?;
    let _ = app.emit(
        "speech-download",
        DownloadEvent {
            id: model.id.into(),
            received: model.bytes,
            total: model.bytes,
            done: true,
        },
    );
    Ok(list_models(&data_dir)?
        .into_iter()
        .find(|row| row.id == model.id)
        .ok_or_else(|| Error::Other("Unknown voice model.".into()))?)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn dev_transcribe(
    state: State<'_, AppState>,
    bytes_base64: String,
    filename: String,
) -> Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.trim())
        .map_err(|_| Error::Other("Could not read the recording.".into()))?;
    let pcm = decode_to_pcm(&bytes, &filename)?;
    let data_dir = state.data_dir.clone();
    let engine = state.speech.clone();
    crate::state::run_blocking(move || transcribe_pcm(&engine, &data_dir, &pcm)).await
}

#[cfg(test)]
mod tests {
    use super::embedded_plist_has_microphone;
    use super::*;
    use std::io::Write;

    #[test]
    fn embedded_plist_detects_the_microphone_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("twanagent");
        let mut macho = vec![0u8; 32 + 72 + 80 + 64];
        macho[0..4].copy_from_slice(&0xFEEDFACFu32.to_le_bytes());
        macho[16..20].copy_from_slice(&1u32.to_le_bytes());
        let cmd_at = 32;
        macho[cmd_at..cmd_at + 4].copy_from_slice(&0x19u32.to_le_bytes());
        macho[cmd_at + 4..cmd_at + 8].copy_from_slice(&(72 + 80u32).to_le_bytes());
        macho[cmd_at + 8..cmd_at + 14].copy_from_slice(b"__TEXT");
        macho[cmd_at + 64..cmd_at + 68].copy_from_slice(&1u32.to_le_bytes());
        let sect = cmd_at + 72;
        macho[sect..sect + 12].copy_from_slice(b"__info_plist");
        let blob = b"<?xml NSMicrophoneUsageDescription </plist>";
        let fileoff = (sect + 80) as u32;
        macho[sect + 40..sect + 48].copy_from_slice(&(blob.len() as u64).to_le_bytes());
        macho[sect + 48..sect + 52].copy_from_slice(&fileoff.to_le_bytes());
        let start = fileoff as usize;
        macho.resize(start + blob.len(), 0);
        macho[start..start + blob.len()].copy_from_slice(blob);
        std::fs::write(&path, &macho).unwrap();
        assert!(embedded_plist_has_microphone(&path));
        macho[start..start + blob.len()].fill(b' ');
        std::fs::write(&path, &macho).unwrap();
        assert!(!embedded_plist_has_microphone(&path));
    }

    #[test]
    fn default_model_is_tiny_english() {
        assert_eq!(normalize_model_id(""), "tiny.en");
        assert_eq!(normalize_model_id("nope"), "tiny.en");
        assert_eq!(normalize_model_id("base.en"), "base.en");
        for model in SPEECH_MODELS {
            assert!(model.file.starts_with("ggml-"));
            assert!(model.file.ends_with(".bin"));
        }
    }

    #[test]
    fn model_path_stays_inside_the_speech_dir() {
        let data = tempfile::tempdir().unwrap();
        let path = model_path(data.path(), "tiny.en").unwrap();
        assert_eq!(path, data.path().join("speech").join("ggml-tiny.en.bin"));
        assert!(model_path(data.path(), "../escape").is_err());
        assert!(model_path(data.path(), "tiny.en/../../x").is_err());
    }

    #[test]
    fn status_is_missing_partial_or_ready() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(model_status(data.path(), "tiny.en").unwrap(), ModelStatus::Missing);
        let path = model_path(data.path(), "tiny.en").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(partial_path(&path), b"part").unwrap();
        assert_eq!(model_status(data.path(), "tiny.en").unwrap(), ModelStatus::Partial);
        let mut file = File::create(&path).unwrap();
        file.write_all(&vec![0u8; 32]).unwrap();
        assert_eq!(model_status(data.path(), "tiny.en").unwrap(), ModelStatus::Partial);
        fs::remove_file(&path).unwrap();
        fs::remove_file(partial_path(&path)).unwrap();
        let expected = catalog_model("tiny.en").unwrap().bytes;
        // Don't write 74 MB in the unit test. Check the size compare directly.
        assert_eq!(status_for(&path, 0).unwrap(), ModelStatus::Missing);
        fs::write(&path, b"").unwrap();
        assert_eq!(status_for(&path, 0).unwrap(), ModelStatus::Ready);
        assert_ne!(expected, 0);
    }

    #[test]
    fn huggingface_hosts_are_the_only_redirects() {
        assert!(host_allowed("huggingface.co"));
        assert!(host_allowed("cdn-lfs.huggingface.co"));
        assert!(host_allowed("us.aws.cdn.hf.co"));
        assert!(host_allowed("cas-server.xethub.hf.co"));
        assert!(!host_allowed("evil.example"));
        assert!(!host_allowed("huggingface.co.evil.com"));
        assert!(!host_allowed("hf.co.evil.com"));
    }

    #[test]
    fn transcript_cleanup_drops_marks_and_blank_audio() {
        assert_eq!(
            clean_transcript("[00:00:00.000 --> 00:00:01.000] hello   there"),
            "hello there"
        );
        assert_eq!(clean_transcript("[BLANK_AUDIO]"), "");
        assert_eq!(clean_transcript("(blank audio)"), "");
        assert_eq!(clean_transcript("  "), "");
    }

    #[test]
    fn decode_reads_a_generated_wav() {
        let wav = wav_bytes(16_000, &[0.0, 0.25, -0.25, 0.5]);
        let pcm = decode_to_pcm(&wav, "dictation.wav").unwrap();
        assert_eq!(pcm.len(), 4);
        assert!((pcm[1] - 0.25).abs() < 0.02);
        assert!(decode_to_pcm(&[], "dictation.wav").is_err());
        assert!(decode_to_pcm(&wav, "dictation.webm").is_err());
    }

    #[test]
    fn decode_rejects_a_clip_over_sixty_seconds() {
        let samples = vec![0f32; 16_000 * 61];
        let wav = wav_bytes(16_000, &samples);
        let err = decode_to_pcm(&wav, "long.wav").unwrap_err();
        assert!(err.to_string().contains("60"));
    }

    #[test]
    fn transcribe_without_a_model_asks_for_a_download() {
        let data = tempfile::tempdir().unwrap();
        let engine = SpeechEngine::new();
        let err = transcribe_pcm(&engine, data.path(), &[0.1, 0.2]).unwrap_err();
        assert_eq!(err.to_string(), "Download a voice model in Settings.");
    }

    #[test]
    #[ignore]
    fn transcribe_with_a_local_model() {
        let path = std::env::var("TWANAGENT_WHISPER_MODEL").unwrap();
        let data = tempfile::tempdir().unwrap();
        let dest = model_path(data.path(), "tiny.en").unwrap();
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::copy(path, &dest).unwrap();
        let engine = SpeechEngine::new();
        let text = transcribe_pcm(&engine, data.path(), &vec![0.0; 16_000]).unwrap();
        assert!(text.len() < 200);
    }

    fn wav_bytes(rate: u32, samples: &[f32]) -> Vec<u8> {
        let mut body = Vec::new();
        for sample in samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let value = (clamped * i16::MAX as f32) as i16;
            body.extend_from_slice(&value.to_le_bytes());
        }
        let data_len = body.len() as u32;
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.extend(body);
        out
    }
}
