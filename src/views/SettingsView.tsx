import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/Button";
import { Symbol } from "../components/Symbol";
import { ThemePicker } from "../components/ThemePicker";
import { maskEmail } from "../lib/mask";
import { formatBytes } from "../lib/usage";
import { folderName } from "../lib/core";
import {
  PERMISSION_MODES,
  parsePermissionMode,
  permissionDetail,
  type PermissionMode,
} from "../lib/permission";
import {
  loadExpandEdits,
  loadFileHoverCard,
  loadMarkdownOpenMode,
  loadPerfOverlay,
  loadSpaceCorner,
  loadSpaceCornerScene,
  saveMarkdownOpenMode,
  setExpandEdits,
  setFileHoverCard,
  setPerfOverlay,
  setSpaceCorner,
  setSpaceCornerScene,
  type MarkdownOpenMode,
} from "../lib/prefs";
import { DEFAULT_SCENE, isSceneId, SCENES, type SceneId } from "../lib/ascii/scenes";
import { loadTheme, type ThemeSelection } from "../lib/theme";
import * as api from "../lib/tauri";
import type { GrokCliInfo, UsageDbInfo } from "../lib/tauri";
import { useApp } from "../state/app-state";
import {
  SPEECH_MODELS,
  loadMicDevice,
  micAudioConstraints,
  micLevel,
  saveMicDevice,
  speechModel,
  speechNote,
  speechSizeLabel,
  type MicDevice,
  type SpeechModelInfo,
} from "../lib/speech";
import pcmCaptureUrl from "../lib/pcm-capture-processor.js?url";
import type { SpeechModelStatus } from "../lib/tauri";

export type SettingsTab = "appearance" | "providers" | "voice" | "storage" | "permissions";

const SETTINGS_TABS: { id: SettingsTab; label: string; hint: string }[] = [
  { id: "providers", label: "Model Providers", hint: "Grok and Claude" },
  { id: "voice", label: "Voice", hint: "Dictation model" },
  { id: "permissions", label: "Permissions", hint: "Folders and tools" },
  { id: "storage", label: "Storage", hint: "Usage database" },
  { id: "appearance", label: "Appearance", hint: "Theme and display" },
];

