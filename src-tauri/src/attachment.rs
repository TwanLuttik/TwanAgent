//! Turn a dropped file into something the model can read.
//!
//! Pictures stay on the `images` sidecar and go out as image parts.
//! Grok's chat completions API only accepts text and images, so other files are
//! written into the user text. Claude also accepts a PDF as a document block.
//! The saved transcript keeps the short `[name]` token. This runs on the
//! request copy, once per round.

use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

const INLINE_MAX: usize = 100_000;
const INLINE_HEAD: usize = 80_000;
const INLINE_TAIL: usize = 8_000;
const READ_MAX: u64 = 50 * 1024 * 1024;
const PDF_DOCUMENT_MAX: usize = 24 * 1024 * 1024;

pub fn expand_messages(data_dir: &Path, messages: Value, pdf_documents: bool) -> Value {
    let Some(rows) = messages.as_array() else {
        return messages;
    };
    Value::Array(
        rows.iter()
            .map(|message| expand_message(data_dir, message, pdf_documents))
            .collect(),
    )
}

fn expand_message(data_dir: &Path, message: &Value, pdf_documents: bool) -> Value {
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return message.clone();
    }
    let Some(rows) = message.get("images").and_then(Value::as_array) else {
        return message.clone();
    };
    if !rows.iter().any(is_file_row) {
        return message.clone();
    }

    let mut pictures = Vec::new();
    let mut documents = Vec::new();
    let mut labels = Vec::new();
    let mut blocks = Vec::new();
    for row in rows {
        if !is_file_row(row) {
            pictures.push(row.clone());
            continue;
        }
        let name = row_name(row);
        labels.push(name.clone());
        match file_block(data_dir, row, &name, pdf_documents) {
            FileBlock::Text(text) => blocks.push(text),
            FileBlock::Document { note, row } => {
                blocks.push(note);
                documents.push(row);
            }
        }
    }

    let mut message = message.clone();
    message["content"] = join_content(message.get("content"), &labels, &blocks);
    let mut kept = pictures;
    kept.extend(documents);
    if let Some(fields) = message.as_object_mut() {
        if kept.is_empty() {
            fields.remove("images");
        } else {
            fields.insert("images".into(), Value::Array(kept));
        }
    }
    message
}

enum FileBlock {
    Text(String),
    Document { note: String, row: Value },
}

fn file_block(data_dir: &Path, row: &Value, name: &str, pdf_documents: bool) -> FileBlock {
    let path = row.get("path").and_then(Value::as_str).unwrap_or("").trim();
    let mime = row.get("mime").and_then(Value::as_str).unwrap_or("");
    let bytes = match read_attachment(data_dir, row) {
        Ok(bytes) => bytes,
        Err(ReadFail::TooLarge) => {
            return FileBlock::Text(tag(
                name,
                &[("bytes", "too-large")],
                &missing_path(path, "File is too large to inline."),
            ));
        }
        Err(ReadFail::Missing) => {
            return FileBlock::Text(tag(name, &[], "File is missing."));
        }
    };
    let len = bytes.len().to_string();
    if is_pdf(name, mime, &bytes) {
        if pdf_documents && !bytes.is_empty() && bytes.len() <= PDF_DOCUMENT_MAX {
            let mut kept = row.clone();
            kept["mime"] = json!("application/pdf");
            kept["dataUrl"] = json!(data_url("application/pdf", &bytes));
            return FileBlock::Document {
                note: tag(name, &[("bytes", &len)], "PDF attached."),
                row: kept,
            };
        }
        let text = pdf_plain_text(&bytes);
        if text.is_empty() {
            return FileBlock::Text(tag(
                name,
                &[("bytes", &len)],
                &missing_path(path, "PDF text could not be extracted."),
            ));
        }
        return FileBlock::Text(text_block(name, path, &len, &text));
    }
    if let Some(text) = as_text(&bytes) {
        if text.trim().is_empty() {
            return FileBlock::Text(tag(name, &[("bytes", &len)], "Empty file."));
        }
        return FileBlock::Text(text_block(name, path, &len, &text));
    }
    FileBlock::Text(tag(
        name,
        &[("bytes", &len)],
        &missing_path(path, "Binary file, not inlined."),
    ))
}

