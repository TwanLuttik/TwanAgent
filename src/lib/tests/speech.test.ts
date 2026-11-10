import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SPEECH_MODEL,
  SPEECH_MODELS,
  TRANSCRIPT_CAP,
  cleanTranscript,
  dictationFilename,
  insertTranscript,
  normalizeSpeechModel,
  encodeWav,
  audioInputDevices,
  micAudioConstraints,
  meterLevel,
  micLevel,
  voiceBars,
  preferredRecorderMime,
  speechDownloadIdle,
  speechDownloadProgress,
  speechDownloadStart,
  speechModel,
  speechRowDownloading,
  speechSizeLabel,
} from "../speech.ts";

describe("speech catalog", () => {
  it("defaults to tiny english", () => {
    assert.equal(DEFAULT_SPEECH_MODEL, "tiny.en");
    assert.equal(normalizeSpeechModel(""), "tiny.en");
    assert.equal(normalizeSpeechModel(null), "tiny.en");
    assert.equal(normalizeSpeechModel("nope"), "tiny.en");
  });

  it("keeps a known model id", () => {
    assert.equal(normalizeSpeechModel(" base.en "), "base.en");
    assert.equal(speechModel("tiny").file, "ggml-tiny.bin");
    assert.equal(speechModel("missing").id, "tiny.en");
  });

  it("lists free downloadable ggml files", () => {
    assert.deepEqual(
      SPEECH_MODELS.map((model) => model.id),
      ["tiny.en", "base.en", "small.en", "tiny"],
    );
    for (const model of SPEECH_MODELS) {
      assert.match(model.file, /^ggml-.*\.bin$/);
      assert.ok(model.bytes > 1_000_000);
    }
  });

  it("rounds sizes to megabytes", () => {
    assert.equal(speechSizeLabel(77_704_715), "74 MB");
  });
});

describe("insert transcript", () => {
  it("inserts in the middle with a trailing space", () => {
    const next = insertTranscript("Hello world", 5, 5, "there");
    assert.equal(next.text, "Hello there world");
    assert.equal(next.cursor, 11);
  });

  it("replaces a selection", () => {
    const next = insertTranscript("Hello world", 6, 11, "there");
    assert.equal(next.text, "Hello there ");
    assert.equal(next.cursor, 12);
  });

  it("adds a leading space only after a letter or digit", () => {
    assert.equal(insertTranscript("Say", 3, 3, "hi").text, "Say hi ");
    assert.equal(insertTranscript("Say ", 4, 4, "hi").text, "Say hi ");
    assert.equal(insertTranscript("", 0, 0, "hi").text, "hi ");
  });

  it("leaves the draft alone for an empty or blank transcript", () => {
    assert.deepEqual(insertTranscript("Keep", 2, 2, "   "), { text: "Keep", cursor: 2 });
    assert.deepEqual(insertTranscript("Keep", 4, 4, "[BLANK_AUDIO]"), { text: "Keep", cursor: 4 });
    assert.deepEqual(insertTranscript("Keep", 1, 1, "(blank audio)"), { text: "Keep", cursor: 1 });
  });

  it("drops timestamp markers and caps the inserted text", () => {
    assert.equal(cleanTranscript("[00:00:00.000 --> 00:00:01.000]  hello   there"), "hello there");
    const long = "a".repeat(TRANSCRIPT_CAP + 20);
    const next = insertTranscript("", 0, 0, long);
    assert.equal(next.text.length, TRANSCRIPT_CAP + 1);
    assert.equal(next.cursor, TRANSCRIPT_CAP + 1);
  });
});

describe("recorder mime", () => {
  it("maps a container whisper can read", () => {
    assert.equal(dictationFilename("audio/wav;codecs=1"), "dictation.wav");
    assert.equal(dictationFilename("audio/mp4"), "dictation.m4a");
    assert.equal(dictationFilename("audio/webm"), null);
  });

  it("prefers wav, then mp4, then ogg", () => {
    assert.equal(
      preferredRecorderMime((mime) => mime === "audio/ogg" || mime === "audio/webm"),
      "audio/ogg",
    );
    assert.equal(preferredRecorderMime(() => false), "");
  });

  it("keeps a chosen microphone and measures its level", () => {
    assert.deepEqual(micAudioConstraints(""), { echoCancellation: true, noiseSuppression: true });
    assert.deepEqual(micAudioConstraints("mic-1").deviceId, { exact: "mic-1" });
    assert.deepEqual(
      audioInputDevices([
        { kind: "audiooutput", deviceId: "spk", label: "Speakers" },
        { kind: "audioinput", deviceId: "mic-1", label: "  Built-in  " },
        { kind: "audioinput", deviceId: "", label: "Ghost" },
        { kind: "audioinput", deviceId: "mic-2", label: "" },
      ]),
      [
        { id: "mic-1", label: "Built-in" },
        { id: "mic-2", label: "Microphone 2" },
      ],
    );
    assert.equal(micLevel([]), 0);
    assert.equal(micLevel(new Float32Array(128)), 0);
    assert.ok(micLevel(new Float32Array(128).fill(0.25)) > 0.9);
    assert.equal(meterLevel([]), 0);
    assert.equal(meterLevel(new Float32Array(128).fill(0.002)), 0);
    const quietSpeech = meterLevel(new Float32Array(128).fill(0.012));
    const normalSpeech = meterLevel(new Float32Array(128).fill(0.03));
    assert.ok(quietSpeech > 0.4);
    assert.ok(normalSpeech > quietSpeech);
    assert.ok(normalSpeech < 1);
    assert.equal(meterLevel(new Float32Array(128).fill(0.2)), 1);
    const quiet = voiceBars(0);
    const loud = voiceBars(1);
    assert.equal(quiet.length, 12);
    assert.ok(quiet.every((bar) => bar >= 0.14 && bar <= 1));
    assert.ok(loud[6] > loud[0]);
    assert.ok(loud[6] > quiet[6]);
  });

  it("encodes mono pcm as a wav blob", async () => {
    const blob = encodeWav(new Float32Array([0, 0.5, -1]), 16_000);
    assert.equal(blob.type, "audio/wav");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
    assert.equal(bytes.length, 44 + 6);
  });
});

describe("speech download", () => {
  it("marks only the model that is actually downloading", () => {
    const idle = speechDownloadIdle();
    assert.equal(speechRowDownloading(idle, "tiny.en"), false);
    assert.equal(speechRowDownloading(idle, "base.en"), false);
    const started = speechDownloadStart("base.en", 100);
    assert.equal(speechRowDownloading(started, "base.en"), true);
    assert.equal(speechRowDownloading(started, "tiny.en"), false);
  });

  it("ignores a late event from a download that was replaced", () => {
    const current = speechDownloadStart("small.en", 400);
    const late = speechDownloadProgress(current, { id: "tiny.en", received: 10, total: 80, done: true });
    assert.deepEqual(late, current);
    const moved = speechDownloadProgress(current, { id: "small.en", received: 40, total: 400, done: false });
    assert.equal(speechRowDownloading(moved, "small.en"), true);
    assert.equal(moved.phase === "downloading" ? moved.received : 0, 40);
    const done = speechDownloadProgress(moved, { id: "small.en", received: 400, total: 400, done: true });
    assert.equal(done.phase, "idle");
  });
});