export function SettingsView({
  initialTab = "appearance",
  embedded = false,
  permission: permissionProp,
  onPermission,
  speechModel,
  speechModels = [],
  speechProgress,
  speechDownloading,
  onSpeechModel,
  onSpeechDownload,
  onKeyChange,
  onClose,
}: {
  initialTab?: SettingsTab;
  embedded?: boolean;
  permission?: PermissionMode;
  onPermission?: (id: PermissionMode) => void;
  speechModel?: string;
  speechModels?: SpeechModelInfo[];
  speechProgress?: { id?: string; received: number; total: number } | null;
  speechDownloading?: boolean;
  onSpeechModel?: (id: string) => void;
  onSpeechDownload?: (id: string) => void;
  onKeyChange?: () => void;
  onClose?: () => void;
} = {}) {
  const { setFlash } = useApp();
  const [theme, setThemeSel] = useState<ThemeSelection>(() => loadTheme());
  const [spaceArt, setSpaceArt] = useState(() => loadSpaceCorner());
  const [spaceScene, setSpaceScene] = useState<SceneId>(() => {
    const stored = loadSpaceCornerScene();
    return isSceneId(stored) ? stored : DEFAULT_SCENE;
  });
  const [spaceVideo, setSpaceVideo] = useState(() => isSceneId(loadSpaceCornerScene()));
  const [fileHoverCard, setFileHoverCardOn] = useState(() => loadFileHoverCard());
  const [perfOverlay, setPerfOverlayOn] = useState(() => loadPerfOverlay());
  const [expandEdits, setExpandEditsOn] = useState(() => loadExpandEdits());
  const [markdownOpen, setMarkdownOpen] = useState<MarkdownOpenMode>(() => loadMarkdownOpenMode());
  const version = __APP_VERSION_LABEL__;
  const [xaiKey, setXaiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<{ saved: boolean; env: boolean } | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicStatus, setAnthropicStatus] = useState<{ saved: boolean; env: boolean } | null>(null);
  const [savingAnthropic, setSavingAnthropic] = useState(false);
  const [cli, setCli] = useState<GrokCliInfo | null>(null);
  const [showEmail, setShowEmail] = useState(false);
  const [db, setDb] = useState<UsageDbInfo | null>(null);
  const [resettingDb, setResettingDb] = useState(false);
  const [openingDb, setOpeningDb] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [addingFolder, setAddingFolder] = useState(false);
  const [permissionLocal, setPermissionLocal] = useState<PermissionMode>(() => parsePermissionMode(permissionProp));
  const permission = permissionProp ?? permissionLocal;
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [voicePicker, setVoicePicker] = useState(false);

  useEffect(() => {
    if (!onClose) return;
    const close = onClose;
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape" || voicePicker) return;
      ev.preventDefault();
      close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, voicePicker]);

  useEffect(() => {
    let gone = false;
    void api
      .keyStatus()
      .then((s) => {
        if (!gone) setKeyStatus(s);
      })
      .catch(() => undefined);
    void api
      .anthropicKeyStatus()
      .then((s) => {
        if (!gone) setAnthropicStatus(s);
      })
      .catch(() => undefined);
    void api
      .cliInfo()
      .then((info) => {
        if (!gone) setCli(info);
      })
      .catch(() => undefined);
    void api
      .usageDbInfo()
      .then((info) => {
        if (!gone) setDb(info);
      })
      .catch(() => undefined);
    void api
      .openedWorkspaces()
      .then((rows) => {
        if (!gone) setFolders(rows);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  const body = (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-[168px] shrink-0 flex-col gap-0.5 border-r border-line/70 px-2 py-3" aria-label="Settings">
        {SETTINGS_TABS.map((opt) => {
          const on = tab === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              aria-current={on ? "page" : undefined}
              onClick={() => setTab(opt.id)}
              className={`rounded-md px-2.5 py-1.5 text-left ${
                on ? "bg-wash-strong text-ink" : "text-muted hover:bg-wash hover:text-ink"
              }`}
            >
              <span className="block text-[13px] font-medium">{opt.label}</span>
              <span className="block truncate text-[11px] text-muted">{opt.hint}</span>
            </button>
          );
        })}
        <div className="mt-auto px-2.5 pt-4">
          <div className="text-[12px] font-medium text-ink">TwanAgent{version ? ` ${version}` : ""}</div>
          <div className="text-[11px] text-muted">Desktop Grok workspace</div>
        </div>
      </nav>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="grid max-w-[520px] gap-4">
          {tab === "appearance" && (
            <Section title="Appearance" text="Finder is the default. Custom builds a theme from light or dark plus accent, background, and sidebar.">
              <ThemePicker value={theme} onChange={setThemeSel} />
              <Toggle
                title="Space corner"
                text="Show a faded picture in the top-left of the sidebar."
                checked={spaceArt}
                onChange={(next) => {
                  setSpaceArt(next);
                  setSpaceCorner(next);
                }}
              />
              <Toggle
                title="Video"
                text="Play an animated ascii scene from ascii.rest instead of the picture."
                checked={spaceVideo}
                onChange={(next) => {
                  setSpaceVideo(next);
                  setSpaceCornerScene(next ? spaceScene : "");
                  if (next && !spaceArt) {
                    setSpaceArt(true);
                    setSpaceCorner(true);
                  }
                }}
              />
              {spaceVideo ? (
                <label className="grid gap-1.5">
                  <span className="block text-[13px] font-medium text-ink">Scene</span>
                  <select
                    value={spaceScene}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (!isSceneId(next)) return;
                      setSpaceScene(next);
                      setSpaceCornerScene(next);
                    }}
                    className="h-8 rounded-md border border-line bg-canvas px-2 text-[13px] text-ink outline-none focus:border-accent"
                  >
                    {SCENES.map((scene) => (
                      <option key={scene.id} value={scene.id}>
                        {scene.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <Toggle
                title="File hover cards"
                text="Show a small preview when you hover a file name in chat."
                checked={fileHoverCard}
                onChange={(next) => {
                  setFileHoverCardOn(next);
                  setFileHoverCard(next);
                }}
              />
              <Toggle
                title="Performance overlay"
                text="Show FPS, native CPU, and memory in the bottom-right, with a live graph."
                checked={perfOverlay}
                onChange={(next) => {
                  setPerfOverlayOn(next);
                  setPerfOverlay(next);
                }}
              />
              <Toggle
                title="Expand edits"
                text="Open file edit diffs in chat. Reads, lists, and commands stay collapsed."
                checked={expandEdits}
                onChange={(next) => {
                  setExpandEditsOn(next);
                  setExpandEdits(next);
                }}
              />
              <div className="grid gap-1.5">
                <span className="block text-[13px] font-medium text-ink">Open Markdown files in</span>
                <span className="text-[12px] leading-relaxed text-muted">
                  Editor shows source. Viewer renders the file. You can switch on the file tab.
                </span>
                <div className="flex gap-1">
                  {(
                    [
                      { id: "editor", label: "Editor" },
                      { id: "viewer", label: "Viewer" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setMarkdownOpen(opt.id);
                        saveMarkdownOpenMode(opt.id);
                      }}
                      className={`rounded-[6px] px-2 py-1 text-[12px] ${
                        markdownOpen === opt.id ? "bg-wash-strong text-ink" : "text-muted hover:text-ink"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </Section>
          )}

          {tab === "providers" && (
            <Section
              title="Model Providers"
              text="Grok uses the CLI login, then a key saved here, then XAI_API_KEY. Claude uses a key saved here, then ANTHROPIC_API_KEY."
            >
              <ProviderBlock title="Grok" text="Composer models from xAI, plus the Grok CLI.">
                <Card>
                  <Row label="CLI" value={cli ? (cli.installed ? "Installed" : "Not found") : "Checking…"} ok={cli?.installed} />
                  <Row label="Path" value={cli?.path || "—"} mono />
                  <Row label="Version" value={cli?.version || "—"} />
                  <Row
                    label="Login"
                    value={
                      cli?.logged_in
                        ? cli.email
                          ? maskEmail(cli.email, showEmail)
                          : "Signed in"
                        : cli
                          ? "Not signed in"
                          : "—"
                    }
                    ok={cli?.logged_in}
                    action={
                      cli?.email ? (
                        <button
                          type="button"
                          aria-label={showEmail ? "Hide email" : "Show email"}
                          aria-pressed={showEmail}
                          title={showEmail ? "Hide email" : "Show email"}
                          onClick={() => setShowEmail((on) => !on)}
                          className="flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-wash hover:text-ink"
                        >
                          <Symbol name={showEmail ? "eye.slash" : "eye"} className="size-3.5" />
                        </button>
                      ) : null
                    }
                  />
                </Card>
                <label className="grid gap-1">
                  <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">xAI API key</span>
                  <input
                    type="password"
                    value={xaiKey}
                    autoComplete="off"
                    placeholder={keyStatus?.saved ? "Key saved — paste to replace" : "xai-…"}
                    onChange={(e) => setXaiKey(e.target.value)}
                    className="h-8 rounded-md border border-line bg-canvas px-2.5 text-[13px] outline-none focus:border-accent"
                  />
                </label>
                <p className="m-0 text-[12px] text-muted">
                  {keyStatus?.saved
                    ? "Using the saved key."
                    : keyStatus?.env
                      ? "Using XAI_API_KEY from the environment."
                      : "No key saved here."}
                </p>
                <div className="flex justify-end gap-2">
                  {keyStatus?.saved && (
                    <Button
                      disabled={savingKey}
                      onClick={() => {
                        setSavingKey(true);
                        void api
                          .clearKey()
                          .then((s) => {
                            setKeyStatus(s);
                            setXaiKey("");
                            onKeyChange?.();
                            setFlash({ kind: "ok", text: "Removed the saved xAI key." });
                          })
                          .catch((e) => setFlash({ kind: "err", text: String(e) }))
                          .finally(() => setSavingKey(false));
                      }}
                    >
                      Clear
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    disabled={savingKey || !xaiKey.trim()}
                    onClick={() => {
                      setSavingKey(true);
                      void api
                        .setKey(xaiKey.trim())
                        .then((s) => {
                          setKeyStatus(s);
                          setXaiKey("");
                          onKeyChange?.();
                          setFlash({ kind: "ok", text: "Saved the xAI API key." });
                        })
                        .catch((e) => setFlash({ kind: "err", text: String(e) }))
                        .finally(() => setSavingKey(false));
                    }}
                  >
                    {savingKey ? "Saving…" : "Save key"}
                  </Button>
                </div>
              </ProviderBlock>
              <ProviderBlock title="Claude" text="Composer models from Anthropic. The key stays in the keychain.">
                <label className="grid gap-1">
                  <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">Anthropic API key</span>
                  <input
                    type="password"
                    value={anthropicKey}
                    autoComplete="off"
                    placeholder={anthropicStatus?.saved ? "Key saved — paste to replace" : "sk-ant-…"}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    className="h-8 rounded-md border border-line bg-canvas px-2.5 text-[13px] outline-none focus:border-accent"
                  />
                </label>
                <p className="m-0 text-[12px] text-muted">
                  {anthropicStatus?.saved
                    ? "Saved"
                    : anthropicStatus?.env
                      ? "Using ANTHROPIC_API_KEY"
                      : "Not set"}
                </p>
                <div className="flex justify-end gap-2">
                  {anthropicStatus?.saved && (
                    <Button
                      disabled={savingAnthropic}
                      onClick={() => {
                        setSavingAnthropic(true);
                        void api
                          .clearAnthropicKey()
                          .then((s) => {
                            setAnthropicStatus(s);
                            setAnthropicKey("");
                            onKeyChange?.();
                            setFlash({ kind: "ok", text: "Removed the saved Anthropic key." });
                          })
                          .catch((e) => setFlash({ kind: "err", text: String(e) }))
                          .finally(() => setSavingAnthropic(false));
                      }}
                    >
                      Clear
                    </Button>
                  )}
                  <Button
                    variant="primary"
                    disabled={savingAnthropic || !anthropicKey.trim()}
                    onClick={() => {
                      setSavingAnthropic(true);
                      void api
                        .setAnthropicKey(anthropicKey.trim())
                        .then((s) => {
                          setAnthropicStatus(s);
                          setAnthropicKey("");
                          onKeyChange?.();
                          setFlash({ kind: "ok", text: "Saved the Anthropic API key." });
                        })
                        .catch((e) => setFlash({ kind: "err", text: String(e) }))
                        .finally(() => setSavingAnthropic(false));
                    }}
                  >
                    {savingAnthropic ? "Saving…" : "Save key"}
                  </Button>
                </div>
              </ProviderBlock>
            </Section>
          )}

          {tab === "voice" && (
            <Section
              title="Voice"
              text="Dictate into the message box. A model downloads once and runs on this Mac."
            >
              <VoiceModelCard
                modelId={speechModel || SPEECH_MODELS[0].id}
                models={speechModels}
                progress={speechProgress}
                downloading={speechDownloading}
              />
              <MicTest />
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => setVoicePicker(true)}>
                  Add model
                </Button>
              </div>
              {voicePicker ? (
                <VoiceModelDialog
                  currentId={speechModel || SPEECH_MODELS[0].id}
                  models={speechModels}
                  progress={speechProgress}
                  downloading={Boolean(speechDownloading)}
                  onClose={() => setVoicePicker(false)}
                  onUse={(id) => {
                    onSpeechModel?.(id);
                    setVoicePicker(false);
                  }}
                  onDownload={(id) => onSpeechDownload?.(id)}
                />
              ) : null}
            </Section>
          )}

          {tab === "storage" && (
            <Section
              title="Storage"
              text="Usage history is kept in a local SQLite file. Resetting it clears the usage chart and does not delete chats."
            >
              <Card>
                <Row label="File" value={db?.path || "Checking…"} title={db?.path} mono />
                <Row label="Size" value={db ? formatBytes(db.bytes) : "—"} />
                <Row label="Status" value={db ? (db.exists ? "On disk" : "Not created yet") : "—"} ok={db?.exists} />
              </Card>
              {confirmReset ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-panel px-3 py-2">
                  <span className="text-[12px] text-ink">Delete the usage database?</span>
                  <div className="flex shrink-0 gap-2">
                    <Button disabled={resettingDb} onClick={() => setConfirmReset(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      disabled={resettingDb}
                      onClick={() => {
                        setResettingDb(true);
                        void api
                          .usageDbReset()
                          .then((info) => {
                            setDb(info);
                            setConfirmReset(false);
                            setFlash({ kind: "ok", text: "Reset the usage database." });
                          })
                          .catch((e) => setFlash({ kind: "err", text: String(e) }))
                          .finally(() => setResettingDb(false));
                      }}
                    >
                      {resettingDb ? "Resetting…" : "Reset"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-end gap-2">
                  <Button
                    disabled={!db || openingDb}
                    onClick={() => {
                      setOpeningDb(true);
                      void api
                        .usageDbOpen()
                        .catch((e) => setFlash({ kind: "err", text: String(e) }))
                        .finally(() => setOpeningDb(false));
                    }}
                  >
                    {openingDb ? "Opening…" : "Open folder"}
                  </Button>
                  <Button variant="danger" disabled={!db?.exists || resettingDb} onClick={() => setConfirmReset(true)}>
                    Reset database
                  </Button>
                </div>
              )}
            </Section>
          )}

          {tab === "permissions" && (
            <Section
              title="Permissions"
              text="Grok can only read and edit folders you have opened. Tool permissions decide whether edits and shell commands need approval."
            >
              <div className="grid gap-1.5">
                {PERMISSION_MODES.map((mode) => {
                  const on = permission === mode.id;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        if (onPermission) onPermission(mode.id);
                        else setPermissionLocal(mode.id);
                      }}
                      className={`rounded-md border px-3 py-2 text-left ${
                        on ? "border-accent bg-wash" : "border-line hover:bg-wash"
                      }`}
                    >
                      <span className="block text-[13px] font-medium text-ink">{mode.label}</span>
                      <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
                        {permissionDetail(mode.id)}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium text-ink">Allowed folders</div>
                  <div className="text-[12px] text-muted">Disk access for chats, files, and commands.</div>
                </div>
                <Button
                  disabled={addingFolder}
                  onClick={() => {
                    setAddingFolder(true);
                    void api
                      .pickDir()
                      .then(async (path) => {
                        if (!path) return;
                        const opened = await api.openFolder(path);
                        setFolders((rows) => (rows.includes(opened) ? rows : [...rows, opened].sort()));
                        setFlash({ kind: "ok", text: `Allowed ${folderName(opened)}.` });
                      })
                      .catch((e) => setFlash({ kind: "err", text: String(e) }))
                      .finally(() => setAddingFolder(false));
                  }}
                >
                  {addingFolder ? "Opening…" : "Add folder"}
                </Button>
              </div>
              {folders.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">No folders yet. Open a project to allow it.</p>
              ) : (
                <div className="grid gap-1">
                  {folders.map((path) => (
                    <div key={path} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-ink">{folderName(path)}</div>
                        <div className="truncate font-mono text-[11px] text-muted">{path}</div>
                      </div>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          void api
                            .forgetWorkspace(path)
                            .then(() => {
                              setFolders((rows) => rows.filter((row) => row !== path));
                              setFlash({ kind: "ok", text: `Removed access to ${folderName(path)}.` });
                            })
                            .catch((e) => setFlash({ kind: "err", text: String(e) }));
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }
  return body;
}

function speechRowStatus(models: SpeechModelInfo[], id: string): SpeechModelStatus {
  return models.find((row) => row.id === id)?.status ?? "missing";
}

function VoiceModelCard({
  modelId,
  models,
  progress,
  downloading,
}: {
  modelId: string;
  models: SpeechModelInfo[];
  progress?: { id?: string; received: number; total: number } | null;
  downloading?: boolean;
}) {
  const model = speechModel(modelId);
  const status = speechRowStatus(models, model.id);
  const active = downloading && (!progress?.id || progress.id === model.id);
  return (
    <Card>
      <div className="text-[13px] font-medium text-ink">{model.label}</div>
      <div className="text-[12px] text-muted">{speechNote(model.id)}</div>
      <div className="text-[12px] text-muted">
        {speechSizeLabel(model.bytes)} · {voiceStatusText(status, active ? progress : null, active)}
      </div>
    </Card>
  );
}

function MicTest() {
  const { setFlash } = useApp();
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [deviceId, setDeviceId] = useState(loadMicDevice);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  const refreshDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    const rows = await navigator.mediaDevices.enumerateDevices();
    const mics = rows
      .filter((row) => row.kind === "audioinput")
      .map((row, index) => ({
        id: row.deviceId,
        label: row.label || `Microphone ${index + 1}`,
      }));
    setDevices(mics);
  }, []);

  useEffect(() => {
    void refreshDevices().catch(() => undefined);
  }, [refreshDevices]);

  useEffect(() => {
    return () => stopRef.current?.();
  }, []);

  async function startTest() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setFlash({ kind: "err", text: "Allow the microphone to test it." });
      return;
    }
    const info = await api.microphoneInfo().catch(() => null);
    if (!info?.ready) {
      setFlash({
        kind: "err",
        text: info?.reason || "This build cannot use the microphone yet. Quit TwanAgent and open it again from a new build.",
      });
      return;
    }
    stopRef.current?.();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints(deviceId) });
    } catch {
      setFlash({ kind: "err", text: "Allow the microphone to test it." });
      return;
    }
    await refreshDevices().catch(() => undefined);
    const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      stream.getTracks().forEach((track) => track.stop());
      setFlash({ kind: "err", text: "This browser cannot test the microphone." });
      return;
    }
    const ctx = new AudioCtx();
    try {
      await ctx.audioWorklet.addModule(pcmCaptureUrl);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
      setFlash({ kind: "err", text: "This browser cannot test the microphone." });
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(ctx, "pcm-capture");
    let peak = 0;
    processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!(event.data instanceof Float32Array)) return;
      const next = micLevel(event.data);
      peak = Math.max(peak * 0.85, next);
      setLevel(peak);
      if (next > 0.08) setHeard(true);
    };
    source.connect(processor);
    setHeard(false);
    setLevel(0);
    setTesting(true);
    stopRef.current = () => {
      processor.port.onmessage = null;
      source.disconnect();
      processor.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void ctx.close();
      stopRef.current = null;
      setTesting(false);
      setLevel(0);
    };
  }

  return (
    <div className="grid gap-2">
      <label className="grid gap-1.5">
        <span className="block text-[13px] font-medium text-ink">Microphone</span>
        <select
          value={devices.some((row) => row.id === deviceId) ? deviceId : ""}
          onChange={(event) => {
            const next = event.target.value;
            setDeviceId(next);
            saveMicDevice(next);
            if (testing) {
              stopRef.current?.();
              void startTest();
            }
          }}
          className="h-8 rounded-md border border-line bg-canvas px-2 text-[13px] text-ink outline-none focus:border-accent"
        >
          <option value="">System default</option>
          {devices.map((device) => (
            <option key={device.id || "default"} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-wash">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <p className="mt-1 mb-0 text-[12px] text-muted">
            {testing ? (heard ? "Hearing you." : "Speak to see the level move.") : "Check that the selected mic hears you."}
          </p>
        </div>
        <Button
          onClick={() => {
            if (testing) stopRef.current?.();
            else void startTest();
          }}
        >
          {testing ? "Stop" : "Test mic"}
        </Button>
      </div>
    </div>
  );
}

function VoiceModelDialog({
  currentId,
  models,
  progress,
  downloading,
  onClose,
  onUse,
  onDownload,
}: {
  currentId: string;
  models: SpeechModelInfo[];
  progress?: { id?: string; received: number; total: number } | null;
  downloading: boolean;
  onClose: () => void;
  onUse: (id: string) => void;
  onDownload: (id: string) => void;
}) {
  const [picked, setPicked] = useState(currentId);
  const status = speechRowStatus(models, picked);
  const active = downloading && (!progress?.id || progress.id === picked);
  const ready = status === "ready";

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      onClose();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-labelledby="voice-model-title"
        className="grid w-full max-w-[420px] gap-3 rounded-xl border border-line bg-canvas p-4 shadow-card"
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div>
          <h3 id="voice-model-title" className="m-0 text-[15px] font-semibold">
            Add a voice model
          </h3>
          <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">
            Pick a free model. It downloads once and stays on this Mac.
          </p>
        </div>
        <div className="grid gap-1.5" role="listbox" aria-label="Voice models">
          {SPEECH_MODELS.map((model) => {
            const rowStatus = speechRowStatus(models, model.id);
            const on = picked === model.id;
            return (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => setPicked(model.id)}
                className={`rounded-md border px-3 py-2 text-left ${
                  on ? "border-accent bg-wash" : "border-line hover:bg-wash"
                }`}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-medium text-ink">{model.label}</span>
                  <span className="shrink-0 text-[11px] text-muted">{speechSizeLabel(model.bytes)}</span>
                </span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{speechNote(model.id)}</span>
                <span className="mt-1 block text-[11px] text-muted">
                  {rowStatus === "ready" ? "Downloaded" : rowStatus === "partial" ? "Download incomplete" : "Not downloaded"}
                  {model.id === currentId ? " · In use" : ""}
                </span>
              </button>
            );
          })}
        </div>
        {active && progress && progress.total > 0 ? (
          <div className="grid gap-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-wash">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.min(100, Math.round((progress.received / progress.total) * 100))}%` }}
              />
            </div>
            <span className="text-[11px] text-muted">{voiceStatusText(status, progress, true)}</span>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          {ready ? (
            <Button variant="primary" onClick={() => onUse(picked)}>
              Use model
            </Button>
          ) : (
            <Button variant="primary" disabled={active} onClick={() => onDownload(picked)}>
              {active ? "Downloading…" : status === "partial" ? "Resume download" : "Download"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function voiceStatusText(
  status: SpeechModelStatus | undefined,
  progress: { received: number; total: number } | null | undefined,
  downloading: boolean | undefined,
): string {
  if (downloading && progress && progress.total > 0) {
    return `Downloading… ${speechSizeLabel(progress.received)} / ${speechSizeLabel(progress.total)}`;
  }
  if (status === "ready") return "Ready";
  if (status === "partial") return "Download incomplete";
  return "Not downloaded";
}

function ProviderBlock({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 rounded-lg border border-line/80 px-3 py-3">
      <div>
        <h3 className="m-0 text-[13px] font-semibold text-ink">{title}</h3>
        <p className="mt-0.5 mb-0 text-[12px] leading-relaxed text-muted">{text}</p>
      </div>
      {children}
    </div>
  );
}

function Section({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        <p className="mt-1 mb-0 text-[12px] leading-relaxed text-muted">{text}</p>
      </div>
      {children}
    </section>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="grid gap-1.5 rounded-md border border-line bg-panel px-3 py-2.5">{children}</div>;
}

function Row({
  label,
  value,
  mono,
  ok,
  title,
  action,
}: {
  label: string;
  value: string;
  mono?: boolean;
  ok?: boolean;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</span>
      <span className="flex min-w-0 items-center gap-1">
        <span
          title={title}
          className={`min-w-0 truncate text-[12px] ${mono ? "font-mono" : ""} ${ok ? "text-ok" : "text-ink"}`}
        >
          {value}
        </span>
        {action}
      </span>
    </div>
  );
}

function Toggle({
  title,
  text,
  checked,
  onChange,
}: {
  title: string;
  text: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{text}</span>
      </span>
    </label>
  );
}