fn text_block(name: &str, path: &str, len: &str, text: &str) -> String {
    let (body, truncated) = clip_text(text);
    let body = guard_body(&body);
    if truncated {
        tag(
            name,
            &[("bytes", len), ("truncated", "true")],
            &format!(
                "{}\n{body}",
                missing_path(path, "File was truncated.").trim_end()
            ),
        )
    } else {
        tag(name, &[], &body)
    }
}

fn missing_path(path: &str, sentence: &str) -> String {
    let path = path.trim();
    if path.is_empty() {
        sentence.to_string()
    } else {
        format!("{sentence} Saved at {path}.")
    }
}

fn join_content(content: Option<&Value>, labels: &[String], blocks: &[String]) -> Value {
    let extra = blocks.join("\n\n");
    match content {
        Some(Value::Array(parts)) => {
            let mut next = Vec::new();
            let mut text_at = Vec::new();
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    let stripped = strip_labels(
                        part.get("text").and_then(Value::as_str).unwrap_or(""),
                        labels,
                    );
                    if stripped.is_empty() {
                        continue;
                    }
                    text_at.push(next.len());
                    next.push(json!({ "type": "text", "text": stripped }));
                    continue;
                }
                next.push(part.clone());
            }
            if !extra.is_empty() {
                if let Some(index) = text_at.last().copied() {
                    let text = next[index]
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    next[index]["text"] = json!(format!("{text}\n\n{extra}"));
                } else {
                    next.push(json!({ "type": "text", "text": extra }));
                }
            }
            Value::Array(next)
        }
        Some(Value::String(text)) => {
            Value::String(join_user_and_files(&strip_labels(text, labels), &extra))
        }
        _ => Value::String(extra),
    }
}

fn join_user_and_files(user: &str, extra: &str) -> String {
    if user.is_empty() {
        extra.to_string()
    } else if extra.is_empty() {
        user.to_string()
    } else {
        format!("{user}\n\n{extra}")
    }
}

fn is_file_row(row: &Value) -> bool {
    row.get("kind").and_then(Value::as_str) == Some("file")
}

fn row_name(row: &Value) -> String {
    let name = row.get("name").and_then(Value::as_str).unwrap_or("").trim();
    let cleaned: String = name
        .chars()
        .filter(|ch| !matches!(ch, '[' | ']' | '\r' | '\n'))
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned.to_string()
    }
}

enum ReadFail {
    Missing,
    TooLarge,
}

fn read_attachment(data_dir: &Path, row: &Value) -> Result<Vec<u8>, ReadFail> {
    let path = row.get("path").and_then(Value::as_str).unwrap_or("").trim();
    if !path.is_empty() {
        if let Ok(file) = crate::image::resolve_attachment(data_dir, path) {
            let meta = std::fs::metadata(&file).map_err(|_| ReadFail::Missing)?;
            if !meta.is_file() {
                return Err(ReadFail::Missing);
            }
            if meta.len() > READ_MAX {
                return Err(ReadFail::TooLarge);
            }
            return std::fs::read(file).map_err(|_| ReadFail::Missing);
        }
    }
    decode_data_url(row.get("dataUrl").and_then(Value::as_str).unwrap_or(""))
        .ok_or(ReadFail::Missing)
}

fn decode_data_url(url: &str) -> Option<Vec<u8>> {
    let rest = url.trim().strip_prefix("data:")?;
    let (_meta, data) = rest.split_once(',')?;
    if !rest.contains(";base64") || data.is_empty() {
        return None;
    }
    BASE64.decode(data.trim()).ok()
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", BASE64.encode(bytes))
}

fn is_pdf(name: &str, mime: &str, bytes: &[u8]) -> bool {
    let mime = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    mime == "application/pdf"
        || name.to_ascii_lowercase().ends_with(".pdf")
        || bytes.starts_with(b"%PDF-")
}

fn as_text(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return None;
    }
    std::str::from_utf8(bytes).ok().map(str::to_string)
}

fn pdf_plain_text(bytes: &[u8]) -> String {
    let owned = bytes.to_vec();
    let extracted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pdf_extract::extract_text_from_mem(&owned).unwrap_or_default()
    }));
    match extracted {
        Ok(text) => text.replace('\0', "").trim().to_string(),
        Err(_) => String::new(),
    }
}

