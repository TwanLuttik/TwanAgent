# Voice to text implementation plan

> **For agentic workers:** Implement task-by-task with TDD. Do not commit unless the user asks. Do not start a task until the user accepts this plan.

**Goal:** Let the user pick a free downloadable speech model in Settings, download it once, and dictate into the conversation composer. The transcript is inserted into the draft. It is not sent until the user presses Send.

**Architecture:** Speech runs on this machine. Settings lists a small catalog of whisper.cpp GGML models from Hugging Face. The chosen file is downloaded into the app data directory. The composer mic captures a short clip, Rust decodes it to 16 kHz mono PCM, and whisper.cpp transcribes it. No xAI key, no network call at dictate time, and the speech model is never sent to chat.

**Tech stack:** Tauri 2, Rust, `whisper-rs` (whisper.cpp bindings), `symphonia` for decode, existing `reqwest` for the one-time download, React, node:test + cargo test.

## Global constraints

- Models are free Whisper weights. Do not call `api.x.ai`, and do not use the saved xAI key or the Grok CLI token.
- Do not vendor model files in the repo or the app bundle. Download a model only after the user picks it.
- Download from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>?download=true`.
- Store models under `<data_dir>/speech/`. A partial file uses a `.partial` suffix and is renamed only after the size matches the catalog.
- Do not record until the user presses the mic. Stop on a second press, on Escape, or after 60 seconds.
- Insert the transcript into the current draft. Do not auto-send.
- One loaded model at a time. Switching models unloads the previous context.
- Transcription runs on a blocking thread so the UI stays responsive. A second dictate waits until the first one finishes.
- A missing model, denied mic, empty clip, or decode error is a flash message. It does not change the draft.
- Follow TDD for catalog, preference, download path checks, and transcript cleanup. No `TBD` leftovers.
- Do not commit unless asked.

## Current code

- Settings tabs live in `src/views/SettingsView.tsx`. The Grok tab is for the CLI and API key. Voice gets its own section there because that is where the user asked for the picker, but it does not depend on the key.
- App settings already persist in SQLite: `dev_app_get_setting` / `dev_app_set_setting` in `src-tauri/src/appdb.rs`. Speech uses the `speech.model` key.
- The composer is `src/components/Composer.tsx`, mounted by `src/views/main/SessionComposer.tsx` for both the landing prompt and the chat prompt.
- `reqwest` is already a dependency. There is no audio decoder and no whisper binding yet.

## Model catalog

These are the public ggml files published for whisper.cpp. Sizes are the file sizes, so the download can be checked.

| id | label | file | size | note |
|---|---|---|---|---|
| `tiny.en` | Tiny English | `ggml-tiny.en.bin` | 77,704,715 | default, fastest |
| `base.en` | Base English | `ggml-base.en.bin` | 147,964,211 | better English |
| `small.en` | Small English | `ggml-small.en.bin` | 487,614,201 | slower, clearly better |
| `tiny` | Tiny multilingual | `ggml-tiny.bin` | 77,691,713 | many languages, less accurate |

Do not list large or medium in the first picker. Large is about 3 GB and is a poor default for a click-to-dictate box. The catalog shape can grow later.

Default when nothing is saved: `tiny.en`.

Language passed to whisper is `en` for the `.en` models. Multilingual `tiny` uses whisper auto-detect (`None`).

## File map

- Create: `src/lib/speech.ts` — catalog, preference normalization, draft insertion
- Create: `src/lib/tests/speech.test.ts`
- Create: `src-tauri/src/speech.rs` — catalog, download, decode, transcribe
- Modify: `src-tauri/Cargo.toml` — `whisper-rs`, `symphonia` with wav/ogg/mp3/aac
- Modify: `src-tauri/src/lib.rs` — `mod speech` and the new commands
- Modify: `src-tauri/src/state.rs` — optional loaded whisper context
- Modify: `src/lib/tauri.ts` — types and invoke wrappers
- Modify: `src/views/SettingsView.tsx` — Voice section on the Grok tab
- Modify: `src/components/Composer.tsx` — mic button
- Modify: `src/views/main/SessionComposer.tsx` — pass speech state
- Modify: `src/views/main/context.tsx` and `src/views/MainView.tsx` — load and save the speech model
- Modify: `src/components/Symbol.tsx` — `mic` and `mic.fill`

## Data

Setting key: `speech.model`.

Value: a catalog id. Unknown or empty values load as `tiny.en`. Do not write the default until the user changes the picker.

On disk:

```text
<data_dir>/speech/ggml-tiny.en.bin
<data_dir>/speech/ggml-tiny.en.bin.partial
```

No audio is stored. The clip exists only in memory until transcription finishes. Deleting a model file from disk makes that row show as not downloaded. Do not add a delete button in this slice.

## Tasks

### Task 1: Catalog and draft insertion

**Files:** `src/lib/speech.ts`, `src/lib/tests/speech.test.ts`.

- Export `SPEECH_MODELS` with `id`, `label`, `file`, `bytes`, and `english`.
- `normalizeSpeechModel(id)` returns the id when it is in the catalog, otherwise `tiny.en`.
- `speechModel(id)` returns the catalog row or the default row.
- `insertTranscript(draft, start, end, text)` replaces the selection, or inserts at the cursor when start equals end.
- Trim the transcript. Collapse internal whitespace to single spaces. Drop a leading `[BLANK_AUDIO]` or `(blank audio)` token. If the result is empty, return the draft unchanged and the original cursor.
- Put one space before the transcript when the character before the cursor is a letter or digit. Do not add a leading space at offset 0 or after whitespace.
- Put one trailing space after the transcript. The returned cursor sits after that space.
- Cap the inserted text at 8_000 characters.

**Done when:** node tests cover the default, an unknown id, insertion, selection replace, spacing, blank-audio cleanup, an empty transcript, and the cap.

### Task 2: Local model status and download

**Files:** `src-tauri/src/speech.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`.

- Mirror the catalog in Rust, including file name and byte size. A test asserts the default id is `tiny.en` and every file name starts with `ggml-` and ends with `.bin`.
- `model_path(data_dir, id)` resolves only inside `<data_dir>/speech/`. Reject an id that is not in the catalog. A test proves `../` cannot escape the speech directory.
- `model_status(data_dir, id)` is `missing`, `partial`, or `ready`. Ready means the final file exists and its length equals the catalog size. A short or long file is `partial`, not ready.
- `dev_speech_models` returns each row plus its status for the app data dir.
- `dev_speech_download(id)` streams the Hugging Face URL to `<file>.partial`, then renames it when the byte count matches. If the final file is already ready, return immediately.
- Refuse a second download of the same id while one is running. Emit `speech-download` events with `id`, `received`, and `total` so Settings can show progress.
- On HTTP error, delete the partial file and return a short message. Do not follow a redirect onto a different host. Hugging Face redirects to `cdn-lfs.huggingface.co` are allowed. Any other host is an error.
- Do not add a live download test. Tests use a local status fixture and a URL-host allow list.

**Done when:** cargo tests cover path jail, ready vs partial vs missing, and the host allow list. Both commands are registered.

### Task 3: Transcribe a clip locally

**Files:** `src-tauri/src/speech.rs`, `src-tauri/src/state.rs`, `src-tauri/src/lib.rs`.

- Add `whisper-rs` and `symphonia`. Enable the whisper features needed to load a ggml bin and transcribe 16 kHz mono f32. Do not enable a GPU backend in this slice.
- `decode_to_pcm(bytes, filename)` accepts wav, mp3, ogg, and m4a/aac. It returns mono f32 samples at 16_000 Hz. Reject empty input, unknown extensions, and clips longer than 60 seconds after decode.
- Stereo becomes mono by averaging. Sample rates other than 16 kHz are linearly resampled. A test can use a tiny generated WAV fixture and check the sample rate and channel count without a model file.
- `clean_transcript(text)` trims, collapses whitespace, and removes blank-audio tokens and whisper timestamp markers like `[00:00:00.000 --> 00:00:01.000]`. Same rules as the frontend cap, but the frontend still caps again.
- `dev_transcribe(bytes_base64, filename)` loads the selected model from `speech.model`. If it is not ready, return `Download a voice model in Settings.`.
- Keep the whisper context in app state, keyed by model id. Reload only when the id changes.
- Run whisper with English for `.en` models and auto-detect for `tiny`. Single segment, greedy, no translate task. The text returned to the UI is the cleaned transcript only.
- Guard the context with a mutex. Do not log audio or the transcript.

**Done when:** cargo tests cover decode of a generated WAV, rejection of a long clip, transcript cleanup, and the not-downloaded error. A full whisper inference test is ignored unless `TWANAGENT_WHISPER_MODEL` points at a local ggml file.

### Task 4: Settings picker

**Files:** `src/views/SettingsView.tsx`, `src/views/MainView.tsx`, `src/views/main/context.tsx`, `src/lib/tauri.ts`.

- Add wrappers: `speechModels()`, `speechDownload(id)`, `onSpeechDownload`, `transcribe(bytesBase64, filename)`.
- On startup, load `speech.model`, normalize it, and keep it in the main context.
- On the Grok tab, under the API key, add a Voice section:
  - Title: Voice
  - Text: Dictate into the message box. The model downloads once and runs on this Mac.
  - A `<select>` of the catalog. Each option shows the label and a short size, such as `Tiny English · 74 MB`.
  - Under the select, show `Not downloaded`, `Downloading… 12 MB / 74 MB`, or `Ready`.
  - A button, `Download`, is visible when the selected model is missing or partial. It is disabled while that download is in progress.
- Changing the select saves `speech.model` but does not start a download. The user presses Download.
- Refresh status when the tab opens and when a download event finishes.

**Done when:** the picker lists the four models, the saved id survives a reload, an unknown stored id shows Tiny English, and the button reflects missing vs ready.

### Task 5: Composer mic

**Files:** `src/components/Composer.tsx`, `src/views/main/SessionComposer.tsx`, `src/components/Symbol.tsx`.

- Add a mic button in the composer toolbar, to the left of the folder chip. Label it `Dictate` when idle and `Stop dictation` while recording.
- Use `mic` / `mic.fill`. Recording uses the filled icon and `text-err`.
- `getUserMedia({ audio: true })` only after the click. Record with `MediaRecorder`, preferring `audio/webm` and falling back to the browser default. Whisper needs a container `symphonia` can read, so if the browser only offers webm, stop and show `This browser recorded a format the local model cannot read.` Do not send that blob.
- Preferred path: record `audio/wav` when offered. Otherwise `audio/mp4` or `audio/ogg`.
- On stop, base64 the blob with `fileToBase64` and call `transcribe`. The command uses the saved model. The composer does not pick a model.
- On success, `insertTranscript` at the textarea selection, then `onDraft`. Focus the box and put the caret at the returned cursor.
- Disable the mic while a transcription request is in flight. Recording may start during a chat turn. Dictation does not send or stop the turn.
- If the model is not downloaded, the command's error is the flash. The mic stays available so the message can tell the user to download it.
- Permission denied: `Allow the microphone to dictate.`
- Escape stops recording and discards the clip. Unmount stops the recorder and the mic tracks.

**Done when:** a click records, a second click inserts text into the draft, Escape cancels, and an error leaves the draft unchanged.

## Suggested order

Task 1 locks insertion and the catalog ids. Task 2 is the download the settings screen needs. Task 3 is the local engine and can land before the mic. Task 4 is the first visible slice. Task 5 wires the composer to the command.

## Out of scope

- xAI Speech to Text, streaming captions, and the realtime voice API.
- GPU or Core ML acceleration.
- Large, medium, and turbo models in the picker.
- A delete-model button and a download queue.
- Live partial transcripts while the user is still talking.
- Dictation in the code editor or terminal.
- Auto-sending the transcript.