fn clip_text(text: &str) -> (String, bool) {
    let count = text.chars().count();
    if count <= INLINE_MAX {
        return (text.to_string(), false);
    }
    let head: String = text.chars().take(INLINE_HEAD).collect();
    let tail: String = text.chars().skip(count - INLINE_TAIL).collect();
    let omitted = count - INLINE_HEAD - INLINE_TAIL;
    (
        format!("{head}\n… omitted {omitted} characters …\n{tail}"),
        true,
    )
}

fn guard_body(body: &str) -> String {
    body.replace("</attached_file>", "</ attached_file>")
}

fn tag(name: &str, attrs: &[(&str, &str)], body: &str) -> String {
    let mut extra = String::new();
    for (key, value) in attrs {
        extra.push(' ');
        extra.push_str(key);
        extra.push_str("=\"");
        extra.push_str(&escape_attr(value));
        extra.push('"');
    }
    format!(
        "<attached_file name=\"{}\"{extra}>\n{body}\n</attached_file>",
        escape_attr(name)
    )
}

fn escape_attr(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\n' | '\r' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out
}

fn strip_labels(text: &str, labels: &[String]) -> String {
    let mut out = text.to_string();
    for label in labels {
        let label = label.trim();
        if label.is_empty() {
            continue;
        }
        out = out.replace(&format!("[{label}]"), "");
    }
    tidy_user_text(&out)
}

fn tidy_user_text(text: &str) -> String {
    let mut out = String::new();
    let mut pending_space = false;
    let mut line_start = true;
    for ch in text.chars() {
        if ch == '\n' {
            while out.ends_with(' ') {
                out.pop();
            }
            out.push('\n');
            pending_space = false;
            line_start = true;
            continue;
        }
        if ch.is_whitespace() {
            if !line_start {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        line_start = false;
        out.push(ch);
    }
    while out.ends_with(' ') || out.ends_with('\n') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn text_file_is_inlined_and_its_token_is_removed() {
        let dir = tempdir().unwrap();
        let stored =
            crate::image::prepare_file(dir.path(), b"fn main() {}\n", "main.rs", Some("c"))
                .unwrap();
        let messages = json!([{
            "role": "user",
            "content": "what does [main.rs] do",
            "images": [{
                "kind": "file",
                "name": "main.rs",
                "path": stored.path,
                "mime": "text/plain"
            }]
        }]);
        let out = expand_messages(dir.path(), messages, false);
        let content = out[0]["content"].as_str().unwrap();
        assert!(content.contains("what does"), "{content}");
        assert!(content.contains("fn main() {}"), "{content}");
        assert!(
            content.contains("<attached_file name=\"main.rs\">"),
            "{content}"
        );
        assert!(!content.contains("[main.rs]"), "{content}");
        assert!(out[0].get("images").is_none());
    }

    #[test]
    fn a_picture_is_left_for_the_image_path() {
        let dir = tempdir().unwrap();
        let messages = json!([{
            "role": "user",
            "content": "see [shot.png]",
            "images": [{ "name": "shot.png", "dataUrl": "data:image/png;base64,abc" }]
        }]);
        let out = expand_messages(dir.path(), messages.clone(), false);
        assert_eq!(out, messages);
    }

    #[test]
    fn a_picture_beside_a_file_keeps_the_picture_only() {
        let dir = tempdir().unwrap();
        let stored = crate::image::prepare_file(dir.path(), b"alpha", "notes.txt", None).unwrap();
        let messages = json!([{
            "role": "user",
            "content": [
                { "type": "text", "text": "see [notes.txt] and [shot.png]" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,abc" } }
            ],
            "images": [
                { "kind": "file", "name": "notes.txt", "path": stored.path, "mime": "text/plain" },
                { "name": "shot.png", "mime": "image/png", "dataUrl": "data:image/png;base64,abc" }
            ]
        }]);
        let out = expand_messages(dir.path(), messages, true);
        let content = &out[0]["content"];
        assert_eq!(content[1]["type"], "image_url");
        let text = content[0]["text"].as_str().unwrap();
        assert!(text.contains("alpha"), "{text}");
        assert!(text.contains("[shot.png]"), "{text}");
        assert!(!text.contains("[notes.txt]"), "{text}");
        assert_eq!(out[0]["images"].as_array().unwrap().len(), 1);
        assert_eq!(out[0]["images"][0]["name"], "shot.png");
    }

    #[test]
    fn binary_bytes_are_not_inlined() {
        let dir = tempdir().unwrap();
        let stored =
            crate::image::prepare_file(dir.path(), &[0, 1, 2, 255], "blob.bin", None).unwrap();
        let messages = json!([{
            "role": "user",
            "content": "[blob.bin]",
            "images": [{ "kind": "file", "name": "blob.bin", "path": stored.path, "mime": "application/octet-stream" }]
        }]);
        let out = expand_messages(dir.path(), messages, false);
        let content = out[0]["content"].as_str().unwrap();
        assert!(content.contains("Binary file, not inlined."), "{content}");
        assert!(content.contains(&stored.path), "{content}");
        assert!(!content.contains("[blob.bin]"), "{content}");
    }

    #[test]
    fn a_path_outside_attachments_is_not_read() {
        let dir = tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"TOP-SECRET-BYTES").unwrap();
        let messages = json!([{
            "role": "user",
            "content": "read [secret.txt]",
            "images": [{
                "kind": "file",
                "name": "secret.txt",
                "path": secret.to_string_lossy().replace('\\', "/"),
                "mime": "text/plain"
            }]
        }]);
        let out = expand_messages(dir.path(), messages, false);
        let content = out[0]["content"].as_str().unwrap();
        assert!(!content.contains("TOP-SECRET-BYTES"), "{content}");
        assert!(content.contains("File is missing."), "{content}");
    }

    #[test]
    fn claude_receives_a_pdf_as_a_document_url() {
        let dir = tempdir().unwrap();
        let stored =
            crate::image::prepare_file(dir.path(), b"%PDF-1.4\nhello\n", "doc.pdf", None).unwrap();
        let messages = json!([{
            "role": "user",
            "content": "summarize [doc.pdf]",
            "images": [{ "kind": "file", "name": "doc.pdf", "path": stored.path, "mime": "application/pdf" }]
        }]);
        let out = expand_messages(dir.path(), messages, true);
        let content = out[0]["content"].as_str().unwrap();
        assert!(content.contains("PDF attached."), "{content}");
        assert!(!content.contains("[doc.pdf]"), "{content}");
        let url = out[0]["images"][0]["dataUrl"].as_str().unwrap();
        assert!(url.starts_with("data:application/pdf;base64,"), "{url}");
    }

    #[test]
    fn grok_does_not_send_a_pdf_as_an_image() {
        let dir = tempdir().unwrap();
        let stored =
            crate::image::prepare_file(dir.path(), b"%PDF-1.4\nhello\n", "doc.pdf", None).unwrap();
        let messages = json!([{
            "role": "user",
            "content": "[doc.pdf]",
            "images": [{ "kind": "file", "name": "doc.pdf", "path": stored.path, "mime": "application/pdf" }]
        }]);
        let out = expand_messages(dir.path(), messages, false);
        assert!(out[0].get("images").is_none());
        let content = out[0]["content"].as_str().unwrap();
        assert!(!content.contains("data:application/pdf"), "{content}");
        assert!(
            content.contains("could not be extracted") || content.contains("hello"),
            "{content}"
        );
    }

    #[test]
    fn a_long_text_file_is_truncated() {
        let dir = tempdir().unwrap();
        let body = "a".repeat(INLINE_MAX + 50);
        let stored =
            crate::image::prepare_file(dir.path(), body.as_bytes(), "long.txt", None).unwrap();
        let messages = json!([{
            "role": "user",
            "content": "",
            "images": [{ "kind": "file", "name": "long.txt", "path": stored.path, "mime": "text/plain" }]
        }]);
        let out = expand_messages(dir.path(), messages, false);
        let content = out[0]["content"].as_str().unwrap();
        assert!(content.contains("truncated=\"true\""), "{content}");
        assert!(content.contains("omitted"), "{content}");
        assert!(content.contains(&stored.path), "{content}");
        assert!(
            content.chars().count() < body.chars().count(),
            "the prompt should be shorter than the file"
        );
    }
}
